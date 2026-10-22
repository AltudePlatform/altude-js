import { AltudeGasStation } from '@altude/gasstation'
import type {
  GetHistoryOptions,
  GetHistoryResponse,
  WalletUiConfiguration,
} from '@altude/gasstation'
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
  ExternalWalletProvider,
  ExternalWalletProviderId,
  WalletIdentityToken,
  WalletSession,
  WalletState,
  WalletTransactionIntent,
  WalletTransactionIntentSnapshot,
  WalletTransactionResult,
  WalletTransferHistory,
} from './types.js'

interface EmbeddedActiveWallet {
  mode: 'embedded'
  identityKey: string
  session: WalletSession
  address: string
  protection: WalletState['protection']
}

interface ExternalActiveWallet {
  mode: 'external'
  provider: ExternalWalletProvider
  providerId: ExternalWalletProviderId
  chain: 'solana' | 'evm'
  address: string
  signer?: NonNullable<Awaited<ReturnType<ExternalWalletProvider['connect']>>['signer']>
}

type ActiveWallet = EmbeddedActiveWallet | ExternalActiveWallet

interface PendingTransaction {
  intent: WalletTransactionIntentSnapshot
  walletMode: ActiveWallet['mode']
  identityKey?: string
  providerId?: ExternalWalletProviderId
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
  readonly #externalWallets: readonly ExternalWalletProvider[]
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
    this.#externalWallets = config.externalWallets ?? []
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
      session: this.#active?.mode === 'embedded' ? this.#active.session : null,
      address: this.#active?.address ?? null,
      protection: this.#active?.mode === 'embedded' ? this.#active.protection : null,
      custody: this.#active?.mode ?? null,
      externalProviderId: this.#active?.mode === 'external' ? this.#active.providerId : null,
      externalChain: this.#active?.mode === 'external' ? this.#active.chain : null,
    }
  }

  get network(): NonNullable<AltudeWalletConfig['network']> {
    return this.#network
  }

  /** Read the optional wallet UI settings returned by transaction config. */
  async getWalletUiConfiguration(): Promise<WalletUiConfiguration | null> {
    const config = await this.#gasStation.getConfig()
    return config.walletUi ?? null
  }

  get address(): string {
    if (!this.#active)
      throw new AltudeWalletError('SESSION', 'Connect a wallet before requesting its address.')
    return this.#active.address
  }

  get canStartOtp(): boolean {
    return (
      (typeof this.#auth.startOtp === 'function' && typeof this.#auth.verifyOtp === 'function') ||
      typeof this.#auth.signInWithOtp === 'function'
    )
  }

  get usesHostedOtp(): boolean {
    return typeof this.#auth.signInWithOtp === 'function'
  }

  canSignInWithOtp(channel: OtpChannel): boolean {
    if (this.#auth.supportsOtpChannel && !this.#auth.supportsOtpChannel(channel)) return false
    return (
      typeof this.#auth.signInWithOtp === 'function' ||
      (typeof this.#auth.startOtp === 'function' && typeof this.#auth.verifyOtp === 'function')
    )
  }

  get canSignInWithSocial(): boolean {
    return typeof this.#auth.signInWithSocial === 'function'
  }

  get canSignInWithPasskey(): boolean {
    return typeof this.#auth.signInWithPasskey === 'function'
  }

  get externalWalletProviders(): readonly Pick<
    ExternalWalletProvider,
    'id' | 'label' | 'isAvailable'
  >[] {
    return this.#externalWallets.map((provider) => ({
      id: provider.id,
      label: provider.label,
      ...(provider.isAvailable
        ? { isAvailable: () => provider.isAvailable?.() ?? false }
        : {}),
    }))
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

  async signInWithOtp(channel: OtpChannel, identifier: string): Promise<WalletState> {
    if (typeof this.#auth.signInWithOtp !== 'function') {
      throw new AltudeWalletError(
        'AUTHENTICATION',
        'This auth provider does not support hosted OTP sign-in.',
      )
    }
    const value = identifier.trim()
    if (!value)
      throw new AltudeWalletError('INVALID_INPUT', 'Enter an email address or phone number.')
    return this.connect(await this.#auth.signInWithOtp(channel, value))
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
    if (this.#active?.mode === 'external') {
      throw new AltudeWalletError(
        'SESSION',
        'Disconnect the external wallet before signing in to an embedded wallet.',
      )
    }
    const generation = ++this.#lifecycleGeneration
    this.#assertIdentity(identity)
    let address: string
    this.#emit({ type: 'setup:progress', stage: 'securing-device' })
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
    this.#emit({ type: 'setup:progress', stage: 'connecting-account' })
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
      this.#emit({ type: 'setup:progress', stage: 'finishing' })
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
      mode: 'embedded',
      identityKey: identity.identityKey,
      session: { user },
      address,
      protection,
    })
    this.#emit({ type: 'state', state: this.state })
    return this.state
  }

  async connectExternalWallet(providerId: ExternalWalletProviderId): Promise<WalletState> {
    const provider = this.#externalWallets.find((candidate) => candidate.id === providerId)
    if (!provider) {
      throw new AltudeWalletError(
        'CONFIGURATION',
        `External wallet provider "${providerId}" is not configured.`,
      )
    }
    if (this.#active) {
      throw new AltudeWalletError(
        'SESSION',
        'Sign out or disconnect the current wallet before connecting an external wallet.',
      )
    }
    const generation = ++this.#lifecycleGeneration
    const token = await this.#withSessionTokens(generation, () => this.#sessionTokens.get())
    if (!this.#isCurrentLifecycle(generation)) return this.state
    if (token) {
      throw new AltudeWalletError(
        'SESSION',
        'Sign out of the existing API session before connecting an external wallet.',
      )
    }
    const connection: unknown = await provider.connect()
    if (!this.#isCurrentLifecycle(generation)) {
      await provider.disconnect?.()
      return this.state
    }
    if (!isExternalWalletConnection(connection)) {
      throw new AltudeWalletError(
        'INVALID_RESPONSE',
        'The external wallet returned an invalid address, chain, or signer.',
      )
    }
    const address = connection.address.trim()
    if (!address) {
      throw new AltudeWalletError('INVALID_RESPONSE', 'The external wallet returned no address.')
    }
    if (connection.signer && connection.signer.address.trim() !== address) {
      throw new AltudeWalletError(
        'INVALID_RESPONSE',
        'The external wallet signer does not match its connected address.',
      )
    }
    if (connection.chain === 'solana') {
      try {
        assertPublicKey(address, 'External Solana wallet address')
      } catch (error) {
        throw new AltudeWalletError('INVALID_RESPONSE', asError(error).message, undefined, error)
      }
    } else if (!/^0x[a-f\d]{40}$/i.test(address)) {
      throw new AltudeWalletError(
        'INVALID_RESPONSE',
        'The external EVM wallet returned an invalid address.',
      )
    }
    if (!this.#isCurrentLifecycle(generation)) {
      await provider.disconnect?.()
      return this.state
    }
    this.#replaceActive({
      mode: 'external',
      provider,
      providerId: provider.id,
      chain: connection.chain,
      address,
      ...(connection.signer ? { signer: connection.signer } : {}),
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
      mode: 'embedded',
      identityKey: record.identityKey,
      session,
      address: record.publicKey,
      protection: record.protection,
    })
    this.#emit({ type: 'state', state: this.state })
    return this.state
  }

  async unlockWithPasskey(): Promise<WalletState> {
    const active = this.#requireEmbeddedActive()
    await this.#vault.unlockWithPasskey(active.identityKey)
    this.#emit({ type: 'state', state: this.state })
    return this.state
  }

  async unlock(): Promise<WalletState> {
    const active = this.#requireEmbeddedActive()
    await this.#vault.unlock(active.identityKey)
    this.#emit({ type: 'state', state: this.state })
    return this.state
  }

  async protectWithPasskey(): Promise<WalletState> {
    const active = this.#requireEmbeddedActive()
    await this.#vault.protectWithPasskey(active.identityKey)
    active.protection = 'passkey'
    this.#emit({ type: 'state', state: this.state })
    return this.state
  }

  async signOut(): Promise<void> {
    const generation = ++this.#lifecycleGeneration
    const active = this.#active
    const identityKey = active?.mode === 'embedded' ? active.identityKey : undefined
    if (identityKey) this.#vault.lock(identityKey)
    this.#cancelPendingTransactions('Wallet signed out before transaction approval.')
    let failed = false
    let failure: unknown
    try {
      const token = await this.#withSessionTokens(generation, () => this.#sessionTokens.get())
      if (!this.#isCurrentLifecycle(generation)) return
      if (token) await this.#api.signOut(token)
      if (!this.#isCurrentLifecycle(generation)) return
      await this.#withSessionTokens(generation, () => this.#sessionTokens.clear())
    } catch (error) {
      failed = true
      failure = error
    }
    if (active?.mode === 'external') {
      try {
        await active.provider.disconnect?.()
      } catch (error) {
        if (!failed) {
          failed = true
          failure = error
        }
      }
    }
    if (this.#isCurrentLifecycle(generation)) {
      if (identityKey) this.#vault.lock(identityKey)
      this.#active = null
      this.#cancelPendingTransactions('Wallet signed out before transaction approval.')
      this.#emit({ type: 'state', state: this.state })
    }
    if (failed) throw failure
  }

  requestTransaction(intent: WalletTransactionIntent): Promise<WalletTransactionResult> {
    assertSupportedIntentKind(intent)
    const snapshot = snapshotIntent(intent)
    this.#validateIntent(snapshot)
    const active = this.#requireActive()
    const id = this.#newId()
    const result = new Promise<WalletTransactionResult>((resolve, reject) => {
      this.#pendingTransactions.set(id, {
        intent: snapshot,
        walletMode: active.mode,
        ...(active.mode === 'embedded' ? { identityKey: active.identityKey } : {}),
        ...(active.mode === 'external' ? { providerId: active.providerId } : {}),
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
      if (
        active.mode !== pending.walletMode ||
        active.address !== pending.address ||
        (active.mode === 'embedded' && active.identityKey !== pending.identityKey) ||
        (active.mode === 'external' && active.providerId !== pending.providerId)
      ) {
        throw new AltudeWalletError(
          'SESSION',
          'The active wallet changed after this transaction was requested. Review and request it again.',
        )
      }
      const signer =
        active.mode === 'embedded' ? await this.#vault.getSigner(active.identityKey) : active.signer
      if (!signer) {
        throw new AltudeWalletError(
          'TRANSACTION',
          'The connected external wallet does not provide a Solana transaction signer.',
        )
      }
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
    const active = this.#requireEmbeddedActive()
    const signer = await this.#vault.getSigner(active.identityKey)
    return this.#gasStation.createAccount({
      account: active.address,
      signer,
      ...(tokens ? { tokens } : {}),
    })
  }

  async getBalance() {
    const active = this.#requireActive()
    if (active.mode === 'external' && active.chain !== 'solana') {
      throw new AltudeWalletError(
        'TRANSACTION',
        'Balance lookup is only available for Solana wallets.',
      )
    }
    if (active.mode === 'external')
      assertSolanaAddress(active.address, 'External Solana wallet address')
    return this.#gasStation.getBalance({ address: active.address })
  }

  async getAccountInfo() {
    const active = this.#requireActive()
    if (active.mode === 'external' && active.chain !== 'solana') {
      throw new AltudeWalletError(
        'TRANSACTION',
        'Account lookup is only available for Solana wallets.',
      )
    }
    if (active.mode === 'external')
      assertSolanaAddress(active.address, 'External Solana wallet address')
    return this.#gasStation.getAccountInfo({ account: active.address })
  }

  async getHistory(
    options: Omit<GetHistoryOptions, 'account' | 'walletAddress'> = {},
  ): Promise<GetHistoryResponse> {
    const active = this.#requireActive()
    if (active.mode === 'external' && active.chain !== 'solana') {
      throw new AltudeWalletError(
        'TRANSACTION',
        'History lookup is only available for Solana wallets.',
      )
    }
    if (active.mode === 'external')
      assertSolanaAddress(active.address, 'External Solana wallet address')
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
    if (this.#active?.mode === 'embedded') this.#vault.lock(this.#active.identityKey)
    this.#emit({ type: 'state', state: this.state })
  }

  #requireActive(): ActiveWallet {
    if (!this.#active)
      throw new AltudeWalletError('SESSION', 'Connect a wallet before using this operation.')
    return this.#active
  }

  #requireEmbeddedActive(): EmbeddedActiveWallet {
    const active = this.#requireActive()
    if (active.mode !== 'embedded') {
      throw new AltudeWalletError(
        'SESSION',
        'This operation is only available for an embedded local wallet.',
      )
    }
    return active
  }

  #replaceActive(next: ActiveWallet): void {
    const previous = this.#active
    const identityChanged =
      previous?.mode === 'embedded' &&
      next.mode === 'embedded' &&
      previous.identityKey !== next.identityKey
    if (
      previous?.mode === 'embedded' &&
      (next.mode !== 'embedded' || previous.identityKey !== next.identityKey)
    ) {
      this.#vault.lock(previous.identityKey)
    }
    if (previous && (previous.mode !== next.mode || identityChanged)) {
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
    if (this.#active?.mode !== 'embedded' || this.#active.identityKey !== identityKey) {
      this.#vault.lock(identityKey)
    }
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
    if (active.mode === 'external') {
      if (active.chain !== 'solana') {
        throw new AltudeWalletError(
          'TRANSACTION',
          'Sponsored Solana transfers are not available for this external wallet chain.',
        )
      }
      if (!active.signer) {
        throw new AltudeWalletError(
          'TRANSACTION',
          'The connected external wallet does not provide a Solana transaction signer.',
        )
      }
      assertSolanaAddress(active.address, 'External Solana wallet address')
    }
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
    if (!active) return false
    return active.mode === 'external' || this.#vault.isUnlocked(active.identityKey)
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

function assertSupportedIntentKind(value: unknown): asserts value is WalletTransactionIntent {
  if (
    typeof value !== 'object' ||
    value === null ||
    (Reflect.get(value, 'kind') !== 'sol-transfer' && Reflect.get(value, 'kind') !== 'spl-transfer')
  ) {
    throw new AltudeWalletError(
      'INVALID_INPUT',
      'Only SOL and standard SPL transfers are supported.',
    )
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function assertSolanaAddress(address: string, name: string): void {
  try {
    assertPublicKey(address, name)
  } catch (error) {
    throw new AltudeWalletError('INVALID_INPUT', asError(error).message, undefined, error)
  }
}

function isExternalWalletConnection(
  value: unknown,
): value is Awaited<ReturnType<ExternalWalletProvider['connect']>> {
  if (typeof value !== 'object' || value === null) return false
  const address: unknown = Reflect.get(value, 'address')
  const chain: unknown = Reflect.get(value, 'chain')
  const signer: unknown = Reflect.get(value, 'signer')
  if (typeof address !== 'string' || (chain !== 'solana' && chain !== 'evm')) {
    return false
  }
  if (signer === undefined) return true
  return (
    typeof signer === 'object' &&
    signer !== null &&
    chain === 'solana' &&
    typeof Reflect.get(signer, 'address') === 'string' &&
    (typeof Reflect.get(signer, 'signTransactionMessage') === 'function' ||
      typeof Reflect.get(signer, 'sign') === 'function')
  )
}
