import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ed25519 } from '@noble/curves/ed25519.js'
import { base58, base64 } from '@scure/base'
import { AltudeGasStation } from '@altude/gasstation'
import { AltudeNativeWallet } from './wallet.js'
import type { NativeWalletEvent } from './wallet.js'
import { NativeWalletVault, createKeychainWalletKeyStore } from './vault.js'
import type { NativeWalletKeyStore, NativeWalletScope } from './vault.js'
import type { RefreshTokenStore } from './platform.js'

const appId = '-17.42'
const userId = 'wallet-user-1'
function serverMessage(address: string | null): string {
  return [
    'Altude Wallet Access Binding v1',
    'Issuer: https://api.altude.so/',
    `AppId: ${appId}`,
    'TenantId: -17',
    `UserId: ${userId}`,
    'IdentityKey: server-identity',
    'RefreshFamilyId: native-family',
    'Origin: ',
    'IdentityTicket: ',
    'ChallengeId: challenge',
    `WalletAddress: ${address ?? ''}`,
    'Nonce: café 🔐',
  ].join('\n')
}
const scope = { apiBaseUrl: 'https://api.altude.so', appId, walletUserId: userId }
const clients: AltudeNativeWallet[] = []

function memoryKeys(): NativeWalletKeyStore & { keys: Map<string, Uint8Array> } {
  const key = (value: NativeWalletScope, address: string) =>
    `${value.apiBaseUrl}/${value.appId}/${value.walletUserId}/${address}`
  return {
    keys: new Map(),
    read(value, address) {
      return Promise.resolve(this.keys.get(key(value, address))?.slice() ?? null)
    },
    write(value, address, secret) {
      this.keys.set(key(value, address), secret.slice())
      return Promise.resolve()
    },
  }
}

function makeServer() {
  let address: string | null = null
  let migrated = true
  let sessionValid = true
  let refreshFails = false
  let revokeFails = false
  let sessionTtl = 120
  let latestMessage = ''
  let messageOverride: ((message: string) => string) | undefined
  const fetcher = vi.fn<typeof fetch>((input, options) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const reply = (body: unknown, status = 200) =>
      Promise.resolve(new Response(JSON.stringify(body), { status }))
    const headers = options?.headers as Record<string, string>
    if (url.endsWith('/config')) {
      return reply({
        AppId: appId,
        NativeScheme: 'so.altude.wallet.tn17.a42',
        Issuer: 'https://api.altude.so/',
        Audience: `urn:altude:wallet:app:${appId}`,
        AuthorizationUrl: 'https://api.altude.so/api/native-wallet/authorize',
        JwksUrl: 'https://api.altude.so/api/native-wallet/jwks',
      })
    }
    if (url.endsWith('/token') || url.endsWith('/refresh')) {
      if (url.endsWith('/refresh') && refreshFails)
        return reply({ Error: 'invalid_refresh_token' }, 401)
      return reply({
        AccessToken: 'native-access',
        RefreshToken: 'refresh-secret',
        ExpiresIn: 300,
        TokenType: 'Bearer',
      })
    }
    if (url.endsWith('/revoke')) {
      sessionValid = false
      return revokeFails ? reply({ Error: 'broker_unavailable' }, 503) : reply({ Revoked: true })
    }
    if (url.endsWith('/native-wallet/wallet')) {
      expect(headers['Authorization']).toBe('Bearer native-access')
      expect(headers['X-API-Key']).toBe('client-key')
      if (!migrated) return reply({ Error: 'wallet_scope_migration_required' }, 409)
      latestMessage = messageOverride?.(serverMessage(address)) ?? serverMessage(address)
      return reply({
        AppId: appId,
        UserId: userId,
        IdentityKey: 'server-identity',
        WalletAddress: address,
        ChallengeId: 'challenge',
        Message: latestMessage,
        ExpiresIn: 60,
      })
    }
    if (url.endsWith('/native-wallet/wallet/session')) {
      expect(headers['Authorization']).toBe('Bearer native-access')
      if (typeof options?.body !== 'string') throw new Error('Expected a JSON proof request.')
      const body = JSON.parse(options.body) as Record<string, string>
      const requested = body['WalletAddress'] ?? ''
      expect(
        ed25519.verify(
          base64.decode(body['Signature'] ?? ''),
          new TextEncoder().encode(latestMessage),
          base58.decode(requested),
        ),
      ).toBe(true)
      if (address !== null && requested !== address)
        return reply({ Error: 'wallet_conflict', WalletAddress: address }, 409)
      address = requested
      sessionValid = true
      return reply({
        Success: true,
        AppId: appId,
        UserId: userId,
        SessionToken: 'opaque-wallet-session',
        User: { Id: userId, WalletAddress: address },
        ExpiresIn: sessionTtl,
      })
    }
    if (url.endsWith('/EmbeddedWallet/session')) {
      expect(headers['Authorization']).toBe('Bearer opaque-wallet-session')
      return reply({
        IsAuthenticated: sessionValid,
        AppId: appId,
        UserId: userId,
        User: { Id: userId, WalletAddress: address },
      })
    }
    return reply({ Error: 'invalid_request' }, 400)
  })
  return {
    fetcher,
    get address() {
      return address
    },
    set address(value: string | null) {
      address = value
    },
    set migrated(value: boolean) {
      migrated = value
    },
    set sessionValid(value: boolean) {
      sessionValid = value
    },
    set refreshFails(value: boolean) {
      refreshFails = value
    },
    set revokeFails(value: boolean) {
      revokeFails = value
    },
    set sessionTtl(value: number) {
      sessionTtl = value
    },
    set messageOverride(value: (message: string) => string) {
      messageOverride = value
    },
  }
}

