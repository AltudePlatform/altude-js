/**
 * Altude HTTP client — typed fetch wrapper for the Altude relay API.
 *
 * Endpoints surfaced by the altude-dynamic-gas-station-demo:
 *   GET  /api/transaction/config     → relay runtime config
 *   POST /api/Transaction/blockhash  → { Blockhash: string }
 *   POST /api/Transaction/send       → relay a signed transaction
 *   POST /api/transaction/sendbatch  → relay a batch transaction
 *   POST /api/Account/create         → sponsored account creation
 *   POST /api/account/close          → close an account
 *   POST /api/account/getaccountinfo → fetch account info
 *   POST /api/account/gethistory     → fetch account history
 *
 * Fee payer: ALTn7gyjm29WthZGgs4z6WVAK2PK5U6w4FAtPg3TPY71
 */

import { AltudeError, ALTUDE_API_URLS, ALTUDE_FEE_PAYER, createAltudeClient } from '@altude/core'
import type { SolanaNetwork } from '@altude/core'

export { ALTUDE_FEE_PAYER }

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BlockhashResponse {
  Blockhash: string
}

export interface ConfigResponse {
  FeePayer: string
  RpcUrl: string
  Token: string
  RpcEnvironment: string
  TokenExpiration: string | null
}

export interface SendTransactionOptions {
  /** Base64-encoded signed transaction */
  transaction: string
  /** Commitment level — kept for forward compatibility; not sent to the relay */
  commitment?: 'confirmed' | 'finalized'
}

/** Mirrors Android SDK `TransactionResponse` — all fields are PascalCase as returned by the relay. */
export interface SendTransactionResponse {
  Signature: string
  Status?: string
  Message?: string
}

export interface BatchTransactionOptions {
  /** Base64-encoded signed transaction batch */
  signedTransaction: string
}

export interface CreateAccountOptions {
  /** Base64-encoded partially-signed transaction (built by the gasstation facade) */
  signedTransaction: string
}

/** Mirrors Android SDK `TransactionResponse` — all fields are PascalCase as returned by the relay. */
export interface CreateAccountResponse {
  Signature: string
  Status?: string
  Message?: string
}

export interface CloseAccountOptions {
  /** Base64-encoded partially-signed transaction (built by the gasstation facade) */
  signedTransaction: string
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

export interface GetAccountInfoOptions {
  /** Wallet or account address (base58) */
  accountAddress: string
}

export interface GetAccountInfoResponse {
  [key: string]: unknown
}

export interface GetHistoryOptions {
  /** Page number */
  page: string | number
  /** Page size */
  pageSize: string | number
  /** Wallet address (base58) */
  walletAddress: string
}

export interface GetHistoryResponse {
  [key: string]: unknown
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

/** Mirrors Android SDK `TransactionResponse` — all fields are PascalCase as returned by the relay. */
export interface SwapResponse {
  Signature: string
  Status?: string
  Message?: string
}

// ---------------------------------------------------------------------------
// AltudeHttpClient
// ---------------------------------------------------------------------------

export class AltudeHttpClient {
  readonly apiKey: string | undefined
  readonly baseUrl: string
  readonly isMockMode: boolean
  readonly network: SolanaNetwork
  #configCache: ConfigResponse | undefined
  #configPromise: Promise<ConfigResponse> | undefined
  #rpcClient: ReturnType<typeof createAltudeClient> | undefined

  constructor(apiKey?: string, baseUrl?: string, network: SolanaNetwork = 'mainnet-beta') {
    this.apiKey = apiKey
    this.network = network
    this.baseUrl = baseUrl ?? ALTUDE_API_URLS[network === 'mainnet-beta' ? 'mainnet' : 'devnet']
    this.isMockMode = !apiKey
    if (!this.isMockMode) {
      this.#configPromise = this.#loadConfig()
    }
  }

  async getConfig(forceRefresh = false): Promise<ConfigResponse> {
    if (this.isMockMode) {
      return this.#getMockConfig()
    }
    if (forceRefresh) {
      this.#configCache = undefined
      this.#configPromise = undefined
      this.#rpcClient = undefined
    }
    if (this.#configCache) {
      return this.#configCache
    }
    this.#configPromise ??= this.#loadConfig()
    return this.#configPromise
  }

  /**
   * Return a Gill-backed Solana RPC client whose URL is resolved from the
   * Altude relay config (`RpcUrl` field).  Mirrors the Android SDK's
   * `AltudeGasStation.init()` behaviour where the RPC connection is
   * initialised from the config API response.
   *
   * In mock mode the client falls back to the well-known public endpoint for
   * the configured network.
   */
  async getRpcClient(): Promise<ReturnType<typeof createAltudeClient>> {
    if (this.isMockMode) {
      this.#rpcClient ??= createAltudeClient({ network: this.network })
      return this.#rpcClient
    }
    // #loadConfig() sets #rpcClient from config.RpcUrl; just ensure it ran.
    await this.#ensureConfig()
    // Fallback should never be reached, but keeps TypeScript happy.
    this.#rpcClient ??= createAltudeClient({ network: this.network })
    return this.#rpcClient
  }

