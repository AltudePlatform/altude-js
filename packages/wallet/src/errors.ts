export type WalletErrorCode =
  | 'CONFIGURATION'
  | 'API'
  | 'INVALID_RESPONSE'
  | 'AUTHENTICATION'
  | 'SESSION'
  | 'WALLET_NOT_FOUND'
  | 'WALLET_LOCKED'
  | 'PASSKEY_UNAVAILABLE'
  | 'PASSKEY_CANCELLED'
  | 'INVALID_INPUT'
  | 'TRANSACTION'

export class AltudeWalletError extends Error {
  readonly code: WalletErrorCode
  readonly status: number | undefined

  constructor(code: WalletErrorCode, message: string, status?: number, cause?: unknown) {
    super(message, { cause })
    this.name = 'AltudeWalletError'
    this.code = code
    this.status = status
  }
}
