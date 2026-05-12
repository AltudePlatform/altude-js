/**
 * OWS Wallet Lifecycle implementation.
 * Covers: create, import, export, list, get, delete, rename.
 *
 * References:
 *  - docs/06-wallet-lifecycle.md
 *  - docs/01-storage-format.md
 */

import type { OWSWallet, OWSAccount, WalletInfo } from '@altude/core'
import {
  walletNotFound,
  vaultStorageError,
  CHAIN_IDS,
  SOLANA_DERIVATION_PATH,
} from '@altude/core'
import type { NodeVaultStorage } from '../storage/index.js'
import {
  encryptWithPassphrase,
  decryptWithPassphrase,
} from '../crypto/index.js'
import { generateMnemonic, deriveSolanaKeypair, deriveSolanaAddress } from '@altude/core'

// ---------------------------------------------------------------------------
// createWallet
// ---------------------------------------------------------------------------

export interface CreateWalletOptions {
  name: string
  passphrase?: string
  words?: 12 | 24
  network?: 'mainnet-beta' | 'devnet' | 'testnet'
  vaultIndex?: number
}

export async function createWallet(
  storage: NodeVaultStorage,
  options: CreateWalletOptions,
): Promise<WalletInfo> {
  const { name, passphrase = '', words = 12, network = 'mainnet-beta', vaultIndex = 0 } = options

  const mnemonic = generateMnemonic(words)
  return importWalletMnemonicInternal(storage, name, mnemonic, passphrase, network, vaultIndex)
}

// ---------------------------------------------------------------------------
// importWalletMnemonic
// ---------------------------------------------------------------------------

export async function importWalletMnemonic(
  storage: NodeVaultStorage,
  name: string,
  mnemonic: string,
  passphrase = '',
  network: 'mainnet-beta' | 'devnet' | 'testnet' = 'mainnet-beta',
  vaultIndex = 0,
): Promise<WalletInfo> {
  return importWalletMnemonicInternal(storage, name, mnemonic, passphrase, network, vaultIndex)
}

async function importWalletMnemonicInternal(
  storage: NodeVaultStorage,
  name: string,
  mnemonic: string,
  passphrase: string,
  network: 'mainnet-beta' | 'devnet' | 'testnet',
  vaultIndex: number,
): Promise<WalletInfo> {
  const id = globalThis.crypto.randomUUID()
  const now = new Date().toISOString()

  const address = await deriveSolanaAddress(mnemonic, vaultIndex)
  const chainId = chainIdForNetwork(network)
  const account: OWSAccount = {
    account_id: `${chainId}:${address}`,
    address,
    chain_id: chainId,
    derivation_path: vaultIndex === 0 ? SOLANA_DERIVATION_PATH : `m/44'/501'/${vaultIndex.toString()}'/0'`,
  }

  // Encrypt the mnemonic (as UTF-8 bytes)
  const crypto = await encryptWithPassphrase(new TextEncoder().encode(mnemonic), passphrase)

  const wallet: OWSWallet = {
    ows_version: 2,
    id,
    name,
    created_at: now,
    accounts: [account],
    crypto,
    key_type: 'mnemonic',
    metadata: {},
  }

  await storage.write(storage.walletPath(id), JSON.stringify(wallet, null, 2))
  return walletToInfo(wallet)
}

// ---------------------------------------------------------------------------
// importWalletPrivateKey
// ---------------------------------------------------------------------------

export async function importWalletPrivateKey(
  storage: NodeVaultStorage,
  name: string,
  privateKey: Uint8Array,
  passphrase = '',
  network: 'mainnet-beta' | 'devnet' | 'testnet' = 'mainnet-beta',
): Promise<WalletInfo> {
  const id = globalThis.crypto.randomUUID()
  const now = new Date().toISOString()

  const { ed25519 } = await import('@noble/curves/ed25519.js')
  const publicKey = ed25519.getPublicKey(privateKey)

  // Encode public key as base58 address
  const address = encodeBase58(publicKey)
  const chainId = chainIdForNetwork(network)

  const account: OWSAccount = {
    account_id: `${chainId}:${address}`,
    address,
    chain_id: chainId,
    derivation_path: SOLANA_DERIVATION_PATH,
  }

  // Encrypt the raw private key bytes
  const crypto = await encryptWithPassphrase(privateKey, passphrase)

  const wallet: OWSWallet = {
    ows_version: 2,
    id,
    name,
    created_at: now,
    accounts: [account],
    crypto,
    key_type: 'private_key',
    metadata: {},
  }

  await storage.write(storage.walletPath(id), JSON.stringify(wallet, null, 2))
  return walletToInfo(wallet)
}

// ---------------------------------------------------------------------------
// importSolanaKeypairJson
// ---------------------------------------------------------------------------

/**
 * Import a wallet from the 64-byte keypair array format used by `solana-keygen`.
 * The array is [privateKey (32 bytes), publicKey (32 bytes)].
 */
export async function importSolanaKeypairJson(
  storage: NodeVaultStorage,
  name: string,
  keypairJsonPath: string,
  passphrase = '',
  network: 'mainnet-beta' | 'devnet' | 'testnet' = 'mainnet-beta',
): Promise<WalletInfo> {
  const raw = await storage.read(keypairJsonPath)
  if (!raw) {
    throw vaultStorageError(`Keypair file not found: ${keypairJsonPath}`)
  }
  const arr = JSON.parse(raw) as number[]
  if (!Array.isArray(arr) || arr.length !== 64) {
    throw vaultStorageError('Expected a 64-byte keypair JSON array')
  }
  const privateKey = new Uint8Array(arr.slice(0, 32))
  return importWalletPrivateKey(storage, name, privateKey, passphrase, network)
}

