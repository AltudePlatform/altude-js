import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzip } from 'node:zlib'
import { encryptWithPassphrase, restoreVault } from '../index.js'

type TarEntry = {
  name: string
  content: string
}

function createTar(entries: TarEntry[]): Buffer {
  const blocks: Buffer[] = []

  for (const entry of entries) {
    const content = Buffer.from(entry.content, 'utf-8')
    const header = Buffer.alloc(512)
    const nameBytes = Buffer.from(entry.name, 'utf-8')

    nameBytes.copy(header, 0, 0, Math.min(nameBytes.length, 100))
    Buffer.from('0000644\0').copy(header, 100)
    Buffer.from('0000000\0').copy(header, 108)
    Buffer.from('0000000\0').copy(header, 116)
    Buffer.from(content.length.toString(8).padStart(11, '0') + '\0').copy(header, 124)
    Buffer.from(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0').copy(header, 136)
    header[156] = 0x30

    let checksum = 256
    for (let i = 0; i < 512; i++) checksum += header[i] ?? 0
    Buffer.from(checksum.toString(8).padStart(6, '0') + '\0 ').copy(header, 148)

    const paddedLen = Math.ceil(content.length / 512) * 512
    const padded = Buffer.alloc(paddedLen)
    content.copy(padded)

    blocks.push(header, padded)
  }

  blocks.push(Buffer.alloc(1024))
  return Buffer.concat(blocks)
}

async function createEncryptedBackupFile(
  root: string,
  passphrase: string,
  entries: TarEntry[],
): Promise<string> {
  const tarBuffer = createTar(entries)
  const compressed: Buffer = await new Promise((resolve, reject) => {
    gzip(tarBuffer, (err, result) => {
      if (err) reject(err)
      else resolve(result)
    })
  })

  const envelope = await encryptWithPassphrase(new Uint8Array(compressed), passphrase)
  const backupPath = join(root, 'backup.enc')
  await writeFile(backupPath, JSON.stringify(envelope), 'utf-8')
  return backupPath
}

describe('backup restore path hardening', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'altude-vault-backup-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('restores regular archive entries', async () => {
    const passphrase = 'test-passphrase'
    const vaultPath = join(root, 'vault')
    const backupPath = await createEncryptedBackupFile(root, passphrase, [
      { name: 'wallets/w1.json', content: '{"name":"wallet"}' },
    ])

    await restoreVault(vaultPath, { inputPath: backupPath, backupPassphrase: passphrase })

    const restored = await readFile(join(vaultPath, 'wallets/w1.json'), 'utf-8')
    expect(restored).toBe('{"name":"wallet"}')
  })

  it('rejects traversal archive entries', async () => {
    const passphrase = 'test-passphrase'
    const vaultPath = join(root, 'vault')
    const backupPath = await createEncryptedBackupFile(root, passphrase, [
      { name: '../../outside.txt', content: 'owned' },
    ])

    await expect(
      restoreVault(vaultPath, { inputPath: backupPath, backupPassphrase: passphrase }),
    ).rejects.toThrow(/escapes destination/)
  })

  it('rejects absolute archive entries', async () => {
    const passphrase = 'test-passphrase'
    const vaultPath = join(root, 'vault')
    const backupPath = await createEncryptedBackupFile(root, passphrase, [
      { name: '/tmp/absolute.txt', content: 'owned' },
    ])

    await expect(
      restoreVault(vaultPath, { inputPath: backupPath, backupPassphrase: passphrase }),
    ).rejects.toThrow(/Invalid archive entry path/)
  })
})
