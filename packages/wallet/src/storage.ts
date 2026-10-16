import { AltudeWalletError } from './errors.js'
import type {
  SessionTokenStore,
  WalletStore,
  WalletStoreCreateResult,
  WalletStoreRecord,
} from './types.js'

const DATABASE_NAME = 'altude-wallet'
const DATABASE_VERSION = 1
const WALLET_STORE = 'wallets'

export class IndexedDbWalletStore implements WalletStore {
  readonly #factory: IDBFactory
  #database?: Promise<IDBDatabase>

  constructor(factory?: IDBFactory) {
    const indexedDb = factory ?? globalThis.indexedDB
    if (typeof indexedDb === 'undefined') {
      throw new AltudeWalletError(
        'CONFIGURATION',
        'IndexedDB is not available. Provide a WalletStore for this runtime.',
      )
    }
    this.#factory = indexedDb
  }

  async get(identityKey: string): Promise<WalletStoreRecord | undefined> {
    return this.#request(
      'readonly',
      (store) => store.get(identityKey) as IDBRequest<WalletStoreRecord | undefined>,
    )
  }

  async getByServerUserId(serverUserId: string): Promise<WalletStoreRecord | undefined> {
    const records = await this.#request(
      'readonly',
      (store) => store.getAll() as IDBRequest<WalletStoreRecord[]>,
    )
    return records.find((record) => record.serverUserId === serverUserId)
  }

  async createIfAbsent(record: WalletStoreRecord): Promise<WalletStoreCreateResult> {
    const database = await this.#open()
    return new Promise<WalletStoreCreateResult>((resolve, reject) => {
      const transaction = database.transaction(WALLET_STORE, 'readwrite')
      const store = transaction.objectStore(WALLET_STORE)
      const request = store.get(record.identityKey) as IDBRequest<WalletStoreRecord | undefined>
      let result: WalletStoreCreateResult = { record, created: true }
      request.onsuccess = () => {
        if (request.result) {
          result = { record: request.result, created: false }
        } else {
          store.add(record)
        }
      }
      request.onerror = () => {
        reject(request.error ?? new Error('Unable to read the local wallet record.'))
      }
      transaction.oncomplete = () => {
        resolve(result)
      }
      transaction.onerror = () => {
        reject(transaction.error ?? new Error('Unable to create the local wallet record.'))
      }
      transaction.onabort = () => {
        reject(transaction.error ?? new Error('Local wallet creation was aborted.'))
      }
    })
  }

  async put(record: WalletStoreRecord): Promise<void> {
    await this.#request('readwrite', (store) => {
      return store.put(record)
    })
  }

  async delete(identityKey: string): Promise<void> {
    await this.#request('readwrite', (store) => {
      return store.delete(identityKey)
    })
  }

  async #request<T = IDBValidKey>(
    mode: IDBTransactionMode,
    createRequest: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    const database = await this.#open()
    return new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(WALLET_STORE, mode)
      const request = createRequest(transaction.objectStore(WALLET_STORE))
      let result: T | undefined
      request.onsuccess = () => {
        result = request.result
      }
      request.onerror = () => {
        reject(request.error ?? new Error('IndexedDB wallet storage failed.'))
      }
      transaction.oncomplete = () => {
        resolve(result as T)
      }
      transaction.onerror = () => {
        reject(transaction.error ?? new Error('IndexedDB wallet transaction failed.'))
      }
      transaction.onabort = () => {
        reject(transaction.error ?? new Error('IndexedDB wallet transaction aborted.'))
      }
    })
  }

  #open(): Promise<IDBDatabase> {
    if (this.#database) return this.#database
    this.#database = new Promise<IDBDatabase>((resolve, reject) => {
      const request = this.#factory.open(DATABASE_NAME, DATABASE_VERSION)
      request.onupgradeneeded = () => {
        const database = request.result
        if (!database.objectStoreNames.contains(WALLET_STORE)) {
          database.createObjectStore(WALLET_STORE, { keyPath: 'identityKey' })
        }
      }
      request.onsuccess = () => {
        resolve(request.result)
      }
      request.onerror = () => {
        reject(request.error ?? new Error('Unable to open IndexedDB wallet storage.'))
      }
      request.onblocked = () => {
        reject(new Error('IndexedDB wallet storage upgrade is blocked by another tab.'))
      }
    })
    return this.#database
  }
}

export class MemorySessionTokenStore implements SessionTokenStore {
  #token: string | null = null

  get(): Promise<string | null> {
    return Promise.resolve(this.#token)
  }

  set(token: string): Promise<void> {
    this.#token = token
    return Promise.resolve()
  }

  clear(): Promise<void> {
    this.#token = null
    return Promise.resolve()
  }
}

export class BrowserSessionTokenStore implements SessionTokenStore {
  readonly #storage: Storage
  readonly #key: string

  constructor(storage?: Storage, key = 'altude.wallet.session') {
    const sessionStorage = storage ?? globalThis.sessionStorage
    if (typeof sessionStorage === 'undefined') {
      throw new AltudeWalletError(
        'CONFIGURATION',
        'Session Storage is not available in this browser context.',
      )
    }
    if (!key.trim()) throw new AltudeWalletError('CONFIGURATION', 'A storage key is required.')
    this.#storage = sessionStorage
    this.#key = key
  }

  get(): Promise<string | null> {
    return Promise.resolve(this.#storage.getItem(this.#key))
  }

  set(token: string): Promise<void> {
    this.#storage.setItem(this.#key, token)
    return Promise.resolve()
  }

  clear(): Promise<void> {
    this.#storage.removeItem(this.#key)
    return Promise.resolve(undefined)
  }
}
