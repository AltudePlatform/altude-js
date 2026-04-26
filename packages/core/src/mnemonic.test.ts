import { describe, it, expect } from 'vitest'
import { generateMnemonic, validateMnemonic, deriveSolanaKeypair, deriveSolanaAddress } from '../src/mnemonic.js'
import { wordlist } from '@scure/bip39/wordlists/english'

describe('generateMnemonic', () => {
  it('generates a 12-word mnemonic by default', () => {
    const m = generateMnemonic()
    expect(m.split(' ')).toHaveLength(12)
    expect(validateMnemonic(m, wordlist)).toBe(true)
  })

  it('generates a 24-word mnemonic when requested', () => {
    const m = generateMnemonic(24)
    expect(m.split(' ')).toHaveLength(24)
    expect(validateMnemonic(m, wordlist)).toBe(true)
  })

  it('produces a different mnemonic each call', () => {
    expect(generateMnemonic()).not.toBe(generateMnemonic())
  })
})

describe('deriveSolanaKeypair', () => {
  // Known test vector: mnemonic → Solana address
  const KNOWN_MNEMONIC =
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

  it('derives a 32-byte private key and 32-byte public key', async () => {
    const { privateKey, publicKey } = await deriveSolanaKeypair(KNOWN_MNEMONIC)
    expect(privateKey).toHaveLength(32)
    expect(publicKey).toHaveLength(32)
  })

  it('produces deterministic output for the same mnemonic and index', async () => {
    const kp1 = await deriveSolanaKeypair(KNOWN_MNEMONIC, 0)
    const kp2 = await deriveSolanaKeypair(KNOWN_MNEMONIC, 0)
    expect(kp1.privateKey).toEqual(kp2.privateKey)
    expect(kp1.publicKey).toEqual(kp2.publicKey)
  })

  it('produces different keys for different indices', async () => {
    const kp0 = await deriveSolanaKeypair(KNOWN_MNEMONIC, 0)
    const kp1 = await deriveSolanaKeypair(KNOWN_MNEMONIC, 1)
    expect(kp0.privateKey).not.toEqual(kp1.privateKey)
  })

  it('throws on invalid mnemonic', async () => {
    await expect(deriveSolanaKeypair('not a valid mnemonic phrase at all here')).rejects.toThrow(
      'Invalid BIP-39 mnemonic phrase',
    )
  })
})

describe('deriveSolanaAddress', () => {
  const KNOWN_MNEMONIC =
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

  it('returns a non-empty base58 string', async () => {
    const addr = await deriveSolanaAddress(KNOWN_MNEMONIC)
    expect(addr).toBeTruthy()
    expect(typeof addr).toBe('string')
    // Solana addresses are 32–44 chars base58
    expect(addr.length).toBeGreaterThanOrEqual(32)
    expect(addr.length).toBeLessThanOrEqual(44)
  })

  it('is deterministic', async () => {
    const a1 = await deriveSolanaAddress(KNOWN_MNEMONIC)
    const a2 = await deriveSolanaAddress(KNOWN_MNEMONIC)
    expect(a1).toBe(a2)
  })
})
