/**
 * AltudeVault — the main entry point for the OWS vault.
 *
 * This is a TypeScript implementation of the Open Wallet Standard (OWS)
 * vault component. It provides OWS-conformant encrypted key storage,
 * API key management, and a declarative policy engine.
 *
 * Usage:
 *   const vault = new AltudeVault()           // uses ~/.ows
 *   const vault = new AltudeVault('/custom')  // custom vault path
 *
 *   // Owner operations (passphrase, no policy enforcement)
 *   const wallet = await vault.createWallet({ name: 'agent-treasury' })
 *   const info = await vault.getWallet('agent-treasury')
 *   const mnemonic = await vault.exportWallet('agent-treasury', passphrase)
 *
 *   // API key management (agent mode)
 *   const { token } = await vault.createApiKey({ name: 'agent', walletId: wallet.id, passphrase })
 *
 *   // Signing
 *   const sig = await vault.signMessage({ walletId: wallet.id, credential: token, message: 'hello' })
 */

import type { WalletInfo, OWSPolicy, SignResult, SignMessageResult } from '@altude/core'
import { apiKeyNotFound } from '@altude/core'
import { NodeVaultStorage } from './storage/index.js'
import type { CreateWalletOptions } from './wallet/index.js'
import {
  createWallet,
  importWalletMnemonic,
  importWalletPrivateKey,
  importSolanaKeypairJson,
  exportWallet,
  listWallets,
  getWallet,
  deleteWallet,
  renameWallet,
  loadWalletFile,
} from './wallet/index.js'
import type { CreateApiKeyOptions, CreatedApiKey } from './wallet/apikeys.js'
import {
  createApiKey,
  listApiKeys,
  revokeApiKey,
  resolveApiKeyAndDecrypt,
} from './wallet/apikeys.js'
import { evaluatePolicies } from './policy/index.js'
import type { AuditEventType } from './audit/index.js'
import { appendAuditLog } from './audit/index.js'
import { decryptWithPassphrase } from './crypto/index.js'
import { deriveSolanaKeypair } from '@altude/core'

// ---------------------------------------------------------------------------
// AltudeVault
// ---------------------------------------------------------------------------

export class AltudeVault {
  readonly storage: NodeVaultStorage

  constructor(vaultPath?: string) {
    this.storage = new NodeVaultStorage(vaultPath)
  }

  // -------------------------------------------------------------------------
  // Wallet lifecycle
  // -------------------------------------------------------------------------

  async createWallet(options: CreateWalletOptions): Promise<WalletInfo> {
    const info = await createWallet(this.storage, options)
    await this.#audit('wallet_created', { wallet_id: info.id })
    return info
  }

  async importWalletMnemonic(
    name: string,
    mnemonic: string,
    passphrase?: string,
    network?: 'mainnet-beta' | 'devnet' | 'testnet',
  ): Promise<WalletInfo> {
    const info = await importWalletMnemonic(this.storage, name, mnemonic, passphrase, network)
    await this.#audit('wallet_created', { wallet_id: info.id })
    return info
  }

  async importWalletPrivateKey(
    name: string,
    privateKey: Uint8Array,
    passphrase?: string,
    network?: 'mainnet-beta' | 'devnet' | 'testnet',
  ): Promise<WalletInfo> {
    const info = await importWalletPrivateKey(this.storage, name, privateKey, passphrase, network)
    await this.#audit('wallet_created', { wallet_id: info.id })
    return info
  }

  async importSolanaKeypairJson(
    name: string,
    keypairJsonPath: string,
    passphrase?: string,
    network?: 'mainnet-beta' | 'devnet' | 'testnet',
  ): Promise<WalletInfo> {
    return importSolanaKeypairJson(this.storage, name, keypairJsonPath, passphrase, network)
  }

  async exportWallet(nameOrId: string, passphrase: string): Promise<string> {
    const result = await exportWallet(this.storage, nameOrId, passphrase)
    await this.#audit('wallet_exported', {})
    return result
  }

  async listWallets(): Promise<WalletInfo[]> {
    return listWallets(this.storage)
  }

  async getWallet(nameOrId: string): Promise<WalletInfo> {
    return getWallet(this.storage, nameOrId)
  }

  async deleteWallet(nameOrId: string): Promise<void> {
    const w = await getWallet(this.storage, nameOrId)
    await deleteWallet(this.storage, nameOrId)
    await this.#audit('wallet_deleted', { wallet_id: w.id })
  }

  async renameWallet(nameOrId: string, newName: string): Promise<WalletInfo> {
    return renameWallet(this.storage, nameOrId, newName)
  }

  // -------------------------------------------------------------------------
  // API key management
  // -------------------------------------------------------------------------

  async createApiKey(options: CreateApiKeyOptions): Promise<CreatedApiKey> {
    const result = await createApiKey(this.storage, options)
    await this.#audit('key_created', { wallet_id: options.walletId, key_id: result.keyInfo.id })
    return result
  }

  async listApiKeys() {
    return listApiKeys(this.storage)
  }

  async revokeApiKey(keyId: string): Promise<void> {
    await revokeApiKey(this.storage, keyId)
    await this.#audit('key_revoked', { key_id: keyId })
  }

  // -------------------------------------------------------------------------
  // Policy management
  // -------------------------------------------------------------------------

