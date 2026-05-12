/**
 * BIP-39 mnemonic generation and BIP-44 HD key derivation for Solana.
 *
 * Solana BIP-44 derivation path: m/44'/501'/0'/0'
 * Reference: https://github.com/AltudePlatform/OWS-core/blob/main/docs/07-supported-chains.md
 */

import { generateMnemonic as _generateMnemonic, mnemonicToSeed, validateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english'
import { HDKey } from '@scure/bip32'
import { ed25519 } from '@noble/curves/ed25519.js'
import { SOLANA_DERIVATION_PATH } from './types.js'
import { AltudeError } from './errors.js'

export { validateMnemonic }

/**
 * Generate a new BIP-39 mnemonic phrase.
 * @param words - Word count: 12 (128-bit entropy) or 24 (256-bit entropy)
 */
export function generateMnemonic(words: 12 | 24 = 12): string {
  const strength = words === 12 ? 128 : 256
  return _generateMnemonic(wordlist, strength)
}

/**
 * Derive a Solana Ed25519 keypair from a BIP-39 mnemonic.
 * Uses the derivation path m/44'/501'/index'/0'
 *
 * @param mnemonic - BIP-39 mnemonic phrase
 * @param index    - Account index (default 0)
 * @returns Object containing { privateKey: Uint8Array (32 bytes), publicKey: Uint8Array (32 bytes) }
 */
export async function deriveSolanaKeypair(
  mnemonic: string,
  index = 0,
): Promise<{ privateKey: Uint8Array; publicKey: Uint8Array }> {
  if (!validateMnemonic(mnemonic, wordlist)) {
    throw new AltudeError({
      code: 'INVALID_INPUT',
      message: 'Invalid BIP-39 mnemonic phrase.',
    })
  }

  const seed = await mnemonicToSeed(mnemonic)
  const root = HDKey.fromMasterSeed(seed)

  // Solana uses hardened derivation: m/44'/501'/<index>'/0'
  const path = index === 0 ? SOLANA_DERIVATION_PATH : `m/44'/501'/${index.toString()}'/0'`
  const child = root.derive(path)

  if (!child.privateKey) {
    throw new AltudeError({
      code: 'VAULT_DERIVATION_ERROR',
      message: `Failed to derive key at path ${path}`,
    })
  }

  const publicKey = ed25519.getPublicKey(child.privateKey)

  return {
    privateKey: child.privateKey,
    publicKey,
  }
}

/**
 * Derive the Solana base58 address from a mnemonic.
 */
export async function deriveSolanaAddress(mnemonic: string, index = 0): Promise<string> {
  const { publicKey } = await deriveSolanaKeypair(mnemonic, index)
  return encodeBase58(publicKey)
}

/**
 * Encode a Uint8Array as base58 (Solana address format).
 */
function encodeBase58(bytes: Uint8Array): string {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
  let num = BigInt(0)
  for (const byte of bytes) {
    num = num * BigInt(256) + BigInt(byte)
  }
  let result = ''
  while (num > BigInt(0)) {
    const rem = num % BigInt(58)
    num = num / BigInt(58)
    result = (ALPHABET[Number(rem)] ?? '') + result
  }
  for (const byte of bytes) {
    if (byte === 0) {
      result = '1' + result
    } else {
      break
    }
  }
  return result
}