function memoryRefreshTokens(): RefreshTokenStore {
  let refreshToken: string | null = null
  return {
    get: (_apiBaseUrl, _app) => Promise.resolve(refreshToken),
    set: (_apiBaseUrl, _app, token) => {
      refreshToken = token
      return Promise.resolve()
    },
    remove: (_apiBaseUrl, _app) => {
      refreshToken = null
      return Promise.resolve()
    },
  }
}

function makeWallet(
  server = makeServer(),
  keys = memoryKeys(),
  seed = 1,
  refreshTokenStore = memoryRefreshTokens(),
  apiBaseUrl = 'https://api.altude.so',
) {
  let randomCounter = seed
  const browser = {
    openAuthSession: vi.fn((url: string, callback: string) =>
      Promise.resolve({
        type: 'success' as const,
        url: `${callback}?code=broker-code&state=${new URL(url).searchParams.get('state') ?? ''}`,
      }),
    ),
  }
  const wallet = new AltudeNativeWallet({
    apiKey: 'client-key',
    apiBaseUrl,
    keyStore: keys,
    randomBytes: (length) => new Uint8Array(length).fill(randomCounter++),
    refreshTokenStore,
    fetch: server.fetcher,
    browser,
  })
  clients.push(wallet)
  return { wallet, keys, server, browser }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  clients.splice(0).forEach((wallet) => {
    wallet.lock()
  })
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('AltudeNativeWallet', () => {
  it('looks up before key generation and establishes a proof-bound ready wallet', async () => {
    const { wallet, server, keys } = makeWallet()
    const events: NativeWalletEvent[] = []
    wallet.onEvent((event) => {
      events.push(event)
    })
    expect(await wallet.connect()).toMatchObject({
      status: 'ready',
      appId,
      walletUserId: userId,
      address: server.address,
    })
    expect(keys.keys.size).toBe(1)
    expect(
      events.filter((event) => event.type === 'setup:progress').map((event) => event.stage),
    ).toEqual(['authenticating', 'connecting-account', 'securing-device', 'finishing'])
    expect(
      events.filter((event) => event.type === 'state').map((event) => event.state.status),
    ).toContain('creating')
  })

  it('reuses the registered address for repeated login and interrupted setup', async () => {
    const { wallet, server, keys } = makeWallet()
    await wallet.connect()
    const original = server.address
    wallet.lock()
    expect(await wallet.restore()).toMatchObject({ status: 'ready', address: original })
    expect(keys.keys.size).toBe(1)
    await wallet.connect()
    expect(server.address).toBe(original)
  })

  it('revokes the persisted family before fresh login after restart replaces credentials', async () => {
    const store = memoryRefreshTokens()
    const first = makeWallet(makeServer(), memoryKeys(), 1, store)
    await first.wallet.connect()
    first.wallet.lock()
    const oldToken = await store.get('https://api.altude.so', appId)
    const originalAddress = first.server.address
    const original = first.server.fetcher.getMockImplementation()
    let completeRevoke: (() => void) | undefined
    const revokeStarted = new Promise<void>((resolve) => {
      first.server.fetcher.mockImplementation(async (input, options) => {
        if (!original) throw new Error('Expected API fixture.')
        if (typeof input === 'string' && input.endsWith('/revoke')) {
          expect(JSON.parse(options?.body as string)).toEqual({
            AppId: appId,
            RefreshToken: oldToken,
          })
          await new Promise<void>((complete) => {
            completeRevoke = complete
            resolve()
          })
        }
        const reply = await original(input, options)
        if (typeof input === 'string' && input.endsWith('/token')) {
          return new Response(
            JSON.stringify({ ...(await reply.json()), RefreshToken: 'refresh-new-family' }),
          )
        }
        return reply
      })
    })
    const restarted = makeWallet(first.server, first.keys, 10, store)
    const login = restarted.wallet.connect()
    await revokeStarted
    expect(restarted.browser.openAuthSession).not.toHaveBeenCalled()
    expect(await store.get('https://api.altude.so', appId)).toBe(oldToken)
    completeRevoke?.()
    expect(await login).toMatchObject({ status: 'ready', address: originalAddress })
    expect(await store.get('https://api.altude.so', appId)).toBe('refresh-new-family')
    expect(
      first.server.fetcher.mock.calls.filter(
        ([input]) => typeof input === 'string' && input.endsWith('/revoke'),
      ),
    ).toHaveLength(1)
    expect(first.keys.keys.size).toBe(1)
  })

  it('rotates the persisted credential without revoking its family on restore after restart', async () => {
    const store = memoryRefreshTokens()
    const first = makeWallet(makeServer(), memoryKeys(), 1, store)
    await first.wallet.connect()
    first.wallet.lock()
    const oldToken = await store.get('https://api.altude.so', appId)
    const original = first.server.fetcher.getMockImplementation()
    first.server.fetcher.mockImplementation(async (input, options) => {
      if (!original) throw new Error('Expected API fixture.')
      const reply = await original(input, options)
      if (typeof input === 'string' && input.endsWith('/refresh')) {
        expect(JSON.parse(options?.body as string)).toEqual({
          AppId: appId,
          RefreshToken: oldToken,
        })
        return new Response(
          JSON.stringify({ ...(await reply.json()), RefreshToken: 'refresh-rotated' }),
        )
      }
      return reply
    })
    first.server.fetcher.mockClear()
    const restarted = makeWallet(first.server, first.keys, 10, store)
    expect(await restarted.wallet.restore()).toMatchObject({
      status: 'ready',
      address: first.server.address,
    })
    expect(await store.get('https://api.altude.so', appId)).toBe('refresh-rotated')
    expect(restarted.browser.openAuthSession).not.toHaveBeenCalled()
    expect(
      first.server.fetcher.mock.calls.some(
        ([input]) => typeof input === 'string' && input.endsWith('/revoke'),
      ),
    ).toBe(false)
    expect(first.keys.keys.size).toBe(1)
  })

  it('blocks fresh login after restart when persisted-family revocation fails', async () => {
    const store = memoryRefreshTokens()
    const first = makeWallet(makeServer(), memoryKeys(), 1, store)
    await first.wallet.connect()
    first.wallet.lock()
    first.server.revokeFails = true
    first.server.fetcher.mockClear()
    const restarted = makeWallet(first.server, first.keys, 10, store)
    await expect(restarted.wallet.connect()).rejects.toMatchObject({ code: 'API', status: 503 })
    expect(restarted.wallet.state.status).toBe('failed')
    expect(restarted.browser.openAuthSession).not.toHaveBeenCalled()
    expect(
      first.server.fetcher.mock.calls.some(
        ([input]) => typeof input === 'string' && input.endsWith('/token'),
      ),
    ).toBe(false)
  })

  it('resumes the same key when registration succeeded but its response was lost', async () => {
    const { wallet, server, keys } = makeWallet()
    const original = server.fetcher.getMockImplementation()
    let interrupted = false
    server.fetcher.mockImplementation(async (input, options) => {
      if (!original) throw new Error('Expected API fixture.')
      const reply = await original(input, options)
      if (
        !interrupted &&
        typeof input === 'string' &&
        input.endsWith('/native-wallet/wallet/session')
      ) {
        interrupted = true
        throw new Error('Response lost after registration.')
      }
      return reply
    })
    await expect(wallet.connect()).rejects.toMatchObject({ code: 'NETWORK' })
    const registered = server.address
    expect(registered).not.toBeNull()
    expect(keys.keys.size).toBe(1)
    expect(await wallet.restore()).toMatchObject({ status: 'ready', address: registered })
    expect(keys.keys.size).toBe(1)
  })

  it('does not create a substitute key for an existing wallet on a new device', async () => {
    const first = makeWallet()
    await first.wallet.connect()
    const second = makeWallet(first.server)
    await expect(second.wallet.connect()).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' })
    expect(second.wallet.state).toMatchObject({
      status: 'recovery-required',
      address: first.server.address,
    })
    expect(second.keys.keys.size).toBe(0)
  })

  it('blocks creation until an operator enrolls a legacy wallet for this app', async () => {
    const { wallet, server, keys } = makeWallet()
    server.migrated = false
    await expect(wallet.connect()).rejects.toMatchObject({
      code: 'WALLET_SCOPE_MIGRATION_REQUIRED',
    })
    expect(keys.keys.size).toBe(0)
  })

  it.each([
    ['arbitrary message', () => 'Sign this transaction'],
    [
      'wrong issuer',
      (message: string) => message.replace('https://api.altude.so/', 'https://other.example/'),
    ],
    ['wrong tenant', (message: string) => message.replace('TenantId: -17', 'TenantId: 99')],
    ['wrong app', (message: string) => message.replace(`AppId: ${appId}`, 'AppId: 99.42')],
    ['wrong user', (message: string) => message.replace(`UserId: ${userId}`, 'UserId: other')],
    [
      'wrong identity',
      (message: string) => message.replace('IdentityKey: server-identity', 'IdentityKey: other'),
    ],
    [
      'browser proof',
      (message: string) =>
        message.replace('RefreshFamilyId: native-family', 'RefreshFamilyId: browser'),
    ],
    [
      'nonempty origin',
      (message: string) => message.replace('Origin: \n', 'Origin: https://site.example\n'),
    ],
    [
      'wrong challenge',
      (message: string) => message.replace('ChallengeId: challenge', 'ChallengeId: other'),
    ],
    [
      'wrong address',
      (message: string) => message.replace('WalletAddress: \n', 'WalletAddress: other\n'),
    ],
    ['trailing line', (message: string) => `${message}\n`],
  ])('rejects %s before creating or signing with a key', async (_label, change) => {
    const { wallet, server, keys } = makeWallet()
    server.messageOverride = change
    await expect(wallet.connect()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    expect(keys.keys.size).toBe(0)
    expect(
      server.fetcher.mock.calls.some(
        ([input]) => typeof input === 'string' && input.endsWith('/native-wallet/wallet/session'),
      ),
    ).toBe(false)
  })
  it('concurrent first login converges to one canonical address in a shared local store', async () => {
    const server = makeServer()
    const keys = memoryKeys()
    const first = makeWallet(server, keys, 1)
    const second = makeWallet(server, keys, 10)
    const states = await Promise.all([first.wallet.connect(), second.wallet.connect()])
    expect(states.map((state) => state.address)).toEqual([server.address, server.address])
    expect(states.every((state) => state.status === 'ready')).toBe(true)
  })

  it('a cross-device first-login race leaves the losing device in recovery-required', async () => {
    const server = makeServer()
    const first = makeWallet(server, memoryKeys(), 1)
    const second = makeWallet(server, memoryKeys(), 10)
    const results = await Promise.allSettled([first.wallet.connect(), second.wallet.connect()])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    expect(second.wallet.state).toMatchObject({
      status: 'recovery-required',
      address: server.address,
    })
  })

  it('locks locally and clears its session even if broker revocation fails', async () => {
    const { wallet, server } = makeWallet()
    await wallet.connect()
    server.revokeFails = true
    await expect(wallet.signOut()).rejects.toMatchObject({ status: 503 })
    expect(wallet.state).toMatchObject({
      status: 'disconnected',
      address: null,
      walletUserId: null,
    })
    await expect(
      wallet.sendTransfer({ kind: 'sol-transfer', recipient: 'recipient', amount: 1 }, () => true),
    ).rejects.toMatchObject({ code: 'LOCKED' })
  })

  it('cannot restore readiness after locking during an in-flight key read', async () => {
    const { wallet, server, keys } = makeWallet()
    await wallet.connect()
    wallet.lock()
    let finish: ((value: Uint8Array | null) => void) | undefined
    const saved = [...keys.keys.values()][0]?.slice() ?? null
    const started = new Promise<void>((resolve) => {
      vi.spyOn(keys, 'read').mockImplementation(() => {
        resolve()
        return new Promise((complete) => {
          finish = complete
        })
      })
    })
    const restore = wallet.restore()
    await started
    wallet.lock()
    finish?.(saved)
    await expect(restore).rejects.toMatchObject({ code: 'LOCKED' })
    expect(wallet.state.status).toBe('locked')
    expect(server.address).not.toBeNull()
    expect(saved?.every((byte) => byte === 0)).toBe(true)
  })

  it('locks automatically when its derived session expires', async () => {
    const { wallet } = makeWallet()
    await wallet.connect()
    vi.advanceTimersByTime(120_000)
    expect(wallet.state.status).toBe('locked')
  })

  it('rejects a revoked session before local transaction authorization', async () => {
    const { wallet, server } = makeWallet()
    await wallet.connect()
    server.sessionValid = false
    const approve = vi.fn(() => true)
    await expect(
      wallet.sendTransfer({ kind: 'sol-transfer', recipient: 'recipient', amount: 1 }, approve),
    ).rejects.toMatchObject({ code: 'SESSION' })
    expect(approve).not.toHaveBeenCalled()
    expect(wallet.state.status).toBe('failed')
  })

  it('rejects another app session even when the wallet user and address match', async () => {
    const { wallet, server } = makeWallet()
    await wallet.connect()
    const original = server.fetcher.getMockImplementation()
    server.fetcher.mockImplementation((input, options) => {
      if (typeof input === 'string' && input.endsWith('/EmbeddedWallet/session')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              IsAuthenticated: true,
              AppId: '17.99',
              UserId: userId,
              User: { Id: userId, WalletAddress: server.address },
            }),
          ),
        )
      }
      if (!original) throw new Error('Expected API fixture.')
      return original(input, options)
    })
    await expect(
      wallet.sendTransfer({ kind: 'sol-transfer', recipient: 'recipient', amount: 1 }, () => true),
    ).rejects.toMatchObject({ code: 'SESSION' })
    expect(wallet.state.status).toBe('failed')
  })

  it('locks on refresh failure instead of leaving a ready signer usable', async () => {
    const { wallet, server } = makeWallet()
    server.sessionTtl = 600
    await wallet.connect()
    server.refreshFails = true
    vi.advanceTimersByTime(301_000)
    const approve = vi.fn(() => true)
    await expect(
      wallet.sendTransfer({ kind: 'sol-transfer', recipient: 'recipient', amount: 1 }, approve),
    ).rejects.toMatchObject({ status: 401 })
    expect(approve).not.toHaveBeenCalled()
    expect(wallet.state.status).toBe('failed')
  })

  it('revokes even when a disconnected-state listener fails', async () => {
    const { wallet, server } = makeWallet()
    await wallet.connect()
    const unsubscribe = wallet.onEvent((event) => {
      if (event.type === 'state' && event.state.status === 'disconnected') {
        throw new Error('Listener failure')
      }
    })
    await expect(wallet.signOut()).rejects.toThrow('Listener failure')
    unsubscribe()
    expect(
      server.fetcher.mock.calls.some(
        ([input]) => typeof input === 'string' && input.endsWith('/revoke'),
      ),
    ).toBe(true)
    expect(wallet.state.status).toBe('disconnected')
  })

  it('cancels sign-in before key creation when the system browser is dismissed', async () => {
    const server = makeServer()
    const keys = memoryKeys()
    const wallet = new AltudeNativeWallet({
      apiKey: 'client-key',
      apiBaseUrl: 'https://api.altude.so',
      keyStore: keys,
      fetch: server.fetcher,
      randomBytes: (length) => new Uint8Array(length).fill(7),
      refreshTokenStore: {
        get: () => Promise.resolve(null),
        set: () => Promise.resolve(),
        remove: () => Promise.resolve(),
      },
      browser: { openAuthSession: () => Promise.resolve({ type: 'cancel' }) },
    })
    clients.push(wallet)
    await expect(wallet.connect()).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(keys.keys.size).toBe(0)
    expect(wallet.state.status).toBe('failed')
  })

  it('does not keep a session when its server user/address differ from the lookup', async () => {
    const { wallet, server } = makeWallet()
    const original = server.fetcher.getMockImplementation()
    server.fetcher.mockImplementation((input, options) => {
      if (typeof input === 'string' && input.endsWith('/native-wallet/wallet/session')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              Success: true,
              SessionToken: 'opaque-session',
              User: { Id: 'another-user', WalletAddress: 'another-address' },
              ExpiresIn: 120,
            }),
          ),
        )
      }
      if (!original) throw new Error('Expected API fixture.')
      return original(input, options)
    })
    await expect(wallet.connect()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    expect(wallet.state.status).toBe('failed')
  })

  it('submits only the frozen approved transfer through Gas Station with a guarded signer', async () => {
    const { wallet } = makeWallet()
    await wallet.connect()
    vi.spyOn(AltudeGasStation.prototype, 'getConfig').mockResolvedValue({
      FeePayer: 'fee-payer', RpcUrl: 'https://rpc.example.test', Token: 'token',
      RpcEnvironment: 'devnet', TokenExpiration: null,
    })
    const send = vi
      .spyOn(AltudeGasStation.prototype, 'send')
      .mockImplementation(async (options) => {
        const signature = await options.sourceSigner?.signTransactionMessage?.(
          new Uint8Array([1, 2]),
        )
        expect(signature).toHaveLength(64)
        return { Signature: 'signed-transfer' }
      })
    const intent = { kind: 'sol-transfer' as const, recipient: 'original', amount: 7 }
    const result = await wallet.sendTransfer(intent, (snapshot) => {
      expect(Object.isFrozen(snapshot)).toBe(true)
      expect(snapshot.network).toBe('devnet')
      intent.recipient = 'changed'
      intent.amount = 500
      return true
    })
    expect(result.Signature).toBe('signed-transfer')
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      toAddress: 'original', amount: 7, expectedNetwork: 'devnet',
    }))
    expect(typeof send.mock.calls[0]?.[0].beforeDispatch).toBe('function')
  })

  it('does not submit after account switching during local authorization', async () => {
    const { wallet } = makeWallet()
    await wallet.connect()
    vi.spyOn(AltudeGasStation.prototype, 'getConfig').mockResolvedValue({
      FeePayer: 'fee-payer', RpcUrl: 'https://rpc.example.test', Token: 'token',
      RpcEnvironment: 'devnet', TokenExpiration: null,
    })
    const send = vi.spyOn(AltudeGasStation.prototype, 'send')
    await expect(
      wallet.sendTransfer({ kind: 'sol-transfer', recipient: 'recipient', amount: 1 }, async () => {
        await wallet.connect()
        return true
      }),
    ).rejects.toMatchObject({ code: 'SESSION' })
    expect(send).not.toHaveBeenCalled()
  })

  it('rejects invalid network configuration before asking for approval', async () => {
    const { wallet } = makeWallet()
    await wallet.connect()
    vi.spyOn(AltudeGasStation.prototype, 'getConfig').mockResolvedValue({
      FeePayer: 'fee-payer', RpcUrl: 'https://rpc.example.test', Token: 'token',
      RpcEnvironment: 'unknown', TokenExpiration: null,
    })
    const approve = vi.fn(() => true)
    await expect(wallet.sendTransfer({
      kind: 'sol-transfer', recipient: 'recipient', amount: 1,
    }, approve)).rejects.toMatchObject({ code: 'RPC_ERROR' })
    expect(approve).not.toHaveBeenCalled()
  })

  it('uses the normalized deployment URL for login, wallet access, and a signed transfer', async () => {
    const server = makeServer()
    const original = server.fetcher.getMockImplementation()
    server.fetcher.mockImplementation((input, options) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      expect(url.startsWith('https://api.altude.so/api/')).toBe(true)
      if (url === 'https://api.altude.so/api/native-wallet/config') {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              AppId: appId,
              NativeScheme: 'so.altude.wallet.tn17.a42',
              Issuer: 'https://api.altude.so/',
              Audience: `urn:altude:wallet:app:${appId}`,
              AuthorizationUrl: 'https://API.ALTUDE.SO:443/api/native-wallet/authorize',
              JwksUrl: 'https://API.ALTUDE.SO:443/api/native-wallet/jwks',
            }),
          ),
        )
      }
      if (!original) throw new Error('Expected API fixture.')
      return original(input, options)
    })
    const { wallet } = makeWallet(
      server,
      memoryKeys(),
      1,
      memoryRefreshTokens(),
      'https://api.altude.so/',
    )
    const requests: string[] = []
    let signedTransaction = ''
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string, init?: RequestInit) => {
        requests.push(input)
        if (input === 'https://api.altude.so/api/transaction/config') {
          expect(new Headers(init?.headers).get('X-API-Key')).toBe('client-key')
          return Promise.resolve(
            new Response(
              JSON.stringify({
                FeePayer: 'ALTn7gyjm29WthZGgs4z6WVAK2PK5U6w4FAtPg3TPY71',
                RpcUrl: 'https://rpc.example.test',
                Token: 'token',
                RpcEnvironment: 'devnet',
                TokenExpiration: '2099-01-01T00:00:00Z',
              }),
            ),
          )
        }
        if (input === 'https://rpc.example.test') {
          expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer token')
          if (typeof init?.body !== 'string') throw new Error('Expected JSON RPC body.')
          const request = JSON.parse(init.body) as { id: string | number; method: string }
          expect(request.method).toBe('getLatestBlockhash')
          return Promise.resolve(
            new Response(
              JSON.stringify({
                jsonrpc: '2.0',
                id: request.id,
                result: {
                  context: { slot: 1 },
                  value: {
                    blockhash: 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N',
                    lastValidBlockHeight: 100,
                  },
                },
              }),
            ),
          )
        }
        if (input === 'https://api.altude.so/api/Transaction/send') {
          expect(new Headers(init?.headers).get('X-API-Key')).toBe('client-key')
          if (typeof init?.body !== 'string') throw new Error('Expected relay body.')
          signedTransaction = (JSON.parse(init.body) as { SignedTransaction: string })
            .SignedTransaction
          return Promise.resolve(new Response(JSON.stringify({ Signature: 'relayed' })))
        }
        throw new Error(`Unexpected request: ${input}`)
      }),
    )
    const state = await wallet.connect()
    expect(state.status).toBe('ready')
    const approve = vi.fn(() => true)
    const result = await wallet.sendTransfer(
      {
        kind: 'sol-transfer',
        recipient: 'So11111111111111111111111111111111111111112',
        amount: 1,
      },
      approve,
    )
    expect(approve).toHaveBeenCalledWith(expect.objectContaining({ network: 'devnet' }))
    expect(result.Signature).toBe('relayed')
    expect(requests).toContain('https://api.altude.so/api/transaction/config')
    expect(requests).toContain('https://rpc.example.test')
    expect(requests).toContain('https://api.altude.so/api/Transaction/send')
    const bytes = base64.decode(signedTransaction)
    const signatureCount = bytes[0] ?? 0
    expect(signatureCount).toBe(2)
    const message = bytes.slice(1 + signatureCount * 64)
    expect(state.address).not.toBeNull()
    expect(
      Array.from({ length: signatureCount }, (_, index) =>
        ed25519.verify(
          bytes.slice(1 + index * 64, 1 + (index + 1) * 64),
          message,
          base58.decode(state.address ?? ''),
        ),
      ).some(Boolean),
    ).toBe(true)
  })

  it('prevents a real relay dispatch if the wallet locks after signing', async () => {
    const { wallet } = makeWallet()
    await wallet.connect()
    let configCount = 0
    let relayCount = 0
    vi.stubGlobal('fetch', vi.fn((input: string, init?: RequestInit) => {
      if (input.endsWith('/api/transaction/config')) {
        configCount++
        if (configCount === 3) wallet.lock()
        return Promise.resolve(new Response(JSON.stringify({
          FeePayer: 'ALTn7gyjm29WthZGgs4z6WVAK2PK5U6w4FAtPg3TPY71',
          RpcUrl: 'https://rpc.example.test', Token: 'token', RpcEnvironment: 'devnet',
          TokenExpiration: '2099-01-01T00:00:00Z',
        })))
      }
      if (input.startsWith('https://rpc.example.test')) {
        if (typeof init?.body !== 'string') throw new Error('Expected JSON RPC body.')
        const request = JSON.parse(init.body) as { id: string | number }
        return Promise.resolve(new Response(JSON.stringify({
          jsonrpc: '2.0', id: request.id, result: {
            context: { slot: 1 },
            value: { blockhash: 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N', lastValidBlockHeight: 100 },
          },
        })))
      }
      if (input.endsWith('/api/Transaction/send')) {
        relayCount++
        return Promise.resolve(new Response(JSON.stringify({ Signature: 'unexpected' })))
      }
      throw new Error(`Unexpected request: ${input}`)
    }))
    await expect(wallet.sendTransfer({
      kind: 'sol-transfer', recipient: 'So11111111111111111111111111111111111111112', amount: 1,
    }, () => true)).rejects.toMatchObject({ code: 'SESSION' })
    expect(configCount).toBe(3)
    expect(relayCount).toBe(0)
  })

  it('rejects wrong server app or user bindings before exposing a signer', async () => {
    const { wallet, server, keys } = makeWallet()
    const original = server.fetcher.getMockImplementation()
    server.fetcher.mockImplementation((input, options) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.endsWith('/native-wallet/wallet')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              AppId: '17.99',
              UserId: userId,
              IdentityKey: 'id',
              WalletAddress: null,
              ChallengeId: 'id',
              Message: 'proof',
              ExpiresIn: 60,
            }),
          ),
        )
      }
      if (!original) throw new Error('Expected API fixture.')
      return original(input, options)
    })
    await expect(wallet.connect()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    expect(keys.keys.size).toBe(0)
  })
})

