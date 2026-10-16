import { AltudeGasStation } from '@altude/gasstation'
import type { GetHistoryOptions, GetHistoryResponse } from '@altude/gasstation'
import { AltudeWalletError } from './errors.js'
import { assertPublicKey } from './crypto.js'
import { EmbeddedWalletApi } from './api.js'
import { MemorySessionTokenStore } from './storage.js'
import { WalletVault } from './vault.js'
import type {
  AltudeWalletConfig,
  OtpChannel,
  WalletAuthProvider,
  WalletEvent,
  WalletIdentityToken,
  WalletSession,
  WalletState,
  WalletTransactionIntent,
  WalletTransactionIntentSnapshot,
  WalletTransactionResult,
  WalletTransferHistory,
} from './types.js'

interface ActiveWallet {
  identityKey: string
  session: WalletSession
  address: string
  protection: WalletState['protection']
}

interface PendingTransaction {
  intent: WalletTransactionIntentSnapshot
  identityKey: string
  address: string
  submitting: boolean
  cancelled?: Error
  resolve: (result: WalletTransactionResult) => void
  reject: (error: Error) => void
}

export class AltudeWallet {
  readonly #auth: WalletAuthProvider
  readonly #api: EmbeddedWalletApi
  readonly #sessionTokens: NonNullable<AltudeWalletConfig['sessionTokenStore']>
  readonly #vault: WalletVault
  readonly #gasStation: AltudeGasStation
  readonly #network: NonNullable<AltudeWalletConfig['network']>
  readonly #crypto: Crypto
  readonly #listeners = new Set<(event: WalletEvent) => void>()
  readonly #pendingTransactions = new Map<string, PendingTransaction>()
  #active: ActiveWallet | null = null
  #lifecycleGeneration = 0
  #sessionTokenQueue: Promise<void> = Promise.resolve()

