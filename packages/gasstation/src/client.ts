/**
 * Altude HTTP client — typed fetch wrapper for the Altude relay API.
 *
 * Endpoints surfaced by the altude-dynamic-gas-station-demo:
 *   GET  /api/transaction/config     → relay runtime config
 *   POST /api/Transaction/send       → relay a signed transaction
 *   POST /api/transaction/sendbatch  → relay a batch transaction
 *   POST /api/Account/create         → sponsored account creation
 *   POST /api/account/close          → close an account
 *   POST /api/account/getaccountinfo → fetch account info
 *   POST /api/account/gethistory     → fetch account history
 *
 * Fee payer: ALTn7gyjm29WthZGgs4z6WVAK2PK5U6w4FAtPg3TPY71
 */

import { AltudeError, ALTUDE_API_URL, ALTUDE_FEE_PAYER, createAltudeClient } from '@altude/core'
import type { SolanaNetwork } from '@altude/core'
import { address, type Address } from './solana.js'
import type { Lamports, Reward, Signature, Slot, TokenBalance, TransactionError, UnixTimestamp } from 'gill'

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
  Signature?: string
  Status?: string
  Message?: string
  signature?: string
  status?: string
  message?: string
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
  signature?: string
  status?: string
  message?: string
}

export interface CloseAccountOptions {
  /** Base64-encoded partially-signed transaction (built by the gasstation facade) */
  signedTransaction: string
}

export interface GetBalanceOptions {
  /** Wallet address (base58). Mirrors Android SDK `GetBalanceOption.account`. */
  account?: string
  /** Wallet address (base58). Kept for backward compatibility; prefer `account`. */
  address?: string
  /** SPL token mint address. Mirrors Android SDK `GetBalanceOption.token`. */
  token?: string
  /** SPL token mint address. Kept for backward compatibility; prefer `token`. */
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
  /** Wallet or account address (base58). Mirrors Android SDK `GetAccountInfoOption.account`. */
  account?: string
  /** Wallet or account address (base58). Kept for backward compatibility; prefer `account`. */
  accountAddress?: string
}

export interface GetAccountInfoResponse {
  [key: string]: unknown
}

export interface GetHistoryOptions {
  /** Page number. Kept for backward compatibility. */
  page?: string | number
  /** Page size. Kept for backward compatibility. */
  pageSize?: string | number
  /** Wallet address (base58). */
  walletAddress?: string
  /** Wallet address (base58). Mirrors Android SDK `GetHistoryOption.account`. */
  account?: string
  /** Number of records to return. Mirrors Android SDK `GetHistoryOption.limit`. Default 10. */
  limit?: number
  /** Number of records to skip. Mirrors Android SDK `GetHistoryOption.offset`. Default 0. */
  offset?: number
}

export interface GetHistoryResponse {
  data: GetHistorySummary[]
  page: number | string
  pageSize: number | string
  limit: number
  offset: number
  total: number
}

export interface GetHistorySummary {
  signature: string
  slot: number
  blockTime: number | null
  status: 'success' | 'failed'
  type: 'send' | 'receive' | 'unknown'
  amount: number
  mint?: string
  from?: string
  to?: string
}
export interface GetWalletHistoryResponse {
  [key: string]: unknown
}

