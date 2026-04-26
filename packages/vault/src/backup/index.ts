/**
 * Vault backup and restore — Node.js only.
 *
 * Creates an AES-256-GCM encrypted tar archive of the entire ~/.ows/ vault,
 * excluding the logs/ subdirectory.
 *
 * Reference: OWS lifecycle spec §Backup
 */

import { encryptWithPassphrase, decryptWithPassphrase } from '../crypto/index.js'

export interface BackupOptions {
  outputPath: string
  backupPassphrase: string
  /** Directories to exclude from the backup (relative to vault root). Defaults to ['logs']. */
  exclude?: string[]
}

export interface RestoreOptions {
  inputPath: string
  backupPassphrase: string
}

/**
 * Create an encrypted backup of the OWS vault directory.
 * Produces a binary file: <AES-256-GCM encrypted tar.gz>
 */
export async function backupVault(vaultPath: string, options: BackupOptions): Promise<void> {
  const zlib = await import('node:zlib')
  const tar = await importTar()
  const fsp = await import('node:fs/promises')
  const path = await import('node:path')

  const { outputPath, backupPassphrase, exclude = ['logs'] } = options

  // Create tar.gz in memory
  const tarBuffer = await tar.create(vaultPath, exclude)

  // Compress
  const compressed: Buffer = await new Promise((resolve, reject) => {
    zlib.gzip(tarBuffer, (err, result) => {
      if (err) reject(err)
      else resolve(result)
    })
  })

  // Encrypt
  const envelope = await encryptWithPassphrase(new Uint8Array(compressed), backupPassphrase)
  const envelopeJson = JSON.stringify(envelope)

  await fsp.writeFile(outputPath, envelopeJson, 'utf-8')
  await fsp.chmod(outputPath, 0o600)
}

/**
 * Restore a vault from an encrypted backup.
 */
export async function restoreVault(vaultPath: string, options: RestoreOptions): Promise<void> {
  const zlib = await import('node:zlib')
  const fsp = await import('node:fs/promises')
  const tar = await importTar()

  const { inputPath, backupPassphrase } = options

  const envelopeJson = await fsp.readFile(inputPath, 'utf-8')
  const envelope = JSON.parse(envelopeJson) as Parameters<typeof decryptWithPassphrase>[0]

  const compressed = await decryptWithPassphrase(envelope, backupPassphrase)

  const tarBuffer: Buffer = await new Promise((resolve, reject) => {
    zlib.gunzip(Buffer.from(compressed), (err, result) => {
      if (err) reject(err)
      else resolve(result)
    })
  })

  await tar.extract(tarBuffer, vaultPath)
}

// ---------------------------------------------------------------------------
// Minimal tar implementation (no external dependency)
// ---------------------------------------------------------------------------

// We implement a basic tar creator/extractor inline to avoid adding a
// dependency. Only regular files are supported (sufficient for the OWS vault).

const importTar = async () => ({
  create: createTar,
  extract: extractTar,
})

async function createTar(rootDir: string, exclude: string[]): Promise<Buffer> {
  const fsp = await import('node:fs/promises')
  const path = await import('node:path')

  const files: { relPath: string; content: Buffer }[] = []

  async function walk(dir: string): Promise<void> {
    const entries = await fsp.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)
      const relPath = path.relative(rootDir, fullPath)
      const topLevel = relPath.split(path.sep)[0] ?? ''
      if (exclude.includes(topLevel)) continue

      if (entry.isDirectory()) {
        await walk(fullPath)
      } else if (entry.isFile()) {
        const content = await fsp.readFile(fullPath)
        files.push({ relPath, content })
      }
    }
  }

  try {
    await walk(rootDir)
  } catch {
    // Vault may not exist yet — return empty archive
    return Buffer.alloc(1024) // 2 × 512-byte end-of-archive blocks
  }

  const blocks: Buffer[] = []
  for (const { relPath, content } of files) {
    // 512-byte header
    const header = Buffer.alloc(512)
    const nameBytes = Buffer.from(relPath, 'utf-8')
    nameBytes.copy(header, 0, 0, Math.min(nameBytes.length, 100))
    // file mode
    Buffer.from('0000644\0').copy(header, 100)
    // uid / gid
    Buffer.from('0000000\0').copy(header, 108)
    Buffer.from('0000000\0').copy(header, 116)
    // size (octal)
    Buffer.from(content.length.toString(8).padStart(11, '0') + '\0').copy(header, 124)
    // mtime
    Buffer.from(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0').copy(header, 136)
    // typeflag = regular file
    header[156] = 0x30
    // Compute checksum
    let checksum = 256 // 8 space bytes (148–155)
    for (let i = 0; i < 512; i++) checksum += header[i] ?? 0
    Buffer.from(checksum.toString(8).padStart(6, '0') + '\0 ').copy(header, 148)

    blocks.push(header)

    // File content + padding to 512-byte boundary
    const paddedLen = Math.ceil(content.length / 512) * 512
    const padded = Buffer.alloc(paddedLen)
    content.copy(padded)
    blocks.push(padded)
  }

  // Two 512-byte null blocks (end of archive)
  blocks.push(Buffer.alloc(1024))
  return Buffer.concat(blocks)
}

async function extractTar(tarBuffer: Buffer, destDir: string): Promise<void> {
  const fsp = await import('node:fs/promises')
  const path = await import('node:path')

  await fsp.mkdir(destDir, { recursive: true })

  let offset = 0
  while (offset + 512 <= tarBuffer.length) {
    const header = tarBuffer.subarray(offset, offset + 512)
    // Check for end-of-archive (two null blocks)
    if (header.every((b) => b === 0)) break

    const nameEnd = header.indexOf(0, 0)
    const name = header.subarray(0, nameEnd === -1 ? 100 : nameEnd).toString('utf-8')
    if (!name) break

    const sizeStr = header.subarray(124, 135).toString('ascii').trim().replace(/\0/g, '')
    const size = parseInt(sizeStr, 8)
    if (isNaN(size)) break

    offset += 512
    const content = tarBuffer.subarray(offset, offset + size)
    offset += Math.ceil(size / 512) * 512

    const fullPath = path.join(destDir, name)
    await fsp.mkdir(path.dirname(fullPath), { recursive: true })
    await fsp.writeFile(fullPath, content, { mode: 0o600 })
  }
}
