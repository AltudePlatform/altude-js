import { AltudeGasStation } from '@altude/gasstation'
import type {
  GetHistoryOptions,
  GetHistoryResponse,
  WalletUiConfiguration,
} from '@altude/gasstation'
import { AltudeWalletError } from './errors.js'
import { assertPublicKey, toArrayBuffer } from './crypto.js'
import { BrowserWalletConflictError, EmbeddedWalletApi } from './api.js'
import type { BrowserWalletAccess } from './api.js'
import { MemorySessionTokenStore } from './storage.js'
import { WalletVault } from './vault.js'
import { BrowserPasskeyAdapter } from './passkeys.js'
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

function base64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
}

interface EmbeddedActiveWallet {
  mode: 'embedded'
  identityKey: string
  session: WalletSession | null
  localOnly?: boolean
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

interface PendingProvisioning {
  identityKey: string
  address: string
  tokens: readonly string[]
  network: NonNullable<AltudeWalletConfig['network']>
  submitting: boolean
  cancelled?: Error
  resolve: (result: Awaited<ReturnType<AltudeGasStation['createAccount']>>) => void
  reject: (error: Error) => void
}

export class AltudeWallet {
  readonly #auth: WalletAuthProvider
  readonly #api: EmbeddedWalletApi
  readonly #sessionTokens: NonNullable<AltudeWalletConfig['sessionTokenStore']>
  readonly #vault: WalletVault
  readonly #gasStation: AltudeGasStation
  #network: NonNullable<AltudeWalletConfig['network']>
  readonly #configuredNetwork: AltudeWalletConfig['network']
  readonly #externalWallets: readonly ExternalWalletProvider[]
  readonly #crypto: Crypto
  readonly #passkeys: NonNullable<AltudeWalletConfig['passkeys']>
  #passkeyAvailable = false
  readonly #pendingProvisioning = new Map<string, PendingProvisioning>()
  readonly #listeners = new Set<(event: WalletEvent) => void>()
  readonly #pendingTransactions = new Map<string, PendingTransaction>()
  readonly #pendingExternalConnections = new Set<ExternalWalletProviderId>()
  readonly #browserKeyGenerations = new Map<string, number>()
  readonly #usedBrowserTickets = new Set<string>()
  #active: ActiveWallet | null = null
  #lifecycleGeneration = 0
  #sessionTokenQueue: Promise<void> = Promise.resolve()

  constructor(config: AltudeWalletConfig) {
    this.#auth = config.auth
    this.#passkeys = config.passkeys ?? new BrowserPasskeyAdapter()
    this.#crypto = config.crypto ?? globalThis.crypto
    this.#api = new EmbeddedWalletApi(config.apiKey, config.apiBaseUrl, config.fetch)
    this.#sessionTokens = config.sessionTokenStore ?? new MemorySessionTokenStore()
    this.#vault = new WalletVault({
      ...(config.store ? { store: config.store } : {}),
      passkeys: this.#passkeys,
      ...(config.indexedDB ? { indexedDB: config.indexedDB } : {}),
      ...(config.crypto ? { crypto: config.crypto } : {}),
    })
    this.#network = config.network ?? 'mainnet-beta'
    this.#configuredNetwork = config.network
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
      custody:
        this.#active?.mode === 'embedded' && this.#active.localOnly
          ? 'local'
          : (this.#active?.mode ?? null),
      localIdentityKey:
        this.#active?.mode === 'embedded' && this.#active.localOnly
          ? this.#active.identityKey
          : null,
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
    this.#networkFromConfig(config.RpcEnvironment)
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
    return this.canUseLocalPasskey && typeof this.#auth.signInWithPasskey === 'function'
  }

  get canUseLocalPasskey(): boolean {
    return this.#passkeyAvailable
  }

  async getPasskeyAvailability(): Promise<boolean> {
    this.#passkeyAvailable = (await this.#passkeys.isAvailable?.()) ?? false
    return this.#passkeyAvailable
  }