export interface SwapOptions {
  /** Input mint address */
  inputMint: string
  /** Output mint address */
  outputMint: string
  /** Amount in lamports / smallest unit */
  amount: number
  /** Signer's public key. Mirrors Android SDK `SwapOption.account`. */
  account?: string
  /** Signer's public key. Kept for backward compatibility; prefer `account`. */
  userPublicKey?: string
  /** Slippage in basis points (default 50 = 0.5%) */
  slippageBps?: number
  /** Swap mode: "ExactIn" or "ExactOut". Default "ExactIn". Mirrors Android SDK `SwapOption.swapMode`. */
  swapMode?: string
  /** DEX names to include (e.g. ["Raydium", "Orca+V2"]). Mirrors Android SDK `SwapOption.dexes`. */
  dexes?: string[]
  /** DEX names to exclude. Mirrors Android SDK `SwapOption.excludeDexes`. */
  excludeDexes?: string[]
  /** Restrict intermediate tokens to stable tokens. Default true. Mirrors Android SDK `SwapOption.restrictIntermediateTokens`. */
  restrictIntermediateTokens?: boolean
  /** Limit to direct (single-hop) routes only. Default false. Mirrors Android SDK `SwapOption.onlyDirectRoutes`. */
  onlyDirectRoutes?: boolean
  /** Use legacy (non-versioned) transaction. Default false. Mirrors Android SDK `SwapOption.asLegacyTransaction`. */
  asLegacyTransaction?: boolean
  /** Platform fee in basis points. Mirrors Android SDK `SwapOption.platformFeeBps`. */
  platformFeeBps?: number
  /** Maximum number of accounts used in the quote. Default 32. Mirrors Android SDK `SwapOption.maxAccounts`. */
  maxAccounts?: number
  /** Instruction version: "V1" or "V2". Default "V1". Mirrors Android SDK `SwapOption.instructionVersion`. */
  instructionVersion?: string
  /** Dynamic slippage (no longer applicable for /swap). Default false. Mirrors Android SDK `SwapOption.dynamicSlippage`. */
  dynamicSlippage?: boolean
  /** Priority level with max lamports. Mirrors Android SDK `SwapOption.priorityLevelWithMaxLamports`. */
  priorityLevelWithMaxLamports?: PriorityLevelWithMaxLamports
  /** Transaction commitment level. Mirrors Android SDK `SwapOption.commitment`. */
  commitment?: 'processed' | 'confirmed' | 'finalized'
}

/** Priority fee configuration. Mirrors Android SDK `PriorityLevelWithMaxLamports`. */
export interface PriorityLevelWithMaxLamports {
  /** Maximum lamports to pay for priority fee. */
  maxLamports: number
  /** Priority level (e.g. "medium", "high", "veryHigh"). */
  priorityLevel: string
  /** Whether to use global fee estimate. */
  global: boolean
}

/** Mirrors Android SDK `TransactionResponse` — all fields are PascalCase as returned by the relay. */
export interface SwapResponse {
  Signature: string
  Status?: string
  Message?: string
  signature?: string
  status?: string
  message?: string
}
// ---------------------------------------------------------------------------
// AltudeHttpClient
// ---------------------------------------------------------------------------

type GetTransactionApiResponseBase = Readonly<{
    /**
     * The estimated production time at which the transaction was processed. `null` if not
     * available.
     */
    blockTime: UnixTimestamp | null;
    /** The slot during which this transaction was processed */
    slot: Slot;
    meta?: TransactionMetaBase;
    transaction: TransactionJson;
}>;
type TransactionMetaBase = Readonly<{
    /** Number of compute units consumed by the transaction */
    computeUnitsConsumed?: bigint;
    /** Error if transaction failed, `null` if transaction succeeded. */
    err: TransactionError | null;
    /** The fee this transaction was charged, in {@link Lamports} */
    fee: Lamports;
    /**
     * String log messages or `null` if log message recording was not enabled during this
     * transaction
     */
    logMessages: readonly string[] | null;
    /** Account balances after the transaction was processed */
    postBalances: readonly bigint[];
    /**
     * List of token balances from after the transaction was processed or omitted if token balance
     * recording was not yet enabled during this transaction
     */
    postTokenBalances?: readonly TokenBalance[];
    /** Account balances from before the transaction was processed */
    preBalances: readonly bigint[];
    /**
     * List of token balances from before the transaction was processed or omitted if token balance
     * recording was not yet enabled during this transaction
     */
    preTokenBalances?: readonly TokenBalance[];
    
    /**
     * Transaction-level rewards; currently only `"Rent"`, but other types may be added in the
     * future
     */
    rewards: readonly Reward[] | null;
}>;