  async getBlockhash(): Promise<BlockhashResponse> {
    if (this.isMockMode) {
      return { Blockhash: 'MockBlockhash11111111111111111111111111111111' }
    }
    await this.#ensureConfig()
    return this.#post<BlockhashResponse>('/api/Transaction/blockhash', {})
  }

  async sendTransaction(options: SendTransactionOptions): Promise<SendTransactionResponse> {
    if (this.isMockMode) {
      return { Signature: 'MockSignature' + Math.random().toString(36).slice(2), Status: 'Success', Message: '' }
    }
    await this.#ensureConfig()
    return this.#post<SendTransactionResponse>('/api/Transaction/send', {
      SignedTransaction: options.transaction,
    })
  }

  async sendBatchTransaction(options: BatchTransactionOptions): Promise<SendTransactionResponse> {
    if (this.isMockMode) {
      return { Signature: 'MockBatchSignature' + Math.random().toString(36).slice(2), Status: 'Success', Message: '' }
    }
    await this.#ensureConfig()
    return this.#post<SendTransactionResponse>('/api/transaction/sendbatch', {
      SignedTransaction: options.signedTransaction,
    })
  }

  async sendBatch(options: BatchTransactionOptions): Promise<SendTransactionResponse> {
    return this.sendBatchTransaction(options)
  }

  async createAccount(options: CreateAccountOptions): Promise<CreateAccountResponse> {
    if (this.isMockMode) {
      return { Signature: 'MockAccountSig' + Math.random().toString(36).slice(2), Status: 'Success', Message: '' }
    }
    await this.#ensureConfig()
    return this.#post<CreateAccountResponse>('/api/Account/create', {
      SignedTransaction: options.signedTransaction,
    })
  }

  async closeAccount(options: CloseAccountOptions): Promise<SendTransactionResponse> {
    if (this.isMockMode) {
      return { Signature: 'MockCloseAccountSig' + Math.random().toString(36).slice(2), Status: 'Success', Message: '' }
    }
    await this.#ensureConfig()
    return this.#post<SendTransactionResponse>('/api/account/close', {
      SignedTransaction: options.signedTransaction,
    })
  }

  async getBalance(options: GetBalanceOptions): Promise<BalanceResponse> {
    if (this.isMockMode) {
      return { address: options.address, lamports: 1_000_000_000, uiAmount: 1.0 }
    }
    await this.#ensureConfig()
    return this.#post<BalanceResponse>('/api/Account/balance', {
      accountAddress: options.address,
      mintAddress: options.mint ?? '',
    })
  }

  async getAccountInfo(options: GetAccountInfoOptions): Promise<GetAccountInfoResponse> {
    if (this.isMockMode) {
      return { accountAddress: options.accountAddress, lamports: 0, executable: false }
    }
    await this.#ensureConfig()
    return this.#post<GetAccountInfoResponse>('/api/account/getaccountinfo', options)
  }

  async getHistory(options: GetHistoryOptions): Promise<GetHistoryResponse> {
    if (this.isMockMode) {
      return { items: [], page: options.page, pageSize: options.pageSize, walletAddress: options.walletAddress }
    }
    await this.#ensureConfig()
    const params = new URLSearchParams({
      Page: options.page.toString(),
      PageSize: options.pageSize.toString(),
      walletAddress: options.walletAddress,
    })
    return this.#post<GetHistoryResponse>(`/api/account/gethistory?${params.toString()}`)
  }

  async swap(options: SwapOptions): Promise<SwapResponse> {
    if (this.isMockMode) {
      return { Signature: 'MockSwapSig' + Math.random().toString(36).slice(2), Status: 'Success', Message: '' }
    }
    await this.#ensureConfig()
    return this.#post<SwapResponse>('/api/Transaction/swap', options)
  }

  // ---------------------------------------------------------------------------
  // Internal fetch with retry and error normalization
  // ---------------------------------------------------------------------------

  async #post<T>(path: string, body?: unknown, retries = 3): Promise<T> {
    return this.#request<T>('POST', path, body, retries)
  }

  async #get<T>(path: string, retries = 3): Promise<T> {
    return this.#request<T>('GET', path, undefined, retries)
  }

  async #request<T>(method: 'GET' | 'POST', path: string, body?: unknown, retries = 3): Promise<T> {
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
          method,
          headers,
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        })

        if (!response.ok) {
          const text = await response.text()
          throw new AltudeError({
            code: 'RELAY_ERROR',
            message: `Altude relay returned ${response.status.toString()}: ${text}`,
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
      message: `Request to ${path} failed after ${retries.toString()} attempts`,
      cause: lastError,
    })
  }

  async #ensureConfig(): Promise<void> {
    await this.getConfig()
  }

  async #loadConfig(): Promise<ConfigResponse> {
    const config = await this.#get<ConfigResponse>('/api/transaction/config')
    this.#configCache = config
    // Initialise the RPC client from the relay-resolved RpcUrl (mirrors Android SDK behaviour).
    this.#rpcClient = createAltudeClient({ rpcUrl: config.RpcUrl, network: this.network })
    return config
  }

  #getMockConfig(): ConfigResponse {
    return {
      FeePayer: ALTUDE_FEE_PAYER,
      RpcUrl: this.baseUrl,
      Token: '',
      RpcEnvironment: this.network,
      TokenExpiration: null,
    }
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
