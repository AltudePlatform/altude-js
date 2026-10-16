import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AltudeGasStation } from '@altude/gasstation'
import { AltudeWallet, AltudeWalletError } from './index.js'
import type { SessionTokenStore, WalletStore, WalletStoreRecord } from './types.js'

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

  createIfAbsent(record: WalletStoreRecord): Promise<{ record: WalletStoreRecord; created: boolean }> {
    const current = this.records.get(record.identityKey)
    if (current) return Promise.resolve({ record: current, created: false })
    const created = structuredClone(record)
    this.records.set(record.identityKey, created)
    return Promise.resolve({ record: created, created: true })
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
      getBalance: vi.fn().mockResolvedValue({ address: 'wallet', uiAmount: 2 }),
      getHistory: vi
        .fn()
        .mockResolvedValue({ data: [], page: 0, pageSize: 0, limit: 10, offset: 0, total: 0 }),
    }
  })

  function createWallet() {
    return new AltudeWallet({
      apiKey: 'test-api-key',
      apiBaseUrl: 'https://api.example.test',
      network: 'devnet',
      auth: {},
      store,
      sessionTokenStore: sessionTokens,
      fetch: fetchMock as typeof fetch,
      gasStation: gasStation as unknown as AltudeGasStation,
    })
  }

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
    const eventHandler = vi.fn((event: { type: string; id?: string }) => {
      if (event.type === 'transaction:confirmation') confirmationId = event.id ?? ''
    })
    wallet.onEvent(eventHandler)
    const resultPromise = wallet.requestTransaction({
      kind: 'sol-transfer',
      recipient: '11111111111111111111111111111111',
      amount: 1_000,
      network: 'devnet',
    })
    expect(confirmationId).not.toBe('')
    expect(gasStation.send).not.toHaveBeenCalled()

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
})