  async savePolicy(policy: OWSPolicy): Promise<void> {
    await this.storage.write(
      this.storage.policyPath(policy.id),
      JSON.stringify(policy, null, 2),
    )
  }

  async loadPolicy(id: string): Promise<OWSPolicy | null> {
    const raw = await this.storage.read(this.storage.policyPath(id))
    if (!raw) return null
    return JSON.parse(raw) as OWSPolicy
  }

  // -------------------------------------------------------------------------
  // Signing — OWS signing interface
  // https://github.com/AltudePlatform/OWS-core/blob/main/docs/02-signing-interface.md
  // -------------------------------------------------------------------------

  /**
   * Sign a transaction.
   *
   * @param walletId - Wallet name or UUID
   * @param chainId  - CAIP-2 chain ID or shorthand ("solana")
   * @param transactionBytes - Raw transaction bytes to sign
   * @param credential - Passphrase (owner mode) or OWS API token (agent mode)
   */
  async sign(
    walletId: string,
    chainId: string,
    transactionBytes: Uint8Array,
    credential: string,
  ): Promise<SignResult> {
    const wallet = await loadWalletFile(this.storage, walletId)
    const isAgent = credential.startsWith('ows_key_')

    let secret: Uint8Array

    if (isAgent) {
      // Agent mode: evaluate policies then decrypt via token
      await this.#evaluatePoliciesForAgent(credential, wallet.id, chainId)
      secret = await resolveApiKeyAndDecrypt(this.storage, credential, wallet.id)
    } else {
      // Owner mode: decrypt directly with passphrase, no policy evaluation
      secret = await decryptWithPassphrase(wallet.crypto, credential)
    }

    try {
      const { privateKey } = await this.#secretToKeypair(wallet, secret)
      const { ed25519 } = await import('@noble/curves/ed25519.js')
      const signatureBytes = ed25519.sign(transactionBytes, privateKey)
      await this.#audit('sign', { wallet_id: wallet.id, chain_id: chainId })
      return { signature: Buffer.from(signatureBytes).toString('hex') }
    } finally {
      secret.fill(0)
    }
  }

  /**
   * Sign a raw message (Ed25519 signature over raw bytes — Solana convention).
   */
  async signMessage(
    walletId: string,
    message: string | Uint8Array,
    credential: string,
    encoding: 'utf8' | 'hex' = 'utf8',
  ): Promise<SignMessageResult> {
    const wallet = await loadWalletFile(this.storage, walletId)
    const isAgent = credential.startsWith('ows_key_')

    let secret: Uint8Array

    if (isAgent) {
      await this.#evaluatePoliciesForAgent(credential, wallet.id, 'solana')
      secret = await resolveApiKeyAndDecrypt(this.storage, credential, wallet.id)
    } else {
      secret = await decryptWithPassphrase(wallet.crypto, credential)
    }

    try {
      const messageBytes =
        typeof message === 'string'
          ? encoding === 'hex'
            ? Buffer.from(message, 'hex')
            : new TextEncoder().encode(message)
          : message

      const { privateKey } = await this.#secretToKeypair(wallet, secret)
      const { ed25519 } = await import('@noble/curves/ed25519.js')
      const signatureBytes = ed25519.sign(messageBytes, privateKey)

      await this.#audit('sign_message', { wallet_id: wallet.id })
      return { signature: Buffer.from(signatureBytes).toString('hex') }
    } finally {
      secret.fill(0)
    }
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  async #evaluatePoliciesForAgent(
    token: string,
    walletId: string,
    chainId: string,
  ): Promise<void> {
    const { sha256Hex } = await import('./crypto/index.js')
    const tokenHash = await sha256Hex(token)

    // Find API key by token hash
    const keys = await listApiKeys(this.storage)
    const key = keys.find((k) => k.token_hash === tokenHash)
    if (!key) throw apiKeyNotFound(token)

    // Load policies
    const policies: OWSPolicy[] = []
    for (const policyId of key.policy_ids) {
      const policy = await this.loadPolicy(policyId)
      if (policy) policies.push(policy)
    }

    const context = {
      chain_id: chainId,
      wallet_id: walletId,
      api_key_id: key.id,
      timestamp: new Date().toISOString(),
    }

    await evaluatePolicies(policies, context, true)
  }

  async #secretToKeypair(
    wallet: { key_type: 'mnemonic' | 'private_key' },
    secret: Uint8Array,
  ): Promise<{ privateKey: Uint8Array; publicKey: Uint8Array }> {
    if (wallet.key_type === 'mnemonic') {
      const mnemonic = new TextDecoder().decode(secret)
      return deriveSolanaKeypair(mnemonic)
    } else {
      const { ed25519 } = await import('@noble/curves/ed25519.js')
      const publicKey = ed25519.getPublicKey(secret)
      return { privateKey: secret, publicKey }
    }
  }

  async #audit(
    event: AuditEventType,
    meta: { wallet_id?: string; key_id?: string; chain_id?: string },
  ): Promise<void> {
    try {
      await appendAuditLog(this.storage, {
        timestamp: new Date().toISOString(),
        event,
        success: true,
        ...meta,
      })
    } catch {
      // Audit failures must not block normal operations
    }
  }
}
