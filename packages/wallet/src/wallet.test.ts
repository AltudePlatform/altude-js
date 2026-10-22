import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AltudeGasStation, GaslessTransactionSigner, SendOptions } from '@altude/gasstation'
import { AltudeWallet, AltudeWalletError } from './index.js'
import type {
  ExternalWalletProvider,
  SessionTokenStore,
  WalletEvent,
  WalletStore,
  WalletStoreRecord,
  WalletTransactionIntent,
  WalletTransactionIntentSnapshot,
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
      getConfig: vi.fn().mockResolvedValue({ walletUi: null }),
      getBalance: vi.fn().mockResolvedValue({ address: 'wallet', uiAmount: 2 }),
      getHistory: vi
        .fn()
        .mockResolvedValue({ data: [], page: 0, pageSize: 0, limit: 10, offset: 0, total: 0 }),
    }
  })

  function createWallet(externalWallets: readonly ExternalWalletProvider[] = []) {
    return new AltudeWallet({
      apiKey: 'test-api-key',
      apiBaseUrl: 'https://api.example.test',
      network: 'devnet',
      auth: {},
      externalWallets,
      store,
      sessionTokenStore: sessionTokens,
      fetch: fetchMock as typeof fetch,
      gasStation: gasStation as unknown as AltudeGasStation,
    })
  }

  it('reads the optional wallet UI settings from transaction config', async () => {
    const walletUi = {
      appName: 'Example',
      enabledMethods: { emailOtp: false, socialProviders: ['google'] },
    }
    gasStation.getConfig.mockResolvedValue({ walletUi })
    const wallet = createWallet()

    expect(wallet.network).toBe('devnet')
    await expect(wallet.getWalletUiConfiguration()).resolves.toEqual(walletUi)
    gasStation.getConfig.mockResolvedValue({})
    await expect(wallet.getWalletUiConfiguration()).resolves.toBeNull()
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
    gasStation.send.mockImplementation(
      (options: SendOptions) => {
        receivedOptions = options
        return Promise.resolve({ Signature: 'transaction-signature', Status: 'Success' })
      },
    )
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
