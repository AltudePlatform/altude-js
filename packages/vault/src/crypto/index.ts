/**
 * Cryptographic primitives for the OWS vault.
 *
 * AES-256-GCM + scrypt (passphrase-derived wallets)
 * AES-256-GCM + HKDF-SHA256 (API-key-derived copies)
 *
 * All parameters match the OWS storage format v2 spec:
 * https://github.com/AltudePlatform/OWS-core/blob/main/docs/01-storage-format.md
 *
 * scrypt params: N=65536, r=8, p=1, dklen=32
 * IV: 12 bytes (random), auth_tag: 16 bytes, salt: 32 bytes (random)
 */

import type { CryptoEnvelope } from '@altude/core'
import * as nodeCrypto from 'node:crypto'

type NodeCryptoModule = typeof nodeCrypto

// OWS-mandated scrypt parameters (production)
const SCRYPT_N_PROD = 65536
// Reduced N for test environments (controlled via env var)
const SCRYPT_N = parseInt(process.env['ALTUDE_SCRYPT_N'] ?? String(SCRYPT_N_PROD), 10)
const SCRYPT_R = 8
const SCRYPT_P = 1
const SCRYPT_DKLEN = 32
const IV_BYTES = 12
const SALT_BYTES = 32
const HKDF_INFO = 'ows-api-key-v1'

// ---------------------------------------------------------------------------
// Passphrase-based (scrypt) — used for wallet files
// ---------------------------------------------------------------------------

/**
 * Encrypt plaintext with a passphrase using scrypt + AES-256-GCM.
 * Uses node:crypto exclusively (Node.js environment).
 */
export async function encryptWithPassphrase(
  plaintext: Uint8Array,
  passphrase: string,
): Promise<CryptoEnvelope> {
  const crypto = importNodeCrypto()

  const salt = crypto.randomBytes(SALT_BYTES)
  const iv = crypto.randomBytes(IV_BYTES)

  const key = await deriveKeyScrypt(passphrase, salt, crypto)

  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()])
  const authTag = cipher.getAuthTag()

  return {
    cipher: 'aes-256-gcm',
    cipherparams: { iv: iv.toString('hex') },
    ciphertext: ciphertext.toString('hex'),
    auth_tag: authTag.toString('hex'),
    kdf: 'scrypt',
    kdfparams: {
      dklen: SCRYPT_DKLEN,
      n: SCRYPT_N as 65536,
      r: SCRYPT_R,
      p: SCRYPT_P,
      salt: salt.toString('hex'),
    },
  }
}

/**
 * Decrypt a passphrase-encrypted CryptoEnvelope.
 */
export async function decryptWithPassphrase(
  envelope: CryptoEnvelope,
  passphrase: string,
): Promise<Uint8Array> {
  const { invalidPassphrase } = await import('@altude/core')
  const crypto = importNodeCrypto()

  if (envelope.kdf !== 'scrypt') {
    throw new Error(`Expected scrypt KDF, got ${envelope.kdf}`)
  }

  const salt = Buffer.from(envelope.kdfparams.salt, 'hex')
  const iv = Buffer.from(envelope.cipherparams.iv, 'hex')
  const ciphertext = Buffer.from(envelope.ciphertext, 'hex')
  const authTag = Buffer.from(envelope.auth_tag, 'hex')
  const n = (envelope.kdfparams as { n?: number }).n ?? SCRYPT_N

  const key = await deriveKeyScrypt(passphrase, salt, crypto, n)

  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(authTag)
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    return new Uint8Array(plaintext)
  } catch {
    throw invalidPassphrase()
  }
}

// ---------------------------------------------------------------------------
// Token-based (HKDF-SHA256) — used for API key files
// ---------------------------------------------------------------------------

/**
 * Encrypt plaintext using an OWS API token (HKDF-SHA256 + AES-256-GCM).
 *
 * Protocol from docs/03-policy-engine.md:
 *   prk = HKDF-Extract(salt, token)
 *   key = HKDF-Expand(prk, "ows-api-key-v1", 32)
 */
