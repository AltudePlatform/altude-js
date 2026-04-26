/**
 * OWS API Key management.
 *
 * Implements the 9-step key creation protocol from:
 * https://github.com/AltudePlatform/OWS-core/blob/main/docs/03-policy-engine.md
 *
 * Key creation flow:
 *  1. Owner enters wallet passphrase
 *  2. OWS decrypts the wallet secret using scrypt(passphrase)
 *  3. Generates random token: T = "ows_key_" + hex(random 256 bits)
 *  4. Generates random salt S
 *  5. Derives key: K = HKDF-SHA256(S, T, "ows-api-key-v1", 32)
 *  6. Encrypts the wallet secret with K via AES-256-GCM
 *  7. Stores key file with token_hash: SHA256(T), policy IDs, and encrypted secret copy
 *  8. Displays T once — owner provisions it to the agent
 *  9. Zeroizes the decrypted secret from memory
 */

import type { OWSApiKey } from '@altude/core'
import { apiKeyNotFound, apiKeyExpired } from '@altude/core'
import type { NodeVaultStorage } from '../storage/index.js'
import { loadWalletFile } from '../wallet/index.js'
import {
  decryptWithPassphrase,
  encryptWithToken,
  decryptWithToken,
  sha256Hex,
  randomHex,
} from '../crypto/index.js'

// ---------------------------------------------------------------------------
// createApiKey
// ---------------------------------------------------------------------------

export interface CreateApiKeyOptions {
  name: string
  walletId: string
  passphrase: string
  policyIds?: string[]
  expiresAt?: string | null // ISO 8601 or null
}

export interface CreatedApiKey {
  keyInfo: OWSApiKey
  /** Raw token — shown once, never stored. Provision this to the agent. */
  token: string
}

export async function createApiKey(
  storage: NodeVaultStorage,
  options: CreateApiKeyOptions,
): Promise<CreatedApiKey> {
  const { name, walletId, passphrase, policyIds = [], expiresAt = null } = options

  // Step 1-2: Load and decrypt wallet secret
  const wallet = await loadWalletFile(storage, walletId)
  const secret = await decryptWithPassphrase(wallet.crypto, passphrase)

  try {
    // Step 3: Generate random token (256 bits = 32 bytes = 64 hex chars)
    const tokenHex = await randomHex(32)
    const token = `ows_key_${tokenHex}`

    // Step 4-6: HKDF-derive key from token, encrypt wallet secret
    const encryptedSecret = await encryptWithToken(secret, token)

    // Step 7: Build and write the key file
    const id = globalThis.crypto.randomUUID()
    const now = new Date().toISOString()
    const tokenHash = await sha256Hex(token)

    const apiKey: OWSApiKey = {
      id,
      name,
      token_hash: tokenHash,
      created_at: now,
      wallet_ids: [wallet.id],
      policy_ids: policyIds,
      expires_at: expiresAt,
      wallet_secrets: { [wallet.id]: encryptedSecret },
    }

    await storage.write(storage.keyPath(id), JSON.stringify(apiKey, null, 2))

    // Step 8: Return token once; step 9 (zeroize) happens in finally
    return { keyInfo: apiKey, token }
  } finally {
    // Step 9: Zeroize secret from memory
    secret.fill(0)
  }
}

// ---------------------------------------------------------------------------
// resolveApiKey — used during agent signing
// ---------------------------------------------------------------------------

/**
 * Look up an API key by token value and decrypt the wallet secret.
 * Returns the decrypted wallet secret bytes — caller MUST zeroize after use.
 */
export async function resolveApiKeyAndDecrypt(
  storage: NodeVaultStorage,
  token: string,
  walletId: string,
): Promise<Uint8Array> {
  const tokenHash = await sha256Hex(token)
  const key = await findApiKeyByHash(storage, tokenHash)

  // Validate expiry
  if (key.expires_at && new Date(key.expires_at) < new Date()) {
    throw apiKeyExpired(key.id)
  }

  // Validate wallet scope
  if (!key.wallet_ids.includes(walletId)) {
    throw apiKeyNotFound(token)
  }

  const encryptedSecret = key.wallet_secrets[walletId]
  if (!encryptedSecret) {
    throw apiKeyNotFound(token)
  }

  return decryptWithToken(encryptedSecret, token)
}

// ---------------------------------------------------------------------------
// listApiKeys / revokeApiKey
// ---------------------------------------------------------------------------

export async function listApiKeys(storage: NodeVaultStorage): Promise<OWSApiKey[]> {
  const entries = await storage.list(storage.keysDir())
  const keys: OWSApiKey[] = []
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    const id = entry.replace('.json', '')
    const raw = await storage.read(storage.keyPath(id))
    if (!raw) continue
    keys.push(JSON.parse(raw) as OWSApiKey)
  }
  return keys
}

export async function revokeApiKey(storage: NodeVaultStorage, keyId: string): Promise<void> {
  const path = storage.keyPath(keyId)
  const raw = await storage.read(path)
  if (!raw) throw apiKeyNotFound(keyId)
  await storage.delete(path)
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function findApiKeyByHash(storage: NodeVaultStorage, tokenHash: string): Promise<OWSApiKey> {
  const entries = await storage.list(storage.keysDir())
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    const id = entry.replace('.json', '')
    const raw = await storage.read(storage.keyPath(id))
    if (!raw) continue
    const k = JSON.parse(raw) as OWSApiKey
    if (k.token_hash === tokenHash) return k
  }
  throw apiKeyNotFound(tokenHash)
}
