import { ed25519 } from '@noble/curves/ed25519.js'
import type { GaslessTransactionSigner } from '@altude/gasstation'
import { AltudeWalletError } from './errors.js'
import { encodeBase58, randomBytes, toArrayBuffer } from './crypto.js'
import { BrowserPasskeyAdapter, createPasskeyChallenge } from './passkeys.js'
import { IndexedDbWalletStore } from './storage.js'
import type {
  PasskeyAdapter,
  WalletProtection,
  WalletStore,
  WalletStoreRecord,
  WalletVaultOptions,
} from './types.js'

export class WalletVault {
  readonly #store: WalletStore
  readonly #passkeys: PasskeyAdapter
  readonly #crypto: Crypto
  readonly #unlocked = new Map<string, Uint8Array>()

  constructor(options: WalletVaultOptions = {}) {
    this.#crypto = options.crypto ?? globalThis.crypto
    this.#store = options.store ?? new IndexedDbWalletStore(options.indexedDB)
    this.#passkeys = options.passkeys ?? new BrowserPasskeyAdapter()
  }

  async getOrCreateAddress(identityKey: string): Promise<string> {
    this.#assertIdentityKey(identityKey)
    const secret = randomBytes(this.#crypto, 32)
    const publicKey = encodeBase58(ed25519.getPublicKey(secret))
    const { record, created } = await this.#store.createIfAbsent({
      identityKey,
      publicKey,
      protection: 'device-local',
      secret: secret.slice(),
    })
    if (created) {
      this.#unlocked.set(identityKey, secret)
    } else {
      secret.fill(0)
    }
    return record.publicKey
  }

  async unlock(identityKey: string): Promise<WalletProtection> {
    const record = await this.#requireRecord(identityKey)
    if (record.protection === 'passkey') {
      throw new AltudeWalletError(
        'WALLET_LOCKED',
        'Unlock this wallet with its registered passkey.',
      )
    }
    if (!record.secret) {
      throw new AltudeWalletError(
        'WALLET_LOCKED',
        'The local wallet key is missing; sign in with its recovery method.',
      )
    }
    this.#unlocked.set(identityKey, record.secret.slice())
    return record.protection
  }

  async unlockWithPasskey(identityKey: string): Promise<void> {
    const record = await this.#requireRecord(identityKey)
    if (
      record.protection !== 'passkey' ||
      !record.ciphertext ||
      !record.iv ||
      !record.prfSalt ||
      !record.credentialId ||
      !record.rpId
    ) {
      throw new AltudeWalletError(
        'WALLET_LOCKED',
        'This wallet does not have a registered passkey.',
      )
    }
    const kek = await this.#passkeys.deriveKey({
      challenge: createPasskeyChallenge(this.#crypto),
      credentialId: record.credentialId,
      rpId: record.rpId,
      prfSalt: record.prfSalt,
    })
    const key = await this.#crypto.subtle.importKey('raw', toArrayBuffer(kek), 'AES-GCM', false, [
      'decrypt',
    ])
    try {
      const secret = new Uint8Array(
        await this.#crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: toArrayBuffer(record.iv) },
          key,
          toArrayBuffer(record.ciphertext),
        ),
      )
      if (encodeBase58(ed25519.getPublicKey(secret)) !== record.publicKey) {
        secret.fill(0)
        throw new Error('Wallet key did not match the stored public address.')
      }
      this.#unlocked.set(identityKey, secret)
    } catch (error) {
      throw new AltudeWalletError(
        'WALLET_LOCKED',
        'Unable to unlock this wallet. Use the passkey that protected it.',
        undefined,
        error,
      )
    } finally {
      kek.fill(0)
    }
  }

  async protectWithPasskey(identityKey: string): Promise<void> {
    const record = await this.#requireRecord(identityKey)
    const secret = this.#unlocked.get(identityKey)
    if (!secret)
      throw new AltudeWalletError('WALLET_LOCKED', 'Unlock the wallet before protecting it.')

    const currentLocation = Reflect.get(globalThis, 'location') as Location | undefined
    const rpId = currentLocation?.hostname
    if (!rpId)
      throw new AltudeWalletError(
        'CONFIGURATION',
        'A browser origin is required for passkey protection.',
      )
    const prfSalt = randomBytes(this.#crypto, 32)
    const registration = await this.#passkeys.register({
      challenge: createPasskeyChallenge(this.#crypto),
      userId: randomBytes(this.#crypto, 32),
      userName: `altude-${record.publicKey.slice(0, 8)}`,
      rpId,
      rpName: 'Altude Wallet',
      prfSalt,
    })
    const kek =
      registration.kek ??
      (await this.#passkeys.deriveKey({
        challenge: createPasskeyChallenge(this.#crypto),
        credentialId: registration.credentialId,
        rpId,
        prfSalt,
      }))
    const iv = randomBytes(this.#crypto, 12)
    try {
      const key = await this.#crypto.subtle.importKey('raw', toArrayBuffer(kek), 'AES-GCM', false, [
        'encrypt',
      ])
      const ciphertext = new Uint8Array(
        await this.#crypto.subtle.encrypt(
          { name: 'AES-GCM', iv: toArrayBuffer(iv) },
          key,
          toArrayBuffer(secret),
        ),
      )
      await this.#store.put({
        identityKey,
        ...(record.serverUserId ? { serverUserId: record.serverUserId } : {}),
        publicKey: record.publicKey,
        protection: 'passkey',
        ciphertext,
        iv,
        prfSalt,
        credentialId: registration.credentialId,
        rpId,
      })
      this.#unlocked.set(identityKey, secret)
    } finally {
      kek.fill(0)
    }
  }

  async getSigner(identityKey: string): Promise<GaslessTransactionSigner> {
    const record = await this.#requireRecord(identityKey)
    if (!this.#unlocked.has(identityKey)) {
      if (record.protection === 'passkey') {
        throw new AltudeWalletError(
          'WALLET_LOCKED',
          'Unlock this wallet with its registered passkey.',
        )
      }
      await this.unlock(identityKey)
    }
    const secret = this.#unlocked.get(identityKey)
    if (!secret) throw new AltudeWalletError('WALLET_LOCKED', 'Unlock the wallet before signing.')
    return {
      address: record.publicKey,
      signTransactionMessage: (bytes) => {
        const currentSecret = this.#unlocked.get(identityKey)
        if (!currentSecret) {
          return Promise.reject(
            new AltudeWalletError('WALLET_LOCKED', 'The wallet was locked before signing.'),
          )
        }
        return Promise.resolve(ed25519.sign(bytes, currentSecret))
      },
    }
  }

  async protection(identityKey: string): Promise<WalletProtection | null> {
    return (await this.#store.get(identityKey))?.protection ?? null
  }

  isUnlocked(identityKey: string): boolean {
    return this.#unlocked.has(identityKey)
  }

  async findByServerUserId(userId: string): Promise<WalletStoreRecord | undefined> {
    return this.#store.getByServerUserId(userId)
  }

  async associateServerUser(identityKey: string, userId: string): Promise<void> {
    const record = await this.#requireRecord(identityKey)
    await this.#store.put({ ...record, serverUserId: userId })
  }

  lock(identityKey?: string): void {
    const entries = identityKey
      ? [[identityKey, this.#unlocked.get(identityKey)] as const]
      : [...this.#unlocked.entries()]
    for (const [key, secret] of entries) {
      secret?.fill(0)
      this.#unlocked.delete(key)
    }
  }

  async delete(identityKey: string): Promise<void> {
    this.lock(identityKey)
    await this.#store.delete(identityKey)
  }

  async #requireRecord(identityKey: string): Promise<WalletStoreRecord> {
    this.#assertIdentityKey(identityKey)
    const record = await this.#store.get(identityKey)
    if (!record)
      throw new AltudeWalletError('WALLET_NOT_FOUND', 'No local wallet exists for this identity.')
    return record
  }

  #assertIdentityKey(identityKey: string): void {
    if (!identityKey.trim() || identityKey.length > 512) {
      throw new AltudeWalletError(
        'INVALID_INPUT',
        'A stable identity key is required for local wallet isolation.',
      )
    }
  }
}
