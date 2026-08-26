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
import {
  createTransaction,
  transactionToBase64WithSigners,
  createNoopSigner,
  address,
  type Address,
  type Instruction,
  type TransactionSigner,
  findAssociatedTokenPda,
  getCreateAssociatedTokenInstructionAsync,
  getCreateAssociatedTokenIdempotentInstruction,
  getTransferInstruction,
  getSetAuthorityInstruction,
  AuthorityType,
  getCloseAccountInstruction,
  getSetComputeUnitLimitInstruction,
  getSetComputeUnitPriceInstruction,
  getRequestHeapFrameInstruction,
  getTransferSolInstruction,
} from './solana.js'
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
  /** Sender wallet address (base58). Mirrors Android SDK `SendOptions.account`. */
  account?: string
  /** Recipient address (base58). Mirrors Android SDK `SendOptions.toAddress`. */
  toAddress?: string
  /** Recipient address (base58). Kept for backward compatibility; prefer `toAddress`. */
  to?: string
  /** Amount in lamports (for SOL) or smallest unit (for tokens) */
  amount: number
  /** SPL token mint. Omit for SOL. */
  token?: string
  /** Transaction commitment level */
  commitment?: 'confirmed' | 'finalized'
  /** Compute budget options. Mirrors Android SDK `SendOptions.computeOptions`. */
  computeOptions?: {
    computeUnitLimit?: number
    computeUnitPriceMicroLamports?: number
    heapFrameBytes?: number
  }
  /** Signer used to build and partially sign the transaction before relay. */
  sourceSigner?: GaslessTransactionSigner
  /** Base64-encoded pre-built signed transaction (optional) */
  signedTransaction?: string
}

export interface GaslessTransactionSigner {
  address: string
  /** Preferred Gill-compatible signer method. */
  signTransactionMessage?: (txBytes: Uint8Array) => Promise<Uint8Array>
  /** Backward-compatible alias used by some client integrations. */
  sign?: (txBytes: Uint8Array) => Promise<Uint8Array>
  signMessage?: (message: Uint8Array) => Promise<Uint8Array>
}

export interface SerializeInstructionPayloadOptions {
  feePayer?: string
}

export interface CreateAccountOptions {
  /** Wallet address for token account ownership. Must match the signer when provided. */
  account?: string
  /** Token mints for ATAs to create. Mirrors Android SDK default to USDC. */
  tokens?: string[]
  /** Reference passthrough field for Android SDK shape parity. */
  reference?: string
  /** Commitment for blockhash resolution. */
  commitment?: 'processed' | 'confirmed' | 'finalized'
  /** Compute budget options matching Android SDK structure. */
  computeOptions?: {
    computeUnitLimit?: number
    computeUnitPriceMicroLamports?: number
    heapFrameBytes?: number
  }
  /** Backward-compatible signer location; Android SDK passes signer separately. */
  signer?: GaslessTransactionSigner
}

export interface CreateAccountResponse {
  Signature: string
  Status?: string
  Message?: string
}

export interface CloseAccountOptions {
  /**
   * The specific token account to close (base58).
   * Use with `destination` for a direct single-account close.
   */
  accountAddress?: string
  /** Destination address that will receive the reclaimed rent lamports (base58). */
  destination?: string
  /**
   * Wallet address (base58). Mirrors Android SDK `CloseAccountOption.account`.
   * When combined with `tokens`, ATAs are auto-discovered and closed.
   */
  account?: string
  /**
   * Token mints whose associated token accounts should be closed.
   * Mirrors Android SDK `CloseAccountOption.tokens`. Defaults to USDC.
   */
  tokens?: string[]
  /** Reference passthrough field. Mirrors Android SDK `CloseAccountOption.reference`. */
  reference?: string
  /** Commitment for blockhash resolution. Mirrors Android SDK `CloseAccountOption.commitment`. */
  commitment?: 'processed' | 'confirmed' | 'finalized'
  /** Compute budget options. Mirrors Android SDK `CloseAccountOption.computeOptions`. */
  computeOptions?: {
    computeUnitLimit?: number
    computeUnitPriceMicroLamports?: number
    heapFrameBytes?: number
  }
  /**
   * Authority that can close the account.
   *
   * - Provide the user's signer when the **user** is the close authority.
   * - Omit when the **fee payer** (Altude relay) is the close authority; the
   *   relay will add its signature server-side.
   */
  signer?: GaslessTransactionSigner
}

