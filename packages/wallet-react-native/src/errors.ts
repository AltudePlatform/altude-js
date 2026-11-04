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
