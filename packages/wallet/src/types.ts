import type { GetHistoryOptions, GetHistoryResponse } from '@altude/gasstation'
import type { AltudeGasStation } from '@altude/gasstation'

export type WalletProtection = 'device-local' | 'passkey'
export type OtpChannel = 'email' | 'sms'

export interface WalletIdentityToken {
  /** Access token for the API's configured Auth0 audience. The API validates it. */
  accessToken: string
  /**
   * Stable opaque identity key from the configured identity SDK. It is used
   * only to select this browser's local key; it never authenticates a session.
   */
  identityKey: string
}

export interface WalletUser {
  id: string
  email?: string | null
  phoneNumber?: string | null
  walletAddress?: string | null
}

export interface WalletSession {
  user: WalletUser
  expiresAt?: string | null
}

export interface WalletAuthProvider {
  startOtp?(channel: OtpChannel, identifier: string): Promise<void>
  verifyOtp?(channel: OtpChannel, identifier: string, code: string): Promise<WalletIdentityToken>
  signInWithSocial?(provider: string): Promise<WalletIdentityToken>
  /** Must return an API-audience access token from a server-validated auth flow. */
  signInWithPasskey?(): Promise<WalletIdentityToken>
}

export type WalletTransactionIntent =
  | {
      kind: 'sol-transfer'
      recipient: string
      /** Amount in lamports. */
      amount: number
      network?: 'mainnet-beta' | 'devnet' | 'testnet'
    }
  | {
      kind: 'spl-transfer'
      recipient: string
      mint: string
      /** Amount in the token's smallest unit. */
      amount: number
      network?: 'mainnet-beta' | 'devnet' | 'testnet'
    }

export type WalletTransactionIntentSnapshot = Readonly<WalletTransactionIntent>

export interface WalletTransactionResult {
  signature: string
  status?: string
  message?: string
}

export type WalletTransferHistoryOptions = GetHistoryOptions
export type WalletTransferHistory = GetHistoryResponse

export interface WalletState {
  status: 'disconnected' | 'connected' | 'locked'
  session: WalletSession | null
  address: string | null
  protection: WalletProtection | null
}

export type WalletEvent =
  | { type: 'state'; state: WalletState }
  | { type: 'transaction:confirmation'; id: string; intent: WalletTransactionIntentSnapshot }
  | { type: 'transaction:complete'; id: string; result: WalletTransactionResult }
  | { type: 'transaction:error'; id: string; error: Error }

export interface WalletStoreRecord {
  identityKey: string
  publicKey: string
  serverUserId?: string
  protection: WalletProtection
  secret?: Uint8Array
  ciphertext?: Uint8Array
  iv?: Uint8Array
  prfSalt?: Uint8Array
  credentialId?: Uint8Array
  rpId?: string
}

export interface WalletStoreCreateResult {
  record: WalletStoreRecord
  created: boolean
}

export interface WalletStore {
  get(identityKey: string): Promise<WalletStoreRecord | undefined>
  getByServerUserId(serverUserId: string): Promise<WalletStoreRecord | undefined>
  createIfAbsent(record: WalletStoreRecord): Promise<WalletStoreCreateResult>
  put(record: WalletStoreRecord): Promise<void>
  delete(identityKey: string): Promise<void>
}

export interface SessionTokenStore {
  get(): Promise<string | null>
  set(token: string): Promise<void>
  clear(): Promise<void>
}

export interface WalletVaultOptions {
  store?: WalletStore
  passkeys?: PasskeyAdapter
  indexedDB?: IDBFactory
  crypto?: Crypto
}

export interface PasskeyAdapter {
  register(input: {
    challenge: Uint8Array
    userId: Uint8Array
    userName: string
    rpId: string
    rpName: string
    prfSalt: Uint8Array
  }): Promise<{ credentialId: Uint8Array; kek?: Uint8Array }>
  deriveKey(input: {
    challenge: Uint8Array
    credentialId: Uint8Array
    rpId: string
    prfSalt: Uint8Array
  }): Promise<Uint8Array>
}

export interface AltudeWalletConfig {
  apiKey: string
  /** Base URL of the Altude API deployment, including scheme. */
  apiBaseUrl: string
  network?: 'mainnet-beta' | 'devnet' | 'testnet'
  auth: WalletAuthProvider
  store?: WalletStore
  sessionTokenStore?: SessionTokenStore
  passkeys?: PasskeyAdapter
  indexedDB?: IDBFactory
  crypto?: Crypto
  fetch?: typeof fetch
  gasStation?: AltudeGasStation
}

export interface WalletUiOptions {
  presentation?: 'modal' | 'inline' | 'fullscreen'
  title?: string
  socialProviders?: readonly string[]
  onClose?: () => void
}