const TOKEN_PROGRAM_ADDRESS = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')

async function getAssociatedTokenAccountAddress(mint: Address, owner: Address) {
  return (
    await findAssociatedTokenPda({
      mint,
      owner,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    })
  )[0]
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

  /** Fetch a recent blockhash from the configured RPC endpoint. */
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
    const latestBlockhash = (await rpc.rpc.getLatestBlockhash({ commitment: 'finalized' }).send()).value
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
    return this.sign(transactionMessageBytes, signer)
  }

  /**
   * Sign raw transaction message bytes using the provided signer.
   * Supports both `signTransactionMessage()` and legacy `sign()` methods.
   */
  async sign(transactionMessageBytes: Uint8Array, signer: GaslessTransactionSigner): Promise<Uint8Array> {
    if (signer.signTransactionMessage) {
      return signer.signTransactionMessage(transactionMessageBytes)
    }
    if (signer.sign) {
      return signer.sign(transactionMessageBytes)
    }
    throw new Error('Signer must implement signTransactionMessage(txBytes) or sign(txBytes).')
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

    const destination = options.toAddress ?? options.to
    if (!destination) {
      throw new Error('send() requires a recipient address (toAddress or to).')
    }

    const execute = async (): Promise<SendTransactionResponse> => {
      const config = await this.getConfig()
      const rpc = await this.getRpcClient()
      const feePayer = config.FeePayer as unknown as Address
      const sourceSigner = this.#toTransactionSigner(options.sourceSigner as GaslessTransactionSigner)
      const destinationAddress = destination as unknown as Address
      const computeOptions = options.computeOptions ?? {}

      // 1) Build instructions / transaction inputs.
      const computeInstructions: Instruction[] = []
      if (options.computeOptions) {
        computeInstructions.push(
          getSetComputeUnitLimitInstruction({ units: computeOptions.computeUnitLimit ?? 400_000 }),
        )
        if (computeOptions.computeUnitPriceMicroLamports !== undefined) {
          computeInstructions.push(
            getSetComputeUnitPriceInstruction({
              microLamports: BigInt(computeOptions.computeUnitPriceMicroLamports),
            }),
          )
        }
        if (computeOptions.heapFrameBytes !== undefined) {
          computeInstructions.push(
            getRequestHeapFrameInstruction({ bytes: computeOptions.heapFrameBytes }),
          )
        }
      }

      let signedTransaction: string
      if (options.token?.trim()) {
        // 2) Resolve a fresh blockhash right before transaction finalisation/signing.
        const { value: latestBlockhash } = await rpc.rpc.getLatestBlockhash({ commitment: 'finalized' }).send()
        const mint = options.token.trim() as unknown as Address
        const [destinationAta, sourceAta] = await Promise.all([
          getAssociatedTokenAccountAddress(mint, destinationAddress),
          getAssociatedTokenAccountAddress(mint, sourceSigner.address),
        ])
        const transaction = createTransaction({
          version: 'legacy',
          feePayer,
          latestBlockhash,
          computeUnitLimit: 31_000,
          instructions: [
            getCreateAssociatedTokenIdempotentInstruction({
              owner: destinationAddress,
              mint,
              ata: destinationAta,
              payer: createNoopSigner(feePayer),
              tokenProgram: TOKEN_PROGRAM_ADDRESS,
            }),
            getTransferInstruction(
              {
                authority: sourceSigner,
                source: sourceAta,
                destination: destinationAta,
                amount: options.amount,
              },
              { programAddress: TOKEN_PROGRAM_ADDRESS },
            ),
          ],
        })
        // 3) Partial sign with source signer(s).
        signedTransaction = await transactionToBase64WithSigners(transaction)
      } else {
        const transferInstruction = getTransferSolInstruction({
          source: sourceSigner,
          destination: destinationAddress,
          amount: BigInt(options.amount),
        })
        // 2) Resolve a fresh blockhash right before transaction finalisation/signing.
        const { value: latestBlockhash } = await rpc.rpc.getLatestBlockhash({ commitment: 'finalized' }).send()
        const transaction = createTransaction({
          version: 'legacy',
          feePayer,
          instructions: [...computeInstructions, transferInstruction],
          latestBlockhash,
        })
        // 3) Partial sign with source signer(s).
        signedTransaction = await transactionToBase64WithSigners(transaction)
      }

      // 4) Relay broadcast request.
      return this.client.sendTransaction({
        transaction: signedTransaction,
        ...(options.commitment !== undefined && { commitment: options.commitment }),
      })
    }

    // Avoid duplicate relay submissions from a single user action.
    // Consumers can explicitly retry at UI level if needed.
    return execute()
  }

  /**
   * Create sponsored token accounts.
   *
  * Mirrors the Android SDK flow:
  *   1. Build ATA creation instructions for each requested token mint
  *   2. Set each ATA owner authority to the relay fee payer
  *   3. Fetch a fresh blockhash
  *   4. Finalise + partial-sign with the user signer
  *   5. Send the partially-signed transaction to the Altude relay
   */
  async createAccount(options: CreateAccountOptions = {}, signer?: GaslessTransactionSigner): Promise<CreateAccountResponse> {
    const signerToUse = signer ?? options.signer
    if (!signerToUse) {
      throw new Error('createAccount() requires a signer.')
    }

    if (options.account?.trim() && options.account !== signerToUse.address) {
      throw new Error('createAccount() account must match signer.address when account is provided.')
    }

    const execute = async (): Promise<CreateAccountResponse> => {
      const config = await this.getConfig()
      const rpc = await this.getRpcClient()
      
      const feePayer = config.FeePayer as unknown as Address

      const feePayerNoop = createNoopSigner(feePayer)
      const owner = this.#toTransactionSigner(signerToUse)
      const ownerAddress = owner.address as unknown as Address
      const tokens = options.tokens?.length ? options.tokens : [this.#defaultCreateAccountMint()]
      const computeOptions = options.computeOptions ?? {}
      const computeInstructions: Instruction[] = [
        getSetComputeUnitLimitInstruction({
          units: computeOptions.computeUnitLimit ?? 400_000,
        }),
        ...(computeOptions.computeUnitPriceMicroLamports !== undefined
          ? [
              getSetComputeUnitPriceInstruction({
                microLamports: BigInt(computeOptions.computeUnitPriceMicroLamports),
              }),
            ]
          : []),
        ...(computeOptions.heapFrameBytes !== undefined
          ? [
              getRequestHeapFrameInstruction({
                bytes: computeOptions.heapFrameBytes,
              }),
            ]
          : []),
      ]
      const tokenInstructions: Instruction[] = []

      for (const token of tokens) {
        const mint = token as unknown as Address
        const ata = await getAssociatedTokenAccountAddress(mint, ownerAddress)
        const createAssociatedTokenInstruction = await getCreateAssociatedTokenInstructionAsync({
          payer: feePayerNoop,
          owner: ownerAddress,
          mint,
          ata,
          tokenProgram: TOKEN_PROGRAM_ADDRESS,
        })
        const setAuthorityInstruction = getSetAuthorityInstruction(
          {
            owned: ata,
            owner,
            authorityType: AuthorityType.CloseAccount,
            newAuthority: feePayer,
          },
          { programAddress: TOKEN_PROGRAM_ADDRESS },
        )
        tokenInstructions.push(createAssociatedTokenInstruction, setAuthorityInstruction)
      }
      const { value: latestBlockhash } = await rpc.rpc.getLatestBlockhash({ commitment: 'finalized' }).send()
      const transaction = createTransaction({
        version: 'legacy',
        feePayer,
        instructions: [...computeInstructions, ...tokenInstructions],
        latestBlockhash,
      })

      const signedTransaction = await transactionToBase64WithSigners(transaction)
      return this.client.createAccount({ signedTransaction })
    }

    // Avoid duplicate create-account relay submissions from a single user action.
    // Consumers can explicitly retry at UI level if needed.
    return execute()
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
  *   1. Generate `Token.closeAccount` instruction(s)
  *   2. Fetch a fresh blockhash
  *   3. Finalise + partial-sign with the close authority's signer (if provided)
  *   4. Send the partially-signed transaction to the Altude relay
   *
   * When the fee payer (Altude relay) is the close authority — as set during
   * account creation — omit `signer`; the relay adds its own signature
   * server-side.  When the user holds the close authority, pass their signer.
   */
  async closeAccount(options: CloseAccountOptions): Promise<SendTransactionResponse> {
    const execute = async (): Promise<SendTransactionResponse> => {
      const config = await this.getConfig()
      const rpc = await this.getRpcClient()
      const feePayer = config.FeePayer as unknown as Address

      // Resolve the close authority: user-provided signer or noop for relay.
      const closeAuthority: Address | TransactionSigner = options.signer
        ? this.#toTransactionSigner(options.signer)
        : createNoopSigner(feePayer)

      // Build optional compute budget instructions.
      const computeInstructions: Instruction[] = []
      if (options.computeOptions) {
        const computeOpts = options.computeOptions
        computeInstructions.push(
          getSetComputeUnitLimitInstruction({ units: computeOpts.computeUnitLimit ?? 400_000 }),
        )
        if (computeOpts.computeUnitPriceMicroLamports !== undefined) {
          computeInstructions.push(
            getSetComputeUnitPriceInstruction({
              microLamports: BigInt(computeOpts.computeUnitPriceMicroLamports),
            }),
          )
        }
        if (computeOpts.heapFrameBytes !== undefined) {
          computeInstructions.push(
            getRequestHeapFrameInstruction({ bytes: computeOpts.heapFrameBytes }),
          )
        }
      }

      const closeInstructions: Instruction[] = []

      if (options.account && !options.accountAddress) {
        // Android SDK-style: auto-discover ATAs for the wallet + token list, close each.
        const walletAddress = options.account as unknown as Address
        const destinationAddress = walletAddress // rent goes back to the wallet
        const tokens = options.tokens?.length ? options.tokens : [this.#defaultCreateAccountMint()]

        for (const token of tokens) {
          const mint = token as unknown as Address
          const ata = await getAssociatedTokenAccountAddress(mint, walletAddress)
          closeInstructions.push(
            getCloseAccountInstruction(
              {
                account: ata,
                destination: destinationAddress,
                owner: closeAuthority,
              },
              { programAddress: TOKEN_PROGRAM_ADDRESS },
            ),
          )
        }
      } else if (options.accountAddress) {
        // JS-style: explicit token account address + destination.
        const destination = (options.destination ?? options.account ?? '') as unknown as Address
        if (!destination) {
          throw new Error('closeAccount() requires a destination address when using accountAddress.')
        }
        closeInstructions.push(
          getCloseAccountInstruction(
            {
              account: options.accountAddress as unknown as Address,
              destination,
              owner: closeAuthority,
            },
            { programAddress: TOKEN_PROGRAM_ADDRESS },
          ),
        )
      } else {
        throw new Error('closeAccount() requires either accountAddress or account (+ optional tokens).')
      }

      const { value: latestBlockhash } = await rpc.rpc.getLatestBlockhash({ commitment: 'finalized' }).send()
      const transaction = createTransaction({
        version: 'legacy',
        feePayer,
        instructions: [...computeInstructions, ...closeInstructions],
        latestBlockhash,
      })

      const signedTransaction = await transactionToBase64WithSigners(transaction)
      return this.client.closeAccount({ signedTransaction })
    }

    // Avoid duplicate close-account relay submissions from a single user action.
    // Consumers can explicitly retry at UI level if needed.
    return execute()
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
  async getHistory(options: GetHistoryOptions): Promise<GetHistoryResponse[]> {
    return this.client.getHistory(options)
  }

  #toTransactionSigner(signer: GaslessTransactionSigner): TransactionSigner {
    const signerAddress = signer.address as unknown as Address
    const signBytes = (txBytes: Uint8Array) => this.sign(txBytes, signer)
    return {
      address: signerAddress,
      signTransactions: async (transactions: ReadonlyArray<{ messageBytes: Uint8Array }>) => {
        const signatureDictionaries = await Promise.all(
          transactions.map(async (transaction) => ({
            [signerAddress]: await signBytes(transaction.messageBytes),
          })),
        )
        return signatureDictionaries
      },
    } as unknown as TransactionSigner
  }

  #defaultCreateAccountMint(): string {
    return this.client.network === 'devnet'
      ? '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'
      : 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
  }

}
