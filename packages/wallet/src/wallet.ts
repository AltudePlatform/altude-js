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
  intent: WalletTransactionIntent
  identityKey: string
  address: string
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
    this.#assertIdentity(identity)
    const address = await this.#vault.getOrCreateAddress(identity.identityKey)
    let result: Awaited<ReturnType<EmbeddedWalletApi['exchangeAuth0']>>
    try {
      result = await this.#api.exchangeAuth0(identity.accessToken, address)
    } catch (error) {
      this.#vault.lock(identity.identityKey)
      throw error
    }
    const { token, user } = result
    if (user.walletAddress && user.walletAddress !== address) {
      throw new AltudeWalletError(
        'SESSION',
        'The API session wallet does not match this browser’s local wallet.',
      )
    }
    await this.#vault.associateServerUser(identity.identityKey, user.id)
    await this.#sessionTokens.set(token)
    const protection = await this.#vault.protection(identity.identityKey)
    this.#replaceActive({
      identityKey: identity.identityKey,
      session: { user },
      address,
      protection,
    })
    if (protection === 'device-local') await this.#vault.unlock(identity.identityKey)
    this.#emit({ type: 'state', state: this.state })
    return this.state
  }

  async restoreSession(): Promise<WalletState> {
    const token = await this.#sessionTokens.get()
    if (!token) return this.state
    const session = await this.#api.getSession(token)
    if (!session) {
      await this.#sessionTokens.clear()
      this.#vault.lock()
      this.#active = null
      this.#cancelPendingTransactions('Wallet session expired before transaction approval.')
      this.#emit({ type: 'state', state: this.state })
      return this.state
    }
    const record = await this.#vault.findByServerUserId(session.user.id)
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
    this.#replaceActive({
      identityKey: record.identityKey,
      session,
      address: record.publicKey,
      protection: record.protection,
    })
    if (record.protection === 'device-local') await this.#vault.unlock(record.identityKey)
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
    const token = await this.#sessionTokens.get()
    if (token) await this.#api.signOut(token)
    await this.#sessionTokens.clear()
    this.#vault.lock(this.#active?.identityKey)
    this.#active = null
    this.#cancelPendingTransactions('Wallet signed out before transaction approval.')
    this.#emit({ type: 'state', state: this.state })
  }

  requestTransaction(intent: WalletTransactionIntent): Promise<WalletTransactionResult> {
    this.#validateIntent(intent)
    const active = this.#requireActive()
    const id = this.#newId()
    const result = new Promise<WalletTransactionResult>((resolve, reject) => {
      this.#pendingTransactions.set(id, {
        intent,
        identityKey: active.identityKey,
        address: active.address,
        resolve,
        reject,
      })
    })
    this.#emit({ type: 'transaction:confirmation', id, intent })
    return result
  }

  async approveTransaction(id: string): Promise<WalletTransactionResult> {
    const pending = this.#pendingTransactions.get(id)
    if (!pending)
      throw new AltudeWalletError('TRANSACTION', 'This transaction request is no longer active.')
    try {
      const active = this.#requireActive()
      if (active.identityKey !== pending.identityKey || active.address !== pending.address) {
        throw new AltudeWalletError(
          'SESSION',
          'The active wallet changed after this transaction was requested. Review and request it again.',
        )
      }
      const signer = await this.#vault.getSigner(active.identityKey)
      const response = await this.#gasStation.send({
        sourceSigner: signer,
        account: active.address,
        toAddress: pending.intent.recipient,
        amount: pending.intent.amount,
        ...(pending.intent.kind === 'spl-transfer' ? { token: pending.intent.mint } : {}),
      })
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
      const normalized = asError(error)
      pending.reject(normalized)
      this.#emit({ type: 'transaction:error', id, error: normalized })
      throw normalized
    } finally {
      this.#pendingTransactions.delete(id)
    }
  }

  rejectTransaction(id: string): void {
    const pending = this.#pendingTransactions.get(id)
    if (!pending) return
    this.#pendingTransactions.delete(id)
    pending.reject(
      new AltudeWalletError('TRANSACTION', 'The wallet user rejected this transaction.'),
    )
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
      pending.reject(new AltudeWalletError('SESSION', message))
      this.#pendingTransactions.delete(id)
    }
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

  #validateIntent(intent: WalletTransactionIntent): void {
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

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
