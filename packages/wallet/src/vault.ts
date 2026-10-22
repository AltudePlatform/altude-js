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

const protectionFields = ['secret', 'ciphertext', 'iv', 'prfSalt', 'credentialId', 'rpId'] as const

function sameBytes(left?: Uint8Array, right?: Uint8Array): boolean {
  return (
    left === right ||
    (left !== undefined &&
      right !== undefined &&
      left.length === right.length &&
      left.every((value, index) => value === right[index]))
  )
}

function sameProtection(left: WalletStoreRecord, right: WalletStoreRecord): boolean {
  return (
    left.publicKey === right.publicKey &&
    left.protection === right.protection &&
    protectionFields.every((field) =>
      field === 'rpId' ? left.rpId === right.rpId : sameBytes(left[field], right[field]),
    )
  )
}

function sameRecord(left: WalletStoreRecord, right: WalletStoreRecord): boolean {
  return (
    left.identityKey === right.identityKey &&
    left.publicKey === right.publicKey &&
    left.serverUserId === right.serverUserId &&
    sameProtection(left, right)
  )
}

function withProtection(
  current: WalletStoreRecord,
  protection: WalletStoreRecord,
): WalletStoreRecord {
  const next = Object.fromEntries(
    Object.entries(current).filter(
      ([key]) => !protectionFields.includes(key as (typeof protectionFields)[number]),
    ),
  ) as WalletStoreRecord
  next.protection = protection.protection
  const fields =
    protection.protection === 'device-local'
      ? (['secret'] as const)
      : (['ciphertext', 'iv', 'prfSalt', 'credentialId', 'rpId'] as const)
  for (const field of fields) {
    const value = protection[field]
    if (value !== undefined) {
      Object.assign(next, { [field]: value instanceof Uint8Array ? value.slice() : value })
    }
  }
  return next
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
      const { record, created } = await this.#write(
        identityKey,
        operation,
        () =>
          this.#store.createIfAbsent({
            identityKey,
            publicKey,
            protection: 'device-local',
            secret: secret.slice(),
          }),
        (result) =>
          result.created
            ? this.#store
                .update(identityKey, (current) =>
                  current && sameRecord(current, result.record) ? undefined : current,
                )
                .then(() => undefined)
            : Promise.resolve(),
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
      if (encodeBase58(ed25519.getPublicKey(secret)) !== record.publicKey) {
        throw new AltudeWalletError(
          'WALLET_LOCKED',
          'The local wallet key changed before passkey protection could be applied.',
        )
      }
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
        await this.#write(
          identityKey,
          operation,
          () =>
            this.#store.update(identityKey, (current) => {
              if (!current) {
                throw new AltudeWalletError(
                  'WALLET_NOT_FOUND',
                  'No local wallet exists for this identity.',
                )
              }
              if (!sameProtection(current, record)) {
                throw new AltudeWalletError(
                  'WALLET_LOCKED',
                  'Wallet protection changed while passkey registration was in progress.',
                )
              }
              return withProtection(current, {
                identityKey: current.identityKey,
                publicKey: current.publicKey,
                ...(current.serverUserId !== undefined
                  ? { serverUserId: current.serverUserId }
                  : {}),
                protection: 'passkey',
                ciphertext,
                iv,
                prfSalt,
                credentialId: registration.credentialId,
                rpId,
              })
            }),
          (written) =>
            written
              ? this.#store
                  .update(identityKey, (current) =>
                    current && sameProtection(current, written)
                      ? withProtection(current, record)
                      : current,
                  )
                  .then(() => undefined)
              : Promise.resolve(),
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
    let changed = false
    let previousServerUserId: string | undefined
    await this.#write(
      identityKey,
      operation,
      () =>
        this.#store.update(identityKey, (record) => {
          if (!record) {
            throw new AltudeWalletError(
              'WALLET_NOT_FOUND',
              'No local wallet exists for this identity.',
            )
          }
          if (record.serverUserId !== undefined && record.serverUserId !== userId) {
            throw new AltudeWalletError(
              'SESSION',
              'This local wallet is already associated with a different server account.',
            )
          }
          previousServerUserId = record.serverUserId
          changed = previousServerUserId !== userId
          return { ...record, serverUserId: userId }
        }),
      () =>
        changed
          ? this.#store
              .update(identityKey, (record) => {
                if (!record || record.serverUserId !== userId) return record
                if (previousServerUserId !== undefined) {
                  return { ...record, serverUserId: previousServerUserId }
                }
                return Object.fromEntries(
                  Object.entries(record).filter(([key]) => key !== 'serverUserId'),
                ) as WalletStoreRecord
              })
              .then(() => undefined)
          : Promise.resolve(),
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
    await this.#write(identityKey, operation, () => this.#store.delete(identityKey))
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
      throw new AltudeWalletError(
        'WALLET_LOCKED',
        'The wallet changed while the operation was in progress.',
      )
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
