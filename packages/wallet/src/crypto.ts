const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

export function encodeBase58(bytes: Uint8Array): string {
  let value = 0n
  for (const byte of bytes) value = value * 256n + BigInt(byte)
  let output = ''
  while (value > 0n) {
    output = BASE58.charAt(Number(value % 58n)) + output
    value /= 58n
  }
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index]
    if (byte !== 0) break
    output = `1${output}`
  }
  return output
}

export function decodeBase58(value: string): Uint8Array {
  let invalidCharacter = value.length === 0
  for (let index = 0; index < value.length; index += 1) {
    if (!BASE58.includes(value.charAt(index))) invalidCharacter = true
  }
  if (invalidCharacter) {
    throw new Error('Address must be a valid base58 string.')
  }
  let decoded = 0n
  for (let index = 0; index < value.length; index += 1) {
    decoded = decoded * 58n + BigInt(BASE58.indexOf(value.charAt(index)))
  }
  const bytes: number[] = []
  while (decoded > 0n) {
    bytes.unshift(Number(decoded % 256n))
    decoded /= 256n
  }
  for (let index = 0; index < value.length; index += 1) {
    const character = value.charAt(index)
    if (character !== '1') break
    bytes.unshift(0)
  }
  return new Uint8Array(bytes)
}

export function assertPublicKey(value: string, name: string): void {
  try {
    if (decodeBase58(value).length !== 32) throw new Error()
  } catch {
    throw new Error(`${name} must be a valid Solana address.`)
  }
}

export function randomBytes(cryptoProvider: Crypto, length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  cryptoProvider.getRandomValues(bytes)
  return bytes
}

export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}
