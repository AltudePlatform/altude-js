import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  CreateAccountOptions,
  GaslessTransactionSigner,
  SendOptions,
} from '@altude/gasstation'
import { AltudeGasStation } from '@altude/gasstation'
import { createHash } from 'node:crypto'
import { ed25519 } from '@noble/curves/ed25519.js'
import { decodeBase58, encodeBase58 } from './crypto.js'
import { AltudeWallet, AltudeWalletError } from './index.js'
import type {
  ExternalWalletProvider,
  SessionTokenStore,
  WalletEvent,
  WalletStore,
  WalletStoreRecord,
  WalletTransactionIntent,
  WalletTransactionIntentSnapshot,
  PasskeyAdapter,
} from './types.js'

class TestWalletStore implements WalletStore {
  readonly records = new Map<string, WalletStoreRecord>()

  get(identityKey: string): Promise<WalletStoreRecord | undefined> {
    return Promise.resolve(this.records.get(identityKey))
  }

  getByServerUserId(userId: string): Promise<WalletStoreRecord | undefined> {
    return Promise.resolve(
      [...this.records.values()].find((record) => record.serverUserId === userId),
    )
  }

  createIfAbsent(
    record: WalletStoreRecord,
  ): Promise<{ record: WalletStoreRecord; created: boolean }> {
    const current = this.records.get(record.identityKey)
    if (current) return Promise.resolve({ record: current, created: false })
    const created = structuredClone(record)
    this.records.set(record.identityKey, created)
    return Promise.resolve({ record: created, created: true })
  }

  update(
    identityKey: string,
    update: (record: WalletStoreRecord | undefined) => WalletStoreRecord | undefined,
  ): Promise<WalletStoreRecord | undefined> {
    const record = update(this.records.get(identityKey))
    if (record) this.records.set(identityKey, structuredClone(record))
    else this.records.delete(identityKey)
    return Promise.resolve(record)
  }

  put(record: WalletStoreRecord): Promise<void> {
    this.records.set(record.identityKey, structuredClone(record))
    return Promise.resolve()
  }

  delete(identityKey: string): Promise<void> {
    this.records.delete(identityKey)
    return Promise.resolve()
  }
}

class TestSessionTokens implements SessionTokenStore {
  token: string | null = null

  get(): Promise<string | null> {
    return Promise.resolve(this.token)
  }

  set(token: string): Promise<void> {
    this.token = token
    return Promise.resolve()
  }

  clear(): Promise<void> {
    this.token = null
    return Promise.resolve()
  }
}

