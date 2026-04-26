/**
 * Altude HTTP client — typed fetch wrapper for the Altude relay API.
 *
 * Endpoints surfaced by the altude-dynamic-gas-station-demo:
 *   POST /api/Transaction/blockhash  → { Blockhash: string }
 *   POST /api/Transaction/send       → relay a signed transaction
 *   POST /api/Account/create         → sponsored account creation
 *
 * Fee payer: ALTn7gyjm29WthZGgs4z6WVAK2PK5U6w4FAtPg3TPY71
 */

import { AltudeError, ALTUDE_API_URLS, ALTUDE_FEE_PAYER } from '@altude/core'
import type { SolanaNetwork } from '@altude/core'

export { ALTUDE_FEE_PAYER }

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BlockhashResponse {
  Blockhash: string
}

export interface SendTransactionOptions {
  /** Base64-encoded signed transaction */
  transaction: string
  commitment?: 'confirmed' | 'finalized'
}

export interface SendTransactionResponse {
  signature: string
}

export interface CreateAccountOptions {
  /** The new account's public key (base58) */
  newAccountPubkey: string
  /** Space in bytes to allocate */
  space?: number
  /** Program owner */
  programId?: string
}

export interface CreateAccountResponse {
  signature: string
}

export interface GetBalanceOptions {
  /** Wallet address (base58) */
  address: string
  /** SPL token mint address. If omitted, returns SOL balance. */
  mint?: string
}

export interface BalanceResponse {
  address: string
  lamports?: number
  amount?: string
  decimals?: number
  uiAmount?: number
}

export interface SwapOptions {
  /** Input mint address */
  inputMint: string
  /** Output mint address */
  outputMint: string
  /** Amount in lamports / smallest unit */
  amount: number
  /** Signer's public key */
  userPublicKey: string
  /** Slippage in basis points (default 50 = 0.5%) */
  slippageBps?: number
}

export interface SwapResponse {
  signature: string
}

// ---------------------------------------------------------------------------
// AltudeHttpClient
// ---------------------------------------------------------------------------

export class AltudeHttpClient {
  readonly apiKey: string | undefined
  readonly baseUrl: string
  readonly isMockMode: boolean

  constructor(apiKey?: string, baseUrl?: string, network: SolanaNetwork = 'mainnet-beta') {
    this.apiKey = apiKey
    this.baseUrl = baseUrl ?? ALTUDE_API_URLS[network === 'mainnet-beta' ? 'mainnet' : 'devnet']
    this.isMockMode = !apiKey
  }

  async getBlockhash(): Promise<BlockhashResponse> {
    if (this.isMockMode) {
      return { Blockhash: 'MockBlockhash11111111111111111111111111111111' }
    }
    return this.#post<BlockhashResponse>('/api/Transaction/blockhash', {})
  }

  async sendTransaction(options: SendTransactionOptions): Promise<SendTransactionResponse> {
    if (this.isMockMode) {
      return { signature: 'MockSignature' + Math.random().toString(36).slice(2) }
    }
    return this.#post<SendTransactionResponse>('/api/Transaction/send', options)
  }

  async createAccount(options: CreateAccountOptions): Promise<CreateAccountResponse> {
    if (this.isMockMode) {
      return { signature: 'MockAccountSig' + Math.random().toString(36).slice(2) }
    }
    return this.#post<CreateAccountResponse>('/api/Account/create', options)
  }

  async getBalance(options: GetBalanceOptions): Promise<BalanceResponse> {
    if (this.isMockMode) {
      return { address: options.address, lamports: 1_000_000_000, uiAmount: 1.0 }
    }
    return this.#post<BalanceResponse>('/api/Account/balance', options)
  }

  async swap(options: SwapOptions): Promise<SwapResponse> {
    if (this.isMockMode) {
      return { signature: 'MockSwapSig' + Math.random().toString(36).slice(2) }
    }
    return this.#post<SwapResponse>('/api/Transaction/swap', options)
  }

  // ---------------------------------------------------------------------------
  // Internal fetch with retry and error normalization
  // ---------------------------------------------------------------------------

  async #post<T>(path: string, body: unknown, retries = 3): Promise<T> {
    const url = `${this.baseUrl}${path}`
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    if (this.apiKey) {
      headers['X-API-Key'] = this.apiKey
    }

    let lastError: unknown
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        })

        if (!response.ok) {
          const text = await response.text()
          throw new AltudeError({
            code: 'RELAY_ERROR',
            message: `Altude relay returned ${response.status}: ${text}`,
          })
        }

        return (await response.json()) as T
      } catch (err) {
        lastError = err
        if (err instanceof AltudeError) throw err
        // Retry on network errors
        if (attempt < retries - 1) {
          await sleep(200 * 2 ** attempt) // 200ms, 400ms, 800ms
        }
      }
    }

    throw new AltudeError({
      code: 'RELAY_ERROR',
      message: `Request to ${path} failed after ${retries} attempts`,
      cause: lastError,
    })
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// Convenience constructors
// ---------------------------------------------------------------------------

export function createAltudeDevnetClient(apiKey?: string): AltudeHttpClient {
  return new AltudeHttpClient(apiKey, undefined, 'devnet')
}

export function createAltudeMainnetClient(apiKey?: string): AltudeHttpClient {
  return new AltudeHttpClient(apiKey, undefined, 'mainnet-beta')
}