  constructor(config: AltudeWalletConfig) {
    this.#auth = config.auth
    this.#crypto = config.crypto ?? globalThis.crypto
    this.#api = new EmbeddedWalletApi(config.apiKey, config.apiBaseUrl, config.fetch)
    this.#sessionTokens = config.sessionTokenStore ?? new MemorySessionTokenStore()
    this.#vault = new WalletVault({
      ...(config.store ? { store: config.store } : {}),
      ...(config.passkeys ? { passkeys: config.passkeys } : {}),
      ...(config.indexedDB ? { indexedDB: config.indexedDB } : {}),
      ...(config.crypto ? { crypto: config.crypto } : {}),
    })
    this.#network = config.network ?? 'mainnet-beta'
    this.#gasStation =
      config.gasStation ??
      new AltudeGasStation({
        apiKey: config.apiKey,
        network: this.#network,
        baseUrl: config.apiBaseUrl,
      })
  }

  get state(): WalletState {
    return {
      status: this.#active ? (this.#isUnlocked() ? 'connected' : 'locked') : 'disconnected',
      session: this.#active?.session ?? null,
      address: this.#active?.address ?? null,
      protection: this.#active?.protection ?? null,
    }
  }

  get address(): string {
    if (!this.#active)
      throw new AltudeWalletError('SESSION', 'Connect a wallet before requesting its address.')
    return this.#active.address
  }

  get canStartOtp(): boolean {
    return typeof this.#auth.startOtp === 'function' && typeof this.#auth.verifyOtp === 'function'
  }

  get canSignInWithSocial(): boolean {
    return typeof this.#auth.signInWithSocial === 'function'
  }

  get canSignInWithPasskey(): boolean {
    return typeof this.#auth.signInWithPasskey === 'function'
  }

  onEvent(listener: (event: WalletEvent) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  async startOtp(channel: OtpChannel, identifier: string): Promise<void> {
    if (typeof this.#auth.startOtp !== 'function')
      throw new AltudeWalletError(
        'AUTHENTICATION',
        'This auth provider does not support OTP sign-in.',
      )
    const value = identifier.trim()
    if (!value)
      throw new AltudeWalletError('INVALID_INPUT', 'Enter an email address or phone number.')
    await this.#auth.startOtp(channel, value)
  }

  async verifyOtp(channel: OtpChannel, identifier: string, code: string): Promise<WalletState> {
    if (typeof this.#auth.verifyOtp !== 'function')
      throw new AltudeWalletError(
        'AUTHENTICATION',
        'This auth provider does not support OTP sign-in.',
      )
    const token = await this.#auth.verifyOtp(channel, identifier.trim(), code.trim())
    return this.connect(token)
  }

  async signInWithSocial(provider: string): Promise<WalletState> {
    if (typeof this.#auth.signInWithSocial !== 'function')
      throw new AltudeWalletError(
        'AUTHENTICATION',
        'This auth provider does not support social sign-in.',
      )
    return this.connect(await this.#auth.signInWithSocial(provider))
  }

  async signInWithPasskey(): Promise<WalletState> {
    if (typeof this.#auth.signInWithPasskey !== 'function') {
      throw new AltudeWalletError(
        'AUTHENTICATION',
        'This auth provider does not support passkey authentication.',
      )
    }
    return this.connect(await this.#auth.signInWithPasskey())
  }

  async connect(identity: WalletIdentityToken): Promise<WalletState> {
    const generation = ++this.#lifecycleGeneration
    this.#assertIdentity(identity)
    let address: string
    try {
      address = await this.#vault.getOrCreateAddress(identity.identityKey)
    } catch (error) {
      if (!this.#isCurrentLifecycle(generation)) return this.state
      throw error
    }
    if (!this.#isCurrentLifecycle(generation)) {
      this.#lockStaleIdentity(identity.identityKey)
      return this.state
    }
    let result: Awaited<ReturnType<EmbeddedWalletApi['exchangeAuth0']>>
    try {
      result = await this.#api.exchangeAuth0(identity.accessToken, address)
    } catch (error) {
      if (!this.#isCurrentLifecycle(generation)) {
        this.#lockStaleIdentity(identity.identityKey)
        return this.state
      }
      this.#vault.lock(identity.identityKey)
      throw error
    }
    if (!this.#isCurrentLifecycle(generation)) {
      this.#lockStaleIdentity(identity.identityKey)
      return this.state
    }
    const { token, user } = result
    if (user.walletAddress && user.walletAddress !== address) {
      throw new AltudeWalletError(
        'SESSION',
        'The API session wallet does not match this browser’s local wallet.',
      )
    }
    try {
      await this.#vault.associateServerUser(identity.identityKey, user.id)
    } catch (error) {
      if (!this.#isCurrentLifecycle(generation)) {
        this.#lockStaleIdentity(identity.identityKey)
        return this.state
      }
      throw error
    }
    if (!this.#isCurrentLifecycle(generation)) return this.state
    let protection: WalletState['protection']
    try {
      protection = await this.#vault.protection(identity.identityKey)
    } catch (error) {
      if (!this.#isCurrentLifecycle(generation)) return this.state
      throw error
    }
    if (!this.#isCurrentLifecycle(generation)) return this.state
    if (protection === 'device-local') {
      try {
        await this.#vault.unlock(identity.identityKey)
      } catch (error) {
        if (!this.#isCurrentLifecycle(generation)) return this.state
        throw error
      }
    }
    if (!this.#isCurrentLifecycle(generation)) {
      this.#lockStaleIdentity(identity.identityKey)
      return this.state
    }
    try {
      await this.#withSessionTokens(generation, () => this.#sessionTokens.set(token))
    } catch (error) {
      this.#lockStaleIdentity(identity.identityKey)
      throw error
    }
    if (!this.#isCurrentLifecycle(generation)) {
      this.#lockStaleIdentity(identity.identityKey)
      return this.state
    }
    this.#replaceActive({
      identityKey: identity.identityKey,
      session: { user },
      address,
      protection,
    })
    this.#emit({ type: 'state', state: this.state })
    return this.state
  }

  async restoreSession(): Promise<WalletState> {
    const generation = ++this.#lifecycleGeneration
    const token = await this.#withSessionTokens(generation, () => this.#sessionTokens.get())
    if (!this.#isCurrentLifecycle(generation) || !token) return this.state
    let session: WalletSession | null
    try {
      session = await this.#api.getSession(token)
    } catch (error) {
      if (!this.#isCurrentLifecycle(generation)) return this.state
      throw error
    }
    if (!this.#isCurrentLifecycle(generation)) return this.state
    if (!session) {
      await this.#withSessionTokens(generation, () => this.#sessionTokens.clear())
      if (!this.#isCurrentLifecycle(generation)) return this.state
      this.#vault.lock()
      this.#active = null
      this.#cancelPendingTransactions('Wallet session expired before transaction approval.')
      this.#emit({ type: 'state', state: this.state })
      return this.state
    }
    let record: Awaited<ReturnType<WalletVault['findByServerUserId']>>
    try {
      record = await this.#vault.findByServerUserId(session.user.id)
    } catch (error) {
      if (!this.#isCurrentLifecycle(generation)) return this.state
      throw error
    }
    if (!this.#isCurrentLifecycle(generation)) return this.state
    if (!record) {
      throw new AltudeWalletError(
        'WALLET_NOT_FOUND',
        'This browser has no local key for the authenticated account. Sign in on the device where the wallet was created.',
      )
    }
    if (session.user.walletAddress && session.user.walletAddress !== record.publicKey) {
      throw new AltudeWalletError(
        'SESSION',
        'The server wallet address does not match the local identity key.',
      )
    }
    if (!this.#isCurrentLifecycle(generation)) return this.state
    if (record.protection === 'device-local') {
      try {
        await this.#vault.unlock(record.identityKey)
      } catch (error) {
        if (!this.#isCurrentLifecycle(generation)) return this.state
        throw error
      }
    }
    if (!this.#isCurrentLifecycle(generation)) {
      this.#lockStaleIdentity(record.identityKey)
      return this.state
    }
    this.#replaceActive({
      identityKey: record.identityKey,
      session,
      address: record.publicKey,
      protection: record.protection,
    })
    this.#emit({ type: 'state', state: this.state })
    return this.state
  }

  async unlockWithPasskey(): Promise<WalletState> {
    const active = this.#requireActive()
    await this.#vault.unlockWithPasskey(active.identityKey)
    this.#emit({ type: 'state', state: this.state })
    return this.state
  }

  async unlock(): Promise<WalletState> {
    const active = this.#requireActive()
    await this.#vault.unlock(active.identityKey)
    this.#emit({ type: 'state', state: this.state })
    return this.state
  }

  async protectWithPasskey(): Promise<WalletState> {
    const active = this.#requireActive()
    await this.#vault.protectWithPasskey(active.identityKey)
    active.protection = 'passkey'
    this.#emit({ type: 'state', state: this.state })
    return this.state
  }

  async signOut(): Promise<void> {
    const generation = ++this.#lifecycleGeneration
    const identityKey = this.#active?.identityKey
    if (identityKey) this.#vault.lock(identityKey)
    this.#cancelPendingTransactions('Wallet signed out before transaction approval.')
    try {
      const token = await this.#withSessionTokens(generation, () => this.#sessionTokens.get())
      if (!this.#isCurrentLifecycle(generation)) return
      if (token) await this.#api.signOut(token)
      if (!this.#isCurrentLifecycle(generation)) return
      await this.#withSessionTokens(generation, () => this.#sessionTokens.clear())
    } finally {
      if (this.#isCurrentLifecycle(generation)) {
        if (identityKey) this.#vault.lock(identityKey)
        this.#active = null
        this.#cancelPendingTransactions('Wallet signed out before transaction approval.')
        this.#emit({ type: 'state', state: this.state })
      }
    }
  }

  requestTransaction(intent: WalletTransactionIntent): Promise<WalletTransactionResult> {
    const snapshot = snapshotIntent(intent)
    this.#validateIntent(snapshot)
    const active = this.#requireActive()
    const id = this.#newId()
    const result = new Promise<WalletTransactionResult>((resolve, reject) => {
      this.#pendingTransactions.set(id, {
        intent: snapshot,
        identityKey: active.identityKey,
        address: active.address,
        submitting: false,
        resolve,
        reject,
      })
    })
    this.#emit(Object.freeze({ type: 'transaction:confirmation', id, intent: snapshot }))
    return result
  }

  async approveTransaction(id: string): Promise<WalletTransactionResult> {
    const pending = this.#pendingTransactions.get(id)
    if (!pending)
      throw new AltudeWalletError('TRANSACTION', 'This transaction request is no longer active.')
    if (pending.submitting)
      throw new AltudeWalletError('TRANSACTION', 'This transaction request is already submitting.')
    pending.submitting = true
    try {
      const active = this.#requireActive()
      if (active.identityKey !== pending.identityKey || active.address !== pending.address) {
        throw new AltudeWalletError(
          'SESSION',
          'The active wallet changed after this transaction was requested. Review and request it again.',
        )
      }
      const signer = await this.#vault.getSigner(active.identityKey)
      this.#assertNotCancelled(pending)
      const response = await this.#gasStation.send({
        sourceSigner: signer,
        account: active.address,
        toAddress: pending.intent.recipient,
        amount: pending.intent.amount,
        ...(pending.intent.kind === 'spl-transfer' ? { token: pending.intent.mint } : {}),
      })
      this.#assertNotCancelled(pending)
      if (!response.Signature) {
        throw new AltudeWalletError(
          'TRANSACTION',
          response.Message || 'The relay did not return a transaction signature.',
        )
      }
      const result = {
        signature: response.Signature,
        ...(response.Status ? { status: response.Status } : {}),
        ...(response.Message ? { message: response.Message } : {}),
      }
      pending.resolve(result)
      this.#emit({ type: 'transaction:complete', id, result })
      return result
    } catch (error) {
      const normalized = pending.cancelled ?? asError(error)
      pending.reject(normalized)
      if (!pending.cancelled) this.#emit({ type: 'transaction:error', id, error: normalized })
      throw normalized
    } finally {
      this.#pendingTransactions.delete(id)
    }
  }

  rejectTransaction(id: string): void {
    const pending = this.#pendingTransactions.get(id)
    if (!pending) return
    this.#pendingTransactions.delete(id)
    pending.cancelled = new AltudeWalletError(
      'TRANSACTION',
      'The wallet user rejected this transaction.',
    )
    pending.reject(pending.cancelled)
  }

  async createAccount(tokens?: string[]) {
    const active = this.#requireActive()
    const signer = await this.#vault.getSigner(active.identityKey)
    return this.#gasStation.createAccount({
      account: active.address,
      signer,
      ...(tokens ? { tokens } : {}),
    })
  }

  async getBalance() {
    const active = this.#requireActive()
    return this.#gasStation.getBalance({ address: active.address })
  }

  async getAccountInfo() {
    const active = this.#requireActive()
    return this.#gasStation.getAccountInfo({ account: active.address })
  }

  async getHistory(
    options: Omit<GetHistoryOptions, 'account' | 'walletAddress'> = {},
  ): Promise<GetHistoryResponse> {
    const active = this.#requireActive()
    return this.#gasStation.getHistory({ ...options, walletAddress: active.address })
  }

  async getTransaction(
    signature: string,
    options: Omit<GetHistoryOptions, 'account' | 'walletAddress'> = {},
  ): Promise<WalletTransferHistory['data'][number] | null> {
    if (!signature.trim())
      throw new AltudeWalletError('INVALID_INPUT', 'A transaction signature is required.')
    const history = await this.getHistory({ limit: 100, ...options })
    return history.data.find((entry) => entry.signature === signature) ?? null
  }

  lock(): void {
    this.#vault.lock(this.#active?.identityKey)
    this.#emit({ type: 'state', state: this.state })
  }

  #requireActive(): ActiveWallet {
    if (!this.#active)
      throw new AltudeWalletError('SESSION', 'Connect a wallet before using this operation.')
    return this.#active
  }

  #replaceActive(next: ActiveWallet): void {
    const previous = this.#active
    if (previous && previous.identityKey !== next.identityKey) {
      this.#vault.lock(previous.identityKey)
      this.#cancelPendingTransactions('Wallet changed before transaction approval.')
    }
    this.#active = next
  }

  #cancelPendingTransactions(message: string): void {
    for (const [id, pending] of this.#pendingTransactions) {
      pending.cancelled = new AltudeWalletError('SESSION', message)
      pending.reject(pending.cancelled)
      this.#pendingTransactions.delete(id)
    }
  }

  #assertNotCancelled(pending: PendingTransaction): void {
    if (pending.cancelled) throw pending.cancelled
  }

  #isCurrentLifecycle(generation: number): boolean {
    return generation === this.#lifecycleGeneration
  }

  #lockStaleIdentity(identityKey: string): void {
    if (this.#active?.identityKey !== identityKey) this.#vault.lock(identityKey)
  }

  #withSessionTokens<T>(generation: number, operation: () => Promise<T>): Promise<T | undefined> {
    const pending = this.#sessionTokenQueue.then(async () => {
      if (!this.#isCurrentLifecycle(generation)) return undefined
      return operation()
    })
    this.#sessionTokenQueue = pending.then(
      () => undefined,
      () => undefined,
    )
    return pending
  }

  #assertIdentity(identity: WalletIdentityToken): void {
    if (!identity.accessToken.trim())
      throw new AltudeWalletError(
        'AUTHENTICATION',
        'The identity provider returned no access token.',
      )
    if (!identity.identityKey.trim() || identity.identityKey.length > 512) {
      throw new AltudeWalletError(
        'AUTHENTICATION',
        'The identity provider must return a stable local identity key.',
      )
    }
  }

  #validateIntent(intent: WalletTransactionIntentSnapshot): void {
    const active = this.#requireActive()
    if (!Number.isSafeInteger(intent.amount) || intent.amount <= 0) {
      throw new AltudeWalletError(
        'INVALID_INPUT',
        'Transfer amount must be a positive safe integer in the smallest unit.',
      )
    }
    try {
      assertPublicKey(intent.recipient, 'Recipient')
      if (intent.kind === 'spl-transfer') assertPublicKey(intent.mint, 'Token mint')
    } catch (error) {
      throw new AltudeWalletError('INVALID_INPUT', asError(error).message, undefined, error)
    }
    if (intent.recipient === active.address) {
      throw new AltudeWalletError(
        'INVALID_INPUT',
        'Transfers to the connected wallet are not supported.',
      )
    }
    if (intent.network && intent.network !== this.#network) {
      throw new AltudeWalletError(
        'INVALID_INPUT',
        'The transaction network does not match the configured Gas Station network.',
      )
    }
  }

  #isUnlocked(): boolean {
    const active = this.#active
    return active !== null && this.#vault.isUnlocked(active.identityKey)
  }

  #newId(): string {
    return this.#crypto.randomUUID()
  }

  #emit(event: WalletEvent): void {
    this.#listeners.forEach((listener) => {
      listener(event)
    })
  }
}

function snapshotIntent(intent: WalletTransactionIntent): WalletTransactionIntentSnapshot {
  if (intent.kind === 'sol-transfer') {
    return Object.freeze({
      kind: 'sol-transfer',
      recipient: intent.recipient,
      amount: intent.amount,
      ...(intent.network === undefined ? {} : { network: intent.network }),
    })
  }
  return Object.freeze({
    kind: 'spl-transfer',
    recipient: intent.recipient,
    mint: intent.mint,
    amount: intent.amount,
    ...(intent.network === undefined ? {} : { network: intent.network }),
  })
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
