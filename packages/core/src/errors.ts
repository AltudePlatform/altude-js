/**
 * Structured error classes for the Altude SDK.
 *
 * Error taxonomy mirrors:
 * - OWS signing interface error codes: https://github.com/AltudePlatform/OWS-core/blob/main/docs/02-signing-interface.md
 * - AndroidSDK VAULT-0xxx codes: https://github.com/AltudePlatform/AndroidSDK/blob/main/docs/VAULT_DOCUMENTATION_INDEX.md
 */

export type AltudeErrorCode =
  // OWS signing errors
  | 'WALLET_NOT_FOUND'
  | 'CHAIN_NOT_SUPPORTED'
  | 'INVALID_PASSPHRASE'
  | 'INVALID_INPUT'
  | 'CAIP_PARSE_ERROR'
  | 'POLICY_DENIED'
  | 'API_KEY_NOT_FOUND'
  | 'API_KEY_EXPIRED'
  // Vault initialization errors (VAULT-01xx)
  | 'VAULT_SEED_ERROR' // VAULT-0101
  | 'VAULT_STORAGE_ERROR' // VAULT-0102
  // Biometric/auth errors (VAULT-02xx) — mapped to passphrase in TypeScript
  | 'VAULT_AUTH_ERROR' // VAULT-0201
  | 'VAULT_AUTH_INVALIDATED' // VAULT-0202
  // Derivation/signing errors (VAULT-03xx)
  | 'VAULT_DERIVATION_ERROR' // VAULT-0301
  | 'VAULT_SIGN_ERROR' // VAULT-0302
  // Vault state errors (VAULT-04xx)
  | 'VAULT_LOCKED' // VAULT-0401
  // Storage/permission errors (VAULT-05xx)
  | 'VAULT_PERMISSION_ERROR' // VAULT-0501
  // Network / relay errors
  | 'RELAY_ERROR'
  | 'RPC_ERROR'

export interface AltudeErrorOptions {
  code: AltudeErrorCode
  message: string
  remediation?: string
  cause?: unknown
}

export class AltudeError extends Error {
  readonly code: AltudeErrorCode
  readonly remediation: string | undefined

  constructor(options: AltudeErrorOptions) {
    super(options.message)
    this.name = 'AltudeError'
    this.code = options.code
    this.remediation = options.remediation
    if (options.cause instanceof Error) {
      this.cause = options.cause
    }
  }
}

// ---------------------------------------------------------------------------
// Typed convenience constructors
// ---------------------------------------------------------------------------

export function walletNotFound(id: string): AltudeError {
  return new AltudeError({
    code: 'WALLET_NOT_FOUND',
    message: `Wallet not found: ${id}`,
    remediation: 'Run listWallets() to see available wallets.',
  })
}

export function invalidPassphrase(): AltudeError {
  return new AltudeError({
    code: 'INVALID_PASSPHRASE',
    message: 'Vault passphrase is incorrect.',
    remediation: 'Check your passphrase and try again.',
  })
}

export function policyDenied(reason: string): AltudeError {
  return new AltudeError({
    code: 'POLICY_DENIED',
    message: `Request rejected by policy engine: ${reason}`,
    remediation: 'Review the attached policies for this API key.',
  })
}

export function apiKeyNotFound(id: string): AltudeError {
  return new AltudeError({
    code: 'API_KEY_NOT_FOUND',
    message: `API key not found: ${id}`,
  })
}

export function apiKeyExpired(id: string): AltudeError {
  return new AltudeError({
    code: 'API_KEY_EXPIRED',
    message: `API key has expired: ${id}`,
    remediation: 'Create a new API key with a later expiry.',
  })
}

export function chainNotSupported(chainId: string): AltudeError {
  return new AltudeError({
    code: 'CHAIN_NOT_SUPPORTED',
    message: `Chain not supported: ${chainId}`,
    remediation: 'Use a Solana chain ID (e.g. "solana" or "solana:5eykt4...").',
  })
}

export function vaultPermissionError(path: string): AltudeError {
  return new AltudeError({
    code: 'VAULT_PERMISSION_ERROR',
    message: `Unsafe permissions on vault path: ${path}`,
    remediation: 'Run: chmod 700 ~/.ows/wallets && chmod 600 ~/.ows/wallets/*.json',
  })
}

export function vaultStorageError(msg: string, cause?: unknown): AltudeError {
  return new AltudeError({
    code: 'VAULT_STORAGE_ERROR',
    message: msg,
    cause,
  })
}
