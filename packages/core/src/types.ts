/**
 * OWS v2 storage format types.
 * Mirrors the schema defined in:
 * https://github.com/AltudePlatform/OWS-core/blob/main/docs/01-storage-format.md
 */

// ---------------------------------------------------------------------------
// Cryptographic envelope
// ---------------------------------------------------------------------------

export interface ScryptParams {
  dklen: 32
  n: 65536
  r: 8
  p: 1
  salt: string // hex-encoded, 32 bytes
}

export interface HkdfParams {
  dklen: 32
  salt: string // hex-encoded, 32 bytes
  info: 'ows-api-key-v1'
}

export type KdfParams = ScryptParams | HkdfParams

export interface CryptoEnvelope {
  cipher: 'aes-256-gcm'
  cipherparams: { iv: string } // hex-encoded, 12 bytes
  ciphertext: string // hex-encoded
  auth_tag: string // hex-encoded, 16 bytes
  kdf: 'scrypt' | 'hkdf-sha256'
  kdfparams: KdfParams
}

// ---------------------------------------------------------------------------
// Wallet file
// ---------------------------------------------------------------------------

export interface OWSAccount {
  account_id: string // CAIP-10: e.g. "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:7Kz9..."
  address: string // chain-native address
  chain_id: string // CAIP-2: e.g. "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"
  derivation_path: string // BIP-44: e.g. "m/44'/501'/0'/0'"
}

export interface OWSWallet {
  ows_version: 2
  id: string // UUID v4
  name: string
  created_at: string // ISO 8601
  accounts: OWSAccount[]
  crypto: CryptoEnvelope
  key_type: 'mnemonic' | 'private_key'
  metadata: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// API key file
// ---------------------------------------------------------------------------

export interface OWSApiKey {
  id: string // UUID v4
  name: string
  token_hash: string // SHA-256 hex of raw token
  created_at: string // ISO 8601
  wallet_ids: string[]
  policy_ids: string[]
  expires_at: string | null // ISO 8601 or null
  wallet_secrets: Record<string, CryptoEnvelope> // walletId → encrypted secret
}

// ---------------------------------------------------------------------------
// Policy file
// ---------------------------------------------------------------------------

export type PolicyRuleAllowedChains = {
  type: 'allowed_chains'
  chain_ids: string[]
}

export type PolicyRuleExpiresAt = {
  type: 'expires_at'
  timestamp: string // ISO 8601
}

export type PolicyRuleAllowedTypedDataContracts = {
  type: 'allowed_typed_data_contracts'
  contracts: string[]
}

export type PolicyRule =
  | PolicyRuleAllowedChains
  | PolicyRuleExpiresAt
  | PolicyRuleAllowedTypedDataContracts

export interface OWSPolicy {
  id: string
  name: string
  version: number
  created_at: string // ISO 8601
  rules: PolicyRule[]
  executable: string | null // path to custom policy executable (Node.js only)
  config: Record<string, unknown> | null
  action: 'deny' // the default action if all rules pass (always 'deny' for now)
}

// ---------------------------------------------------------------------------
// Policy evaluation context
// ---------------------------------------------------------------------------

export interface PolicyContext {
  chain_id: string
  wallet_id: string
  api_key_id: string
  transaction_hex?: string
  timestamp: string // ISO 8601
}

// ---------------------------------------------------------------------------
// Signing interface
// https://github.com/AltudePlatform/OWS-core/blob/main/docs/02-signing-interface.md
// ---------------------------------------------------------------------------

export interface SignRequest {
  walletId: string
  chainId: string // CAIP-2 or shorthand alias (e.g. "solana")
  transactionHex: string
}

export interface SignResult {
  signature: string
  recoveryId?: number
}

export interface SignAndSendRequest extends SignRequest {
  rpcUrl?: string
}

export interface SignAndSendResult {
  transactionHash: string
}

export interface SignMessageRequest {
  walletId: string
  chainId: string
  message: string | Uint8Array
  encoding?: 'utf8' | 'hex'
}

export interface SignMessageResult {
  signature: string
  recoveryId?: number
}

// ---------------------------------------------------------------------------
// Public wallet/account descriptors (never expose key material)
// ---------------------------------------------------------------------------

export interface AccountInfo {
  chainId: string // CAIP-2
  address: string
  derivationPath: string
}

export interface WalletInfo {
  id: string
  name: string
  accounts: AccountInfo[]
  createdAt: string // ISO 8601
  keyType: 'mnemonic' | 'private_key'
}

// ---------------------------------------------------------------------------
// Chain aliases
// ---------------------------------------------------------------------------

export const CHAIN_IDS = {
  SOLANA_MAINNET: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  SOLANA_DEVNET: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
  SOLANA_TESTNET: 'solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z',
} as const

export type SolanaNetwork = 'mainnet-beta' | 'devnet' | 'testnet'

export const SOLANA_DERIVATION_PATH = "m/44'/501'/0'/0'" as const

// ---------------------------------------------------------------------------
// Altude relay constants
// ---------------------------------------------------------------------------

export const ALTUDE_FEE_PAYER = 'ALTn7gyjm29WthZGgs4z6WVAK2PK5U6w4FAtPg3TPY71' as const

export const ALTUDE_API_URLS = {
  mainnet: 'https://api.altude.so',
  devnet: 'https://api.altude.so',
} as const