type TransactionJson = Readonly<{
    message: {
        /** An ordered list of addresses belonging to the accounts loaded by this transaction */
        accountKeys: readonly Address[];
        header: {
            /**
             * The number of read-only accounts in the static accounts list that must sign this
             * transaction.
             *
             * Subtracting this number from `numRequiredSignatures` yields the index of the first
             * read-only signer account in the static accounts list.
             */
            numReadonlySignedAccounts: number;
            /**
             * The number of accounts in the static accounts list that are neither writable nor
             * signers.
             *
             * Adding this number to `numRequiredSignatures` yields the index of the first read-only
             * non-signer account in the static accounts list.
             */
            numReadonlyUnsignedAccounts: number;
            /**
             * The number of accounts in the static accounts list that must sign this transaction.
             *
             * Subtracting `numReadonlySignedAccounts` from this number yields the number of
             * writable signer accounts in the static accounts list. Writable signer accounts always
             * begin at index zero in the static accounts list.
             *
             * This number itself is the index of the first non-signer account in the static
             * accounts list.
             */
            numRequiredSignatures: number;
        };
    };
}> 
export class AltudeHttpClient {
  readonly apiKey: string | undefined
  readonly baseUrl: string = ALTUDE_API_URL
  readonly isMockMode: boolean
  readonly network: SolanaNetwork
  readonly #configRefreshSkewMs = 30_000
  #configCache: ConfigResponse | undefined
  #configPromise: Promise<ConfigResponse> | undefined
  #rpcClient: ReturnType<typeof createAltudeClient> | undefined

  constructor(apiKey?: string, baseUrl?: string, network: SolanaNetwork = 'mainnet-beta') {
    this.apiKey = apiKey
    this.network = network
    this.baseUrl = baseUrl ?? ALTUDE_API_URL
    this.isMockMode = !apiKey
  }

