import { sha256 } from '@noble/hashes/sha2.js'
import { NativeWalletError } from './errors.js'
import type { RandomBytesSource } from './platform.js'

const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

export function createPkcePair(randomBytes: RandomBytesSource): {
  verifier: string
  challenge: string
} {
  const bytes = randomBytes(32)
  if (!(bytes instanceof Uint8Array) || bytes.length !== 32) {
    throw new NativeWalletError(
      'CONFIGURATION',
      'The secure random source must return exactly the requested number of bytes.',
    )
  }
  const verifier = base64UrlEncode(bytes)
  const challenge = base64UrlEncode(sha256(asciiBytes(verifier)))
  return { verifier, challenge }
}

export function createState(randomBytes: RandomBytesSource): string {
  const bytes = randomBytes(32)
  if (!(bytes instanceof Uint8Array) || bytes.length !== 32) {
    throw new NativeWalletError(
      'CONFIGURATION',
      'The secure random source must return exactly the requested number of bytes.',
    )
  }
  return base64UrlEncode(bytes)
}

function asciiBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length)
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code > 0x7f) throw new NativeWalletError('CONFIGURATION', 'Invalid PKCE verifier.')
    bytes[index] = code
  }
  return bytes
}

function base64UrlEncode(bytes: Uint8Array): string {
  let encoded = ''
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index]
    const second = bytes[index + 1]
    const third = bytes[index + 2]
    if (first === undefined) break

    encoded += BASE64URL_ALPHABET[first >> 2] ?? ''
    encoded += BASE64URL_ALPHABET[((first & 0x03) << 4) | ((second ?? 0) >> 4)] ?? ''
    if (second !== undefined) {
      encoded += BASE64URL_ALPHABET[((second & 0x0f) << 2) | ((third ?? 0) >> 6)] ?? ''
    }
    if (third !== undefined) encoded += BASE64URL_ALPHABET[third & 0x3f] ?? ''
  }
  return encoded
}
