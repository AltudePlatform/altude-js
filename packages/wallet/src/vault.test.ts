import 'fake-indexeddb/auto'
import { ed25519 } from '@noble/curves/ed25519.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IndexedDbWalletStore } from './storage.js'
import { WalletVault } from './vault.js'
import type { PasskeyAdapter } from './types.js'
import { decodeBase58 } from './crypto.js'

const testPasskey: PasskeyAdapter = {
  register() {
    return Promise.resolve({
      credentialId: new Uint8Array([4, 5, 6]),
      kek: new Uint8Array(32).fill(7),
    })
  },
  deriveKey() {
    return Promise.resolve(new Uint8Array(32).fill(7))
  },
}

describe('WalletVault', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('persists separate local wallets and signs without exposing key bytes', async () => {
    const store = new IndexedDbWalletStore(indexedDB)
    const vault = new WalletVault({ store, crypto: globalThis.crypto, passkeys: testPasskey })
    const firstAddress = await vault.getOrCreateAddress('issuer|first')
    const secondAddress = await vault.getOrCreateAddress('issuer|second')
    expect(firstAddress).not.toBe(secondAddress)

    const signer = await vault.getSigner('issuer|first')
    const message = new Uint8Array([1, 2, 3, 4])
    const sign = signer.signTransactionMessage
    if (!sign) throw new Error('Expected transaction signer.')
    const signature = await sign(message)
    const record = await store.get('issuer|first')
    expect(record).not.toHaveProperty('privateKey')
    expect(record?.secret).toHaveLength(32)
    expect(ed25519.verify(signature, message, decodeBase58(firstAddress))).toBe(true)

    vault.lock('issuer|first')
    await expect(sign(message)).rejects.toThrow('locked')
  })

  it('wraps passkey-protected keys and requires a PRF assertion to unlock', async () => {
    vi.stubGlobal('location', { hostname: 'localhost' })
    const store = new IndexedDbWalletStore(indexedDB)
    const vault = new WalletVault({ store, crypto: globalThis.crypto, passkeys: testPasskey })
    const address = await vault.getOrCreateAddress('issuer|protected')
    await vault.protectWithPasskey('issuer|protected')
    const stored = await store.get('issuer|protected')
    expect(stored?.protection).toBe('passkey')
    expect(stored?.secret).toBeUndefined()
    expect(stored?.ciphertext).toBeDefined()

    vault.lock('issuer|protected')
    await expect(vault.getSigner('issuer|protected')).rejects.toThrow('passkey')
    await vault.unlockWithPasskey('issuer|protected')
    const signer = await vault.getSigner('issuer|protected')
    expect(signer.address).toBe(address)
    const bytes = new Uint8Array([8, 9])
    const sign = signer.signTransactionMessage
    if (!sign) throw new Error('Expected transaction signer.')
    const signature = await sign(bytes)
    expect(ed25519.verify(signature, bytes, decodeBase58(address))).toBe(true)
  })

  it('creates one stable wallet when tabs race to initialize the same identity', async () => {
    const firstStore = new IndexedDbWalletStore(indexedDB)
    const secondStore = new IndexedDbWalletStore(indexedDB)
    const first = new WalletVault({ store: firstStore, crypto: globalThis.crypto, passkeys: testPasskey })
    const second = new WalletVault({ store: secondStore, crypto: globalThis.crypto, passkeys: testPasskey })
    const addresses = await Promise.all([
      first.getOrCreateAddress('issuer|racing'),
      second.getOrCreateAddress('issuer|racing'),
    ])

    expect(addresses[0]).toBe(addresses[1])
    expect((await firstStore.get('issuer|racing'))?.publicKey).toBe(addresses[0])
  })
})
