export type NativeWalletErrorCode =
  | 'CONFIGURATION'
  | 'NETWORK'
  | 'API'
  | 'INVALID_RESPONSE'
  | 'AUTHENTICATION'
  | 'CANCELLED'
  | 'BROWSER'
  | 'SECURE_STORAGE'
  | 'SESSION'
  | 'CONCURRENT_OPERATION'
  | 'RECOVERY_REQUIRED'
  | 'LOCKED'
  | 'WALLET_CONFLICT'
  | 'INVALID_INPUT'
  | 'WALLET_SCOPE_MIGRATION_REQUIRED'

export class NativeWalletError extends Error {
  readonly code: NativeWalletErrorCode
  readonly status: number | undefined

  constructor(code: NativeWalletErrorCode, message: string, status?: number, cause?: unknown) {
    super(message, { cause })
    this.name = 'NativeWalletError'
    this.code = code
    this.status = status
  }
}