  async getConfig(forceRefresh = false): Promise<ConfigResponse> {
    if (this.isMockMode) {
      return this.#getMockConfig()
    }
    const hasExpiredConfig = this.#configCache ? this.#isConfigExpired(this.#configCache) : false
    if (forceRefresh) {
      this.#configCache = undefined
      this.#configPromise = undefined
      this.#rpcClient = undefined
    } else if (hasExpiredConfig) {
      // Token returned by /api/transaction/config is short-lived, so clear caches and reload before use.
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
   */
  async getRpcClient(): Promise<ReturnType<typeof createAltudeClient>> {
    if (this.isMockMode) {
      throw new AltudeError({
        code: 'RPC_ERROR',
        message: 'An Altude API key is required to resolve RPC node configuration.',
        remediation: 'Create the client with an API key, then retry the RPC operation.',
      })
    }

    await this.#ensureConfig()
    if (!this.#rpcClient) {
      throw new AltudeError({
        code: 'RPC_ERROR',
        message: 'Altude transaction config did not initialize an RPC client.',
        remediation: 'Request fresh transaction config and retry the RPC operation.',
      })
    }
    return this.#rpcClient
  }

  async getBlockhash(): Promise<BlockhashResponse> {
    if (this.isMockMode) {
      return { Blockhash: 'MockBlockhash11111111111111111111111111111111' }
    }
    const rpc = await this.getRpcClient()
    const { value } = await rpc.rpc.getLatestBlockhash({ commitment: 'finalized' }).send()
    return { Blockhash: String(value.blockhash) }
  }

  async sendTransaction(options: SendTransactionOptions): Promise<SendTransactionResponse> {
    if (this.isMockMode) {
      return { Signature: 'MockSignature' + Math.random().toString(36).slice(2), Status: 'Success', Message: '' }
    }
    await this.#ensureConfig()
    try {
      const response = await this.#post<SendTransactionResponse>('/api/Transaction/send', {
        SignedTransaction: options.transaction,
      })
      return this.#normalizeTransactionResponse(response)
    } catch (err) {
      if (!(err instanceof AltudeError) || err.code !== 'RELAY_ERROR') {
        throw err
      }

      const fallback = await this.#post<SendTransactionResponse>('/api/Transaction/send', {
        transaction: options.transaction,
      })
      return this.#normalizeTransactionResponse(fallback)
    }
  }

  async sendBatchTransaction(options: BatchTransactionOptions): Promise<SendTransactionResponse> {
    if (this.isMockMode) {
      return { Signature: 'MockBatchSignature' + Math.random().toString(36).slice(2), Status: 'Success', Message: '' }
    }
    await this.#ensureConfig()
    try {
      const response = await this.#post<SendTransactionResponse>('/api/transaction/sendbatch', {
        signedTransaction: options.signedTransaction,
      })
      return this.#normalizeTransactionResponse(response)
    } catch (err) {
      if (!(err instanceof AltudeError) || err.code !== 'RELAY_ERROR') {
        throw err
      }

      const fallback = await this.#post<SendTransactionResponse>('/api/transaction/sendbatch', {
        SignedTransaction: options.signedTransaction,
      })
      return this.#normalizeTransactionResponse(fallback)
    }
  }

  async sendBatch(options: BatchTransactionOptions): Promise<SendTransactionResponse> {
    return this.sendBatchTransaction(options)
  }

  async createAccount(options: CreateAccountOptions): Promise<CreateAccountResponse> {
    if (this.isMockMode) {
      return { Signature: 'MockAccountSig' + Math.random().toString(36).slice(2), Status: 'Success', Message: '' }
    }
    await this.#ensureConfig()
    try {
      const response = await this.#post<CreateAccountResponse>('/api/Account/create', {
        signedTransaction: options.signedTransaction,
      })
      return this.#normalizeTransactionResponse(response)
    } catch (err) {
      if (!(err instanceof AltudeError) || err.code !== 'RELAY_ERROR') {
        throw err
      }

      const fallback = await this.#post<CreateAccountResponse>('/api/Account/create', {
        SignedTransaction: options.signedTransaction,
      })
      return this.#normalizeTransactionResponse(fallback)
    }
  }

  async closeAccount(options: CloseAccountOptions): Promise<SendTransactionResponse> {
    if (this.isMockMode) {
      return { Signature: 'MockCloseAccountSig' + Math.random().toString(36).slice(2), Status: 'Success', Message: '' }
    }
    await this.#ensureConfig()
    try {
      const response = await this.#post<SendTransactionResponse>('/api/account/close', {
        signedTransaction: options.signedTransaction,
      })
      return this.#normalizeTransactionResponse(response)
    } catch (err) {
      if (!(err instanceof AltudeError) || err.code !== 'RELAY_ERROR') {
        throw err
      }

      const fallback = await this.#post<SendTransactionResponse>('/api/account/close', {
        SignedTransaction: options.signedTransaction,
      })
      return this.#normalizeTransactionResponse(fallback)
    }
  }

  async getBalance(options: GetBalanceOptions): Promise<BalanceResponse> {
    const walletAddress = options.account ?? options.address ?? ''
    const mintAddress = options.token ?? options.mint ?? ''
    if (this.isMockMode) {
      return { address: walletAddress, lamports: 1_000_000_000, uiAmount: 1.0 }
    }
    await this.#ensureConfig()
    try {
      return await this.#post<BalanceResponse>('/api/Account/balance', {
        accountAddress: walletAddress,
        mintAddress,
      })
    } catch (err) {
      if (!(err instanceof AltudeError) || err.code !== 'RELAY_ERROR') {
        throw err
      }

      return this.#post<BalanceResponse>('/api/Account/balance', {
        AccountAddress: walletAddress,
        MintAddress: mintAddress,
      })
    }
  }

  async getAccountInfo(options: GetAccountInfoOptions): Promise<GetAccountInfoResponse> {
    const addr = options.account ?? options.accountAddress ?? ''
    if (this.isMockMode) {
      return { accountAddress: addr, lamports: 0, executable: false }
    }
    await this.#ensureConfig()
    try {
      return await this.#post<GetAccountInfoResponse>('/api/account/getaccountinfo', {
        accountAddress: addr,
      })
    } catch (err) {
      if (!(err instanceof AltudeError) || err.code !== 'RELAY_ERROR') {
        throw err
      }

      return this.#post<GetAccountInfoResponse>('/api/account/getaccountinfo', {
        AccountAddress: addr,
      })
    }
  }

  // async getHistory(options: GetHistoryOptions): Promise<GetHistoryResponse> {
  //   const walletAddr = options.walletAddress ?? options.account ?? ''
  //   // Android-style pagination (limit/offset) takes precedence over page/pageSize.
  //   const useAndroidStyle = options.limit !== undefined || options.offset !== undefined
  //   if (this.isMockMode) {
  //     if (useAndroidStyle) {
  //       return {
  //         items: [],
  //         limit: options.limit ?? 10,
  //         offset: options.offset ?? 0,
  //         walletAddress: walletAddr,
  //       }
  //     }
  //     return { items: [], page: options.page, pageSize: options.pageSize, walletAddress: walletAddr }
  //   }
  //   await this.#ensureConfig()
  //   if (useAndroidStyle) {
  //     // Android SDK-style: { account, limit, offset, walletAddress }
  //     const account = options.account ?? options.walletAddress ?? ''
  //     try {
  //       return await this.#post<GetHistoryResponse>('/api/account/gethistory', {
  //         account,
  //         limit: options.limit ?? 10,
  //         offset: options.offset ?? 0,
  //         walletAddress: walletAddr,
  //       })
  //     } catch (err) {
  //       if (!(err instanceof AltudeError) || err.code !== 'RELAY_ERROR') {
  //         throw err
  //       }
  //       return this.#post<GetHistoryResponse>('/api/account/gethistory', {
  //         Account: account,
  //         Limit: options.limit ?? 10,
  //         Offset: options.offset ?? 0,
  //         WalletAddress: walletAddr,
  //       })
  //     }
  //   }
  //   try {
  //     return await this.#post<GetHistoryResponse>('/api/account/gethistory', {
  //       page: options.page,
  //       pageSize: options.pageSize,
  //       walletAddress: walletAddr,
  //     })
  //   } catch (err) {
  //     if (!(err instanceof AltudeError) || err.code !== 'RELAY_ERROR') {
  //       throw err
  //     }

  //     try {
  //       return await this.#post<GetHistoryResponse>('/api/account/gethistory', {
  //         Page: options.page,
  //         PageSize: options.pageSize,
  //         WalletAddress: walletAddr,
  //       })
  //     } catch (fallbackErr) {
  //       if (!(fallbackErr instanceof AltudeError) || fallbackErr.code !== 'RELAY_ERROR') {
  //         throw fallbackErr
  //       }

  //       // Final fallback for relays that still expect query parameters.
  //       const params = new URLSearchParams({
  //         Page: options.page?.toString() ?? '',
  //         PageSize: options.pageSize?.toString() ?? '',
  //         walletAddress: walletAddr,
  //       })
  //       return this.#post<GetHistoryResponse>(`/api/account/gethistory?${params.toString()}`)
  //     }
  //   }
  // }

  async getHistory(options: GetHistoryOptions): Promise<GetHistoryResponse> {
    const walletAddr = options.walletAddress ?? options.account ?? ''
    // Android-style pagination (limit/offset) takes precedence over page/pageSize.
    const useAndroidStyle = options.limit !== undefined || options.offset !== undefined
    if (this.isMockMode) {
      if (useAndroidStyle) {
        return {
          data: [],
          page: options.page ?? 0,
          pageSize: options.pageSize ?? 0,
          limit: options.limit ?? 0,
          offset: options.offset ?? 0,
          total: 0
        }
      }
      return {
        data: [],
        page: options.page ?? 0,
        pageSize: options.pageSize ?? 0,
        limit: options.limit ?? 0,
        offset: options.offset ?? 0,
        total: 0
      }
    }
    
    const client = await this.getRpcClient()
    const signatures = await client.rpc.getSignaturesForAddress(address(walletAddr)).send()

    const offset = options.offset ?? 0
    const limit = options.limit ?? 10
    const signatureList = signatures
      .map((sig: { signature: Signature }) => sig.signature)
      .slice(offset, offset + limit)

    const transactionlist: GetHistoryResponse = {
      data: [],
      page: options.page ?? 0,
      pageSize: options.pageSize ?? 0,
      limit,
      offset,
      total: signatures.length,
    }
    for (const sig of signatureList) {
      const transaction = await client.rpc
        .getTransaction(sig, { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 0 })
        .send()
      if (!transaction) continue
      try {
        transactionlist.data.push(this.summarizeTransaction(transaction  as GetTransactionApiResponseBase, sig, walletAddr))
      } catch (err) {
        console.error(`Failed to summarize transaction ${sig}:`, err)
      }
    }
    return transactionlist
    
  }

  private getTokenTransfer(
    tx: GetTransactionApiResponseBase,
    walletAddress: string,
  ): {
    amount: number;
    mint: string;
    type: 'send' | 'receive';
    from?: string;
    to?: string;
  } | null {
    const meta = tx.meta;

    if (!meta) {
      return null;
    }

    const preTokenBalances = meta.preTokenBalances ?? [];
    const postTokenBalances = meta.postTokenBalances ?? [];

    if (
      preTokenBalances.length === 0 &&
      postTokenBalances.length === 0
    ) {
      return null;
    }

    /**
     * Combine pre/post balances using:
     *
     * accountIndex + mint
     *
     * because a token account may only appear in pre OR post
     * when it was created during this transaction.
     */
    const balances = new Map<
    string,
    {
      accountIndex: number;
      mint: string;
      owner: string;
      preAmount: string;
      postAmount: string;
      decimals: number;
    }
  >();

    for (const item of preTokenBalances) {
      const key = `${String(item.accountIndex)}:${item.mint}`;

      balances.set(key, {
        accountIndex: item.accountIndex,
        mint: item.mint,
        owner: item.owner ?? '',
        preAmount:  item.uiTokenAmount.uiAmountString,
        postAmount: '0',
        decimals: 0
      });
    }

    for (const item of postTokenBalances) {
      const key = `${String(item.accountIndex)}:${item.mint}`;

      const existing = balances.get(key);

      if (existing) {
        existing.postAmount =  item.uiTokenAmount.uiAmountString;
      } else {
        balances.set(key, {
          accountIndex: item.accountIndex,
          mint: item.mint,
          owner: item.owner ?? '',
          preAmount: '0',
          postAmount: item.uiTokenAmount.uiAmountString ,
          decimals: 0
        });
      }
    }

    const changes = Array.from(balances.values())
      .map(item => ({
        ...item,
        change: Number(item.postAmount) - Number(item.preAmount),
      }))
      .filter(item => item.change !== 0);

    /**
     * Find the token balance belonging to our wallet.
     */
    const walletChange = changes.find(
      item => item.owner === walletAddress,
    );

    if (!walletChange) {
      return null;
    }

    /**
     * Find the opposite token movement.
     *
     * Example:
     *
     * Wallet A: -10 USDC
     * Wallet B: +10 USDC
     */
    const counterparty = changes.find(
      item =>
        item.mint === walletChange.mint &&
        item.owner !== walletAddress &&
        Math.sign(item.change) !==
          Math.sign(walletChange.change),
    );

    const isSend = walletChange.change < 0;

    const result: {
      amount: number;
      mint: string;
      type: 'send' | 'receive';
      from?: string;
      to?: string;
    } = {
      amount: Math.abs(walletChange.change),
      mint: walletChange.mint,
      type: isSend ? 'send' : 'receive',
    };

    if (isSend) {
      result.from = walletAddress;

      if (counterparty?.owner) {
        result.to = counterparty.owner;
      }
    } else {
      result.to = walletAddress;

      if (counterparty?.owner) {
        result.from = counterparty.owner;
      }
    }

    return result;
  }

  private summarizeTransaction(
    tx: GetTransactionApiResponseBase,
    signature: string,
    walletAddress: string,
  ): GetHistorySummary {
    const meta = tx.meta;

    /**
     * First check for an SPL token transfer.
     */
    const tokenTransfer = this.getTokenTransfer(
      tx,
      walletAddress,
    );

    if (tokenTransfer) {
      const summary: GetHistorySummary = {
        signature,
        slot: Number(tx.slot),
        blockTime: Number(tx.blockTime),
        status: meta?.err ? 'failed' : 'success',
        type: tokenTransfer.type,
        amount: tokenTransfer.amount,
        mint: tokenTransfer.mint,
      };

      if (tokenTransfer.from) {
        summary.from = tokenTransfer.from;
      }

      if (tokenTransfer.to) {
        summary.to = tokenTransfer.to;
      }

      return summary;
    }

    /**
     * Otherwise treat it as a SOL transaction.
     */
    const change = this.getWalletBalanceChange(
      tx,
      walletAddress,
    );

    let type: GetHistorySummary['type'] = 'unknown';

    if (change > 0) {
      type = 'receive';
    } else if (change < 0) {
      type = 'send';
    }

    const summary: GetHistorySummary = {
      signature,
      slot: Number(tx.slot),
      blockTime: Number(tx.blockTime),
      status: meta?.err ? 'failed' : 'success',
      type,
      amount: Math.abs(change) / 1_000_000_000,
    };

    if (type === 'send') {
      summary.from = walletAddress;
    } else if (type === 'receive') {
      summary.to = walletAddress;
    }

    return summary;
  }

  private getWalletBalanceChange(
    tx: GetTransactionApiResponseBase,
    walletAddress: string,
  ): number {
    const { meta } = tx;

    if (!meta) {
      return 0;
    }


    const accountKeys = tx.transaction.message.accountKeys;
    console.log('Account keys:', accountKeys);

    const index = accountKeys.findIndex(
      (key: string) => key === walletAddress,
    );


    if (index === -1) {
      return 0;
    }

    return (
      Number (meta.postBalances[index]) -
      Number(meta.preBalances[index])
    );
  }

  async swap(options: SwapOptions): Promise<SwapResponse> {
    if (this.isMockMode) {
      return { Signature: 'MockSwapSig' + Math.random().toString(36).slice(2), Status: 'Success', Message: '' }
    }
    await this.#ensureConfig()
    // Normalize: `account` (Android SDK) and `userPublicKey` (JS compat) both map to the relay's userPublicKey field.
    const { account, userPublicKey, ...rest } = options
    const normalizedUserPublicKey = account ?? userPublicKey
    const swapBody = { ...rest, userPublicKey: normalizedUserPublicKey }
    try {
      const response = await this.#post<SwapResponse>('/api/Transaction/swap', swapBody)
      return this.#normalizeTransactionResponse(response)
    } catch (err) {
      if (!(err instanceof AltudeError) || err.code !== 'RELAY_ERROR') {
        throw err
      }

      const fallback = await this.#post<SwapResponse>('/api/Transaction/swap', {
        InputMint: options.inputMint,
        OutputMint: options.outputMint,
        Amount: options.amount,
        UserPublicKey: normalizedUserPublicKey,
        SlippageBps: options.slippageBps,
      })
      return this.#normalizeTransactionResponse(fallback)
    }
  }

  #normalizeTransactionResponse<T extends SendTransactionResponse>(response: T): T {
    const normalized = {
      ...response,
      Signature: response.Signature ?? response.signature ?? '',
      Status: response.Status ?? response.status,
      Message: response.Message ?? response.message,
    }
    return normalized
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
    let hasRefreshedConfigAfterAuthError = false
    const isConfigEndpoint = path.startsWith('/api/transaction/config')
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const response = await fetch(url, {
          method,
          headers,
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        })

        if (!response.ok) {
          const text = await response.text()
          const isAuthError = response.status === 401 || response.status === 403
          if (!this.isMockMode && !isConfigEndpoint && isAuthError && !hasRefreshedConfigAfterAuthError) {
            hasRefreshedConfigAfterAuthError = true
            await this.getConfig(true)
            continue
          }

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
    const rpcClient = createAltudeClient({
      rpcUrl: config.RpcUrl,
      rpcToken: config.Token,
    })
    this.#configCache = config
    this.#rpcClient = rpcClient
    return config
  }

  #isConfigExpired(config: ConfigResponse): boolean {
    const expiration = config.TokenExpiration
    if (!expiration) {
      return false
    }

    const expirationMs = Date.parse(expiration)
    if (Number.isNaN(expirationMs)) {
      return false
    }

    return Date.now() >= expirationMs - this.#configRefreshSkewMs
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
