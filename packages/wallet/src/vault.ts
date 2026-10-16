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

interface VaultOperation {
  globalEpoch: number
  identityEpoch: number
}

export class WalletVault {
  readonly #store: WalletStore
  readonly #passkeys: PasskeyAdapter
  readonly #crypto: Crypto
  readonly #unlocked = new Map<string, Uint8Array>()
  readonly #identityEpochs = new Map<string, number>()
  #globalEpoch = 0
  #writeQueue: Promise<void> = Promise.resolve()

  constructor(options: WalletVaultOptions = {}) {
    this.#crypto = options.crypto ?? globalThis.crypto
    this.#store = options.store ?? new IndexedDbWalletStore(options.indexedDB)
    this.#passkeys = options.passkeys ?? new BrowserPasskeyAdapter()
  }

  async getOrCreateAddress(identityKey: string): Promise<string> {
    this.#assertIdentityKey(identityKey)
    const operation = this.#operation(identityKey)
    const secret = randomBytes(this.#crypto, 32)
    const publicKey = encodeBase58(ed25519.getPublicKey(secret))
    try {
      const { record, created } = await this.#write(identityKey, operation, () =>
        this.#store.createIfAbsent({
          identityKey,
          publicKey,
          protection: 'device-local',
          secret: secret.slice(),
        }),
        (result) => result.created ? this.#store.delete(identityKey) : Promise.resolve(),
      )
      this.#assertCurrent(identityKey, operation)
      if (created) this.#unlocked.set(identityKey, secret)
      else secret.fill(0)
      return record.publicKey
    } catch (error) {
      secret.fill(0)
      throw error
    }
  }

  async unlock(identityKey: string): Promise<WalletProtection> {
    this.#assertIdentityKey(identityKey)
    const operation = this.#operation(identityKey)
    return this.#unlock(identityKey, operation)
  }

  async #unlock(identityKey: string, operation: VaultOperation): Promise<WalletProtection> {
    const record = await this.#requireRecord(identityKey)
    this.#assertCurrent(identityKey, operation)
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
    const secret = record.secret.slice()
    this.#assertCurrent(identityKey, operation)
    this.#unlocked.set(identityKey, secret)
    return record.protection
  }

  async unlockWithPasskey(identityKey: string): Promise<void> {
    this.#assertIdentityKey(identityKey)
    const operation = this.#operation(identityKey)
    const record = await this.#requireRecord(identityKey)
    this.#assertCurrent(identityKey, operation)
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
    try {
      this.#assertCurrent(identityKey, operation)
      const key = await this.#crypto.subtle.importKey('raw', toArrayBuffer(kek), 'AES-GCM', false, [
        'decrypt',
      ])
      this.#assertCurrent(identityKey, operation)
      const secret = new Uint8Array(
        await this.#crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: toArrayBuffer(record.iv) },
          key,
          toArrayBuffer(record.ciphertext),
        ),
      )
      try {
        this.#assertCurrent(identityKey, operation)
        if (encodeBase58(ed25519.getPublicKey(secret)) !== record.publicKey) {
          throw new Error('Wallet key did not match the stored public address.')
        }
        this.#assertCurrent(identityKey, operation)
        this.#unlocked.set(identityKey, secret)
      } catch (error) {
        secret.fill(0)
        throw error
      }
    } catch (error) {
      if (error instanceof AltudeWalletError && error.code === 'WALLET_LOCKED') throw error
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
    this.#assertIdentityKey(identityKey)
    const operation = this.#operation(identityKey)
    const unlockedSecret = this.#unlocked.get(identityKey)
    if (!unlockedSecret)
      throw new AltudeWalletError('WALLET_LOCKED', 'Unlock the wallet before protecting it.')
    const secret = unlockedSecret.slice()

    try {
      const record = await this.#requireRecord(identityKey)
      this.#assertCurrent(identityKey, operation)
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
      let kek = registration.kek
      try {
        this.#assertCurrent(identityKey, operation)
        if (!kek) {
          kek = await this.#passkeys.deriveKey({
            challenge: createPasskeyChallenge(this.#crypto),
            credentialId: registration.credentialId,
            rpId,
            prfSalt,
          })
        }
        this.#assertCurrent(identityKey, operation)
        const iv = randomBytes(this.#crypto, 12)
        const key = await this.#crypto.subtle.importKey(
          'raw',
          toArrayBuffer(kek),
          'AES-GCM',
          false,
          ['encrypt'],
        )
        this.#assertCurrent(identityKey, operation)
        const ciphertext = new Uint8Array(
          await this.#crypto.subtle.encrypt(
            { name: 'AES-GCM', iv: toArrayBuffer(iv) },
            key,
            toArrayBuffer(secret),
          ),
        )
        this.#assertCurrent(identityKey, operation)
        const protectedRecord: WalletStoreRecord = {
          identityKey,
          ...(record.serverUserId ? { serverUserId: record.serverUserId } : {}),
          publicKey: record.publicKey,
          protection: 'passkey',
          ciphertext,
          iv,
          prfSalt,
          credentialId: registration.credentialId,
          rpId,
        }
        await this.#write(
          identityKey,
          operation,
          () => this.#store.put(protectedRecord),
          () => this.#store.put(record),
        )
        this.#assertCurrent(identityKey, operation)
        this.#unlocked.set(identityKey, secret.slice())
      } finally {
        kek?.fill(0)
      }
    } finally {
      secret.fill(0)
    }
  }

  async getSigner(identityKey: string): Promise<GaslessTransactionSigner> {
    this.#assertIdentityKey(identityKey)
    const operation = this.#operation(identityKey)
    const record = await this.#requireRecord(identityKey)
    this.#assertCurrent(identityKey, operation)
    if (!this.#unlocked.has(identityKey)) {
      if (record.protection === 'passkey') {
        throw new AltudeWalletError(
          'WALLET_LOCKED',
          'Unlock this wallet with its registered passkey.',
        )
      }
      throw new AltudeWalletError('WALLET_LOCKED', 'Unlock this wallet before signing.')
    }
    this.#assertCurrent(identityKey, operation)
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
    this.#assertIdentityKey(identityKey)
    const operation = this.#operation(identityKey)
    const record = await this.#requireRecord(identityKey)
    this.#assertCurrent(identityKey, operation)
    if (record.serverUserId && record.serverUserId !== userId) {
      throw new AltudeWalletError(
        'SESSION',
        'This local wallet is already associated with a different server account.',
      )
    }
    await this.#write(
      identityKey,
      operation,
      () => this.#store.put({ ...record, serverUserId: userId }),
      () => this.#store.put(record),
    )
  }

  lock(identityKey?: string): void {
    if (identityKey) {
      this.#identityEpochs.set(identityKey, (this.#identityEpochs.get(identityKey) ?? 0) + 1)
    } else {
      this.#globalEpoch++
    }
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
    const operation = this.#operation(identityKey)
    const record = await this.#store.get(identityKey)
    this.#assertCurrent(identityKey, operation)
    await this.#write(
      identityKey,
      operation,
      () => this.#store.delete(identityKey),
      () => record ? this.#store.put(record) : Promise.resolve(),
    )
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

  #operation(identityKey: string): VaultOperation {
    return {
      globalEpoch: this.#globalEpoch,
      identityEpoch: this.#identityEpochs.get(identityKey) ?? 0,
    }
  }

  #assertCurrent(identityKey: string, operation: VaultOperation): void {
    if (
      operation.identityEpoch !== (this.#identityEpochs.get(identityKey) ?? 0) ||
      operation.globalEpoch !== this.#globalEpoch
    ) {
      throw new AltudeWalletError('WALLET_LOCKED', 'The wallet changed while the operation was in progress.')
    }
  }

  async #write<T>(
    identityKey: string,
    operation: VaultOperation,
    write: () => Promise<T>,
    rollback?: (result: T) => Promise<void>,
  ): Promise<T> {
    let result!: T
    const pending = this.#writeQueue.then(async () => {
      this.#assertCurrent(identityKey, operation)
      result = await write()
      if (!this.#isCurrent(identityKey, operation)) {
        await rollback?.(result)
        this.#assertCurrent(identityKey, operation)
      }
    })
    this.#writeQueue = pending.catch(() => {})
    await pending
    return result
  }

  #isCurrent(identityKey: string, operation: VaultOperation): boolean {
    return (
      operation.identityEpoch === (this.#identityEpochs.get(identityKey) ?? 0) &&
      operation.globalEpoch === this.#globalEpoch
    )
  }
}
