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
import { createTransaction, transactionToBase64WithSigners, createNoopSigner } from 'gill'
import type { Address, Instruction, TransactionSigner } from 'gill'
import { buildTransferTokensTransaction } from 'gill/programs/token'
import { getTransferSolInstruction, getCreateAccountInstruction } from 'gill/programs'
import { getCloseAccountInstruction } from 'gill/programs/token'
import type {
  ConfigResponse,
  SendTransactionResponse,
  BatchTransactionOptions,
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
  feePayer?: string
}

export interface CreateAccountOptions {
  /** The new account's public key (base58). Must match the provided signer's address. */
  newAccountPubkey: string
  /** Space in bytes to allocate (default: 0) */
  space?: number
  /** Program that will own the account (default: System Program) */
  programId?: string
  /**
   * Lamports to deposit for rent-exemption.
   * Obtain via `rpc.getMinimumBalanceForRentExemption(space).send()`.
   */
  lamports: number
  /** Signer for the new account (the keypair being created). */
  signer: GaslessTransactionSigner
}

export interface CreateAccountResponse {
  Signature: string
  Status?: string
  Message?: string
}

export interface CloseAccountOptions {
  /** The token account to close (base58). */
  accountAddress: string
  /** Destination address that will receive the reclaimed rent lamports (base58). */
  destination: string
  /**
   * Authority that can close the account.
   *
   * - Provide the user's signer when the **user** is the close authority.
   * - Omit when the **fee payer** (Altude relay) is the close authority; the
   *   relay will add its signature server-side.
   */
  signer?: GaslessTransactionSigner
}

export class AltudeGasStation {
  readonly client: AltudeHttpClient
  #instructions: Instruction[] = []

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
  setInstructions(instructions: readonly Instruction[]): void {
    this.#instructions = [...instructions]
  }

  /** Append one instruction to the managed transaction instruction list. */
  addInstruction(instruction: Instruction): void {
    this.#instructions.push(instruction)
  }

  /** Remove one instruction from the managed transaction instruction list. */
  removeInstruction(index: number): Instruction | undefined {
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
  getInstructions(): readonly Instruction[] {
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
    const latestBlockhash = (await rpc.rpc.getLatestBlockhash().send()).value
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

  /**
   * Create a sponsored Solana account.
   *
   * Mirrors the Android SDK flow:
   *   1. Generate `SystemProgram.createAccount` instruction (fee payer as relay signer)
   *   2. Partial-sign with the new account's signer
   *   3. Send the partially-signed transaction to the Altude relay
   *
   * The relay (fee payer) adds its signature server-side and broadcasts the
   * transaction, covering the rent deposit and transaction fee on behalf of
   * the user.
   */
  async createAccount(options: CreateAccountOptions): Promise<CreateAccountResponse> {
    const config = await this.getConfig()
    const rpc = await this.getRpcClient()
    const { value: latestBlockhash } = await rpc.rpc.getLatestBlockhash().send()
    const feePayer = config.FeePayer as unknown as Address

    // The relay (fee payer) pays rent — use a noop signer so the slot stays
    // empty for the relay to fill in server-side.
    const feePayerNoop = createNoopSigner(feePayer)
    const newAccountSigner = options.signer as unknown as TransactionSigner

    const SYSTEM_PROGRAM_ADDRESS = '11111111111111111111111111111111' as unknown as Address
    const programAddress = (options.programId ?? SYSTEM_PROGRAM_ADDRESS) as unknown as Address

    const instruction = getCreateAccountInstruction({
      payer: feePayerNoop,
      newAccount: newAccountSigner,
      lamports: BigInt(options.lamports),
      space: BigInt(options.space ?? 0),
      programAddress,
    })

    const transaction = createTransaction({
      version: 'legacy',
      feePayer,
      instructions: [instruction],
      latestBlockhash,
    })

    const signedTransaction = await transactionToBase64WithSigners(transaction)
    return this.client.createAccount({ signedTransaction })
  }

  /** Relay a batch transaction payload. */
  async sendBatchTransaction(options: BatchTransactionOptions): Promise<SendTransactionResponse> {
    return this.client.sendBatchTransaction(options)
  }

  /** Relay a batch transaction payload. */
  async sendBatch(options: BatchTransactionOptions): Promise<SendTransactionResponse> {
    return this.sendBatchTransaction(options)
  }

  /**
   * Close a token account and reclaim its rent lamports.
   *
   * Mirrors the Android SDK flow:
   *   1. Generate `Token.closeAccount` instruction
   *   2. Partial-sign with the close authority's signer (if provided)
   *   3. Send the partially-signed transaction to the Altude relay
   *
   * When the fee payer (Altude relay) is the close authority — as set during
   * account creation — omit `signer`; the relay adds its own signature
   * server-side.  When the user holds the close authority, pass their signer.
   */
  async closeAccount(options: CloseAccountOptions): Promise<SendTransactionResponse> {
    const config = await this.getConfig()
    const rpc = await this.getRpcClient()
    const { value: latestBlockhash } = await rpc.rpc.getLatestBlockhash().send()
    const feePayer = config.FeePayer as unknown as Address

    // Resolve the close authority: user-provided signer or noop for relay.
    const closeAuthority: Address | TransactionSigner = options.signer
      ? (options.signer as unknown as TransactionSigner)
      : createNoopSigner(feePayer)

    const instruction = getCloseAccountInstruction({
      account: options.accountAddress as unknown as Address,
      destination: options.destination as unknown as Address,
      owner: closeAuthority,
    })

    const transaction = createTransaction({
      version: 'legacy',
      feePayer,
      instructions: [instruction],
      latestBlockhash,
    })

    const signedTransaction = await transactionToBase64WithSigners(transaction)
    return this.client.closeAccount({ signedTransaction })
  }

  /**
   * Gasless token swap via the Jupiter aggregator.
   *
   * Expected flow (mirrors Android SDK):
   *   1. Send swap parameters to the Altude relay.
   *   2. The relay fetches a Jupiter quote and builds a partially-signed
   *      transaction (fee payer signature included, user signature missing).
   *   3. The caller signs the transaction with `options.signer`.
   *   4. The fully-signed transaction is sent back to the relay for broadcast.
   *
   * If `options.signer` is not provided the relay is responsible for the
   * entire flow.  Note that most Jupiter swap transactions debit the **user's**
   * token accounts, so omitting the signer will only work when the relay has
   * an alternative signing arrangement for those accounts.
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
