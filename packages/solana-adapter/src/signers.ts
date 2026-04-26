/**
 * OWS Vault → Gill KeyPairSigner adapter.
 *
 * Returns a Gill-compatible KeyPairSigner that delegates signing to the
 * AltudeVault under the hood. The credential can be:
 *   - A passphrase  → owner mode, no policy evaluation
 *   - An OWS token  → agent mode, policies enforced
 *
 * Reference: docs/03-policy-engine.md §Access Model
 */

import type { AltudeVault } from '@altude/vault'
import { ed25519 } from '@noble/curves/ed25519.js'

// Gill's KeyPairSigner type — minimal interface for compatibility
export interface GillKeyPairSigner {
  address: string
  signTransactionMessage(txBytes: Uint8Array): Promise<Uint8Array>
  signMessage(message: Uint8Array): Promise<Uint8Array>
}

/**
 * Create a Gill-compatible KeyPairSigner backed by an OWS vault wallet.
 *
 * @param vault      - AltudeVault instance
 * @param nameOrId   - Wallet name or UUID
 * @param credential - Passphrase (owner) or OWS API token (agent)
 */
export async function createOWSGillSigner(
  vault: AltudeVault,
  nameOrId: string,
  credential: string,
): Promise<GillKeyPairSigner> {
  const walletInfo = await vault.getWallet(nameOrId)
  const address = walletInfo.accounts[0]?.address ?? ''

  return {
    address,

    async signTransactionMessage(txBytes: Uint8Array): Promise<Uint8Array> {
      const result = await vault.sign(walletInfo.id, 'solana', txBytes, credential)
      return Buffer.from(result.signature, 'hex')
    },

    async signMessage(message: Uint8Array): Promise<Uint8Array> {
      const result = await vault.signMessage(walletInfo.id, message, credential)
      return Buffer.from(result.signature, 'hex')
    },
  }
}

// ---------------------------------------------------------------------------
// Legacy @solana/web3.js Signer adapter
// ---------------------------------------------------------------------------

/**
 * Minimal interface matching @solana/web3.js Signer.
 * Avoids importing @solana/web3.js as a hard dependency.
 */
export interface Web3Signer {
  publicKey: { toBase58(): string; toBytes(): Uint8Array; toString(): string }
  signTransaction(transaction: unknown): Promise<unknown>
  signAllTransactions(transactions: unknown[]): Promise<unknown[]>
}

/**
 * Create a @solana/web3.js-compatible Signer backed by an OWS vault wallet.
 *
 * @param vault      - AltudeVault instance
 * @param nameOrId   - Wallet name or UUID
 * @param credential - Passphrase or OWS API token
 */
export async function createOWSWeb3Signer(
  vault: AltudeVault,
  nameOrId: string,
  credential: string,
): Promise<Web3Signer> {
  const walletInfo = await vault.getWallet(nameOrId)
  const address = walletInfo.accounts[0]?.address ?? ''
  const addressBytes = decodeBase58(address)

  const publicKeyObj = {
    toBase58: () => address,
    toBytes: () => addressBytes,
    toString: () => address,
  }

  async function signSingleTransaction(transaction: Record<string, unknown>): Promise<Record<string, unknown>> {
    // Extract the serialized message bytes for signing
    const message = transaction['message'] as { serialize?: () => Uint8Array } | undefined
    if (!message?.serialize) {
      throw new Error('Transaction must have a serializable message')
    }
    const msgBytes = message.serialize()
    const sigResult = await vault.sign(walletInfo.id, 'solana', msgBytes, credential)
    const sigBytes = Buffer.from(sigResult.signature, 'hex')

    // Add signature to transaction (web3.js Transaction shape)
    const tx = { ...transaction } as Record<string, unknown>
    const sigs = (tx['signatures'] as Array<{ publicKey: typeof publicKeyObj; signature: Buffer | null }> | undefined) ?? []
    const existing = sigs.findIndex((s) => s.publicKey.toBase58() === address)
    if (existing >= 0) {
      (sigs[existing] as { signature: Buffer }).signature = sigBytes
    } else {
      sigs.push({ publicKey: publicKeyObj, signature: sigBytes })
    }
    tx['signatures'] = sigs
    return tx
  }

  return {
    publicKey: publicKeyObj,

    async signTransaction(transaction: unknown): Promise<unknown> {
      return signSingleTransaction(transaction as Record<string, unknown>)
    },

    async signAllTransactions(transactions: unknown[]): Promise<unknown[]> {
      return Promise.all(transactions.map((tx) => signSingleTransaction(tx as Record<string, unknown>)))
    },
  }
}

// ---------------------------------------------------------------------------
// Helper: base58 decode (for Solana public key bytes)
// ---------------------------------------------------------------------------

function decodeBase58(encoded: string): Uint8Array {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
  let num = BigInt(0)
  for (const char of encoded) {
    const idx = ALPHABET.indexOf(char)
    if (idx === -1) throw new Error(`Invalid base58 character: ${char}`)
    num = num * BigInt(58) + BigInt(idx)
  }
  const bytes: number[] = []
  while (num > BigInt(0)) {
    bytes.unshift(Number(num % BigInt(256)))
    num = num / BigInt(256)
  }
  for (const char of encoded) {
    if (char === '1') bytes.unshift(0)
    else break
  }
  return new Uint8Array(bytes)
}