  /** Create a passkey-protected local wallet without authenticating an API session. */
  async createLocalWallet(): Promise<WalletState> {
    if (this.#active)
      throw new AltudeWalletError(
        'SESSION',
        'Disconnect the active wallet before creating a local wallet.',
      )
    const generation = ++this.#lifecycleGeneration
    const token = await this.#withSessionTokens(generation, () => this.#sessionTokens.get())
    if (!this.#isCurrentLifecycle(generation)) return this.state
    if (token)
      throw new AltudeWalletError(
        'SESSION',
        'Sign out of the existing API session before creating a local wallet.',
      )
    if (!(await this.getPasskeyAvailability()))
      throw new AltudeWalletError(
        'PASSKEY_UNAVAILABLE',
        'A PRF-capable passkey authenticator is required.',
      )
    if (!this.#isCurrentLifecycle(generation)) return this.state
    const identityKey = `altude:local:v1:${this.#newId()}`
    let completed = false
    try {
      const address = await this.#vault.getOrCreateAddress(identityKey)
      if (!this.#isCurrentLifecycle(generation)) return this.state
      await this.#vault.protectWithPasskey(identityKey)
      if (!this.#isCurrentLifecycle(generation)) return this.state
      this.#replaceActive({
        mode: 'embedded',
        identityKey,
        address,
        protection: 'passkey',
        session: null,
        localOnly: true,
      })
      completed = true
      this.#emit({ type: 'state', state: this.state })
      return this.state
    } finally {
      if (!completed) {
        this.#vault.lock(identityKey)
        // This random local-only handle was never exposed or registered on the server.
        await this.#vault.delete(identityKey)
      }
    }
  }

  async openLocalWallet(identityKey: string): Promise<WalletState> {
    if (!identityKey.startsWith('altude:local:v1:'))
      throw new AltudeWalletError('INVALID_INPUT', 'A local-only wallet handle is required.')
    if (this.#active)
      throw new AltudeWalletError(
        'SESSION',
        'Disconnect the active wallet before opening a local wallet.',
      )
    const generation = ++this.#lifecycleGeneration
    this.#browserKeyGenerations.set(identityKey, generation)
    try {
      const token = await this.#withSessionTokens(generation, () => this.#sessionTokens.get())
      if (!this.#isCurrentLifecycle(generation)) return this.state
      if (token)
        throw new AltudeWalletError(
          'SESSION',
          'Sign out of the existing API session before opening a local wallet.',
        )
      const record = await this.#vault.findByIdentityKey(identityKey)
      if (!this.#isCurrentLifecycle(generation)) return this.state
      if (!record || record.protection !== 'passkey')
        throw new AltudeWalletError(
          'RECOVERY_REQUIRED',
          'The protected local wallet is not available in this browser.',
        )
      await this.#vault.unlockWithPasskey(identityKey)
      if (!this.#isCurrentLifecycle(generation)) return this.state
      this.#replaceActive({
        mode: 'embedded',
        identityKey,
        address: record.publicKey,
        protection: 'passkey',
        session: null,
        localOnly: true,
      })
      this.#emit({ type: 'state', state: this.state })
      return this.state
    } finally {
      if (!this.#isCurrentLifecycle(generation)) this.#lockStaleIdentity(identityKey)
      if (this.#browserKeyGenerations.get(identityKey) === generation)
        this.#browserKeyGenerations.delete(identityKey)
    }
  }

  /** Sign a copy locally. This neither authenticates a session nor relays a transaction. */
  async signMessage(message: Uint8Array): Promise<Uint8Array> {
    const active = this.#requireEmbeddedActive()
    const generation = this.#lifecycleGeneration
    const bytes = message.slice()
    const signer = await this.#vault.getSigner(active.identityKey)
    if (
      generation !== this.#lifecycleGeneration ||
      active !== this.#active ||
      !signer.signTransactionMessage
    ) {
      throw new AltudeWalletError('SESSION', 'The active wallet changed before signing.')
    }
    const signature = await signer.signTransactionMessage(bytes)
    if (
      generation !== this.#lifecycleGeneration ||
      active !== this.#active ||
      !this.#vault.isUnlocked(active.identityKey)
    ) {
      throw new AltudeWalletError(
        'WALLET_LOCKED',
        'The wallet changed before the signature was returned.',
      )
    }
    return signature
  }

  async signTransactionMessage(message: Uint8Array): Promise<Uint8Array> {
    return this.signMessage(message)
  }

  get externalWalletProviders(): readonly Pick<
    ExternalWalletProvider,
    'id' | 'label' | 'isAvailable'
  >[] {
    return this.#externalWallets.map((provider) => ({
      id: provider.id,
      label: provider.label,
      ...(provider.isAvailable ? { isAvailable: () => provider.isAvailable?.() ?? false } : {}),
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
    const auth = this.#auth
    if (typeof auth.verifyOtp !== 'function')
      throw new AltudeWalletError(
        'AUTHENTICATION',
        'This auth provider does not support OTP sign-in.',
      )
    const verifyOtp = auth.verifyOtp.bind(auth)
    return this.#authenticateAndConnect(() => verifyOtp(channel, identifier.trim(), code.trim()))
  }

  async signInWithOtp(channel: OtpChannel, identifier: string): Promise<WalletState> {
    const auth = this.#auth
    if (typeof auth.signInWithOtp !== 'function') {
      throw new AltudeWalletError(
        'AUTHENTICATION',
        'This auth provider does not support hosted OTP sign-in.',
      )
    }
    const value = identifier.trim()
    if (!value)
      throw new AltudeWalletError('INVALID_INPUT', 'Enter an email address or phone number.')
    const signInWithOtp = auth.signInWithOtp.bind(auth)
    return this.#authenticateAndConnect(() => signInWithOtp(channel, value))
  }

  async signInWithSocial(provider: string): Promise<WalletState> {
    const auth = this.#auth
    if (typeof auth.signInWithSocial !== 'function')
      throw new AltudeWalletError(
        'AUTHENTICATION',
        'This auth provider does not support social sign-in.',
      )
    const signInWithSocial = auth.signInWithSocial.bind(auth)
    return this.#authenticateAndConnect(() => signInWithSocial(provider))
  }

  async signInWithPasskey(): Promise<WalletState> {
    const auth = this.#auth
    if (typeof auth.signInWithPasskey !== 'function') {
      throw new AltudeWalletError(
        'AUTHENTICATION',
        'This auth provider does not support passkey authentication.',
      )
    }
    const signInWithPasskey = auth.signInWithPasskey.bind(auth)
    return this.#authenticateAndConnect(() => signInWithPasskey())
  }

  async #authenticateAndConnect(
    authenticate: () => Promise<WalletIdentityToken>,
  ): Promise<WalletState> {
    const generation = ++this.#lifecycleGeneration
    let identity: WalletIdentityToken
    try {
      identity = await authenticate()
    } catch (error) {
      if (!this.#isCurrentLifecycle(generation)) return this.state
      throw error
    }
    if (!this.#isCurrentLifecycle(generation)) return this.state
    return this.connect(identity)
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
    if (identity.broker) return this.#connectBrowser(identity, generation)
    this.#browserKeyGenerations.set(identity.identityKey, generation)
    try {
      return await this.#connectLegacy(identity, generation)
    } finally {
      if (this.#browserKeyGenerations.get(identity.identityKey) === generation) {
        this.#browserKeyGenerations.delete(identity.identityKey)
      }
    }
  }

  async #connectLegacy(
    identity: WalletIdentityToken & { accessToken: string },
    generation: number,
  ): Promise<WalletState> {
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

  async #connectBrowser(identity: WalletIdentityToken, generation: number): Promise<WalletState> {
    const broker = identity.broker
    if (!broker || broker.walletAccessVersion !== 1 || !broker.appId) {
      throw new AltudeWalletError('CONFIGURATION', 'Browser wallet access binding v1 is required.')
    }
    if (this.#usedBrowserTickets.has(broker.identityTicket)) {
      throw new AltudeWalletError(
        'AUTHENTICATION',
        'This identity ticket was already submitted. Restart sign-in; session binding is never retried.',
      )
    }
    let localIdentity: string | undefined
    let access: BrowserWalletAccess | undefined
    const current = () => {
      if (!this.#isCurrentLifecycle(generation)) {
        throw new AltudeWalletError('SESSION', 'Wallet sign-in was superseded.')
      }
    }
    try {
      this.#emit({ type: 'setup:progress', stage: 'connecting-account' })
      const appId = await this.#api.browserAppId()
      current()
      if (appId !== broker.appId) {
        throw new AltudeWalletError(
          'AUTHENTICATION',
          'The browser identity belongs to a different application.',
        )
      }
      access = await this.#api.getBrowserWallet(broker.identityTicket)
      current()
      if (access.appId !== appId || access.identityKey !== identity.identityKey) {
        throw new AltudeWalletError(
          'INVALID_RESPONSE',
          'The authoritative wallet identity does not match this sign-in.',
        )
      }
      await this.#validateBrowserMessage(access, broker.identityTicket)
      current()
      localIdentity = this.#api.browserIdentityKey(access.appId, access.userId)
      this.#browserKeyGenerations.set(localIdentity, generation)
      this.#vault.lock(localIdentity)
      this.#emit({ type: 'setup:progress', stage: 'securing-device' })
      const address = await this.#vault.resolveAssociatedAddress(
        localIdentity,
        access.walletAddress,
      )
      current()
      const protection = await this.#vault.protection(localIdentity)
      current()
      if (protection === 'passkey') await this.#vault.unlockWithPasskey(localIdentity)
      else await this.#vault.unlock(localIdentity)
      current()
      const signer = await this.#vault.getSigner(localIdentity)
      current()
      if (signer.address !== address) {
        throw new AltudeWalletError(
          'RECOVERY_REQUIRED',
          'The signing key does not match the registered wallet.',
        )
      }
      if (!signer.signTransactionMessage) {
        throw new AltudeWalletError(
          'WALLET_LOCKED',
          'The local wallet cannot sign the wallet access proof.',
        )
      }
      const signature = await signer.signTransactionMessage(
        new TextEncoder().encode(access.message),
      )
      current()
      if (signature.length !== 64) {
        throw new AltudeWalletError(
          'INVALID_RESPONSE',
          'The wallet access signature must be a 64-byte Ed25519 signature.',
        )
      }
      if (this.#usedBrowserTickets.has(broker.identityTicket)) {
        throw new AltudeWalletError(
          'AUTHENTICATION',
          'This identity ticket was already submitted. Restart sign-in.',
        )
      }
      this.#usedBrowserTickets.add(broker.identityTicket)
      const result = await this.#api.exchangeBrowserBroker(
        broker.identityTicket,
        address,
        access.challengeId,
        base64(signature),
      )
      current()
      if (
        result.appId !== access.appId ||
        result.userId !== access.userId ||
        result.user.walletAddress !== address
      ) {
        throw new AltudeWalletError(
          'SESSION',
          'The API session scope or wallet does not match the authoritative local wallet.',
        )
      }
      await this.#vault.associateServerUser(localIdentity, result.userId)
      current()
      this.#emit({ type: 'setup:progress', stage: 'finishing' })
      await this.#withSessionTokens(generation, () => this.#sessionTokens.set(result.token))
      current()
      this.#replaceActive({
        mode: 'embedded',
        identityKey: localIdentity,
        address,
        protection,
        session: { user: result.user, appId: result.appId, userId: result.userId },
      })
      this.#emit({ type: 'state', state: this.state })
      return this.state
    } catch (error) {
      if (localIdentity && this.#browserKeyGenerations.get(localIdentity) === generation) {
        if (this.#isCurrentLifecycle(generation)) this.#vault.lock(localIdentity)
        else this.#lockStaleIdentity(localIdentity)
      }
      if (!this.#isCurrentLifecycle(generation)) return this.state
      if (error instanceof BrowserWalletConflictError && access && localIdentity) {
        if (error.appId !== access.appId || error.userId !== access.userId) {
          throw new AltudeWalletError(
            'INVALID_RESPONSE',
            'The wallet conflict belongs to a different application or user.',
          )
        }
        // A conflict consumes the ticket. Inspect locally but never repeat the session exchange.
        try {
          await this.#vault.resolveAssociatedAddress(localIdentity, error.walletAddress)
        } catch (recoveryError) {
          if (!this.#isCurrentLifecycle(generation)) return this.state
          throw recoveryError
        }
        if (!this.#isCurrentLifecycle(generation)) return this.state
      }
      throw error
    } finally {
      if (localIdentity && this.#browserKeyGenerations.get(localIdentity) === generation) {
        this.#browserKeyGenerations.delete(localIdentity)
      }
    }
  }

  async #validateBrowserMessage(access: BrowserWalletAccess, ticket: string): Promise<void> {
    if (!/^[A-Za-z0-9_-]+$/.test(ticket)) {
      throw new AltudeWalletError(
        'INVALID_RESPONSE',
        'The browser identity ticket must be an ASCII base64url value.',
      )
    }
    const digest = await this.#crypto.subtle.digest(
      'SHA-256',
      toArrayBuffer(new TextEncoder().encode(ticket)),
    )
    const ticketHash = base64(new Uint8Array(digest))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
    const lines = access.message.split('\n')
    if (
      lines.length !== 12 ||
      access.message.includes('\r') ||
      lines[0] !== 'Altude Wallet Access Binding v1' ||
      lines[1] !== `Issuer: ${this.#api.browserOrigin}` ||
      lines[2] !== `AppId: ${access.appId}` ||
      !/^TenantId: -?\d+$/.test(lines[3] ?? '') ||
      lines[4] !== `UserId: ${access.userId}` ||
      lines[5] !== `IdentityKey: ${access.identityKey}` ||
      lines[6] !== 'RefreshFamilyId: browser' ||
      !lines[7]?.startsWith('Origin: ') ||
      (typeof location !== 'undefined' && lines[7] !== `Origin: ${location.origin}`) ||
      lines[8] !== `IdentityTicket: ${ticketHash}` ||
      lines[9] !== `ChallengeId: ${access.challengeId}` ||
      lines[10] !== `WalletAddress: ${access.walletAddress ?? ''}` ||
      !lines[11]?.startsWith('Nonce: ') ||
      lines[11].length <= 7
    ) {
      throw new AltudeWalletError(
        'INVALID_RESPONSE',
        'The browser broker returned an invalid or mismatched wallet access proof message.',
      )
    }
  }

  async connectExternalWallet(providerId: ExternalWalletProviderId): Promise<WalletState> {
    const provider = this.#externalWallets.find((candidate) => candidate.id === providerId)
    if (!provider) {
      throw new AltudeWalletError(
        'CONFIGURATION',
        `External wallet provider "${providerId}" is not configured.`,
      )
    }
    if (provider.isAvailable?.() === false) {
      throw new AltudeWalletError(
        'CONFIGURATION',
        `External wallet provider "${providerId}" is unavailable in this browser.`,
      )
    }
    if (this.#active) {
      throw new AltudeWalletError(
        'SESSION',
        'Sign out or disconnect the current wallet before connecting an external wallet.',
      )
    }
    if (this.#pendingExternalConnections.has(providerId)) {
      throw new AltudeWalletError(
        'SESSION',
        `An external wallet connection for "${providerId}" is already in progress.`,
      )
    }
    this.#pendingExternalConnections.add(providerId)
    try {
      return await this.#connectExternalWallet(provider)
    } finally {
      this.#pendingExternalConnections.delete(providerId)
    }
  }

  async #connectExternalWallet(provider: ExternalWalletProvider): Promise<WalletState> {
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
      if (session.appId && session.userId) {
        const appId = await this.#api.browserAppId()
        if (!this.#isCurrentLifecycle(generation)) return this.state
        if (appId !== session.appId || !session.user.walletAddress) {
          throw new AltudeWalletError(
            'SESSION',
            'The restored wallet session belongs to a different application or has no registered address.',
          )
        }
        const identityKey = this.#api.browserIdentityKey(appId, session.userId)
        await this.#vault.resolveAssociatedAddress(identityKey, session.user.walletAddress)
        if (!this.#isCurrentLifecycle(generation)) return this.state
        record = await this.#vault.findByIdentityKey(identityKey)
      } else {
        if (this.#auth.browserBroker) {
          throw new AltudeWalletError(
            'WALLET_SCOPE_MIGRATION_REQUIRED',
            'This legacy session cannot restore a broker wallet. Restart sign-in after an explicit wallet-scope migration.',
          )
        }
        record = await this.#vault.findByServerUserId(session.user.id)
        if (record?.identityKey.startsWith('altude:browser:v1:')) {
          throw new AltudeWalletError(
            'WALLET_SCOPE_MIGRATION_REQUIRED',
            'A legacy session cannot access an application-scoped broker wallet.',
          )
        }
      }
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
    this.#vault.lock()
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
    return this.#requestValidatedTransaction(snapshot)
  }

  async #requestValidatedTransaction(
    snapshot: WalletTransactionIntentSnapshot,
  ): Promise<WalletTransactionResult> {
    const active = this.#requireActive()
    const generation = this.#lifecycleGeneration
    const network = await this.#approvedNetwork()
    if (generation !== this.#lifecycleGeneration || active !== this.#active)
      throw new AltudeWalletError('SESSION', 'The wallet changed before transaction confirmation.')
    if (snapshot.network && snapshot.network !== network)
      throw new AltudeWalletError(
        'INVALID_INPUT',
        'The approved network does not match the authoritative RPC environment.',
      )
    const approvedSnapshot = Object.freeze({ ...snapshot, network })
    const id = this.#newId()
    const result = new Promise<WalletTransactionResult>((resolve, reject) => {
      this.#pendingTransactions.set(id, {
        intent: approvedSnapshot,
        walletMode: active.mode,
        ...(active.mode === 'embedded' ? { identityKey: active.identityKey } : {}),
        ...(active.mode === 'external' ? { providerId: active.providerId } : {}),
        address: active.address,
        submitting: false,
        resolve,
        reject,
      })
    })
    this.#emit(Object.freeze({ type: 'transaction:confirmation', id, intent: approvedSnapshot }))
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
      await this.#approvedNetwork(pending.intent.network)
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
      const signTransactionMessage = signer.signTransactionMessage
      const sign = signer.sign
      const cancellableSigner = {
        address: signer.address,
        ...(signTransactionMessage
          ? {
              signTransactionMessage: async (txBytes: Uint8Array) => {
                this.#assertNotCancelled(pending)
                await this.#approvedNetwork(pending.intent.network)
                this.#assertNotCancelled(pending)
                const signature = await signTransactionMessage.call(signer, txBytes)
                this.#assertNotCancelled(pending)
                await this.#approvedNetwork(pending.intent.network)
                this.#assertNotCancelled(pending)
                return signature
              },
            }
          : {}),
        ...(sign
          ? {
              sign: async (txBytes: Uint8Array) => {
                this.#assertNotCancelled(pending)
                await this.#approvedNetwork(pending.intent.network)
                this.#assertNotCancelled(pending)
                const signature = await sign.call(signer, txBytes)
                this.#assertNotCancelled(pending)
                await this.#approvedNetwork(pending.intent.network)
                this.#assertNotCancelled(pending)
                return signature
              },
            }
          : {}),
      }
      const response = await this.#gasStation.send({
        ...(pending.intent.network ? { expectedNetwork: pending.intent.network } : {}),
        sourceSigner: cancellableSigner,
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

  async createAccount(tokens: string[] = [], signal?: AbortSignal) {
    const active = this.#requireEmbeddedActive()
    const generation = this.#lifecycleGeneration
    const assertNotAborted = () => {
      if (signal?.aborted)
        throw new AltudeWalletError('TRANSACTION', 'Account provisioning was cancelled.')
    }
    assertNotAborted()
    const snapshot = Object.freeze([...tokens])
    for (const token of snapshot) assertSolanaAddress(token, 'Token mint')
    await this.#vault.getSigner(active.identityKey)
    const network = await this.#approvedNetwork()
    assertNotAborted()
    if (generation !== this.#lifecycleGeneration || active !== this.#active)
      throw new AltudeWalletError('SESSION', 'The wallet changed before provisioning confirmation.')
    const id = this.#newId()
    const result = new Promise<Awaited<ReturnType<AltudeGasStation['createAccount']>>>(
      (resolve, reject) => {
        this.#pendingProvisioning.set(id, {
          identityKey: active.identityKey,
          address: active.address,
          tokens: snapshot,
          network,
          submitting: false,
          resolve,
          reject,
        })
      },
    )
    const abort = () => {
      this.rejectProvisioning(id)
    }
    signal?.addEventListener('abort', abort, { once: true })
    try {
      this.#emit(
        Object.freeze({ type: 'provisioning:confirmation', id, tokens: snapshot, network }),
      )
      return await result
    } finally {
      signal?.removeEventListener('abort', abort)
    }
  }

  async approveProvisioning(id: string) {
    const pending = this.#pendingProvisioning.get(id)
    if (!pending || pending.submitting)
      throw new AltudeWalletError(
        'TRANSACTION',
        'This provisioning request is unavailable or already submitting.',
      )
    pending.submitting = true
    const check = () => {
      if (pending.cancelled) throw pending.cancelled
      const active = this.#requireEmbeddedActive()
      if (active.identityKey !== pending.identityKey || active.address !== pending.address)
        throw new AltudeWalletError('SESSION', 'The active wallet changed before provisioning.')
      if (!this.#vault.isUnlocked(active.identityKey))
        throw new AltudeWalletError('WALLET_LOCKED', 'Unlock the wallet before provisioning.')
    }
    try {
      check()
      await this.#approvedNetwork(pending.network)
      const signer = await this.#vault.getSigner(pending.identityKey)
      const sign = signer.signTransactionMessage
      if (!sign)
        throw new AltudeWalletError('WALLET_LOCKED', 'The wallet cannot sign provisioning.')
      check()
      const result = await this.#gasStation.createAccount({
        account: pending.address,
        tokens: [...pending.tokens],
        expectedNetwork: pending.network,
        signer: {
          address: signer.address,
          signTransactionMessage: async (bytes) => {
            check()
            await this.#approvedNetwork(pending.network)
            check()
            const signature = await sign(bytes)
            check()
            await this.#approvedNetwork(pending.network)
            check()
            return signature
          },
        },
      })
      check()
      if (
        result.Status?.toLowerCase() !== 'success' ||
        (!result.Signature && result.Message !== 'Account already exists')
      ) {
        throw new AltudeWalletError(
          'TRANSACTION',
          result.Message || 'Account provisioning did not succeed.',
        )
      }
      pending.resolve(result)
      this.#emit({ type: 'provisioning:complete', id, result })
      return result
    } catch (error) {
      const normalized = pending.cancelled ?? asError(error)
      pending.reject(normalized)
      if (!pending.cancelled) this.#emit({ type: 'provisioning:error', id, error: normalized })
      throw normalized
    } finally {
      this.#pendingProvisioning.delete(id)
    }
  }

  rejectProvisioning(id: string): void {
    const pending = this.#pendingProvisioning.get(id)
    if (!pending) return
    pending.cancelled = new AltudeWalletError(
      'TRANSACTION',
      'The wallet user rejected account provisioning.',
    )
    pending.reject(pending.cancelled)
    this.#pendingProvisioning.delete(id)
  }

  async getBalance(token?: string) {
    const active = this.#requireActive()
    if (active.mode === 'external' && active.chain !== 'solana') {
      throw new AltudeWalletError(
        'TRANSACTION',
        'Balance lookup is only available for Solana wallets.',
      )
    }
    if (active.mode === 'external')
      assertSolanaAddress(active.address, 'External Solana wallet address')
    if (token) assertSolanaAddress(token, 'Token mint')
    return this.#gasStation.getBalance({ address: active.address, ...(token ? { token } : {}) })
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
    for (const [id, pending] of this.#pendingProvisioning) {
      pending.cancelled = new AltudeWalletError('SESSION', message)
      pending.reject(pending.cancelled)
      this.#pendingProvisioning.delete(id)
    }
    for (const [id, pending] of this.#pendingTransactions) {
      pending.cancelled = new AltudeWalletError('SESSION', message)
      pending.reject(pending.cancelled)
      this.#pendingTransactions.delete(id)
    }
  }

  #assertNotCancelled(pending: PendingTransaction): void {
    if (pending.cancelled) throw pending.cancelled
  }

  #networkFromConfig(environment: string): NonNullable<AltudeWalletConfig['network']> {
    const value = typeof environment === 'string' ? environment.toLowerCase() : ''
    const network = value === 'mainnet' ? 'mainnet-beta' : value
    if (network !== 'mainnet-beta' && network !== 'devnet' && network !== 'testnet')
      throw new AltudeWalletError(
        'INVALID_RESPONSE',
        'Transaction config did not return a supported RpcEnvironment.',
      )
    if (this.#configuredNetwork && network !== this.#configuredNetwork)
      throw new AltudeWalletError(
        'TRANSACTION',
        'The authoritative RPC environment does not match the configured wallet network.',
      )
    this.#network = network
    return network
  }

  async #approvedNetwork(
    expected?: AltudeWalletConfig['network'],
  ): Promise<NonNullable<AltudeWalletConfig['network']>> {
    const config = await this.#gasStation.getConfig(true)
    const network = this.#networkFromConfig(config.RpcEnvironment)
    if (expected && network !== expected)
      throw new AltudeWalletError(
        'TRANSACTION',
        'The authoritative RPC environment changed after approval. Review the network again.',
      )
    return network
  }

  #isCurrentLifecycle(generation: number): boolean {
    return generation === this.#lifecycleGeneration
  }

  #lockStaleIdentity(identityKey: string): void {
    if (this.#browserKeyGenerations.get(identityKey) === this.#lifecycleGeneration) return
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
    if (!identity.broker && identity.identityKey.startsWith('altude:browser:v1:')) {
      throw new AltudeWalletError(
        'AUTHENTICATION',
        'Legacy identity adapters cannot select application-scoped broker keys.',
      )
    }
    const credential = identity.broker ? identity.broker.identityTicket : identity.accessToken
    if (!credential.trim())
      throw new AltudeWalletError(
        'AUTHENTICATION',
        'The identity provider must return an access token or a browser identity ticket.',
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
    if (intent.network && this.#configuredNetwork && intent.network !== this.#configuredNetwork) {
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
