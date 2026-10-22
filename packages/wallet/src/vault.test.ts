import 'fake-indexeddb/auto'
import { ed25519 } from '@noble/curves/ed25519.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IndexedDbWalletStore } from './storage.js'
import { WalletVault } from './vault.js'
import type { PasskeyAdapter, WalletStore } from './types.js'
import { decodeBase58 } from './crypto.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

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
    await expect(vault.getSigner('issuer|first')).rejects.toMatchObject({
      code: 'WALLET_LOCKED',
    })
    expect(vault.isUnlocked('issuer|first')).toBe(false)

    await vault.unlock('issuer|first')
    expect(vault.isUnlocked('issuer|first')).toBe(true)
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

  it('does not commit protection after locking during passkey registration', async () => {
    vi.stubGlobal('location', { hostname: 'localhost' })
    const registration = deferred<{ credentialId: Uint8Array; kek: Uint8Array }>()
    const passkeys: PasskeyAdapter = {
      ...testPasskey,
      register: () => registration.promise,
    }
    const store = new IndexedDbWalletStore(indexedDB)
    const vault = new WalletVault({ store, crypto: globalThis.crypto, passkeys })
    const identityKey = 'issuer|registration-race'
    await vault.getOrCreateAddress(identityKey)
    const original = await store.get(identityKey)

    const protecting = vault.protectWithPasskey(identityKey)
    vault.lock(identityKey)
    registration.resolve({
      credentialId: new Uint8Array([4, 5, 6]),
      kek: new Uint8Array(32).fill(7),
    })

    await expect(protecting).rejects.toThrow('changed')
    const stored = await store.get(identityKey)
    expect(stored?.protection).toBe('device-local')
    expect(Array.from(stored?.secret ?? [])).toEqual(Array.from(original?.secret ?? []))
    expect(vault.isUnlocked(identityKey)).toBe(false)
  })

  it('restores the original record if locking races a passkey storage write', async () => {
    vi.stubGlobal('location', { hostname: 'localhost' })
    const store = new IndexedDbWalletStore(indexedDB)
    const writeStarted = deferred<boolean>()
    const finishWrite = deferred<boolean>()
    const delayedStore: WalletStore = {
      get: (identityKey) => store.get(identityKey),
      getByServerUserId: (userId) => store.getByServerUserId(userId),
      createIfAbsent: (record) => store.createIfAbsent(record),
      async update(identityKey, update) {
        writeStarted.resolve(true)
        await finishWrite.promise
        return store.update(identityKey, update)
      },
      put: (record) => store.put(record),
      delete: (identityKey) => store.delete(identityKey),
    }
    const vault = new WalletVault({
      store: delayedStore,
      crypto: globalThis.crypto,
      passkeys: testPasskey,
    })
    const identityKey = 'issuer|storage-race'
    await vault.getOrCreateAddress(identityKey)
    const original = await store.get(identityKey)

    const protecting = vault.protectWithPasskey(identityKey)
    await writeStarted.promise
    vault.lock(identityKey)
    finishWrite.resolve(true)

    await expect(protecting).rejects.toThrow('changed')
    const stored = await store.get(identityKey)
    expect(stored?.protection).toBe('device-local')
    expect(Array.from(stored?.secret ?? [])).toEqual(Array.from(original?.secret ?? []))
    expect(vault.isUnlocked(identityKey)).toBe(false)
  })

  it('does not restore signing access when passkey unlock finishes after locking', async () => {
    vi.stubGlobal('location', { hostname: 'localhost' })
    const derive = deferred<Uint8Array>()
    const passkeys: PasskeyAdapter = {
      register: (input) => testPasskey.register(input),
      deriveKey: () => derive.promise,
    }
    const store = new IndexedDbWalletStore(indexedDB)
    const vault = new WalletVault({ store, crypto: globalThis.crypto, passkeys })
    const identityKey = 'issuer|unlock-race'
    await vault.getOrCreateAddress(identityKey)
    await vault.protectWithPasskey(identityKey)
    vault.lock(identityKey)

    const unlocking = vault.unlockWithPasskey(identityKey)
    vault.lock(identityKey)
    derive.resolve(new Uint8Array(32).fill(7))

    await expect(unlocking).rejects.toThrow('changed')
    expect(vault.isUnlocked(identityKey)).toBe(false)
  })

  it('creates one stable wallet when tabs race to initialize the same identity', async () => {
    const firstStore = new IndexedDbWalletStore(indexedDB)
    const secondStore = new IndexedDbWalletStore(indexedDB)
    const first = new WalletVault({
      store: firstStore,
      crypto: globalThis.crypto,
      passkeys: testPasskey,
    })
    const second = new WalletVault({
      store: secondStore,
      crypto: globalThis.crypto,
      passkeys: testPasskey,
    })
    const addresses = await Promise.all([
      first.getOrCreateAddress('issuer|racing'),
      second.getOrCreateAddress('issuer|racing'),
    ])

    expect(addresses[0]).toBe(addresses[1])
    expect((await firstStore.get('issuer|racing'))?.publicKey).toBe(addresses[0])
  })

  it('allows only one server user to claim a wallet across vault instances', async () => {
    const firstStore = new IndexedDbWalletStore(indexedDB)
    const secondStore = new IndexedDbWalletStore(indexedDB)
    const first = new WalletVault({
      store: firstStore,
      crypto: globalThis.crypto,
      passkeys: testPasskey,
    })
    const second = new WalletVault({
      store: secondStore,
      crypto: globalThis.crypto,
      passkeys: testPasskey,
    })
    const identityKey = 'issuer|claim-race'
    await first.getOrCreateAddress(identityKey)

    const results = await Promise.allSettled([
      first.associateServerUser(identityKey, 'server-user-a'),
      second.associateServerUser(identityKey, 'server-user-b'),
    ])

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find((result) => result.status === 'rejected')
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: { code: 'SESSION' },
    })
    expect(['server-user-a', 'server-user-b']).toContain(
      (await firstStore.get(identityKey))?.serverUserId,
    )
  })

  it('preserves the winning passkey when two vault instances protect concurrently', async () => {
    vi.stubGlobal('location', { hostname: 'localhost' })
    const firstStore = new IndexedDbWalletStore(indexedDB)
    const secondStore = new IndexedDbWalletStore(indexedDB)
    const firstPasskeys: PasskeyAdapter = {
      ...testPasskey,
      register: () =>
        Promise.resolve({ credentialId: new Uint8Array([1]), kek: new Uint8Array(32).fill(1) }),
    }
    const secondRegistration = deferred<{ credentialId: Uint8Array; kek: Uint8Array }>()
    const secondRegistrationStarted = deferred<boolean>()
    const secondPasskeys: PasskeyAdapter = {
      ...testPasskey,
      register: () => {
        secondRegistrationStarted.resolve(true)
        return secondRegistration.promise
      },
    }
    const first = new WalletVault({
      store: firstStore,
      crypto: globalThis.crypto,
      passkeys: firstPasskeys,
    })
    const second = new WalletVault({
      store: secondStore,
      crypto: globalThis.crypto,
      passkeys: secondPasskeys,
    })
    const identityKey = 'issuer|passkey-race'
    await first.getOrCreateAddress(identityKey)
    await second.unlock(identityKey)

    const firstProtection = first.protectWithPasskey(identityKey)
    const secondProtection = second.protectWithPasskey(identityKey)
    await secondRegistrationStarted.promise
    await firstProtection
    secondRegistration.resolve({
      credentialId: new Uint8Array([2]),
      kek: new Uint8Array(32).fill(2),
    })

    await expect(secondProtection).rejects.toMatchObject({ code: 'WALLET_LOCKED' })
    const stored = await firstStore.get(identityKey)
    expect(stored?.protection).toBe('passkey')
    expect(Array.from(stored?.credentialId ?? [])).toEqual([1])
    expect(stored?.secret).toBeUndefined()
  })

  it('preserves server association when passkey protection races another vault', async () => {
    vi.stubGlobal('location', { hostname: 'localhost' })
    const store = new IndexedDbWalletStore(indexedDB)
    const registration = deferred<{ credentialId: Uint8Array; kek: Uint8Array }>()
    const registrationStarted = deferred<boolean>()
    const passkeys: PasskeyAdapter = {
      ...testPasskey,
      register: () => {
        registrationStarted.resolve(true)
        return registration.promise
      },
    }
    const protectingVault = new WalletVault({ store, crypto: globalThis.crypto, passkeys })
    const associatingVault = new WalletVault({
      store: new IndexedDbWalletStore(indexedDB),
      crypto: globalThis.crypto,
      passkeys: testPasskey,
    })
    const identityKey = 'issuer|association-protection-race'
    await protectingVault.getOrCreateAddress(identityKey)
    const protecting = protectingVault.protectWithPasskey(identityKey)
    await registrationStarted.promise
    await associatingVault.associateServerUser(identityKey, 'server-user')
    registration.resolve({
      credentialId: new Uint8Array([3]),
      kek: new Uint8Array(32).fill(7),
    })

    await protecting
    const stored = await store.get(identityKey)
    expect(stored?.serverUserId).toBe('server-user')
    expect(stored?.protection).toBe('passkey')
  })
})
