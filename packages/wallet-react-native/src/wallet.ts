import { AltudeGasStation, getConfigNetwork } from '@altude/gasstation'
import type { GaslessTransactionSigner, SendTransactionResponse, SolanaNetwork } from '@altude/gasstation'
import { NativeWalletClient } from './client.js'
import type { NativeWalletClientOptions } from './client.js'
import { NativeWalletError } from './errors.js'
import { NativeWalletSessionAdapter } from './session.js'
import type { NativeWalletAccessSession } from './session.js'
import { NativeWalletVault } from './vault.js'
import type { NativeWalletKeyStore } from './vault.js'

export type NativeWalletStatus =
  | 'disconnected'
  | 'authenticating'
  | 'authenticated'
  | 'creating'
  | 'recovering'
  | 'recovery-required'
  | 'locked'
  | 'ready'
  | 'failed'

export interface NativeWalletState {
  readonly status: NativeWalletStatus
  readonly appId: string | null
  readonly walletUserId: string | null
  readonly address: string | null
}

export type NativeWalletEvent =
  | { type: 'state'; state: NativeWalletState }
  | {
      type: 'setup:progress'
      stage: 'authenticating' | 'connecting-account' | 'securing-device' | 'finishing'
    }

export type NativeWalletTransfer =
  | { readonly kind: 'sol-transfer'; readonly recipient: string; readonly amount: number }
  | {
      readonly kind: 'spl-transfer'
      readonly recipient: string
      readonly amount: number
      readonly mint: string
    }

export type NativeWalletTransferApproval = NativeWalletTransfer & {
  readonly network: SolanaNetwork
}

export interface AltudeNativeWalletOptions extends Omit<NativeWalletClientOptions, 'onSignedOut'> {
  keyStore: NativeWalletKeyStore
}