export function encryptWithToken(
  plaintext: Uint8Array,
  token: string,
): Promise<CryptoEnvelope> {
  const crypto = importNodeCrypto()

  const salt = crypto.randomBytes(SALT_BYTES)
  const iv = crypto.randomBytes(IV_BYTES)

  const key = deriveKeyHkdf(token, salt, crypto)

  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()])
  const authTag = cipher.getAuthTag()

  return Promise.resolve({
    cipher: 'aes-256-gcm',
    cipherparams: { iv: iv.toString('hex') },
    ciphertext: ciphertext.toString('hex'),
    auth_tag: authTag.toString('hex'),
    kdf: 'hkdf-sha256',
    kdfparams: {
      dklen: SCRYPT_DKLEN,
      salt: salt.toString('hex'),
      info: HKDF_INFO,
    },
  })
}

/**
 * Decrypt a token-encrypted CryptoEnvelope.
 */
export async function decryptWithToken(
  envelope: CryptoEnvelope,
  token: string,
): Promise<Uint8Array> {
  const { AltudeError } = await import('@altude/core')
  const crypto = importNodeCrypto()

  if (envelope.kdf !== 'hkdf-sha256') {
    throw new Error(`Expected hkdf-sha256 KDF, got ${envelope.kdf}`)
  }

  const salt = Buffer.from(envelope.kdfparams.salt, 'hex')
  const iv = Buffer.from(envelope.cipherparams.iv, 'hex')
  const ciphertext = Buffer.from(envelope.ciphertext, 'hex')
  const authTag = Buffer.from(envelope.auth_tag, 'hex')

  const key = deriveKeyHkdf(token, salt, crypto)

  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(authTag)
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    return new Uint8Array(plaintext)
  } catch {
    throw new AltudeError({ code: 'INVALID_PASSPHRASE', message: 'Token decryption failed.' })
  }
}

// ---------------------------------------------------------------------------
// SHA-256 hash (for token_hash field in API key files)
// ---------------------------------------------------------------------------

export function sha256Hex(input: string): Promise<string> {
  const crypto = importNodeCrypto()
  return Promise.resolve(crypto.createHash('sha256').update(input).digest('hex'))
}

// ---------------------------------------------------------------------------
// Secure random helpers
// ---------------------------------------------------------------------------

export function randomBytes(n: number): Promise<Uint8Array> {
  const crypto = importNodeCrypto()
  return Promise.resolve(crypto.randomBytes(n))
}

export async function randomHex(n: number): Promise<string> {
  const buf = await randomBytes(n)
  return Buffer.from(buf).toString('hex')
}

// ---------------------------------------------------------------------------
// Internal KDF helpers
// ---------------------------------------------------------------------------

async function deriveKeyScrypt(
  passphrase: string,
  salt: Buffer,
  crypto: NodeCryptoModule,
  n: number = SCRYPT_N,
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    crypto.scrypt(
      passphrase,
      salt,
      SCRYPT_DKLEN,
      { N: n, r: SCRYPT_R, p: SCRYPT_P },
      (err, derivedKey) => {
        if (err) reject(err)
        else resolve(derivedKey)
      },
    )
  })
}

function deriveKeyHkdf(
  token: string,
  salt: Buffer,
  crypto: NodeCryptoModule,
): Buffer {
  // HKDF-SHA256: extract then expand
  const prk = crypto.createHmac('sha256', salt).update(token).digest()
  // Expand with info = "ows-api-key-v1", length = 32
  const infoBytes = Buffer.from(HKDF_INFO, 'utf-8')
  // T(1) = HMAC-Hash(PRK, "" || info || 0x01)
  const t1 = crypto
    .createHmac('sha256', prk)
    .update(Buffer.concat([infoBytes, Buffer.from([0x01])]))
    .digest()
  return t1.subarray(0, SCRYPT_DKLEN)
}

function importNodeCrypto(): NodeCryptoModule {
  return nodeCrypto
}