describe('AltudeWallet', () => {
  let store: TestWalletStore
  let sessionTokens: TestSessionTokens
  let fetchMock: ReturnType<typeof vi.fn>
  let gasStation: {
    send: ReturnType<typeof vi.fn>
    createAccount: ReturnType<typeof vi.fn>
    getConfig: ReturnType<typeof vi.fn>
    getBalance: ReturnType<typeof vi.fn>
    getHistory: ReturnType<typeof vi.fn>
  }

  beforeEach(() => {
    store = new TestWalletStore()
    sessionTokens = new TestSessionTokens()
    fetchMock = vi.fn()
    gasStation = {
      send: vi.fn().mockResolvedValue({ Signature: 'transaction-signature', Status: 'Success' }),
      createAccount: vi
        .fn()
        .mockResolvedValue({ Signature: 'account-signature', Status: 'Success' }),
      getConfig: vi.fn().mockResolvedValue({ walletUi: null, RpcEnvironment: 'devnet' }),
      getBalance: vi.fn().mockResolvedValue({ address: 'wallet', uiAmount: 2 }),
      getHistory: vi
        .fn()
        .mockResolvedValue({ data: [], page: 0, pageSize: 0, limit: 10, offset: 0, total: 0 }),
    }
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function createWallet(
    externalWallets: readonly ExternalWalletProvider[] = [],
    passkeys?: PasskeyAdapter,
    executor?: AltudeGasStation,
  ) {
    return new AltudeWallet({
      apiKey: 'test-api-key',
      apiBaseUrl: 'https://api.example.test',
      network: 'devnet',
      auth: {},
      externalWallets,
      ...(passkeys ? { passkeys } : {}),
      store,
      sessionTokenStore: sessionTokens,
      fetch: fetchMock as typeof fetch,
      gasStation: executor ?? (gasStation as unknown as AltudeGasStation),
    })
  }

  it('reads the optional wallet UI settings from transaction config', async () => {
    const walletUi = {
      branding: { appName: 'Example' },
      authMethods: { emailOtp: false, socialProviders: ['google'] },
    }
    gasStation.getConfig.mockResolvedValue({ walletUi, RpcEnvironment: 'devnet' })
    const wallet = createWallet()

    expect(wallet.network).toBe('devnet')
    await expect(wallet.getWalletUiConfiguration()).resolves.toEqual(walletUi)
    gasStation.getConfig.mockResolvedValue({ RpcEnvironment: 'devnet' })
    await expect(wallet.getWalletUiConfiguration()).resolves.toBeNull()
  })

  it('orders a successor broker login behind a cancelled committed creation and preserves the registered key', async () => {
    browserBackend()
    const creationCommitted = deferred<boolean>()
    const completeCreation = deferred<boolean>()
    const original = store.createIfAbsent.bind(store)
    vi.spyOn(store, 'createIfAbsent').mockImplementationOnce(async (record) => {
      const result = await original(record)
      creationCommitted.resolve(true)
      await completeCreation.promise
      return result
    })
    const wallet = createWallet()
    const older = wallet.connect(browserIdentity('older'))
    await creationCommitted.promise
    const newer = wallet.connect(browserIdentity('newer'))
    await vi.waitFor(() => {
      expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/wallet'))).toHaveLength(
        2,
      )
    })
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/api/browser-wallet/session')),
    ).toHaveLength(0)
    completeCreation.resolve(true)
    await older
    const state = await newer
    expect(state.status).toBe('connected')
    expect([...store.records.values()][0]?.publicKey).toBe(state.address)
    expect((await wallet.signMessage(new Uint8Array([5]))).length).toBe(64)
    expect((await createWallet().connect(browserIdentity('fresh'))).address).toBe(state.address)
  })

  it('does not lock a newer legacy connection awaiting a local read when an older exchange finishes', async () => {
    const olderResponse = deferred<Response>()
    fetchMock.mockReturnValueOnce(olderResponse.promise)
    const wallet = createWallet()
    const older = wallet.connect({ identityKey: 'legacy|race', accessToken: 'older' })
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledOnce()
    })
    const readStarted = deferred<boolean>()
    const finishRead = deferred<boolean>()
    const original = store.get.bind(store)
    vi.spyOn(store, 'get').mockImplementationOnce(async (key) => {
      readStarted.resolve(true)
      await finishRead.promise
      return original(key)
    })
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ Success: true, SessionToken: 'newer', User: { Id: 'owner' } }),
    )
    const newer = wallet.connect({ identityKey: 'legacy|race', accessToken: 'newer' })
    await readStarted.promise
    olderResponse.resolve(
      jsonResponse({ Success: true, SessionToken: 'older', User: { Id: 'owner' } }),
    )
    await older
    finishRead.resolve(true)
    expect(await newer).toMatchObject({ status: 'connected' })
    expect(sessionTokens.token).toBe('newer')
  })

  async function connectedWallet() {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        jsonResponse({ Success: true, SessionToken: 'session', User: { Id: 'user' } }),
      ),
    )
    const wallet = createWallet()
    await wallet.connect({ identityKey: 'legacy|operations', accessToken: 'access' })
    return wallet
  }

  it('rejects constructor/approved network mismatches before confirmation or submission', async () => {
    const wallet = await connectedWallet()
    const events: WalletEvent[] = []
    wallet.onEvent((event) => events.push(event))
    gasStation.getConfig.mockResolvedValue({ RpcEnvironment: 'mainnet-beta' })
    await expect(
      wallet.requestTransaction({
        kind: 'sol-transfer',
        recipient: '11111111111111111111111111111111',
        amount: 1,
        network: 'devnet',
      }),
    ).rejects.toThrow('authoritative RPC')
    expect(events).toHaveLength(0)
    expect(gasStation.send).not.toHaveBeenCalled()
  })

  it('rejects a network switch between confirmation and signing', async () => {
    const wallet = await connectedWallet()
    let id = ''
    wallet.onEvent((event) => {
      if (event.type === 'transaction:confirmation') id = event.id
    })
    const requested = wallet.requestTransaction({
      kind: 'sol-transfer',
      recipient: '11111111111111111111111111111111',
      amount: 1,
    })
    const rejected = expect(requested).rejects.toThrow('authoritative RPC')
    await vi.waitFor(() => {
      expect(id).not.toBe('')
    })
    gasStation.getConfig.mockResolvedValue({ RpcEnvironment: 'mainnet-beta' })
    await expect(wallet.approveTransaction(id)).rejects.toThrow('authoritative RPC')
    await rejected
    expect(gasStation.send).not.toHaveBeenCalled()
  })

  it('discards signatures when executor preparation changes the approved network', async () => {
    const wallet = await connectedWallet()
    let id = ''
    wallet.onEvent((event) => {
      if (event.type === 'transaction:confirmation') id = event.id
    })
    const relayed = vi.fn()
    gasStation.send.mockImplementation(async ({ sourceSigner }: SendOptions) => {
      gasStation.getConfig.mockResolvedValue({ RpcEnvironment: 'mainnet-beta' })
      await sourceSigner?.signTransactionMessage?.(new Uint8Array([1]))
      relayed()
      return { Signature: 'must-not-relay' }
    })
    const requested = wallet.requestTransaction({
      kind: 'sol-transfer',
      recipient: '11111111111111111111111111111111',
      amount: 1,
    })
    const rejected = expect(requested).rejects.toThrow('authoritative RPC')
    await vi.waitFor(() => {
      expect(id).not.toBe('')
    })
    await expect(wallet.approveTransaction(id)).rejects.toThrow('authoritative RPC')
    await rejected
    expect(relayed).not.toHaveBeenCalled()
  })

  it('requires explicit provisioning approval and snapshots the token selection', async () => {
    const wallet = await connectedWallet()
    let id = ''
    let tokens: readonly string[] | undefined
    wallet.onEvent((event) => {
      if (event.type === 'provisioning:confirmation') {
        id = event.id
        tokens = event.tokens
      }
    })
    const selection = ['So11111111111111111111111111111111111111112']
    const requested = wallet.createAccount(selection)
    selection[0] = '11111111111111111111111111111111'
    await vi.waitFor(() => {
      expect(id).not.toBe('')
    })
    expect(gasStation.createAccount).not.toHaveBeenCalled()
    expect(tokens).toEqual(['So11111111111111111111111111111111111111112'])
    expect(Object.isFrozen(tokens)).toBe(true)
    const result = await wallet.approveProvisioning(id)
    expect(await requested).toEqual(result)
    expect(gasStation.createAccount).toHaveBeenCalledWith(
      expect.objectContaining({ expectedNetwork: 'devnet', tokens }),
    )
  })

  it('cancels provisioning before relay on sign-out and supports SPL balance selection', async () => {
    const wallet = await connectedWallet()
    let id = ''
    wallet.onEvent((event) => {
      if (event.type === 'provisioning:confirmation') id = event.id
    })

    const requested = wallet.createAccount()
    const rejected = expect(requested).rejects.toMatchObject({ code: 'SESSION' })
    await vi.waitFor(() => {
      expect(id).not.toBe('')
    })
    await wallet.getBalance('So11111111111111111111111111111111111111112')
    expect(gasStation.getBalance).toHaveBeenCalledWith({
      address: wallet.address,
      token: 'So11111111111111111111111111111111111111112',
    })
    await wallet.signOut()
    await rejected
    await expect(wallet.approveProvisioning(id)).rejects.toMatchObject({ code: 'TRANSACTION' })
    expect(gasStation.createAccount).not.toHaveBeenCalled()
  })

  it('uses the authoritative network when the constructor has no network constraint', async () => {
    const wallet = new AltudeWallet({
      apiKey: 'key',
      apiBaseUrl: 'https://api.example.test',
      auth: {},
      store,
      gasStation: gasStation as unknown as AltudeGasStation,
    })
    expect(await wallet.getWalletUiConfiguration()).toBeNull()
    expect(wallet.network).toBe('devnet')
  })

  it.each([
    { Status: 'Success', Signature: '', Message: 'Account already exists', succeeds: true },
    { Status: 'Failed', Signature: '', Message: 'Relay rejected provisioning', succeeds: false },
  ])('handles provisioning result $Status: $Message', async ({ succeeds, ...response }) => {
    const wallet = await connectedWallet()
    let id = ''
    wallet.onEvent((event) => {
      if (event.type === 'provisioning:confirmation') id = event.id
    })
    gasStation.createAccount.mockResolvedValue(response)
    const requested = wallet.createAccount()
    const outcomes = Promise.allSettled([requested])
    await vi.waitFor(() => {
      expect(id).not.toBe('')
    })
    const approval = wallet.approveProvisioning(id)
    if (succeeds) {
      expect(await approval).toEqual(response)
      expect(await requested).toEqual(response)
    } else {
      await expect(approval).rejects.toMatchObject({ code: 'TRANSACTION' })
      expect(await outcomes).toMatchObject([
        { status: 'rejected', reason: { code: 'TRANSACTION' } },
      ])
    }
  })

  it('claims provisioning once and prevents signing after cancellation during preparation', async () => {
    const wallet = await connectedWallet()
    let id = ''
    wallet.onEvent((event) => {
      if (event.type === 'provisioning:confirmation') id = event.id
    })
    const prepared = deferred<boolean>()
    const release = deferred<boolean>()
    const relayed = vi.fn()
    gasStation.createAccount.mockImplementation(async (options: CreateAccountOptions) => {
      prepared.resolve(true)
      await release.promise
      await options.signer?.signTransactionMessage?.(new Uint8Array([5]))
      relayed()
      return { Status: 'Success', Signature: 'unexpected', Message: '' }
    })
    const requested = wallet.createAccount()
    const requestOutcome = Promise.allSettled([requested])
    await vi.waitFor(() => {
      expect(id).not.toBe('')
    })
    const approved = wallet.approveProvisioning(id)
    const approvalOutcome = Promise.allSettled([approved])
    await prepared.promise
    await expect(wallet.approveProvisioning(id)).rejects.toMatchObject({ code: 'TRANSACTION' })
    wallet.rejectProvisioning(id)
    release.resolve(true)
    expect(await requestOutcome).toMatchObject([{ status: 'rejected' }])
    expect(await approvalOutcome).toMatchObject([
      { status: 'rejected', reason: { code: 'TRANSACTION' } },
    ])
    expect(relayed).not.toHaveBeenCalled()
    expect(gasStation.createAccount).toHaveBeenCalledOnce()
  })
  it('aborts provisioning preparation without emitting an orphaned confirmation', async () => {
    const wallet = await connectedWallet()
    const config = deferred<{ RpcEnvironment: string }>()
    const started = deferred<boolean>()
    gasStation.getConfig.mockImplementationOnce(() => {
      started.resolve(true)
      return config.promise
    })
    const controller = new AbortController()
    const confirmation = vi.fn()
    wallet.onEvent((event) => {
      if (event.type === 'provisioning:confirmation') confirmation()
    })
    const requested = wallet.createAccount([], controller.signal)
    const rejected = expect(requested).rejects.toMatchObject({ code: 'TRANSACTION' })
    await started.promise
    controller.abort()
    config.resolve({ RpcEnvironment: 'devnet' })
    await rejected
    expect(confirmation).not.toHaveBeenCalled()
    expect(gasStation.createAccount).not.toHaveBeenCalled()
  })

  it('creates and reopens a local PRF wallet for signing without API authentication or relay', async () => {
    vi.stubGlobal('location', { hostname: 'consumer.example.test' })
    const passkeys: PasskeyAdapter = {
      isAvailable: () => true,
      register: () =>
        Promise.resolve({ credentialId: new Uint8Array([1]), kek: new Uint8Array(32).fill(5) }),
      deriveKey: () => Promise.resolve(new Uint8Array(32).fill(5)),
    }
    const wallet = createWallet([], passkeys)
    const state = await wallet.createLocalWallet()
    expect(state).toMatchObject({ custody: 'local', session: null, protection: 'passkey' })
    if (!state.localIdentityKey || !state.address) throw new Error('Expected local handle/address')
    const bytes = new Uint8Array([1, 2, 3])
    expect(
      ed25519.verify(await wallet.signMessage(bytes), bytes, decodeBase58(state.address)),
    ).toBe(true)
    wallet.lock()
    await expect(wallet.signMessage(bytes)).rejects.toMatchObject({ code: 'WALLET_LOCKED' })
    await wallet.signOut()
    const reopened = await createWallet([], passkeys).openLocalWallet(state.localIdentityKey)
    expect(reopened).toMatchObject({ address: state.address, custody: 'local', session: null })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(gasStation.send).not.toHaveBeenCalled()
    expect([...store.records.values()][0]?.secret).toBeUndefined()
  })

  function browserIdentity(ticket = 'ticket', appId = '-17.42') {
    return {
      identityKey: 'auth0|broker-user',
      broker: { identityTicket: ticket, appId, walletAccessVersion: 1 as const },
    }
  }

  function browserBackend() {
    const backend = {
      appId: '-17.42',
      userId: 'broker-user',
      address: null as string | null,
      message: '',
      sessionStatus: 200,
      sessionError: 'wallet_conflict',
      sessionUserId: 'broker-user',
      sessionAppId: '-17.42',
      version: 1,
      mutateMessage: (message: string) => message,
    }
    fetchMock.mockImplementation(async (url: string, request: RequestInit) => {
      await Promise.resolve()
      expect(new Headers(request.headers).get('X-API-Key')).toBe('test-api-key')
      if (url.endsWith('/config'))
        return jsonResponse({ AppId: backend.appId, WalletAccessVersion: backend.version })
      if (url.endsWith('/wallet')) {
        const body = JSON.parse(typeof request.body === 'string' ? request.body : '') as {
          IdentityTicket: string
        }
        backend.message = backend.mutateMessage(
          [
            'Altude Wallet Access Binding v1',
            'Issuer: https://api.example.test',
            `AppId: ${backend.appId}`,
            'TenantId: -17',
            `UserId: ${backend.userId}`,
            'IdentityKey: auth0|broker-user',
            'RefreshFamilyId: browser',
            'Origin: https://consumer.example.test',
            `IdentityTicket: ${createHash('sha256').update(body.IdentityTicket).digest('base64url')}`,
            'ChallengeId: challenge-id',
            `WalletAddress: ${backend.address ?? ''}`,
            'Nonce: random',
          ].join('\n'),
        )
        return jsonResponse({
          AppId: backend.appId,
          UserId: backend.userId,
          IdentityKey: 'auth0|broker-user',
          WalletAddress: backend.address,
          ChallengeId: 'challenge-id',
          Message: backend.message,
          ExpiresIn: 60,
        })
      }
      if (url.endsWith('/api/EmbeddedWallet/session')) {
        return jsonResponse({
          IsAuthenticated: true,
          AppId: backend.appId,
          UserId: backend.userId,
          User: { Id: backend.userId, WalletAddress: backend.address },
        })
      }
      if (url.endsWith('/signout')) return jsonResponse({ Success: true })
      if (!url.endsWith('/api/browser-wallet/session')) throw new Error(`Unexpected URL ${url}`)
      const body = JSON.parse(typeof request.body === 'string' ? request.body : '') as {
        WalletAddress: string
        Signature: string
        ChallengeId: string
      }
      expect(body.ChallengeId).toBe('challenge-id')
      const signature = Buffer.from(body.Signature, 'base64')
      expect(signature).toHaveLength(64)
      expect(body.Signature).toMatch(/^[A-Za-z0-9+/]{86}==$/)
      expect(
        ed25519.verify(
          signature,
          new TextEncoder().encode(backend.message),
          decodeBase58(body.WalletAddress),
        ),
      ).toBe(true)
      if (backend.sessionStatus !== 200) {
        return new Response(
          JSON.stringify({
            Error: backend.sessionError,
            AppId: backend.appId,
            UserId: backend.userId,
            WalletAddress: backend.address,
          }),
          { status: backend.sessionStatus, headers: { 'Content-Type': 'application/json' } },
        )
      }
      backend.address = body.WalletAddress
      return jsonResponse({
        Success: true,
        SessionToken: 'broker-session',
        AppId: backend.sessionAppId,
        UserId: backend.sessionUserId,
        User: { Id: backend.sessionUserId, WalletAddress: body.WalletAddress },
      })
    })
    return backend
  }

  it('looks up the authoritative wallet before creating a key and signs the exact challenge', async () => {
    browserBackend()
    const wallet = createWallet()
    const first = await wallet.connect(browserIdentity('ticket-1'))
    expect(first.status).toBe('connected')
    expect(sessionTokens.token).toBe('broker-session')
    const second = await wallet.connect(browserIdentity('ticket-2'))
    expect(second.address).toBe(first.address)
    expect(store.records.size).toBe(1)
    expect([...store.records.values()][0]?.serverUserId).toBe('broker-user')
    expect(store.records.has('auth0|broker-user')).toBe(false)
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://api.example.test/api/browser-wallet/wallet',
      expect.objectContaining({
        body: JSON.stringify({ IdentityTicket: 'ticket-1' }),
        credentials: 'omit',
        redirect: 'error',
      }),
    )
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit
    expect(new Headers(request.headers).get('X-API-Key')).toBe('test-api-key')
    expect(new Headers(request.headers).has('Authorization')).toBe(false)
  })

  it('rejects a broker session with a different application or user', async () => {
    const backend = browserBackend()
    backend.sessionAppId = 'different-app'
    const wallet = createWallet()
    await expect(wallet.connect(browserIdentity())).rejects.toThrow('does not match')
    expect(sessionTokens.token).toBeNull()
    expect(wallet.state.status).toBe('disconnected')
  })

  it('never creates a replacement key when the canonical wallet is on another device', async () => {
    const backend = browserBackend()
    backend.address = encodeBase58(ed25519.getPublicKey(new Uint8Array(32).fill(7)))
    await expect(createWallet().connect(browserIdentity())).rejects.toMatchObject({
      code: 'RECOVERY_REQUIRED',
    })
    expect(store.records.size).toBe(0)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('isolates the same provider identity and user across applications', async () => {
    const backend = browserBackend()
    const first = await createWallet().connect(browserIdentity('ticket-1'))
    backend.appId = 'other-app'
    backend.sessionAppId = 'other-app'
    backend.address = null
    const second = await createWallet().connect(browserIdentity('ticket-2', 'other-app'))
    expect(second.address).not.toBe(first.address)
    expect(store.records.size).toBe(2)
  })

  it('rejects unavailable proof versions before looking up or creating a wallet', async () => {
    const backend = browserBackend()
    backend.version = 2
    await expect(createWallet().connect(browserIdentity())).rejects.toMatchObject({
      code: 'CONFIGURATION',
    })
    expect(store.records.size).toBe(0)
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it.each([
    (message: string) => message.replace('Binding v1', 'Binding v2'),
    (message: string) => message.replace('IdentityKey: auth0|broker-user', 'IdentityKey: attacker'),
    (message: string) => message.replace('RefreshFamilyId: browser', 'RefreshFamilyId: native'),
    (message: string) => message.replace('ChallengeId: challenge-id', 'ChallengeId: attacker'),
    (message: string) => message.replace('IdentityTicket: ', 'IdentityTicket: wrong'),
    (message: string) => `${message}\n`,
  ])('rejects a mismatched proof message before local key generation %#', async (mutate) => {
    const backend = browserBackend()
    backend.mutateMessage = mutate
    await expect(createWallet().connect(browserIdentity())).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    })
    expect(store.records.size).toBe(0)
  })

  it('requires recovery after a canonical conflict and never resubmits the consumed ticket', async () => {
    const backend = browserBackend()
    backend.sessionStatus = 409
    const implementation = fetchMock.getMockImplementation() as (
      url: string,
      request: RequestInit,
    ) => Promise<Response>
    fetchMock.mockImplementation(async (url: string, request: RequestInit) => {
      if (url.endsWith('/api/browser-wallet/session')) {
        backend.address = encodeBase58(ed25519.getPublicKey(new Uint8Array(32).fill(8)))
      }
      return await implementation(url, request)
    })
    await expect(createWallet().connect(browserIdentity())).rejects.toMatchObject({
      code: 'RECOVERY_REQUIRED',
    })
    expect(store.records.size).toBe(1)
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/api/browser-wallet/session')),
    ).toHaveLength(1)
    expect(sessionTokens.token).toBeNull()
  })

  it('restores a broker session by application and canonical user, not the legacy user index', async () => {
    browserBackend()
    const wallet = createWallet()
    const first = await wallet.connect(browserIdentity())
    const restored = await createWallet().restoreSession()
    expect(restored.address).toBe(first.address)
    store.records.clear()
    await expect(createWallet().restoreSession()).rejects.toMatchObject({
      code: 'RECOVERY_REQUIRED',
    })
    expect(store.records.size).toBe(0)
  })

  it.each(['broker', 'legacy'] as const)(
    'keeps a pending %s restore unlocked when an older connection finishes',
    async (mode) => {
      if (mode === 'broker') browserBackend()
      else
        fetchMock.mockImplementation((_url: string, request: RequestInit) => {
          const body = parseBody(request.body)
          return Promise.resolve(
            jsonResponse({
              success: true,
              sessionToken: 'retained-session',
              user: { id: 'legacy-user', walletAddress: body.walletAddress },
            }),
          )
        })
      const wallet = createWallet()
      const identity =
        mode === 'broker'
          ? browserIdentity()
          : { accessToken: 'provider-token', identityKey: 'auth0|restore-owner' }
      const first = await wallet.connect(identity)
      wallet.lock()
      const record = [...store.records.values()][0]
      if (!record) throw new Error('Expected persisted key')
      const implementation = fetchMock.getMockImplementation() as
        | ((url: string, request: RequestInit) => Promise<Response>)
        | undefined
      if (!implementation) throw new Error('Expected synthetic API')
      const exchangeEntered = deferred<boolean>()
      const exchange = deferred<Response>()
      fetchMock.mockImplementation((url: string, request: RequestInit) => {
        if (url.endsWith('/api/browser-wallet/session') || url.endsWith('/auth0')) {
          exchangeEntered.resolve(true)
          return exchange.promise
        }
        if (mode === 'legacy' && url.endsWith('/session'))
          return Promise.resolve(
            jsonResponse({
              isAuthenticated: true,
              user: { id: 'legacy-user', walletAddress: first.address },
            }),
          )
        return implementation(url, request)
      })
      const connecting = wallet.connect(
        mode === 'broker' ? browserIdentity('second-ticket') : identity,
      )
      await exchangeEntered.promise
      const readEntered = deferred<boolean>()
      const read = deferred<WalletStoreRecord | undefined>()
      const get = store.get.bind(store)
      store.get = vi
        .fn()
        .mockImplementationOnce(() => {
          readEntered.resolve(true)
          return read.promise
        })
        .mockImplementation(get)
      const restoring = wallet.restoreSession()
      await readEntered.promise
      exchange.resolve(
        jsonResponse({
          Success: true,
          SessionToken: 'superseded-session',
          ...(mode === 'broker' ? { AppId: '-17.42', UserId: 'broker-user' } : {}),
          User: {
            Id: mode === 'broker' ? 'broker-user' : 'legacy-user',
            WalletAddress: first.address,
          },
        }),
      )
      await connecting
      read.resolve(record)
      expect(await restoring).toMatchObject({ status: 'connected', address: first.address })
      await expect(wallet.signMessage(new Uint8Array([1, 2, 3]))).resolves.toHaveLength(64)
    },
  )

  it('does not generate a key for an authoritative lookup completing after sign-out', async () => {
    browserBackend()
    const lookup = deferred<Response>()
    const implementation = fetchMock.getMockImplementation() as (
      url: string,
      request: RequestInit,
    ) => Promise<Response>
    fetchMock.mockImplementation((url: string, request: RequestInit) =>
      url.endsWith('/wallet') ? lookup.promise : implementation(url, request),
    )
    const wallet = createWallet()
    const connecting = wallet.connect(browserIdentity())
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })
    await wallet.signOut()
    lookup.resolve(jsonResponse({}))
    expect(await connecting).toMatchObject({ status: 'disconnected' })
    expect(store.records.size).toBe(0)
    expect(sessionTokens.token).toBeNull()
  })

  it('keeps same-address conflicts explicit and blocks reuse of submitted tickets', async () => {
    const backend = browserBackend()
    backend.sessionStatus = 409
    const implementation = fetchMock.getMockImplementation() as (
      url: string,
      request: RequestInit,
    ) => Promise<Response>
    fetchMock.mockImplementation((url: string, request: RequestInit) => {
      if (url.endsWith('/api/browser-wallet/session')) {
        const body = JSON.parse(typeof request.body === 'string' ? request.body : '') as {
          WalletAddress: string
        }
        backend.address = body.WalletAddress
      }
      return implementation(url, request)
    })
    const wallet = createWallet()
    await expect(wallet.connect(browserIdentity())).rejects.toMatchObject({
      code: 'WALLET_CONFLICT',
    })
    const count = fetchMock.mock.calls.length
    await expect(wallet.connect(browserIdentity())).rejects.toThrow('already submitted')
    expect(fetchMock).toHaveBeenCalledTimes(count)
    expect(sessionTokens.token).toBeNull()
  })

  it('blocks legacy scope migration before generating a wallet', async () => {
    browserBackend()
    fetchMock.mockResolvedValueOnce(jsonResponse({ AppId: '-17.42', WalletAccessVersion: 1 }))
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ Error: 'wallet_scope_migration_required' }), { status: 409 }),
    )
    await expect(createWallet().connect(browserIdentity())).rejects.toMatchObject({
      code: 'WALLET_SCOPE_MIGRATION_REQUIRED',
    })
    expect(store.records.size).toBe(0)
  })

  it('reuses interrupted setup after a rejected proof with fresh authentication, without another key', async () => {
    const backend = browserBackend()
    backend.sessionStatus = 400
    backend.sessionError = 'invalid_proof'
    const wallet = createWallet()
    await expect(wallet.connect(browserIdentity('ticket-1'))).rejects.toThrow('Restart sign-in')
    const address = [...store.records.values()][0]?.publicKey
    expect(sessionTokens.token).toBeNull()
    backend.sessionStatus = 200
    const state = await wallet.connect(browserIdentity('ticket-2'))
    expect(state.address).toBe(address)
    expect(store.records.size).toBe(1)
  })

  it('unlocks protected local keys before signing the broker proof and cancels late passkey completion', async () => {
    vi.stubGlobal('location', {
      hostname: 'consumer.example.test',
      origin: 'https://consumer.example.test',
    })
    browserBackend()
    const key = () => new Uint8Array(32).fill(9)
    const deriveKey = vi.fn().mockImplementation(() => Promise.resolve(key()))
    const passkeys: PasskeyAdapter = {
      register: () => Promise.resolve({ credentialId: new Uint8Array([1, 2, 3]), kek: key() }),
      deriveKey,
    }
    const first = createWallet([], passkeys)
    const initial = await first.connect(browserIdentity('ticket-1'))
    await first.protectWithPasskey()
    const second = createWallet([], passkeys)
    expect((await second.connect(browserIdentity('ticket-2'))).address).toBe(initial.address)
    expect(deriveKey).toHaveBeenCalledOnce()

    const pendingKey = deferred<Uint8Array>()
    deriveKey.mockImplementationOnce(() => pendingKey.promise)
    const third = createWallet([], passkeys)
    const connecting = third.connect(browserIdentity('ticket-3'))
    await vi.waitFor(() => {
      expect(deriveKey).toHaveBeenCalledTimes(2)
    })
    await third.signOut()
    pendingKey.resolve(key())
    expect(await connecting).toMatchObject({ status: 'disconnected' })
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/api/browser-wallet/session')),
    ).toHaveLength(2)
  })

  it('does not let a superseded passkey unlock lock a newer login for the same scoped wallet', async () => {
    vi.stubGlobal('location', {
      hostname: 'consumer.example.test',
      origin: 'https://consumer.example.test',
    })
    browserBackend()
    const key = () => new Uint8Array(32).fill(9)
    const olderKey = deferred<Uint8Array>()
    const newerKey = deferred<Uint8Array>()
    const deriveKey = vi
      .fn()
      .mockImplementationOnce(() => olderKey.promise)
      .mockImplementationOnce(() => newerKey.promise)
    const passkeys: PasskeyAdapter = {
      register: () => Promise.resolve({ credentialId: new Uint8Array([1]), kek: key() }),
      deriveKey,
    }
    const wallet = createWallet([], passkeys)
    await wallet.connect(browserIdentity('ticket-1'))
    await wallet.protectWithPasskey()
    const older = wallet.connect(browserIdentity('ticket-2'))
    await vi.waitFor(() => {
      expect(deriveKey).toHaveBeenCalledOnce()
    })
    const newer = wallet.connect(browserIdentity('ticket-3'))
    await vi.waitFor(() => {
      expect(deriveKey).toHaveBeenCalledTimes(2)
    })
    olderKey.resolve(key())
    await older
    newerKey.resolve(key())
    expect(await newer).toMatchObject({ status: 'connected', protection: 'passkey' })
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/api/browser-wallet/session')),
    ).toHaveLength(2)
  })

  it('requires recovery for a canonical wallet with corrupt local signing material', async () => {
    browserBackend()
    await createWallet().connect(browserIdentity('ticket-1'))
    const record = [...store.records.values()][0]
    if (!record) throw new Error('Expected registered local wallet')
    record.secret = new Uint8Array(32).fill(4)
    await expect(createWallet().connect(browserIdentity('ticket-2'))).rejects.toMatchObject({
      code: 'RECOVERY_REQUIRED',
    })
    expect(store.records.size).toBe(1)
  })

  it('does not activate a scoped session that arrives after sign-out', async () => {
    browserBackend()
    const pending = deferred<Response>()
    const implementation = fetchMock.getMockImplementation() as (
      url: string,
      request: RequestInit,
    ) => Promise<Response>
    let original: Response | undefined
    fetchMock.mockImplementation(async (url: string, request: RequestInit) => {
      const response = await implementation(url, request)
      if (url.endsWith('/api/browser-wallet/session')) {
        original = response
        return pending.promise
      }
      return response
    })
    const wallet = createWallet()
    const connecting = wallet.connect(browserIdentity())
    await vi.waitFor(() => {
      expect(original).toBeDefined()
    })
    await wallet.signOut()
    if (!original) throw new Error('Expected scoped session response')
    pending.resolve(original)
    expect(await connecting).toMatchObject({ status: 'disconnected' })
    expect(sessionTokens.token).toBeNull()
  })

  it('prevents direct adapters from selecting broker-scoped local records', async () => {
    browserBackend()
    await createWallet().connect(browserIdentity())
    const identityKey = [...store.records.keys()][0]
    if (!identityKey) throw new Error('Expected scoped identity')
    await expect(
      createWallet().connect({ identityKey, accessToken: 'legacy' }),
    ).rejects.toMatchObject({ code: 'AUTHENTICATION' })
  })

  it('routes hosted OTP through the auth provider and exchanges its token with the API', async () => {
    const signInWithOtp = vi.fn().mockResolvedValue({
      accessToken: 'auth0-api-token',
      identityKey: 'auth0|email-user',
    })
    let exchangedAccessToken: string | undefined
    fetchMock.mockImplementation((_url: string, request: RequestInit) => {
      exchangedAccessToken = parseBody(request.body).accessToken
      return Promise.resolve(
        jsonResponse({
          success: true,
          sessionToken: 'wallet-session-token',
          user: { id: 'wallet-user' },
        }),
      )
    })
    const wallet = new AltudeWallet({
      apiKey: 'test-api-key',
      apiBaseUrl: 'https://api.example.test',
      auth: {
        signInWithOtp,
        supportsOtpChannel: (channel) => channel === 'email',
      },
      store,
      sessionTokenStore: sessionTokens,
      fetch: fetchMock as typeof fetch,
      gasStation: gasStation as unknown as AltudeGasStation,
    })

    expect(wallet.canStartOtp).toBe(true)
    expect(wallet.usesHostedOtp).toBe(true)
    expect(wallet.canSignInWithOtp('email')).toBe(true)
    expect(wallet.canSignInWithOtp('sms')).toBe(false)
    const state = await wallet.signInWithOtp('email', ' user@example.test ')

    expect(signInWithOtp).toHaveBeenCalledWith('email', 'user@example.test')
    expect(exchangedAccessToken).toBe('auth0-api-token')
    expect(state.status).toBe('connected')
    expect(sessionTokens.token).toBe('wallet-session-token')
  })

  it('does not connect a provider result that resolves after sign-out', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        sessionToken: 'existing-session',
        user: { id: 'existing-user' },
      }),
    )
    const providerResult = deferred<{ accessToken: string; identityKey: string }>()
    const wallet = new AltudeWallet({
      apiKey: 'test-api-key',
      apiBaseUrl: 'https://api.example.test',
      auth: { signInWithSocial: () => providerResult.promise },
      store,
      sessionTokenStore: sessionTokens,
      fetch: fetchMock as typeof fetch,
      gasStation: gasStation as unknown as AltudeGasStation,
    })
    await wallet.connect({ accessToken: 'existing-token', identityKey: 'auth0|existing-user' })
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true }))

    const signIn = wallet.signInWithSocial('google')
    await wallet.signOut()
    providerResult.resolve({
      accessToken: 'stale-token',
      identityKey: 'auth0|stale-user',
    })

    expect(await signIn).toMatchObject({ status: 'disconnected' })
    expect(wallet.state.status).toBe('disconnected')
    expect(sessionTokens.token).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('lets a newer login supersede an older pending provider result', async () => {
    const olderProviderResult = deferred<{ accessToken: string; identityKey: string }>()
    const wallet = new AltudeWallet({
      apiKey: 'test-api-key',
      apiBaseUrl: 'https://api.example.test',
      auth: {
        signInWithSocial: () => olderProviderResult.promise,
        signInWithPasskey: () =>
          Promise.resolve({
            accessToken: 'new-token',
            identityKey: 'auth0|new-user',
          }),
      },
      store,
      sessionTokenStore: sessionTokens,
      fetch: fetchMock as typeof fetch,
      gasStation: gasStation as unknown as AltudeGasStation,
    })
    fetchMock.mockImplementation((_url: string, request: RequestInit) => {
      const body = parseBody(request.body)
      return Promise.resolve(
        jsonResponse({
          success: true,
          sessionToken: 'new-session',
          user: { id: 'new-user', walletAddress: body.walletAddress },
        }),
      )
    })
    const olderSignIn = wallet.signInWithSocial('google')
    const newerState = await wallet.signInWithPasskey()
    olderProviderResult.resolve({
      accessToken: 'old-token',
      identityKey: 'auth0|old-user',
    })

    expect(await olderSignIn).toEqual(newerState)
    expect(wallet.state).toMatchObject({
      status: 'connected',
      session: { user: { id: 'new-user' } },
    })
    expect(sessionTokens.token).toBe('new-session')
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('exchanges provider tokens for validated API sessions and isolates local identities', async () => {
    fetchMock.mockImplementation((_url: string, request: RequestInit) => {
      expect(new Headers(request.headers).get('X-API-Key')).toBe('test-api-key')
      const body = parseBody(request.body)
      expect(body.accessToken).toBe('provider-access-token')
      return Promise.resolve(
        jsonResponse({
          Success: true,
          SessionToken: 'server-session-token',
          User: { Id: 'server-user-1', WalletAddress: body.walletAddress },
        }),
      )
    })
    const wallet = createWallet()
    const progressStages: string[] = []
    wallet.onEvent((event: WalletEvent) => {
      if (event.type === 'setup:progress') progressStages.push(event.stage)
    })

    const first = await wallet.connect({
      accessToken: 'provider-access-token',
      identityKey: 'auth0|first-user',
    })
    const firstAddress = first.address
    const second = await wallet.connect({
      accessToken: 'provider-access-token',
      identityKey: 'auth0|second-user',
    })

    expect(first.status).toBe('connected')
    expect(second.address).not.toBe(firstAddress)
    expect(sessionTokens.token).toBe('server-session-token')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(progressStages).toEqual([
      'securing-device',
      'connecting-account',
      'finishing',
      'securing-device',
      'connecting-account',
      'finishing',
    ])
  })

  it('restores only a server-authenticated session and unlocks the matching local wallet', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          sessionToken: 'session-token',
          user: { id: 'server-user-2' },
        }),
      )
      .mockImplementationOnce((_url: string, request: RequestInit) => {
        expect(new Headers(request.headers).get('Authorization')).toBe('Bearer session-token')
        return Promise.resolve(
          jsonResponse({
            isAuthenticated: true,
            user: { id: 'server-user-2', walletAddress: [...store.records.values()][0]?.publicKey },
            expiresAt: '2030-01-01T00:00:00Z',
          }),
        )
      })
    const wallet = createWallet()
    await wallet.connect({ accessToken: 'provider-token', identityKey: 'auth0|restore-user' })
    wallet.lock()
    expect(wallet.state.status).toBe('locked')

    const restored = await wallet.restoreSession()
    expect(restored.status).toBe('connected')
    expect(restored.session?.user.id).toBe('server-user-2')
  })

  it('rejects connecting an existing local wallet to a different server user', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          sessionToken: 'user-a-session',
          user: { id: 'server-user-a' },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          sessionToken: 'user-b-session',
          user: { id: 'server-user-b' },
        }),
      )
    const wallet = createWallet()
    const identityKey = 'auth0|shared-identity'
    await wallet.connect({ accessToken: 'user-a-token', identityKey })
    const address = wallet.address

    await expect(
      wallet.connect({ accessToken: 'user-b-token', identityKey }),
    ).rejects.toMatchObject({
      code: 'SESSION',
      message: 'This local wallet is already associated with a different server account.',
    })

    expect(store.records.get(identityKey)?.serverUserId).toBe('server-user-a')
    expect(wallet.address).toBe(address)
    expect(sessionTokens.token).toBe('user-a-session')
  })

  it('refuses malformed identity results and non-HTTPS API origins', async () => {
    const wallet = createWallet()
    await expect(wallet.connect({ accessToken: '', identityKey: 'subject' })).rejects.toMatchObject(
      {
        code: 'AUTHENTICATION',
      },
    )
    expect(fetchMock).not.toHaveBeenCalled()

    expect(
      () =>
        new AltudeWallet({
          apiKey: 'key',
          apiBaseUrl: 'http://api.example.test',
          auth: {},
        }),
    ).toThrow(AltudeWalletError)
  })

  it('connects an external Solana wallet without creating an API session or local key', async () => {
    const signer = {
      address: '11111111111111111111111111111111',
      sign: vi.fn(),
    }
    const provider: ExternalWalletProvider = {
      id: 'phantom',
      label: 'Phantom',
      isAvailable: () => true,
      connect: vi.fn().mockResolvedValue({
        address: signer.address,
        chain: 'solana',
        signer,
      }),
      disconnect: vi.fn(),
    }
    const wallet = createWallet([provider])

    const state = await wallet.connectExternalWallet('phantom')

    expect(state).toMatchObject({
      status: 'connected',
      session: null,
      address: signer.address,
      protection: null,
      custody: 'external',
      externalProviderId: 'phantom',
      externalChain: 'solana',
    })
    expect(wallet.externalWalletProviders).toHaveLength(1)
    expect(wallet.externalWalletProviders[0]).toMatchObject({ id: 'phantom', label: 'Phantom' })
    expect(wallet.externalWalletProviders[0]?.isAvailable?.()).toBe(true)
    expect(store.records.size).toBe(0)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects an overlapping connection to the same provider until it finishes', async () => {
    const olderConnection = deferred<{
      address: string
      chain: 'solana'
    }>()
    const address = '11111111111111111111111111111111'
    const disconnect = vi.fn()
    const connect = vi.fn(() => olderConnection.promise)
    const provider: ExternalWalletProvider = {
      id: 'phantom',
      label: 'Phantom',
      connect,
      disconnect,
    }
    const wallet = createWallet([provider])

    const olderAttempt = wallet.connectExternalWallet('phantom')
    await vi.waitFor(() => {
      expect(connect).toHaveBeenCalledOnce()
    })
    await expect(wallet.connectExternalWallet('phantom')).rejects.toMatchObject({
      code: 'SESSION',
      message: 'An external wallet connection for "phantom" is already in progress.',
    })

    olderConnection.resolve({ address, chain: 'solana' })
    await expect(olderAttempt).resolves.toMatchObject({
      status: 'connected',
      address,
      externalProviderId: 'phantom',
    })
    expect(connect).toHaveBeenCalledOnce()
    expect(disconnect).not.toHaveBeenCalled()
  })

  it('keeps same-provider connections blocked until stale-provider cleanup finishes', async () => {
    const staleConnection = deferred<{ address: string; chain: 'solana' }>()
    const cleanup = deferred<boolean>()
    const connect = vi
      .fn()
      .mockImplementationOnce(() => staleConnection.promise)
      .mockResolvedValue({
        address: '11111111111111111111111111111111',
        chain: 'solana',
      })
    const disconnect = vi.fn(async () => {
      await cleanup.promise
    })
    const provider: ExternalWalletProvider = {
      id: 'phantom',
      label: 'Phantom',
      connect,
      disconnect,
    }
    const wallet = createWallet([provider])

    const staleAttempt = wallet.connectExternalWallet('phantom')
    await vi.waitFor(() => {
      expect(connect).toHaveBeenCalledOnce()
    })
    await wallet.signOut()
    await expect(wallet.connectExternalWallet('phantom')).rejects.toMatchObject({
      code: 'SESSION',
    })

    staleConnection.resolve({
      address: '11111111111111111111111111111111',
      chain: 'solana',
    })
    await vi.waitFor(() => {
      expect(disconnect).toHaveBeenCalledOnce()
    })
    await expect(wallet.connectExternalWallet('phantom')).rejects.toMatchObject({
      code: 'SESSION',
    })

    cleanup.resolve(true)
    await expect(staleAttempt).resolves.toMatchObject({ status: 'disconnected' })
    await expect(wallet.connectExternalWallet('phantom')).resolves.toMatchObject({
      status: 'connected',
      externalProviderId: 'phantom',
    })
    expect(connect).toHaveBeenCalledTimes(2)
  })

  it('preserves overlapping connections to different providers', async () => {
    const olderConnection = deferred<{ address: string; chain: 'solana' }>()
    const olderDisconnect = vi.fn()
    const olderConnect = vi.fn(() => olderConnection.promise)
    const olderProvider: ExternalWalletProvider = {
      id: 'phantom',
      label: 'Phantom',
      connect: olderConnect,
      disconnect: olderDisconnect,
    }
    const newerProvider: ExternalWalletProvider = {
      id: 'walletconnect',
      label: 'WalletConnect',
      connect: vi.fn().mockResolvedValue({
        address: '11111111111111111111111111111111',
        chain: 'solana',
      }),
    }
    const wallet = createWallet([olderProvider, newerProvider])

    const olderAttempt = wallet.connectExternalWallet('phantom')
    await vi.waitFor(() => {
      expect(olderConnect).toHaveBeenCalledOnce()
    })
    await expect(wallet.connectExternalWallet('walletconnect')).resolves.toMatchObject({
      status: 'connected',
      address: '11111111111111111111111111111111',
      externalProviderId: 'walletconnect',
    })

    olderConnection.resolve({
      address: 'Vote111111111111111111111111111111111111111',
      chain: 'solana',
    })
    await olderAttempt
    expect(olderDisconnect).toHaveBeenCalledOnce()
    expect(wallet.state).toMatchObject({
      status: 'connected',
      externalProviderId: 'walletconnect',
    })
  })

  it('routes an approved external Solana transfer through its adapter signer', async () => {
    const signer = {
      address: '11111111111111111111111111111111',
      sign: vi.fn(),
    }
    const provider: ExternalWalletProvider = {
      id: 'phantom',
      label: 'Phantom',
      connect: vi.fn().mockResolvedValue({
        address: signer.address,
        chain: 'solana',
        signer,
      }),
    }
    const wallet = createWallet([provider])
    await wallet.connectExternalWallet('phantom')
    let transactionId = ''
    wallet.onEvent((event) => {
      if (event.type === 'transaction:confirmation') transactionId = event.id
    })

    const result = wallet.requestTransaction({
      kind: 'sol-transfer',
      recipient: 'Vote111111111111111111111111111111111111111',
      amount: 500,
    })
    let receivedOptions: SendOptions | undefined
    gasStation.send.mockImplementation((options: SendOptions) => {
      receivedOptions = options
      return Promise.resolve({ Signature: 'transaction-signature', Status: 'Success' })
    })
    await vi.waitFor(() => {
      expect(transactionId).not.toBe('')
    })
    await wallet.approveTransaction(transactionId)

    await expect(result).resolves.toMatchObject({ signature: 'transaction-signature' })
    expect(gasStation.send).toHaveBeenCalledOnce()
    expect(receivedOptions).toMatchObject({
      account: signer.address,
      toAddress: 'Vote111111111111111111111111111111111111111',
      amount: 500,
    })
    expect(receivedOptions?.sourceSigner).toHaveProperty('address', signer.address)
    expect(receivedOptions?.sourceSigner).toHaveProperty('sign')
    expect(receivedOptions?.sourceSigner).not.toBe(signer)
    expect(store.records.size).toBe(0)
    expect(sessionTokens.token).toBeNull()
  })

  it('rejects EVM wallet operations that require Solana and disconnects without API credentials', async () => {
    const disconnect = vi.fn()
    const provider: ExternalWalletProvider = {
      id: 'metamask',
      label: 'MetaMask',
      connect: vi.fn().mockResolvedValue({
        address: '0x1234567890123456789012345678901234567890',
        chain: 'evm',
      }),
      disconnect,
    }
    const wallet = createWallet([provider])
    await wallet.connectExternalWallet('metamask')

    await expect(wallet.getBalance()).rejects.toMatchObject({ code: 'TRANSACTION' })
    expect(() =>
      wallet.requestTransaction({
        kind: 'sol-transfer',
        recipient: 'Vote111111111111111111111111111111111111111',
        amount: 500,
      }),
    ).toThrow(AltudeWalletError)
    await expect(wallet.createAccount()).rejects.toMatchObject({ code: 'SESSION' })
    expect(gasStation.getBalance).not.toHaveBeenCalled()
    expect(gasStation.send).not.toHaveBeenCalled()
    expect(gasStation.createAccount).not.toHaveBeenCalled()

    await wallet.signOut()
    expect(disconnect).toHaveBeenCalledOnce()
    expect(wallet.state.status).toBe('disconnected')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects external connections while an API session token remains', async () => {
    sessionTokens.token = 'active-api-session'
    const connect = vi.fn()
    const provider: ExternalWalletProvider = {
      id: 'phantom',
      label: 'Phantom',
      connect,
    }
    const wallet = createWallet([provider])

    await expect(wallet.connectExternalWallet('phantom')).rejects.toMatchObject({
      code: 'SESSION',
      message: 'Sign out of the existing API session before connecting an external wallet.',
    })
    expect(connect).not.toHaveBeenCalled()
    expect(wallet.state.status).toBe('disconnected')
  })

  it('requires user confirmation and relays only validated structured transfers', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        success: true,
        sessionToken: 'session-token',
        user: { id: 'server-user-3' },
      }),
    )
    const wallet = createWallet()
    await wallet.connect({ accessToken: 'provider-token', identityKey: 'auth0|transfer-user' })
    let confirmationId = ''
    let confirmationIntent: WalletTransactionIntentSnapshot | undefined
    let confirmationEvent: WalletEvent | undefined
    const eventHandler = vi.fn((event: WalletEvent) => {
      if (event.type === 'transaction:confirmation') {
        confirmationId = event.id
        confirmationIntent = event.intent
        confirmationEvent = event
      }
    })
    wallet.onEvent(eventHandler)
    const intent: WalletTransactionIntent = {
      kind: 'sol-transfer',
      recipient: '11111111111111111111111111111111',
      amount: 1_000,
      network: 'devnet',
    }
    const resultPromise = wallet.requestTransaction(intent)
    await vi.waitFor(() => {
      expect(confirmationId).not.toBe('')
    })
    expect(confirmationId).not.toBe('')
    expect(gasStation.send).not.toHaveBeenCalled()
    intent.recipient = 'Vote111111111111111111111111111111111111111'
    intent.amount = 2_000
    if (!confirmationIntent || !confirmationEvent)
      throw new Error('Confirmation event was not emitted.')
    expect(confirmationIntent).toEqual({
      kind: 'sol-transfer',
      recipient: '11111111111111111111111111111111',
      amount: 1_000,
      network: 'devnet',
    })
    expect(Object.isFrozen(confirmationIntent)).toBe(true)
    expect(Reflect.set(confirmationIntent, 'recipient', intent.recipient)).toBe(false)
    expect(confirmationEvent).toBeDefined()
    expect(Reflect.set(confirmationEvent, 'intent', intent)).toBe(false)

    await vi.waitFor(() => {
      expect(confirmationId).not.toBe('')
    })
    const result = await wallet.approveTransaction(confirmationId)
    expect(await resultPromise).toEqual(result)
    expect(result.signature).toBe('transaction-signature')
    expect(gasStation.send).toHaveBeenCalledWith(
      expect.objectContaining({
        toAddress: '11111111111111111111111111111111',
        amount: 1_000,
        account: wallet.address,
      }),
    )
    expect(() =>
      wallet.requestTransaction({
        kind: 'sol-transfer',
        recipient: 'not-an-address',
        amount: 1,
      }),
    ).toThrow(AltudeWalletError)
  })

  it.each([
    ['transfer', 'reject'],
    ['transfer', 'signout'],
    ['provisioning', 'reject'],
    ['provisioning', 'signout'],
    ['provisioning', 'abort'],
  ] as const)(
    'prevents the actual HTTP relay when %s is cancelled by %s during final config refresh',
    async (operation, cancellation) => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(
          jsonResponse({
            Success: true,
            SessionToken: 'session-token',
            User: { Id: 'dispatch-user' },
          }),
        ),
      )
      const gs = new AltudeGasStation({
        apiKey: 'test-api-key',
        baseUrl: 'https://api.example.test',
      })
      const configEntered = deferred<boolean>()
      const configRelease = deferred<boolean>()
      let signed = false
      let relayCalls = 0
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init?: RequestInit) => {
          if (url.startsWith('https://rpc.example.test')) {
            const request: unknown = JSON.parse(typeof init?.body === 'string' ? init.body : '')
            if (
              !request ||
              typeof request !== 'object' ||
              !('method' in request) ||
              !('id' in request) ||
              typeof request.method !== 'string' ||
              (typeof request.id !== 'number' && typeof request.id !== 'string')
            )
              throw new Error('Invalid synthetic RPC request')
            if (request.method !== 'getAccountInfo' && request.method !== 'getLatestBlockhash')
              throw new Error(`Unexpected RPC method: ${request.method}`)
            return jsonResponse({
              jsonrpc: '2.0',
              id: request.id,
              result: {
                context: { slot: 1 },
                value:
                  request.method === 'getAccountInfo'
                    ? null
                    : {
                        blockhash: 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N',
                        lastValidBlockHeight: 100,
                      },
              },
            })
          }
          if (url.endsWith('/api/transaction/config')) {
            if (signed) {
              configEntered.resolve(true)
              await configRelease.promise
            }
            return jsonResponse({
              FeePayer: 'ALTn7gyjm29WthZGgs4z6WVAK2PK5U6w4FAtPg3TPY71',
              RpcUrl: 'https://rpc.example.test',
              RpcEnvironment: 'devnet',
              Token: 'synthetic-token',
              TokenExpiration: '2099-01-01T00:00:00Z',
            })
          }
          if (!url.endsWith('/api/Transaction/send') && !url.endsWith('/api/Account/create'))
            throw new Error(`Unexpected HTTP request ${url}`)
          relayCalls++
          return jsonResponse({ Signature: 'relay-signature', Status: 'Success' })
        }),
      )
      // Instrument only the signer's return so the pause occurs after the
      // wallet's last signing check, in the real facade's final config refresh.
      const send = gs.send.bind(gs)
      vi.spyOn(gs, 'send').mockImplementation((options) => {
        const signer = options.sourceSigner
        if (!signer?.signTransactionMessage) throw new Error('Expected transaction signer')
        const sign = signer.signTransactionMessage.bind(signer)
        return send({
          ...options,
          sourceSigner: {
            ...signer,
            signTransactionMessage: async (bytes) => {
              const signature = await sign(bytes)
              signed = true
              return signature
            },
          },
        })
      })
      const provision = gs.createAccount.bind(gs)
      vi.spyOn(gs, 'createAccount').mockImplementation((options) => {
        const signer = options?.signer
        if (!signer?.signTransactionMessage) throw new Error('Expected provisioning signer')
        const sign = signer.signTransactionMessage.bind(signer)
        return provision({
          ...options,
          signer: {
            ...signer,
            signTransactionMessage: async (bytes) => {
              const signature = await sign(bytes)
              signed = true
              return signature
            },
          },
        })
      })
      const wallet = createWallet([], undefined, gs)
      await wallet.connect({ accessToken: 'provider-token', identityKey: 'auth0|dispatch-user' })
      const confirmation = deferred<string>()
      wallet.onEvent((event) => {
        if (event.type === 'transaction:confirmation' || event.type === 'provisioning:confirmation')
          confirmation.resolve(event.id)
      })
      const controller = new AbortController()
      const request =
        operation === 'transfer'
          ? wallet.requestTransaction({
              kind: 'sol-transfer',
              recipient: 'So11111111111111111111111111111111111111112',
              amount: 1000,
              network: 'devnet',
            })
          : wallet.createAccount(['So11111111111111111111111111111111111111112'], controller.signal)
      const result = request.then(
        () => 'unexpected-success',
        (error: unknown) => error,
      )
      const id = await confirmation.promise
      const approval =
        operation === 'transfer' ? wallet.approveTransaction(id) : wallet.approveProvisioning(id)
      const approved = approval.then(
        () => 'unexpected-success',
        (error: unknown) => error,
      )
      await configEntered.promise
      expect(relayCalls).toBe(0)
      if (cancellation === 'signout') await wallet.signOut()
      else if (cancellation === 'abort') controller.abort()
      else if (operation === 'transfer') wallet.rejectTransaction(id)
      else wallet.rejectProvisioning(id)
      configRelease.resolve(true)
      expect(await result).toBeInstanceOf(AltudeWalletError)
      expect(await approved).toBeInstanceOf(AltudeWalletError)
      expect(relayCalls).toBe(0)
    },
  )

  it('rejects unsupported runtime intent kinds before confirmation or relay', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        success: true,
        sessionToken: 'session-token',
        user: { id: 'unsupported-kind-user' },
      }),
    )
    const wallet = createWallet()
    await wallet.connect({ accessToken: 'provider-token', identityKey: 'auth0|unsupported-kind' })
    const confirmationHandler = vi.fn()
    wallet.onEvent((event) => {
      if (event.type === 'transaction:confirmation') confirmationHandler(event)
    })

    const unsupportedIntent: unknown = JSON.parse(
      '{"kind":"unsupported-transfer","recipient":"11111111111111111111111111111111","amount":1000}',
    )
    const requestTransaction = wallet.requestTransaction.bind(wallet)
    let error: unknown
    try {
      Reflect.apply(requestTransaction, wallet, [unsupportedIntent])
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(AltudeWalletError)
    expect((error as AltudeWalletError).code).toBe('INVALID_INPUT')
    expect(confirmationHandler).not.toHaveBeenCalled()
    expect(gasStation.send).not.toHaveBeenCalled()
  })

  it('requires an explicit unlock before approving transactions or creating accounts', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        success: true,
        sessionToken: 'session-token',
        user: { id: 'locked-wallet-user' },
      }),
    )
    const wallet = createWallet()
    await wallet.connect({
      accessToken: 'provider-token',
      identityKey: 'auth0|locked-wallet-user',
    })
    let confirmationId = ''
    wallet.onEvent((event) => {
      if (event.type === 'transaction:confirmation') confirmationId = event.id
    })
    const resultPromise = wallet.requestTransaction({
      kind: 'sol-transfer',
      recipient: '11111111111111111111111111111111',
      amount: 1_000,
      network: 'devnet',
    })
    wallet.lock()

    await vi.waitFor(() => {
      expect(confirmationId).not.toBe('')
    })
    await expect(wallet.approveTransaction(confirmationId)).rejects.toMatchObject({
      code: 'WALLET_LOCKED',
    })
    await expect(resultPromise).rejects.toMatchObject({ code: 'WALLET_LOCKED' })
    await expect(wallet.createAccount()).rejects.toMatchObject({ code: 'WALLET_LOCKED' })
    expect(gasStation.send).not.toHaveBeenCalled()
    expect(gasStation.createAccount).not.toHaveBeenCalled()
    expect(wallet.state.status).toBe('locked')

    const stateEvents: string[] = []
    wallet.onEvent((event) => {
      if (event.type === 'state') stateEvents.push(event.state.status)
    })
    expect((await wallet.unlock()).status).toBe('connected')
    expect(stateEvents).toEqual(['connected'])
  })

  it.each([true, false])(
    'relays concurrent approvals only once (relay succeeds: %s)',
    async (succeeds) => {
      fetchMock.mockResolvedValue(
        jsonResponse({
          success: true,
          sessionToken: 'session-token',
          user: { id: 'concurrent-user' },
        }),
      )
      const wallet = createWallet()
      await wallet.connect({ accessToken: 'provider-token', identityKey: 'auth0|concurrent' })
      let confirmationId = ''
      const events: WalletEvent[] = []
      wallet.onEvent((event) => {
        events.push(event)
        if (event.type === 'transaction:confirmation') confirmationId = event.id
      })
      const relay = deferred<{ Signature: string }>()
      gasStation.send.mockReturnValue(relay.promise)
      const requested = wallet.requestTransaction({
        kind: 'sol-transfer',
        recipient: '11111111111111111111111111111111',
        amount: 1_000,
      })
      await vi.waitFor(() => {
        expect(confirmationId).not.toBe('')
      })
      const first = wallet.approveTransaction(confirmationId)
      const outcomes = Promise.allSettled([requested, first])
      const second = wallet.approveTransaction(confirmationId)

      await expect(second).rejects.toMatchObject({
        code: 'TRANSACTION',
        message: 'This transaction request is already submitting.',
      })
      await vi.waitFor(() => {
        expect(gasStation.send).toHaveBeenCalledOnce()
      })
      relay.resolve({ Signature: succeeds ? 'only-signature' : '' })

      const settled = await outcomes
      if (succeeds) {
        expect(settled).toEqual([
          { status: 'fulfilled', value: { signature: 'only-signature' } },
          { status: 'fulfilled', value: { signature: 'only-signature' } },
        ])
        expect(events.filter((event) => event.type === 'transaction:complete')).toHaveLength(1)
      } else {
        for (const outcome of settled) {
          expect(outcome).toMatchObject({
            status: 'rejected',
            reason: { code: 'TRANSACTION' },
          })
        }
        expect(events.filter((event) => event.type === 'transaction:error')).toHaveLength(1)
      }
      await expect(wallet.approveTransaction(confirmationId)).rejects.toMatchObject({
        code: 'TRANSACTION',
        message: 'This transaction request is no longer active.',
      })
      expect(gasStation.send).toHaveBeenCalledOnce()
    },
  )

  it('does not relay an approval cancelled while obtaining its signer', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        success: true,
        sessionToken: 'session-token',
        user: { id: 'cancel-before-relay' },
      }),
    )
    const wallet = createWallet()
    await wallet.connect({
      accessToken: 'provider-token',
      identityKey: 'auth0|cancel-before-relay',
    })
    let confirmationId = ''
    wallet.onEvent((event) => {
      if (event.type === 'transaction:confirmation') confirmationId = event.id
    })
    const requested = wallet.requestTransaction({
      kind: 'sol-transfer',
      recipient: '11111111111111111111111111111111',
      amount: 1_000,
    })
    await vi.waitFor(() => {
      expect(confirmationId).not.toBe('')
    })
    const approval = wallet.approveTransaction(confirmationId)
    const outcomes = Promise.allSettled([requested, approval])

    wallet.rejectTransaction(confirmationId)

    for (const outcome of await outcomes) {
      expect(outcome).toMatchObject({
        status: 'rejected',
        reason: { code: 'TRANSACTION', message: 'The wallet user rejected this transaction.' },
      })
    }
    expect(gasStation.send).not.toHaveBeenCalled()
  })

  it('does not sign when approval is cancelled during transaction preparation', async () => {
    const signer = {
      address: '11111111111111111111111111111111',
      sign: vi.fn().mockResolvedValue(new Uint8Array(64)),
    }
    const provider: ExternalWalletProvider = {
      id: 'phantom',
      label: 'Phantom',
      connect: vi.fn().mockResolvedValue({
        address: signer.address,
        chain: 'solana',
        signer,
      }),
    }
    const wallet = createWallet([provider])
    await wallet.connectExternalWallet('phantom')
    let confirmationId = ''
    wallet.onEvent((event) => {
      if (event.type === 'transaction:confirmation') confirmationId = event.id
    })
    const preparation = deferred<boolean>()
    const preparing = deferred<boolean>()
    gasStation.send.mockImplementation(
      async (options: { sourceSigner?: GaslessTransactionSigner }) => {
        const sourceSigner = options.sourceSigner
        if (!sourceSigner?.sign) throw new Error('Expected a signer.')
        preparing.resolve(true)
        await preparation.promise
        await sourceSigner.sign(new Uint8Array([1]))
        return { Signature: 'should-not-relay' }
      },
    )

    const requested = wallet.requestTransaction({
      kind: 'sol-transfer',
      recipient: 'Vote111111111111111111111111111111111111111',
      amount: 1_000,
    })
    await vi.waitFor(() => {
      expect(confirmationId).not.toBe('')
    })
    const approval = wallet.approveTransaction(confirmationId)
    const outcomes = Promise.allSettled([requested, approval])
    await preparing.promise
    wallet.rejectTransaction(confirmationId)
    preparation.resolve(true)

    for (const outcome of await outcomes) {
      expect(outcome).toMatchObject({
        status: 'rejected',
        reason: { code: 'TRANSACTION', message: 'The wallet user rejected this transaction.' },
      })
    }
    expect(signer.sign).not.toHaveBeenCalled()
  })

  it('discards a signature when approval is cancelled while the signer is executing', async () => {
    const signing = deferred<Uint8Array>()
    const signStarted = deferred<boolean>()
    const signer = {
      address: '11111111111111111111111111111111',
      signTransactionMessage: vi.fn(() => {
        signStarted.resolve(true)
        return signing.promise
      }),
    }
    const provider: ExternalWalletProvider = {
      id: 'phantom',
      label: 'Phantom',
      connect: vi.fn().mockResolvedValue({
        address: signer.address,
        chain: 'solana',
        signer,
      }),
    }
    const wallet = createWallet([provider])
    await wallet.connectExternalWallet('phantom')
    let confirmationId = ''
    wallet.onEvent((event) => {
      if (event.type === 'transaction:confirmation') confirmationId = event.id
    })
    const relay = vi
      .fn<() => Promise<{ Signature: string }>>()
      .mockResolvedValue({ Signature: 'should-not-relay' })
    gasStation.send.mockImplementation(
      async (options: { sourceSigner?: GaslessTransactionSigner }) => {
        const sourceSigner = options.sourceSigner
        if (!sourceSigner?.signTransactionMessage) throw new Error('Expected a signer.')
        await sourceSigner.signTransactionMessage(new Uint8Array([1]))
        return relay()
      },
    )

    const requested = wallet.requestTransaction({
      kind: 'sol-transfer',
      recipient: 'Vote111111111111111111111111111111111111111',
      amount: 1_000,
    })
    await vi.waitFor(() => {
      expect(confirmationId).not.toBe('')
    })
    const approval = wallet.approveTransaction(confirmationId)
    const outcomes = Promise.allSettled([requested, approval])
    await signStarted.promise
    wallet.rejectTransaction(confirmationId)
    signing.resolve(new Uint8Array(64))

    for (const outcome of await outcomes) {
      expect(outcome).toMatchObject({
        status: 'rejected',
        reason: { code: 'TRANSACTION', message: 'The wallet user rejected this transaction.' },
      })
    }
    expect(signer.signTransactionMessage).toHaveBeenCalledOnce()
    expect(relay).not.toHaveBeenCalled()
  })

  it.each(['identity change', 'sign-out', 'rejection'])(
    'keeps an in-flight approval cancellable on %s and ignores its late relay response',
    async (cancellation) => {
      const signOutResponse = deferred<Response>()
      fetchMock.mockImplementation((url: string, request: RequestInit) => {
        if (url.endsWith('/signout')) return signOutResponse.promise
        const body = parseBody(request.body)
        return Promise.resolve(
          jsonResponse({
            success: true,
            sessionToken: `session-${body.walletAddress}`,
            user: { id: body.walletAddress, walletAddress: body.walletAddress },
          }),
        )
      })
      const wallet = createWallet()
      await wallet.connect({ accessToken: 'provider-token', identityKey: 'auth0|first' })
      let confirmationId = ''
      const eventHandler = vi.fn((event: WalletEvent) => {
        if (event.type === 'transaction:confirmation') confirmationId = event.id
      })
      wallet.onEvent(eventHandler)
      const relay = deferred<{ Signature: string }>()
      gasStation.send.mockReturnValue(relay.promise)
      const requested = wallet.requestTransaction({
        kind: 'sol-transfer',
        recipient: '11111111111111111111111111111111',
        amount: 1_000,
      })
      await vi.waitFor(() => {
        expect(confirmationId).not.toBe('')
      })
      const approval = wallet.approveTransaction(confirmationId)
      const code = cancellation === 'rejection' ? 'TRANSACTION' : 'SESSION'
      const requestRejected = expect(requested).rejects.toMatchObject({ code })
      const approvalRejected = expect(approval).rejects.toMatchObject({ code })
      await vi.waitFor(() => {
        expect(gasStation.send).toHaveBeenCalledOnce()
      })

      if (cancellation === 'identity change') {
        await wallet.connect({ accessToken: 'provider-token', identityKey: 'auth0|second' })
      } else if (cancellation === 'sign-out') {
        const signOut = wallet.signOut()
        await requestRejected
        signOutResponse.resolve(jsonResponse({ success: true }))
        await signOut
      } else {
        wallet.rejectTransaction(confirmationId)
      }

      await requestRejected
      await expect(wallet.approveTransaction(confirmationId)).rejects.toMatchObject({
        code: 'TRANSACTION',
      })
      eventHandler.mockClear()
      relay.resolve({ Signature: 'stale-signature' })
      await approvalRejected
      expect(eventHandler).not.toHaveBeenCalled()
      expect(gasStation.send).toHaveBeenCalledOnce()
    },
  )

  it('keeps SPL transfer approval bound to its immutable confirmed snapshot', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        success: true,
        sessionToken: 'session-token',
        user: { id: 'server-user-spl' },
      }),
    )
    const wallet = createWallet()
    await wallet.connect({ accessToken: 'provider-token', identityKey: 'auth0|spl-transfer-user' })
    let confirmationId = ''
    let confirmationIntent: WalletTransactionIntentSnapshot | undefined
    wallet.onEvent((event) => {
      if (event.type === 'transaction:confirmation') {
        confirmationId = event.id
        confirmationIntent = event.intent
      }
    })
    const intent: WalletTransactionIntent = {
      kind: 'spl-transfer',
      recipient: '11111111111111111111111111111111',
      mint: 'Vote111111111111111111111111111111111111111',
      amount: 1_000,
      network: 'devnet',
    }
    const resultPromise = wallet.requestTransaction(intent)
    intent.recipient = 'Stake11111111111111111111111111111111111111'
    intent.mint = 'SysvarRent111111111111111111111111111111111'
    intent.amount = 2_000
    await vi.waitFor(() => {
      expect(confirmationIntent).toBeDefined()
    })
    if (!confirmationIntent) throw new Error('Confirmation intent was not emitted.')
    expect(Object.isFrozen(confirmationIntent)).toBe(true)
    expect(Reflect.set(confirmationIntent, 'mint', intent.mint)).toBe(false)

    await wallet.approveTransaction(confirmationId)
    await resultPromise
    expect(gasStation.send).toHaveBeenCalledWith(
      expect.objectContaining({
        toAddress: '11111111111111111111111111111111',
        amount: 1_000,
        token: 'Vote111111111111111111111111111111111111111',
        account: wallet.address,
      }),
    )
  })

  it('cancels a pending approval when the connected identity changes', async () => {
    fetchMock.mockImplementation((_url: string, request: RequestInit) => {
      const body = parseBody(request.body)
      return Promise.resolve(
        jsonResponse({
          success: true,
          sessionToken: `session-${body.walletAddress}`,
          user: { id: body.walletAddress, walletAddress: body.walletAddress },
        }),
      )
    })
    const wallet = createWallet()
    await wallet.connect({ accessToken: 'provider-token', identityKey: 'auth0|first' })
    let confirmationId = ''
    wallet.onEvent((event) => {
      if (event.type === 'transaction:confirmation') confirmationId = event.id
    })
    const pendingResult = wallet.requestTransaction({
      kind: 'sol-transfer',
      recipient: '11111111111111111111111111111111',
      amount: 1_000,
    })
    const rejected = expect(pendingResult).rejects.toMatchObject({ code: 'SESSION' })

    await wallet.connect({ accessToken: 'provider-token', identityKey: 'auth0|second' })
    await rejected
    await expect(wallet.approveTransaction(confirmationId)).rejects.toMatchObject({
      code: 'TRANSACTION',
    })
    expect(gasStation.send).not.toHaveBeenCalled()
  })

  it('does not commit a pending connection after sign-out', async () => {
    const exchange = deferred<Response>()
    fetchMock.mockReturnValue(exchange.promise)
    const wallet = createWallet()
    const connection = wallet.connect({
      accessToken: 'provider-token',
      identityKey: 'auth0|pending-connect',
    })
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledOnce()
    })

    await wallet.signOut()
    exchange.resolve(
      jsonResponse({
        success: true,
        sessionToken: 'stale-session',
        user: { id: 'stale-user' },
      }),
    )

    expect(await connection).toMatchObject({ status: 'disconnected' })
    expect(sessionTokens.token).toBeNull()
    expect(wallet.state.status).toBe('disconnected')
  })

  it('does not restore a session after sign-out supersedes restoration', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        sessionToken: 'session-token',
        user: { id: 'server-user-restore-race' },
      }),
    )
    const wallet = createWallet()
    await wallet.connect({
      accessToken: 'provider-token',
      identityKey: 'auth0|restore-race',
    })
    wallet.lock()

    fetchMock.mockClear()
    const sessionResponse = deferred<Response>()
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith('/session')) return sessionResponse.promise
      if (url.endsWith('/signout')) return Promise.resolve(jsonResponse({ success: true }))
      throw new Error(`Unexpected URL: ${url}`)
    })
    const restoration = wallet.restoreSession()
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledOnce()
    })

    await wallet.signOut()
    sessionResponse.resolve(
      jsonResponse({
        isAuthenticated: true,
        user: { id: 'server-user-restore-race' },
      }),
    )

    expect(await restoration).toMatchObject({ status: 'disconnected' })
    expect(sessionTokens.token).toBeNull()
    expect(wallet.state.status).toBe('disconnected')
  })

  it('does not unlock a wallet when sign-out occurs during restoration unlock', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        sessionToken: 'session-token',
        user: { id: 'server-user-unlock-race' },
      }),
    )
    const wallet = createWallet()
    await wallet.connect({
      accessToken: 'provider-token',
      identityKey: 'auth0|unlock-race',
    })
    wallet.lock()

    const unlockRecord = deferred<WalletStoreRecord | undefined>()
    const unlockStarted = deferred<boolean>()
    store.get = () => {
      unlockStarted.resolve(true)
      return unlockRecord.promise
    }
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith('/session')) {
        return Promise.resolve(
          jsonResponse({
            isAuthenticated: true,
            user: { id: 'server-user-unlock-race' },
          }),
        )
      }
      if (url.endsWith('/signout')) return Promise.resolve(jsonResponse({ success: true }))
      throw new Error(`Unexpected URL: ${url}`)
    })
    const restoration = wallet.restoreSession()
    await unlockStarted.promise

    await wallet.signOut()
    unlockRecord.resolve([...store.records.values()][0])

    expect(await restoration).toMatchObject({ status: 'disconnected' })
    expect(wallet.state.status).toBe('disconnected')
    expect(sessionTokens.token).toBeNull()
  })

  it('ignores a stale unauthenticated restoration after a new connection', async () => {
    sessionTokens.token = 'old-session'
    const sessionResponse = deferred<Response>()
    fetchMock.mockImplementation((url: string, request: RequestInit) => {
      if (url.endsWith('/session')) return sessionResponse.promise
      if (url.endsWith('/auth0')) {
        const body = parseBody(request.body)
        return Promise.resolve(
          jsonResponse({
            success: true,
            sessionToken: 'new-session',
            user: { id: 'new-user', walletAddress: body.walletAddress },
          }),
        )
      }
      throw new Error(`Unexpected URL: ${url}`)
    })
    const wallet = createWallet()
    const restoration = wallet.restoreSession()
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledOnce()
    })

    const connected = await wallet.connect({
      accessToken: 'provider-token',
      identityKey: 'auth0|fresh-connection',
    })
    sessionResponse.resolve(jsonResponse({ isAuthenticated: false }))

    await restoration
    expect(connected.status).toBe('connected')
    expect(wallet.state.status).toBe('connected')
    expect(wallet.state.address).toBe(connected.address)
    expect(sessionTokens.token).toBe('new-session')
  })

  function parseBody(body: BodyInit | null | undefined): {
    accessToken: string
    walletAddress: string
  } {
    if (typeof body !== 'string') throw new Error('Expected JSON request body.')
    const parsed: unknown = JSON.parse(body)
    if (typeof parsed !== 'object' || parsed === null) throw new Error('Expected an object body.')
    const record = parsed as Record<string, unknown>
    if (typeof record.accessToken !== 'string' || typeof record.walletAddress !== 'string') {
      throw new Error('Expected accessToken and walletAddress.')
    }
    return { accessToken: record.accessToken, walletAddress: record.walletAddress }
  }

  function jsonResponse(body: unknown): Response {
    const serialized = JSON.stringify(body)
    return new Response(serialized, { headers: { 'Content-Type': 'application/json' } })
  }

  function deferred<T>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((resolvePromise) => {
      resolve = resolvePromise
    })
    return { promise, resolve }
  }

  it('signs out through the API and clears the session token only after revocation', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          sessionToken: 'session-token',
          user: { id: 'server-user-4' },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ success: true }))
    const wallet = createWallet()
    await wallet.connect({ accessToken: 'provider-token', identityKey: 'auth0|signout-user' })
    await wallet.signOut()
    expect(sessionTokens.token).toBeNull()
    expect(wallet.state.status).toBe('disconnected')
  })

  it('cleans up locally after revocation fails and retains the token for retry', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          sessionToken: 'session-token',
          user: { id: 'server-user-signout-retry' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: 'Revocation temporarily unavailable.' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ success: true }))
    const wallet = createWallet()
    await wallet.connect({
      accessToken: 'provider-token',
      identityKey: 'auth0|signout-retry',
    })
    const pending = wallet.requestTransaction({
      kind: 'sol-transfer',
      recipient: '11111111111111111111111111111111',
      amount: 1_000,
    })
    const pendingRejected = expect(pending).rejects.toMatchObject({ code: 'SESSION' })

    await expect(wallet.signOut()).rejects.toMatchObject({
      code: 'API',
      message: 'Revocation temporarily unavailable.',
    })
    await pendingRejected
    expect(wallet.state.status).toBe('disconnected')
    expect(wallet.state.session).toBeNull()
    expect(sessionTokens.token).toBe('session-token')

    await wallet.signOut()
    expect(sessionTokens.token).toBeNull()
    expect(wallet.state.status).toBe('disconnected')
  })

  it('does not clear a newer session when an older sign-out completes late', async () => {
    const revoke = deferred<Response>()
    let authCalls = 0
    fetchMock.mockImplementation((url: string, request: RequestInit) => {
      if (url.endsWith('/signout')) return revoke.promise
      const body = parseBody(request.body)
      const isNewSession = ++authCalls > 1
      return Promise.resolve(
        jsonResponse({
          success: true,
          sessionToken: isNewSession ? 'new-session' : 'old-session',
          user: { id: isNewSession ? 'new-user' : 'old-user', walletAddress: body.walletAddress },
        }),
      )
    })
    const wallet = createWallet()
    const first = await wallet.connect({
      accessToken: 'provider-token',
      identityKey: 'auth0|old-session',
    })
    expect(first.status).toBe('connected')
    const signOut = wallet.signOut()
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    await wallet.connect({
      accessToken: 'provider-token',
      identityKey: 'auth0|new-session',
    })
    revoke.resolve(jsonResponse({ success: true }))
    await signOut

    expect(wallet.state).toMatchObject({
      status: 'connected',
      session: { user: { id: 'new-user' } },
    })
    expect(sessionTokens.token).toBe('new-session')
  })
})