describe('NativeWalletVault', () => {
  it('invalidates previously returned signers when locked and scopes keys by app/user/address', async () => {
    const keys = memoryKeys()
    const vault = new NativeWalletVault(keys, (length) => new Uint8Array(length).fill(7))
    const address = await vault.create(scope)
    const signer = await vault.unlock(scope, address)
    const message = new Uint8Array([1, 2, 3])
    const signature = await signer.signMessage?.(message)
    expect(signature && ed25519.verify(signature, message, base58.decode(address))).toBe(true)
    vault.lock()
    expect(() => signer.signMessage?.(message)).toThrow('locked')
    await expect(vault.unlock({ ...scope, appId: '17.99' }, address)).rejects.toMatchObject({
      code: 'RECOVERY_REQUIRED',
    })
    await expect(
      vault.unlock({ ...scope, apiBaseUrl: 'https://staging.altude.so' }, address),
    ).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' })
  })

  it('requires device-only secure storage and persists bytes without Buffer', async () => {
    const get = vi.fn(() => Promise.resolve(false as const))
    const set = vi.fn(() => Promise.resolve(true))
    const keychain = {
      ACCESSIBLE: { WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'device-only' },
      getGenericPassword: get,
      setGenericPassword: set,
      resetGenericPassword: () => Promise.resolve(true),
    }
    const keys = createKeychainWalletKeyStore(keychain)
    await keys.write(scope, 'address', new Uint8Array(32).fill(4))
    expect(set).toHaveBeenCalledWith('altude-wallet-key', expect.any(String), {
      service: 'so.altude.wallet.key.https%3A%2F%2Fapi.altude.so.-17.42.wallet-user-1.address',
      accessible: 'device-only',
    })
    expect(await keys.read(scope, 'missing')).toBeNull()
    expect(() => createKeychainWalletKeyStore({ ...keychain, ACCESSIBLE: {} })).toThrow(
      'Device-only',
    )
  })
})
