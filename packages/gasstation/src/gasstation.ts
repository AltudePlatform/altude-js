/**
 * AltudeGasStation — single-entry-point façade for gasless Solana operations.
 *
 * Mirrors `AltudeGasStation.init(context, apiKey)` from the Android SDK.
 *
 * Usage:
 *   const gs = new AltudeGasStation({ apiKey: 'your-key', network: 'devnet' })
 *   const rpc = await gs.getRpcClient()   // Gill client initialised from config RpcUrl
 *   const blockhash = await gs.getBlockhash()
 *   const sig = await gs.send({ to: '...', amount: 1_000_000 })
 */

import type { SolanaNetwork } from '@altude/core'
import type { createAltudeClient } from '@altude/core'
import { AltudeHttpClient, createAltudeDevnetClient, createAltudeMainnetClient } from './client.js'
import { createTransaction, transactionToBase64WithSigners } from 'gill'
import type { Address, IInstruction, TransactionSigner } from 'gill'
import { buildTransferTokensTransaction } from 'gill/programs/token'
import { getTransferSolInstruction } from 'gill/programs'
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
  /** Signer used to build and partially sign the transaction before relay. */
  sourceSigner?: GaslessTransactionSigner
  /** Base64-encoded pre-built signed transaction (optional) */
  signedTransaction?: string
}

export interface GaslessTransactionSigner {
  address: string
  signTransactionMessage(txBytes: Uint8Array): Promise<Uint8Array>
  signMessage(message: Uint8Array): Promise<Uint8Array>
}

export interface SerializeInstructionPayloadOptions {
  latestBlockhash?: string
  feePayer?: string
}

export class AltudeGasStation {
  readonly client: AltudeHttpClient
  #instructions: IInstruction[] = []

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

  /**
   * Initialize relay runtime state (config + RPC client bootstrap).
   * Mirrors the Android-style init flow.
   */
  async init(forceRefresh = false): Promise<ConfigResponse> {
    const config = await this.getConfig(forceRefresh)
    await this.getRpcClient()
    return config
  }

  /** Fetch relay configuration resolved at runtime from the Altude API. */
  async getConfig(forceRefresh = false): Promise<ConfigResponse> {
    return this.client.getConfig(forceRefresh)
  }

  /**
   * Return a Gill-backed Solana RPC client whose endpoint is resolved from
   * the Altude relay config (`RpcUrl`).  This mirrors the Android SDK's
   * `AltudeGasStation.init()` flow where the RPC connection is bootstrapped
   * from the config API response.
   *
   * In mock mode the client uses the well-known public endpoint for the
   * configured network.
   */
  async getRpcClient(): Promise<ReturnType<typeof createAltudeClient>> {
    return this.client.getRpcClient()
  }

  /** Replace the managed transaction instruction list. */
  setInstructions(instructions: readonly IInstruction[]): void {
    this.#instructions = [...instructions]
  }

  /** Append one instruction to the managed transaction instruction list. */
  addInstruction(instruction: IInstruction): void {
    this.#instructions.push(instruction)
  }

  /** Remove one instruction from the managed transaction instruction list. */
  removeInstruction(index: number): IInstruction | undefined {
    if (index < 0 || index >= this.#instructions.length) {
      return undefined
    }
    return this.#instructions.splice(index, 1)[0]
  }

  /** Clear all managed transaction instructions. */
  clearInstructions(): void {
    this.#instructions = []
  }

  /** Read back the current managed transaction instructions. */
  getInstructions(): readonly IInstruction[] {
    return this.#instructions
  }

  /**
   * Serialize managed instructions into a relay-ready transaction payload.
   * Any signer objects already embedded in instruction accounts are used.
   */
  async serializeInstructionPayload(options: SerializeInstructionPayloadOptions = {}): Promise<string> {
    if (this.#instructions.length === 0) {
      throw new Error('No instructions available. Add instructions before serializing.')
    }

    const config = await this.getConfig()
    const rpc = await this.getRpcClient()
    const latestBlockhash =
      options.latestBlockhash ?? (await rpc.rpc.getLatestBlockhash().send()).value.blockhash
    const feePayer = (options.feePayer ?? config.FeePayer) as unknown as Address

    const transaction = createTransaction({
      version: 'legacy',
      feePayer,
      instructions: [...this.#instructions],
      latestBlockhash,
    })

    return transactionToBase64WithSigners(transaction)
  }

  /**
   * Partial-sign a transaction message using the provided signer implementation.
   * Useful when callers control message compilation externally.
   */
  async partialSignTransactionMessage(
    transactionMessageBytes: Uint8Array,
    signer: GaslessTransactionSigner,
  ): Promise<Uint8Array> {
    return signer.signTransactionMessage(transactionMessageBytes)
  }

  /** Relay a serialized instruction payload string to the Altude API. */
  async sendSerializedInstructionPayload(serializedPayload: string): Promise<SendTransactionResponse> {
    return this.sendBatchTransaction({ signedTransaction: serializedPayload })
  }

  /**
   * Relay a gasless SPL token or SOL transfer.
   * If `options.signedTransaction` is provided it is forwarded directly.
   * Otherwise a source signer is required so the SDK can build and partially
   * sign a transaction before handing it to the relay.
   */
  async send(options: SendOptions): Promise<SendTransactionResponse> {
    if (options.signedTransaction) {
      return this.client.sendTransaction({
        transaction: options.signedTransaction,
        ...(options.commitment !== undefined && { commitment: options.commitment }),
      })
    }

    if (!options.sourceSigner) {
      throw new Error(
        'send() requires either a pre-built signedTransaction or a sourceSigner so the SDK can build one.',
      )
    }

    const config = await this.getConfig()
    const rpc = await this.getRpcClient()
    const { value: latestBlockhash } = await rpc.rpc.getLatestBlockhash().send()
    const feePayer = config.FeePayer as unknown as Address
    const sourceSigner = options.sourceSigner as unknown as TransactionSigner
    const destination = options.to as unknown as Address

    let signedTransaction: string
    if (options.token?.trim()) {
      const transaction = await buildTransferTokensTransaction({
        feePayer,
        latestBlockhash,
        mint: options.token.trim() as unknown as Address,
        authority: sourceSigner,
        amount: options.amount,
        destination,
      })
      signedTransaction = await transactionToBase64WithSigners(transaction)
    } else {
      const instruction = getTransferSolInstruction({
        source: sourceSigner,
        destination,
        amount: BigInt(options.amount),
      })
      const transaction = createTransaction({
        version: 'legacy',
        feePayer,
        instructions: [instruction],
        latestBlockhash,
      })
      signedTransaction = await transactionToBase64WithSigners(transaction)
    }

    return this.client.sendTransaction({
      transaction: signedTransaction,
      ...(options.commitment !== undefined && { commitment: options.commitment }),
    })
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
