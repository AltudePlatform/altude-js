/**
 * VaultStorage — abstraction over the underlying persistence layer.
 *
 * Two implementations are provided:
 *  - NodeVaultStorage  — filesystem-backed (Node.js), enforces OWS permission model
 *  - BrowserVaultStorage — IndexedDB-backed (browser), uses Web Crypto API
 *
 * OWS permission requirements (storage format spec §Filesystem Permissions):
 *   ~/.ows/              drwx------  (700)
 *   ~/.ows/wallets/      drwx------  (700)
 *   ~/.ows/wallets/*.json -rw-------  (600)
 *   ~/.ows/keys/         drwx------  (700)
 *   ~/.ows/keys/*.json   -rw-------  (600)
 *   ~/.ows/policies/     drwxr-xr-x  (755)
 *   ~/.ows/policies/*.json -rw-r--r-- (644)
 */

export interface VaultStorage {
  /** Read a file. Returns null if not found. */
  read(path: string): Promise<string | null>
  /** Write a file, creating parent directories as needed. */
  write(path: string, data: string): Promise<void>
  /** Delete a file. No-op if not found. */
  delete(path: string): Promise<void>
  /** List entries (files + dirs) in a directory. Returns [] if not found. */
  list(dir: string): Promise<string[]>
  /** Verify that vault directory permissions are safe. Throws on violations. */
  checkPermissions(): Promise<void>
}

// ---------------------------------------------------------------------------
// NodeVaultStorage
// ---------------------------------------------------------------------------

export class NodeVaultStorage implements VaultStorage {
  readonly vaultPath: string

  constructor(vaultPath?: string) {
    // Keep default path derivation dependency-free so ESM builds do not rely
    // on CommonJS require shims.
    this.vaultPath = vaultPath ?? this.#defaultVaultPath()
  }

  #defaultVaultPath(): string {
    const home = process.env['HOME'] ?? process.env['USERPROFILE'] ?? '.'
    return this.#join(home, '.ows')
  }

  async #fsp() {
    return import('node:fs/promises')
  }

  #join(...parts: string[]): string {
    return parts
      .filter((p) => p.length > 0)
      .join('/')
      .replace(/[\\/]+/g, '/')
  }

  #dirname(filePath: string): string {
    const normalized = filePath.replace(/\\/g, '/')
    const idx = normalized.lastIndexOf('/')
    if (idx <= 0) return idx === 0 ? '/' : '.'
    return normalized.slice(0, idx)
  }

  async read(filePath: string): Promise<string | null> {
    const fsp = await this.#fsp()
    try {
      return await fsp.readFile(filePath, 'utf-8')
    } catch (err: unknown) {
      if (isNodeError(err) && err.code === 'ENOENT') return null
      throw err
    }
  }

  async write(filePath: string, data: string): Promise<void> {
    const fsp = await this.#fsp()
    const dir = this.#dirname(filePath)
    await fsp.mkdir(dir, { recursive: true })

    // Determine permission mode from the path
    const mode = this.#modeFor(filePath)
    await fsp.writeFile(filePath, data, { encoding: 'utf-8', mode })

    // Enforce directory permissions
    const dirMode = this.#dirModeFor(dir)
    await fsp.chmod(dir, dirMode)
  }

  async delete(filePath: string): Promise<void> {
    const fsp = await this.#fsp()
    try {
      await fsp.unlink(filePath)
    } catch (err: unknown) {
      if (isNodeError(err) && err.code === 'ENOENT') return
      throw err
    }
  }

  async list(dir: string): Promise<string[]> {
    const fsp = await this.#fsp()
    try {
      return await fsp.readdir(dir)
    } catch (err: unknown) {
      if (isNodeError(err) && err.code === 'ENOENT') return []
      throw err
    }
  }

  async checkPermissions(): Promise<void> {
    const { vaultPermissionError } = await import('@altude/core')
    const fsp = await this.#fsp()

    const sensitiveSubdirs = ['wallets', 'keys']
    for (const sub of sensitiveSubdirs) {
      const dir = this.#join(this.vaultPath, sub)
      try {
        const stat = await fsp.stat(dir)
        // 0o700 = 448 decimal
        if ((stat.mode & 0o777) !== 0o700) {
          throw vaultPermissionError(dir)
        }
      } catch (err: unknown) {
        if (isNodeError(err) && err.code === 'ENOENT') continue
        throw err
      }

      // Check individual files inside
      const entries = await this.list(dir)
      for (const entry of entries) {
        const filePath = this.#join(dir, entry)
        const stat = await fsp.stat(filePath)
        if ((stat.mode & 0o777) !== 0o600) {
          throw vaultPermissionError(filePath)
        }
      }
    }
  }

  #modeFor(filePath: string): number {
    const rel = filePath.replace(/\\/g, '/').replace(this.vaultPath.replace(/\\/g, '/') + '/', '')
    if (rel.startsWith('policies')) return 0o644
    return 0o600
  }

  #dirModeFor(dir: string): number {
    if (dir.includes('policies')) return 0o755
    return 0o700
  }

  /** Full path helpers used by the vault manager. */
  walletPath(id: string): string {
    return this.#join(this.vaultPath, 'wallets', `${id}.json`)
  }

  walletsDir(): string {
    return this.#join(this.vaultPath, 'wallets')
  }

  keyPath(id: string): string {
    return this.#join(this.vaultPath, 'keys', `${id}.json`)
  }

  keysDir(): string {
    return this.#join(this.vaultPath, 'keys')
  }

  policyPath(id: string): string {
    return this.#join(this.vaultPath, 'policies', `${id}.json`)
  }

  auditLogPath(): string {
    return this.#join(this.vaultPath, 'logs', 'audit.jsonl')
  }
}