export class AltudeNativeWallet {
  readonly #auth: NativeWalletClient
  readonly #sessions: NativeWalletSessionAdapter
  readonly #vault: NativeWalletVault
  readonly #station: AltudeGasStation
  readonly #now: () => number
  readonly #listeners = new Set<(event: NativeWalletEvent) => void>()
  #state: NativeWalletState = Object.freeze({
    status: 'disconnected',
    appId: null,
    walletUserId: null,
    address: null,
  })
  #session: NativeWalletAccessSession | undefined
  #signer: GaslessTransactionSigner | undefined
  #generation = 0
  #connecting = false
  #signingOut = false
  #expiryTimer: ReturnType<typeof setTimeout> | undefined

  constructor(options: AltudeNativeWalletOptions) {
    this.#auth = new NativeWalletClient(options)
    this.#sessions = new NativeWalletSessionAdapter(this.#auth, options)
    this.#vault = new NativeWalletVault(options.keyStore, options.randomBytes)
    this.#station = new AltudeGasStation({ apiKey: options.apiKey, baseUrl: options.apiBaseUrl })
    this.#now = options.now ?? Date.now
  }

  get state(): NativeWalletState {
    if (this.#session && this.#session.expiresAt <= this.#now()) this.lock()
    return this.#state
  }

  onEvent(listener: (event: NativeWalletEvent) => void): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  async connect(): Promise<NativeWalletState> {
    return this.#connect(false)
  }

  async restore(): Promise<NativeWalletState> {
    return this.#connect(true)
  }

  lock(): void {
    this.#invalidate()
    this.#setState('locked')
  }

  async signOut(): Promise<void> {
    if (this.#signingOut)
      throw new NativeWalletError('CONCURRENT_OPERATION', 'Wallet sign-out is already in progress.')
    this.#signingOut = true
    this.#invalidate()
    try {
      this.#setState('disconnected', null, null, null)
    } finally {
      // Local signer/session cleanup precedes network revocation, including listener failures.
      try {
        await this.#auth.signOut()
      } finally {
        this.#signingOut = false
      }
    }
  }

  async sendTransfer(
    intent: NativeWalletTransfer,
    authorize: (intent: NativeWalletTransferApproval) => boolean | Promise<boolean>,
  ): Promise<SendTransactionResponse> {
    const kind: unknown = intent.kind
    if (kind !== 'sol-transfer' && kind !== 'spl-transfer') {
      throw new NativeWalletError('INVALID_INPUT', 'Unsupported wallet transfer kind.')
    }
    const snapshot: NativeWalletTransfer = Object.freeze(
      intent.kind === 'sol-transfer'
        ? { kind: intent.kind, recipient: intent.recipient, amount: intent.amount }
        : {
            kind: intent.kind,
            recipient: intent.recipient,
            amount: intent.amount,
            mint: intent.mint,
          },
    )
    if (
      typeof snapshot.recipient !== 'string' ||
      !snapshot.recipient.trim() ||
      !Number.isSafeInteger(snapshot.amount) ||
      snapshot.amount <= 0 ||
      (snapshot.kind === 'spl-transfer' &&
        (typeof snapshot.mint !== 'string' || !snapshot.mint.trim())) ||
      typeof authorize !== 'function'
    ) {
      throw new NativeWalletError(
        'INVALID_INPUT',
        'A positive transfer amount, recipient, and local authorization are required.',
      )
    }
    const generation = this.#generation
    const signer = await this.#authorizedSigner(generation)
    const network = getConfigNetwork(await this.#station.getConfig(true))
    this.#assertCurrent(generation)
    const approval: NativeWalletTransferApproval = Object.freeze({ ...snapshot, network })
    if (!(await authorize(approval)))
      throw new NativeWalletError('CANCELLED', 'The wallet transfer was not approved.')
    this.#assertCurrent(generation)
    const guardedSigner: GaslessTransactionSigner = {
      address: signer.address,
      signTransactionMessage: async (bytes) => {
        const current = await this.#authorizedSigner(generation)
        if (!current.signTransactionMessage)
          throw new NativeWalletError('LOCKED', 'The wallet transaction signer is unavailable.')
        const signature = await current.signTransactionMessage(bytes)
        this.#assertCurrent(generation)
        return signature
      },
    }
    // Gas Station owns fresh blockhash, configured RPC/JWT and fee-payer selection.
    const result = await this.#station.send({
      toAddress: snapshot.recipient,
      amount: snapshot.amount,
      ...(snapshot.kind === 'spl-transfer' ? { token: snapshot.mint } : {}),
      sourceSigner: guardedSigner,
      expectedNetwork: network,
      beforeDispatch: () => {
        this.#assertCurrent(generation)
        void this.state
        this.#assertCurrent(generation)
      },
    })
    this.#assertCurrent(generation)
    return result
  }

  async #connect(restore: boolean): Promise<NativeWalletState> {
    if (this.#connecting || this.#signingOut)
      throw new NativeWalletError(
        'CONCURRENT_OPERATION',
        'Wallet setup or sign-out is already in progress.',
      )
    this.#connecting = true
    this.#invalidate()
    const generation = this.#generation
    try {
      this.#setState('authenticating', null, null, null)
      this.#progress('authenticating')
      this.#assertCurrent(generation)
      if (!restore) {
        await this.#auth.signOut()
        this.#assertCurrent(generation)
      }
      const identity = restore ? await this.#auth.restoreSession() : await this.#auth.signIn()
      this.#assertCurrent(generation)
      if (!identity) {
        this.#setState('disconnected', null, null, null)
        return this.#state
      }
      this.#setState('authenticated')
      this.#progress('connecting-account')
      this.#assertCurrent(generation)
      let access = await this.#sessions.lookup()
      this.#assertCurrent(generation)
      this.#setState('authenticated', access.appId, access.walletUserId, access.walletAddress)
      let address = access.walletAddress
      this.#progress('securing-device')
      this.#assertCurrent(generation)
      if (address === null) {
        this.#setState('creating')
        this.#assertCurrent(generation)
        address = await this.#vault.create(access)
        this.#assertCurrent(generation)
      } else {
        this.#setState('recovering')
        this.#assertCurrent(generation)
      }
      let signer = await this.#vault.unlock(access, address)
      this.#assertCurrent(generation)
      let session: NativeWalletAccessSession
      try {
        session = await this.#sessions.establish(access, signer)
      } catch (error) {
        if (!(error instanceof NativeWalletError) || error.code !== 'WALLET_CONFLICT') throw error
        this.#assertCurrent(generation)
        this.#vault.lock()
        access = await this.#sessions.lookup()
        this.#assertCurrent(generation)
        if (!access.walletAddress)
          throw new NativeWalletError(
            'INVALID_RESPONSE',
            'A wallet conflict did not resolve to a registered address.',
          )
        this.#setState('recovering', access.appId, access.walletUserId, access.walletAddress)
        this.#assertCurrent(generation)
        signer = await this.#vault.unlock(access, access.walletAddress)
        this.#assertCurrent(generation)
        session = await this.#sessions.establish(access, signer)
      }
      this.#assertCurrent(generation)
      this.#progress('finishing')
      this.#assertCurrent(generation)
      await this.#sessions.validate(session)
      this.#assertCurrent(generation)
      this.#session = session
      this.#signer = signer
      this.#expiryTimer = setTimeout(
        () => {
          this.lock()
        },
        Math.min(session.expiresAt - this.#now(), 2_147_483_647),
      )
      this.#setState('ready', session.appId, session.walletUserId, session.address)
      this.#assertCurrent(generation)
      return this.state
    } catch (error) {
      if (generation === this.#generation) {
        this.#invalidate()
        this.#setState(
          error instanceof NativeWalletError && error.code === 'RECOVERY_REQUIRED'
            ? 'recovery-required'
            : 'failed',
        )
      }
      throw error
    } finally {
      this.#connecting = false
    }
  }

  async #authorizedSigner(generation: number): Promise<GaslessTransactionSigner> {
    this.#assertCurrent(generation)
    const session = this.#session
    const signer = this.#signer
    if (!session || !signer || this.state.status !== 'ready') {
      throw new NativeWalletError(
        'LOCKED',
        'Connect or restore the expected wallet before signing.',
      )
    }
    try {
      if (!(await this.#auth.getAccessToken())) {
        throw new NativeWalletError('AUTHENTICATION', 'The native identity session is unavailable.')
      }
      await this.#sessions.validate(session)
      this.#assertCurrent(generation)
      return signer
    } catch (error) {
      if (generation === this.#generation) {
        this.#invalidate()
        this.#setState('failed')
      }
      throw error
    }
  }

  #invalidate(): void {
    this.#generation += 1
    this.#vault.lock()
    this.#session = undefined
    this.#signer = undefined
    if (this.#expiryTimer !== undefined) clearTimeout(this.#expiryTimer)
    this.#expiryTimer = undefined
  }

  #assertCurrent(generation: number): void {
    if (generation !== this.#generation)
      throw new NativeWalletError('SESSION', 'The wallet operation was superseded.')
  }

  #setState(
    status: NativeWalletStatus,
    appId = this.#state.appId,
    walletUserId = this.#state.walletUserId,
    address = this.#state.address,
  ): void {
    this.#state = Object.freeze({ status, appId, walletUserId, address })
    this.#emit({ type: 'state', state: this.#state })
  }

  #progress(stage: Extract<NativeWalletEvent, { type: 'setup:progress' }>['stage']): void {
    this.#emit({ type: 'setup:progress', stage })
  }

  #emit(event: NativeWalletEvent): void {
    for (const listener of this.#listeners) listener(Object.freeze(event))
  }
}
