/**
 * AltudeGasStation — single-entry-point façade for gasless Solana operations.
 *
 * Mirrors `AltudeGasStation.init(context, apiKey)` from the Android SDK.
 *
 * Usage:
 *   const gs = new AltudeGasStation({ apiKey: 'your-key', network: 'devnet' })
 *   const blockhash = await gs.getBlockhash()
 *   const sig = await gs.send({ to: '...', amount: 1_000_000 })
 */

import type { SolanaNetwork } from '@altude/core'
import { AltudeHttpClient, createAltudeDevnetClient, createAltudeMainnetClient } from './client.js'
import type {
  ConfigResponse,
  SendTransactionResponse,
  BatchTransactionOptions,
  CreateAccountOptions,
  CreateAccountResponse,
  CloseAccountOptions,
  GetBalanceOptions,
  BalanceResponse,
  GetAccountInfoOptions,
  GetAccountInfoResponse,
  GetHistoryOptions,
  GetHistoryResponse,
  SwapOptions,
  SwapResponse,
  BlockhashResponse,
} from './client.js'

export interface AltudeGasStationConfig {
  apiKey?: string
  network?: SolanaNetwork
  baseUrl?: string
}

export interface SendOptions {
  /** Recipient address (base58) */
  to: string
  /** Amount in lamports (for SOL) or smallest unit (for tokens) */
  amount: number
  /** SPL token mint. Omit for SOL. */
  token?: string
  /** Transaction commitment level */
  commitment?: 'confirmed' | 'finalized'
  /** Base64-encoded pre-built signed transaction (optional) */
  signedTransaction?: string
}

export class AltudeGasStation {
  readonly client: AltudeHttpClient

  constructor(config: AltudeGasStationConfig = {}) {
    const { apiKey, network = 'mainnet-beta', baseUrl } = config

    if (baseUrl) {
      this.client = new AltudeHttpClient(apiKey, baseUrl, network)
    } else if (network === 'devnet' || network === 'testnet') {
      this.client = createAltudeDevnetClient(apiKey)
    } else {
      this.client = createAltudeMainnetClient(apiKey)
    }
  }

  /** Fetch a recent blockhash from the Altude relay. */
  async getBlockhash(): Promise<BlockhashResponse> {
    return this.client.getBlockhash()
  }

  /** Fetch relay configuration resolved at runtime from the Altude API. */
  async getConfig(forceRefresh = false): Promise<ConfigResponse> {
    return this.client.getConfig(forceRefresh)
  }

  /**
   * Relay a gasless SPL token or SOL transfer.
   * If `options.signedTransaction` is provided it is forwarded directly.
   */
  async send(options: SendOptions): Promise<SendTransactionResponse> {
    if (options.signedTransaction) {
      return this.client.sendTransaction({
        transaction: options.signedTransaction,
        ...(options.commitment !== undefined && { commitment: options.commitment }),
      })
    }
    // Placeholder — caller is responsible for building + signing the transaction
    // and passing it as signedTransaction. This branch exists for future
    // built-in transaction construction using Gill.
    throw new Error(
      'send() requires a pre-built signedTransaction (base64). ' +
        'Build the transaction with @altude/solana-adapter and pass it here.',
    )
  }

  /** Create a sponsored Solana account (Altude pays rent). */
  async createAccount(options: CreateAccountOptions): Promise<CreateAccountResponse> {
    return this.client.createAccount(options)
  }

  /** Relay a batch transaction payload. */
  async sendBatchTransaction(options: BatchTransactionOptions): Promise<SendTransactionResponse> {
    return this.client.sendBatchTransaction(options)
  }

  /** Close an account using a signed transaction payload. */
  async closeAccount(options: CloseAccountOptions): Promise<SendTransactionResponse> {
    return this.client.closeAccount(options)
  }

  /**
   * Gasless token swap via Jupiter aggregator.
   * The relay builds, signs (fee payer), and submits the swap transaction.
   */
  async swap(options: SwapOptions): Promise<SwapResponse> {
    return this.client.swap(options)
  }

  /** Fetch SOL or SPL token balance for an address. */
  async getBalance(options: GetBalanceOptions): Promise<BalanceResponse> {
    return this.client.getBalance(options)
  }

  /** Fetch on-chain account info for an address. */
  async getAccountInfo(options: GetAccountInfoOptions): Promise<GetAccountInfoResponse> {
    return this.client.getAccountInfo(options)
  }

  /** Fetch paginated account history for a wallet address. */
  async getHistory(options: GetHistoryOptions): Promise<GetHistoryResponse> {
    return this.client.getHistory(options)
  }
}