// ---------------------------------------------------------------------------
// BrowserVaultStorage (IndexedDB)
// ---------------------------------------------------------------------------

const IDB_DB_NAME = 'altude-ows-vault'
const IDB_VERSION = 1
const STORES = ['wallets', 'keys', 'policies', 'logs'] as const
type StoreName = (typeof STORES)[number]

export class BrowserVaultStorage implements VaultStorage {
  #db: IDBDatabase | null = null

  async #openDb(): Promise<IDBDatabase> {
    if (this.#db) return this.#db
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_DB_NAME, IDB_VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        for (const store of STORES) {
          if (!db.objectStoreNames.contains(store)) {
            db.createObjectStore(store)
          }
        }
      }
      req.onsuccess = () => {
        this.#db = req.result
        resolve(req.result)
      }
      req.onerror = () => { reject(req.error ?? new Error('IDB open error')) }
    })
  }

  /** Parse a virtual path like "wallets/abc.json" into store + key. */
  #parsePath(path: string): { store: StoreName; key: string } {
    const parts = path.split('/')
    const store = (parts[0] as StoreName | undefined) ?? 'wallets'
    const key = parts.slice(1).join('/')
    return { store, key }
  }

  async read(path: string): Promise<string | null> {
    const db = await this.#openDb()
    const { store, key } = this.#parsePath(path)
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readonly')
      const req = tx.objectStore(store).get(key)
      req.onsuccess = () => { resolve((req.result as string | undefined) ?? null) }
      req.onerror = () => { reject(req.error ?? new Error('IDB read error')) }
    })
  }

  async write(path: string, data: string): Promise<void> {
    const db = await this.#openDb()
    const { store, key } = this.#parsePath(path)
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite')
      tx.objectStore(store).put(data, key)
      tx.oncomplete = () => { resolve() }
      tx.onerror = () => { reject(tx.error ?? new Error('IDB write error')) }
    })
  }

  async delete(path: string): Promise<void> {
    const db = await this.#openDb()
    const { store, key } = this.#parsePath(path)
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite')
      tx.objectStore(store).delete(key)
      tx.oncomplete = () => { resolve() }
      tx.onerror = () => { reject(tx.error ?? new Error('IDB delete error')) }
    })
  }

  async list(dir: string): Promise<string[]> {
    const db = await this.#openDb()
    const store = dir as StoreName
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readonly')
      const req = tx.objectStore(store).getAllKeys()
      req.onsuccess = () => { resolve(req.result.map(String)) }
      req.onerror = () => { reject(req.error ?? new Error('IDB list error')) }
    })
  }

  /** Browser has no filesystem permissions to check. */
  async checkPermissions(): Promise<void> {
    // No-op in browser
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err
}