// ---------------------------------------------------------------------------
// exportWallet
// ---------------------------------------------------------------------------

/**
 * Export a wallet's secret material.
 * - For mnemonic wallets: returns the mnemonic phrase string
 * - For private_key wallets: returns a JSON string { ed25519: "<hex>" }
 */
export async function exportWallet(
  storage: NodeVaultStorage,
  nameOrId: string,
  passphrase: string,
): Promise<string> {
  const wallet = await loadWalletFile(storage, nameOrId)
  const plaintext = await decryptWithPassphrase(wallet.crypto, passphrase)

  if (wallet.key_type === 'mnemonic') {
    return new TextDecoder().decode(plaintext)
  } else {
    const hex = Buffer.from(plaintext).toString('hex')
    return JSON.stringify({ ed25519: hex })
  }
}

// ---------------------------------------------------------------------------
// listWallets / getWallet / deleteWallet / renameWallet
// ---------------------------------------------------------------------------

export async function listWallets(storage: NodeVaultStorage): Promise<WalletInfo[]> {
  const entries = await storage.list(storage.walletsDir())
  const wallets: WalletInfo[] = []
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    const id = entry.replace('.json', '')
    const raw = await storage.read(storage.walletPath(id))
    if (!raw) continue
    wallets.push(walletToInfo(JSON.parse(raw) as OWSWallet))
  }
  return wallets
}

export async function getWallet(storage: NodeVaultStorage, nameOrId: string): Promise<WalletInfo> {
  const wallet = await loadWalletFile(storage, nameOrId)
  return walletToInfo(wallet)
}

export async function deleteWallet(storage: NodeVaultStorage, nameOrId: string): Promise<void> {
  const wallet = await loadWalletFile(storage, nameOrId)
  await storage.delete(storage.walletPath(wallet.id))
}

export async function renameWallet(
  storage: NodeVaultStorage,
  nameOrId: string,
  newName: string,
): Promise<WalletInfo> {
  const wallet = await loadWalletFile(storage, nameOrId)
  const updated: OWSWallet = { ...wallet, name: newName }
  await storage.write(storage.walletPath(wallet.id), JSON.stringify(updated, null, 2))
  return walletToInfo(updated)
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

export async function loadWalletFile(
  storage: NodeVaultStorage,
  nameOrId: string,
): Promise<OWSWallet> {
  // Try direct ID lookup first
  const byId = await storage.read(storage.walletPath(nameOrId))
  if (byId) return JSON.parse(byId) as OWSWallet

  // Scan by name
  const entries = await storage.list(storage.walletsDir())
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    const raw = await storage.read(storage.walletPath(entry.replace('.json', '')))
    if (!raw) continue
    const w = JSON.parse(raw) as OWSWallet
    if (w.name === nameOrId || w.id === nameOrId) return w
  }

  throw walletNotFound(nameOrId)
}

/**
 * Decrypt and return the Solana keypair (private key) from a wallet file.
 * Key material is returned as a Uint8Array that MUST be wiped after use.
 */
export async function decryptSolanaKeypair(
  wallet: OWSWallet,
  credential: string,
): Promise<{ privateKey: Uint8Array; publicKey: Uint8Array }> {
  const plaintext = await decryptWithPassphrase(wallet.crypto, credential)

  if (wallet.key_type === 'mnemonic') {
    const mnemonic = new TextDecoder().decode(plaintext)
    const kp = await deriveSolanaKeypair(mnemonic)
    // Wipe mnemonic bytes
    plaintext.fill(0)
    return kp
  } else {
    // private_key wallet: plaintext is the raw 32-byte Ed25519 private key
    const { ed25519 } = await import('@noble/curves/ed25519.js')
    const publicKey = ed25519.getPublicKey(plaintext)
    return { privateKey: plaintext, publicKey }
  }
}

function walletToInfo(w: OWSWallet): WalletInfo {
  return {
    id: w.id,
    name: w.name,
    createdAt: w.created_at,
    keyType: w.key_type,
    accounts: w.accounts.map((a) => ({
      chainId: a.chain_id,
      address: a.address,
      derivationPath: a.derivation_path,
    })),
  }
}

function chainIdForNetwork(network: 'mainnet-beta' | 'devnet' | 'testnet'): string {
  if (network === 'mainnet-beta') return CHAIN_IDS.SOLANA_MAINNET
  if (network === 'devnet') return CHAIN_IDS.SOLANA_DEVNET
  return CHAIN_IDS.SOLANA_TESTNET
}

function encodeBase58(bytes: Uint8Array): string {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
  let num = BigInt(0)
  for (const byte of bytes) {
    num = num * BigInt(256) + BigInt(byte)
  }
  let result = ''
  while (num > BigInt(0)) {
    const rem = num % BigInt(58)
    num = num / BigInt(58)
    result = (ALPHABET[Number(rem)] ?? '') + result
  }
  for (const byte of bytes) {
    if (byte === 0) result = '1' + result
    else break
  }
  return result
}
