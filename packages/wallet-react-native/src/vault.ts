import { ed25519 } from '@noble/curves/ed25519.js'
import { base58, base64url } from '@scure/base'
import type { GaslessTransactionSigner } from '@altude/gasstation'
import { NativeWalletError } from './errors.js'
import type { KeychainModule, RandomBytesSource } from './platform.js'

export interface NativeWalletScope {
  appId: string
  walletUserId: string
}

export interface NativeWalletKeyStore {
  read(scope: NativeWalletScope, address: string): Promise<Uint8Array | null>
  write(scope: NativeWalletScope, address: string, secret: Uint8Array): Promise<void>
}

export function createKeychainWalletKeyStore(keychain: KeychainModule): NativeWalletKeyStore {
  const accessible = keychain.ACCESSIBLE?.WHEN_UNLOCKED_THIS_DEVICE_ONLY
  if (accessible === undefined) {
    throw new NativeWalletError('CONFIGURATION', 'Device-only Keychain protection is required.')
  }
  const service = (scope: NativeWalletScope, address: string) =>
    `so.altude.wallet.key.${encodeURIComponent(scope.appId)}.${encodeURIComponent(scope.walletUserId)}.${address}`
  return {
    async read(scope, address) {
      try {
        const record = await keychain.getGenericPassword({ service: service(scope, address) })
        return record === false ? null : base64url.decode(record.password)
      } catch (cause) {
        throw new NativeWalletError(
          'SECURE_STORAGE',
          'The protected wallet key could not be read.',
          undefined,
          cause,
        )
      }
    },
    async write(scope, address, secret) {
      try {
        const result = await keychain.setGenericPassword(
          'altude-wallet-key',
          base64url.encode(secret),
          {
            service: service(scope, address),
            accessible,
          },
        )
        if (result === false) throw new Error('Protected storage declined the key write.')
      } catch (cause) {
        throw new NativeWalletError(
          'SECURE_STORAGE',
          'The wallet key could not be saved to protected storage.',
          undefined,
          cause,
        )
      }
    },
  }
}

export class NativeWalletVault {
  readonly #store: NativeWalletKeyStore
  readonly #randomBytes: RandomBytesSource
  #secret: Uint8Array | undefined
  #generation = 0

  constructor(store: NativeWalletKeyStore, randomBytes: RandomBytesSource) {
    this.#store = store
    this.#randomBytes = randomBytes
  }

  async create(scope: NativeWalletScope): Promise<string> {
    const secret = this.#randomBytes(32)
    if (!(secret instanceof Uint8Array) || secret.length !== 32) {
      throw new NativeWalletError('CONFIGURATION', 'The random source must return 32 secure bytes.')
    }
    try {
      const address = base58.encode(ed25519.getPublicKey(secret))
      // Persist before registration so an interrupted setup cannot lose a registered key.
      await this.#store.write(scope, address, secret)
      return address
    } finally {
      secret.fill(0)
    }
  }

  async unlock(scope: NativeWalletScope, address: string): Promise<GaslessTransactionSigner> {
    this.lock()
    const generation = this.#generation
    const secret = await this.#store.read(scope, address)
    if (!secret) {
      throw new NativeWalletError(
        'RECOVERY_REQUIRED',
        'This wallet exists, but its signing key is unavailable on this device. Provision or recover the original key.',
      )
    }
    if (generation !== this.#generation) {
      secret.fill(0)
      throw new NativeWalletError('LOCKED', 'Wallet unlock was superseded.')
    }
    if (secret.length !== 32 || base58.encode(ed25519.getPublicKey(secret)) !== address) {
      secret.fill(0)
      throw new NativeWalletError(
        'SECURE_STORAGE',
        'The protected key does not match the registered wallet.',
      )
    }
    this.#secret = secret
    const sign = (message: Uint8Array): Promise<Uint8Array> => {
      if (generation !== this.#generation || !this.#secret) {
        throw new NativeWalletError('LOCKED', 'The wallet signer is locked.')
      }
      return Promise.resolve(ed25519.sign(message, this.#secret))
    }
    return { address, signMessage: sign, signTransactionMessage: sign }
  }

  lock(): void {
    this.#generation += 1
    this.#secret?.fill(0)
    this.#secret = undefined
  }
}
