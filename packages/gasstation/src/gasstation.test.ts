import { afterEach, describe, expect, it, vi } from 'vitest'
import { AltudeGasStation } from '../src/gasstation.js'
import { AltudeHttpClient } from '../src/client.js'
import { address, type Instruction } from 'gill'
import {
  AuthorityType,
  createNoopSigner,
  createTransaction,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getSetAuthorityInstruction,
  getSetComputeUnitLimitInstruction,
  transactionToBase64WithSigners,
} from '../src/solana.js'

const TOKEN_PROGRAM_ADDRESS = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
const WRAPPED_SOL_MINT_ADDRESS = 'So11111111111111111111111111111111111111112'
const TEST_WALLET = '11111111111111111111111111111111'
const TEST_COUNTERPARTY = 'ALTn7gyjm29WthZGgs4z6WVAK2PK5U6w4FAtPg3TPY71'
const TEST_SIGNATURES = [
  '2AXDGYSE4f2sz7tvMMzyHvUfcoJmxudvdhBcmiUSo6ijwfYmfZYsKRxboQMPh3R4kUhXRVdtSXFXMheka4Rc4P2',
  '3L3RY5sT8K4kyEnqhizwaqxLEbcYvpGrGPNEYRwtbCSUtL6YL86jdrvCbohnP5q8VxQ3qzGmt3W3iQJW97rD7m3',
  '4VZdodJgBy6dxMgm45zusmRzrPvKtiumu5YrK9RLPJADpzeJzgebxHsoQD4B58FCFS6aGUufKZka56xFiBGpB94',
] as const

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function rpcResponse(id: string | number, result: unknown): Response {
  return jsonResponse({ jsonrpc: '2.0', id, result })
}

function parseRpcRequest(init?: RequestInit): {
  id: string | number
  method: string
  params: unknown[]
} {
  if (typeof init?.body !== 'string') {
    throw new Error('Expected a JSON-RPC request body')
  }
  return JSON.parse(init.body) as { id: string | number; method: string; params: unknown[] }
}

function rpcTransactionFixture({
  signature,
  version,
  slot,
  blockTime,
  preBalances,
  postBalances,
  failed = false,
  preTokenBalances = [],
  postTokenBalances = [],
  instructionData = '',
}: {
  signature: string
  version: 'legacy' | 0 | 1
  slot: number
  blockTime: number | null
  preBalances: number[]
  postBalances: number[]
  failed?: boolean
  preTokenBalances?: unknown[]
  postTokenBalances?: unknown[]
  instructionData?: string
}) {
  const transactionConfig =
    version === 1
      ? {
          transactionConfig: {
            computeUnitLimit: 200_000,
            heapSize: null,
            loadedAccountsDataSizeLimit: null,
            priorityFee: 5_000,
          },
        }
      : {}

  return {
    blockTime,
    slot,
    version,
    meta: {
      computeUnitsConsumed: 25_000,
      err: failed ? { InstructionError: [0, 'Custom'] } : null,
      fee: 5_000,
      innerInstructions: null,
      loadedAddresses: { readonly: [], writable: [] },
      logMessages: [],
      postBalances,
      postTokenBalances,
      preBalances,
      preTokenBalances,
      rewards: [],
      status: failed ? { Err: { InstructionError: [0, 'Custom'] } } : { Ok: null },
    },
    transaction: {
      message: {
        accountKeys: [TEST_WALLET, TEST_COUNTERPARTY],
        addressTableLookups: [],
        header: {
          numReadonlySignedAccounts: 0,
          numReadonlyUnsignedAccounts: 1,
          numRequiredSignatures: 1,
        },
        instructions: [{ accounts: [0, 1], data: instructionData, programIdIndex: 1 }],
        recentBlockhash: TEST_WALLET,
        ...transactionConfig,
      },
      signatures: [signature],
    },
    unknownFutureField: { preservedByJsonTransport: true },
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('AltudeHttpClient — mock mode', () => {
  it('operates in mock mode when no API key is given', () => {
    const client = new AltudeHttpClient()
    expect(client.isMockMode).toBe(true)
  })

  it('getConfig returns mock relay config', async () => {
    const client = new AltudeHttpClient()
    const result = await client.getConfig()
    expect(result.FeePayer).toBeTruthy()
    expect(result.RpcEnvironment).toBe('mainnet-beta')
  })

  it('getBlockhash returns a mock blockhash', async () => {
    const client = new AltudeHttpClient()
    const result = await client.getBlockhash()
    expect(result.Blockhash).toBeTruthy()
    expect(typeof result.Blockhash).toBe('string')
  })

  it('sendTransaction returns a mock signature', async () => {
    const client = new AltudeHttpClient()
    const result = await client.sendTransaction({ transaction: 'base64encodedtx==' })
    expect(result.Signature).toBeTruthy()
  })

  it('createAccount returns a mock signature', async () => {
    const client = new AltudeHttpClient()
    const result = await client.createAccount({ signedTransaction: 'base64encodedtx==' })
    expect(result.Signature).toBeTruthy()
  })

  it('sendBatchTransaction returns a mock signature', async () => {
    const client = new AltudeHttpClient()
    const result = await client.sendBatchTransaction({ signedTransaction: 'base64encodedtx==' })
    expect(result.Signature).toBeTruthy()
  })

  it('sendBatch aliases sendBatchTransaction in mock mode', async () => {
    const client = new AltudeHttpClient()
    const sendBatchTransactionSpy = vi.spyOn(client, 'sendBatchTransaction')

    const result = await client.sendBatch({ signedTransaction: 'base64encodedtx==' })

    expect(result.Signature).toBeTruthy()
    expect(sendBatchTransactionSpy).toHaveBeenCalledWith({ signedTransaction: 'base64encodedtx==' })
  })

  it('closeAccount returns a mock signature', async () => {
    const client = new AltudeHttpClient()
    const result = await client.closeAccount({ signedTransaction: 'base64encodedtx==' })
    expect(result.Signature).toBeTruthy()
  })

  it('getBalance returns mock data (address field)', async () => {
    const client = new AltudeHttpClient()
    const result = await client.getBalance({ address: '11111111111111111111111111111111' })
    expect(result.address).toBe('11111111111111111111111111111111')
    expect(result.lamports).toBeGreaterThan(0)
  })

  it('getBalance returns mock data (Android-style account field)', async () => {
    const client = new AltudeHttpClient()
    const result = await client.getBalance({ account: '11111111111111111111111111111111' })
    expect(result.address).toBe('11111111111111111111111111111111')
    expect(result.lamports).toBeGreaterThan(0)
  })

  it('getAccountInfo returns mock data (accountAddress field)', async () => {
    const client = new AltudeHttpClient()
    const result = await client.getAccountInfo({ accountAddress: '11111111111111111111111111111111' })
    expect(result.accountAddress).toBe('11111111111111111111111111111111')
  })

  it('getAccountInfo returns mock data (Android-style account field)', async () => {
    const client = new AltudeHttpClient()
    const result = await client.getAccountInfo({ account: '11111111111111111111111111111111' })
    expect(result.accountAddress).toBe('11111111111111111111111111111111')
  })

  it('getHistory returns mock data (page/pageSize fields)', async () => {
    const client = new AltudeHttpClient()
    const result = await client.getHistory({
      page: 1,
      pageSize: 10,
      walletAddress: '11111111111111111111111111111111',
    })
    expect(result.page).toBe(1)
    expect(result.pageSize).toBe(10)
  })

  it('getHistory returns mock data (Android-style limit/offset fields)', async () => {
    const client = new AltudeHttpClient()
    const result = await client.getHistory({
      account: '11111111111111111111111111111111',
      limit: 20,
      offset: 5,
    })
    expect(result.limit).toBe(20)
    expect(result.offset).toBe(5)
  })

  it('swap returns a mock signature (userPublicKey field)', async () => {
    const client = new AltudeHttpClient()
    const result = await client.swap({
      inputMint: 'So11111111111111111111111111111111111111112',
      outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      amount: 1_000_000,
      userPublicKey: '11111111111111111111111111111111',
    })
    expect(result.Signature).toBeTruthy()
  })

  it('swap returns a mock signature (Android-style account field)', async () => {
    const client = new AltudeHttpClient()
    const result = await client.swap({
      inputMint: 'So11111111111111111111111111111111111111112',
      outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      amount: 1_000_000,
      account: '11111111111111111111111111111111',
      swapMode: 'ExactIn',
      slippageBps: 50,
    })
    expect(result.Signature).toBeTruthy()
  })

  it('getRpcClient requires an API key instead of using a public RPC fallback', async () => {
    const client = new AltudeHttpClient()

    await expect(client.getRpcClient()).rejects.toMatchObject({
      code: 'RPC_ERROR',
      message: 'An Altude API key is required to resolve RPC node configuration.',
    })
  })
})

describe('AltudeHttpClient — live mode', () => {
  it('loads and caches runtime config on demand', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({
        FeePayer: 'ALTn7gyjm29WthZGgs4z6WVAK2PK5U6w4FAtPg3TPY71',
        RpcUrl: 'https://rpc.altude.so',
        Token: 'runtime-token',
        RpcEnvironment: 'devnet',
        TokenExpiration: '2099-01-01T00:00:00Z',
      }),
    )

    const client = new AltudeHttpClient('test-key', 'https://api.altude.so', 'devnet')
    expect(fetchSpy).not.toHaveBeenCalled()

    const first = await client.getConfig()
    const second = await client.getConfig()
    const requestInit = fetchSpy.mock.calls[0]?.[1]

    expect(first).toEqual(second)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('https://api.altude.so/api/transaction/config')
    expect(requestInit).toMatchObject({
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': 'test-key',
      },
    })
  })

  it('loads runtime config before additional live requests', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        jsonResponse({
          FeePayer: 'ALTn7gyjm29WthZGgs4z6WVAK2PK5U6w4FAtPg3TPY71',
          RpcUrl: 'https://rpc.altude.so',
          Token: 'runtime-token',
          RpcEnvironment: 'devnet',
          TokenExpiration: '2099-01-01T00:00:00Z',
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ Signature: 'LiveBatchSig', Status: 'Success', Message: '' }))

    const client = new AltudeHttpClient('test-key', 'https://api.altude.so', 'devnet')
    const result = await client.sendBatchTransaction({ signedTransaction: 'base64encodedtx==' })

    expect(result.Signature).toBe('LiveBatchSig')
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('https://api.altude.so/api/transaction/config')
    expect(fetchSpy.mock.calls[1]?.[0]).toBe('https://api.altude.so/api/transaction/sendbatch')
  })

  it('sendBatch aliases sendBatchTransaction in live mode', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        jsonResponse({
          FeePayer: 'ALTn7gyjm29WthZGgs4z6WVAK2PK5U6w4FAtPg3TPY71',
          RpcUrl: 'https://rpc.altude.so',
          Token: 'runtime-token',
          RpcEnvironment: 'devnet',
          TokenExpiration: '2099-01-01T00:00:00Z',
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ Signature: 'LiveBatchSig', Status: 'Success', Message: '' }))

    const client = new AltudeHttpClient('test-key', 'https://api.altude.so', 'devnet')
    const result = await client.sendBatch({ signedTransaction: 'base64encodedtx==' })

    expect(result.Signature).toBe('LiveBatchSig')
    expect(fetchSpy.mock.calls[1]?.[0]).toBe('https://api.altude.so/api/transaction/sendbatch')
  })

  it('getRpcClient returns a client initialised from config RpcUrl', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({
        FeePayer: 'ALTn7gyjm29WthZGgs4z6WVAK2PK5U6w4FAtPg3TPY71',
        RpcUrl: 'https://rpc.altude.so',
        Token: 'runtime-token',
        RpcEnvironment: 'devnet',
        TokenExpiration: '2099-01-01T00:00:00Z',
      }),
    )

    const client = new AltudeHttpClient('test-key', 'https://api.altude.so', 'devnet')
    const rpc = await client.getRpcClient()
    // The RPC client is a Gill SolanaClient — it should expose rpc and rpcSubscriptions.
    expect(rpc).toHaveProperty('rpc')
    expect(rpc).toHaveProperty('rpcSubscriptions')
  })

  it('getRpcClient returns same instance on repeated calls', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({
        FeePayer: 'ALTn7gyjm29WthZGgs4z6WVAK2PK5U6w4FAtPg3TPY71',
        RpcUrl: 'https://rpc.altude.so',
        Token: 'runtime-token',
        RpcEnvironment: 'devnet',
        TokenExpiration: '2099-01-01T00:00:00Z',
      }),
    )

    const client = new AltudeHttpClient('test-key', 'https://api.altude.so', 'devnet')
    const first = await client.getRpcClient()
    const second = await client.getRpcClient()
    expect(first).toBe(second)
  })

  it('transforms mixed legacy, v0, and large v1 history through the public facade', async () => {
    const tokenMint = WRAPPED_SOL_MINT_ADDRESS
    const transactions = [
      rpcTransactionFixture({
        signature: TEST_SIGNATURES[0],
        version: 'legacy',
        slot: 100,
        blockTime: 1_700_000_000,
        preBalances: [2_000_000_000, 0],
        postBalances: [1_000_000_000, 1_000_000_000],
      }),
      rpcTransactionFixture({
        signature: TEST_SIGNATURES[1],
        version: 0,
        slot: 101,
        blockTime: null,
        preBalances: [1_000_000_000, 0],
        postBalances: [1_000_000_000, 0],
        failed: true,
      }),
      rpcTransactionFixture({
        signature: TEST_SIGNATURES[2],
        version: 1,
        slot: 102,
        blockTime: 1_700_000_002,
        preBalances: [1_000_000_000, 0],
        postBalances: [1_000_000_000, 0],
        preTokenBalances: [
          {
            accountIndex: 0,
            mint: tokenMint,
            owner: TEST_WALLET,
            programId: TOKEN_PROGRAM_ADDRESS,
            uiTokenAmount: { amount: '1000000', decimals: 6, uiAmount: 1, uiAmountString: '1' },
          },
          {
            accountIndex: 1,
            mint: tokenMint,
            owner: TEST_COUNTERPARTY,
            programId: TOKEN_PROGRAM_ADDRESS,
            uiTokenAmount: { amount: '3500000', decimals: 6, uiAmount: 3.5, uiAmountString: '3.5' },
          },
        ],
        postTokenBalances: [
          {
            accountIndex: 0,
            mint: tokenMint,
            owner: TEST_WALLET,
            programId: TOKEN_PROGRAM_ADDRESS,
            uiTokenAmount: { amount: '3500000', decimals: 6, uiAmount: 3.5, uiAmountString: '3.5' },
          },
          {
            accountIndex: 1,
            mint: tokenMint,
            owner: TEST_COUNTERPARTY,
            programId: TOKEN_PROGRAM_ADDRESS,
            uiTokenAmount: { amount: '1000000', decimals: 6, uiAmount: 1, uiAmountString: '1' },
          },
        ],
        // 1,300 zero bytes encoded as base58, above the legacy packet ceiling and below v1's allowance.
        instructionData: '1'.repeat(1_300),
      }),
    ]
    let transactionIndex = 0
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      if (input === 'https://api.altude.so/api/transaction/config') {
        return Promise.resolve(
          jsonResponse({
            FeePayer: TEST_COUNTERPARTY,
            RpcUrl: 'https://rpc.altude.so',
            Token: 'runtime-token',
            RpcEnvironment: 'devnet',
            TokenExpiration: '2099-01-01T00:00:00Z',
          }),
        )
      }

      const request = parseRpcRequest(init)
      if (request.method === 'getSignaturesForAddress') {
        return Promise.resolve(
          rpcResponse(
            request.id,
            TEST_SIGNATURES.map((signature, index) => ({
              blockTime: 1_700_000_000 + index,
              confirmationStatus: 'confirmed',
              err: null,
              memo: null,
              signature,
              slot: 100 + index,
            })),
          ),
        )
      }
      if (request.method === 'getTransaction') {
        expect(request.params[1]).toMatchObject({
          commitment: 'confirmed',
          encoding: 'json',
          maxSupportedTransactionVersion: 1,
        })
        return Promise.resolve(rpcResponse(request.id, transactions[transactionIndex++] ?? transactions[2]))
      }
      throw new Error(`Unexpected RPC method: ${request.method}`)
    })

    const gasStation = new AltudeGasStation({
      apiKey: 'test-key',
      baseUrl: 'https://api.altude.so',
      network: 'devnet',
    })
    const result = await gasStation.getHistory({ account: TEST_WALLET, limit: 10 })
    const rpc = await gasStation.getRpcClient()
    const transformedSignatures = await rpc.rpc.getSignaturesForAddress(address(TEST_WALLET)).send()
    const v1Signature = transformedSignatures[2]?.signature
    if (!v1Signature) {
      throw new Error('Expected the v1 signature fixture')
    }
    const transformedV1 = await rpc.rpc
      .getTransaction(v1Signature, {
        commitment: 'confirmed',
        encoding: 'json',
        maxSupportedTransactionVersion: 1,
      })
      .send()

    expect(fetchSpy).toHaveBeenCalledTimes(7)
    expect(transformedV1?.version).toBe(1)
    expect(transformedV1?.transaction.message.transactionConfig).toEqual({
      computeUnitLimit: 200_000,
      heapSize: null,
      loadedAccountsDataSizeLimit: null,
      priorityFee: 5_000n,
    })
    expect(transformedV1).toHaveProperty('unknownFutureField', { preservedByJsonTransport: true })
    expect(result).toEqual({
      data: [
        {
          signature: TEST_SIGNATURES[0],
          slot: 100,
          blockTime: 1_700_000_000,
          status: 'success',
          type: 'send',
          amount: 1,
          from: TEST_WALLET,
        },
        {
          signature: TEST_SIGNATURES[1],
          slot: 101,
          blockTime: null,
          status: 'failed',
          type: 'unknown',
          amount: 0,
        },
        {
          signature: TEST_SIGNATURES[2],
          slot: 102,
          blockTime: 1_700_000_002,
          status: 'success',
          type: 'receive',
          amount: 2.5,
          mint: tokenMint,
          from: TEST_COUNTERPARTY,
          to: TEST_WALLET,
        },
      ],
      page: 0,
      pageSize: 0,
      limit: 10,
      offset: 0,
      total: 3,
    })
  })

  it('keeps empty and temporarily unavailable history entries explicit', async () => {
    let signatureRequestCount = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      if (input === 'https://api.altude.so/api/transaction/config') {
        return Promise.resolve(
          jsonResponse({
            FeePayer: TEST_COUNTERPARTY,
            RpcUrl: 'https://rpc.altude.so',
            Token: 'runtime-token',
            RpcEnvironment: 'devnet',
            TokenExpiration: '2099-01-01T00:00:00Z',
          }),
        )
      }

      const request = parseRpcRequest(init)
      if (request.method === 'getSignaturesForAddress') {
        signatureRequestCount += 1
        return Promise.resolve(
          rpcResponse(
            request.id,
            signatureRequestCount === 1
              ? []
              : [
                  {
                    blockTime: null,
                    confirmationStatus: 'confirmed',
                    err: null,
                    memo: null,
                    signature: TEST_SIGNATURES[0],
                    slot: 100,
                  },
                ],
          ),
        )
      }
      return Promise.resolve(rpcResponse(request.id, null))
    })

    const gasStation = new AltudeGasStation({
      apiKey: 'test-key',
      baseUrl: 'https://api.altude.so',
      network: 'devnet',
    })

    await expect(gasStation.getHistory({ account: TEST_WALLET })).resolves.toMatchObject({
      data: [],
      total: 0,
    })
    await expect(gasStation.getHistory({ account: TEST_WALLET })).resolves.toMatchObject({
      data: [],
      total: 1,
    })
  })

  it.each([
    {
      name: 'unsupported future transaction versions',
      rpcError: {
        code: -32015,
        message: 'Transaction version (2) is not supported by the requesting client',
      },
    },
    {
      name: 'RPC authentication failures',
      rpcError: { code: -32001, message: 'Authentication failed' },
    },
  ])('surfaces $name instead of returning empty history', async ({ rpcError }) => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      if (input === 'https://api.altude.so/api/transaction/config') {
        return Promise.resolve(
          jsonResponse({
            FeePayer: TEST_COUNTERPARTY,
            RpcUrl: 'https://rpc.altude.so',
            Token: 'runtime-token',
            RpcEnvironment: 'devnet',
            TokenExpiration: '2099-01-01T00:00:00Z',
          }),
        )
      }

      const request = parseRpcRequest(init)
      if (request.method === 'getSignaturesForAddress') {
        return Promise.resolve(
          rpcResponse(request.id, [
            {
              blockTime: null,
              confirmationStatus: 'confirmed',
              err: null,
              memo: null,
              signature: TEST_SIGNATURES[0],
              slot: 100,
            },
          ]),
        )
      }
      return Promise.resolve(jsonResponse({ jsonrpc: '2.0', id: request.id, error: rpcError }))
    })

    const gasStation = new AltudeGasStation({
      apiKey: 'test-key',
      baseUrl: 'https://api.altude.so',
      network: 'devnet',
    })

    await expect(gasStation.getHistory({ account: TEST_WALLET })).rejects.toThrow(rpcError.message)
  })

  it('surfaces RPC transport failures instead of returning empty history', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      if (input === 'https://api.altude.so/api/transaction/config') {
        return Promise.resolve(
          jsonResponse({
            FeePayer: TEST_COUNTERPARTY,
            RpcUrl: 'https://rpc.altude.so',
            Token: 'runtime-token',
            RpcEnvironment: 'devnet',
            TokenExpiration: '2099-01-01T00:00:00Z',
          }),
        )
      }

      const request = parseRpcRequest(init)
      if (request.method === 'getSignaturesForAddress') {
        return Promise.resolve(
          rpcResponse(request.id, [
            {
              blockTime: null,
              confirmationStatus: 'confirmed',
              err: null,
              memo: null,
              signature: TEST_SIGNATURES[0],
              slot: 100,
            },
          ]),
        )
      }
      return Promise.resolve(new Response('upstream unavailable', { status: 503 }))
    })

    const gasStation = new AltudeGasStation({
      apiKey: 'test-key',
      baseUrl: 'https://api.altude.so',
      network: 'devnet',
    })

    await expect(gasStation.getHistory({ account: TEST_WALLET })).rejects.toThrow()
  })

  it('rejects success-shaped API fallback config', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({
        FeePayer: 'ALTn7gyjm29WthZGgs4z6WVAK2PK5U6w4FAtPg3TPY71',
        RpcUrl: 'https://rpc.altude.so',
        Token: 'jwt_unavailable',
        RpcEnvironment: 'devnet',
        TokenExpiration: null,
      }),
    )

    const client = new AltudeHttpClient('test-key', 'https://api.altude.so', 'devnet')

    await expect(client.getConfig()).rejects.toMatchObject({
      code: 'RPC_ERROR',
      message: 'Altude transaction config did not return a usable RPC JWT.',
    })
  })

  it('sendTransaction sends { SignedTransaction } body matching Android SDK', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        jsonResponse({
          FeePayer: 'ALTn7gyjm29WthZGgs4z6WVAK2PK5U6w4FAtPg3TPY71',
          RpcUrl: 'https://rpc.altude.so',
          Token: 'runtime-token',
          RpcEnvironment: 'devnet',
          TokenExpiration: '2099-01-01T00:00:00Z',
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ Signature: 'TxSig123', Status: 'Success', Message: '' }))

    const client = new AltudeHttpClient('test-key', 'https://api.altude.so', 'devnet')
    const result = await client.sendTransaction({ transaction: 'base64tx==' })

    expect(result.Signature).toBe('TxSig123')
    const sentBody = JSON.parse(fetchSpy.mock.calls[1]?.[1]?.body as string) as Record<string, unknown>
    expect(sentBody).toEqual({ SignedTransaction: 'base64tx==' })
  })

  it('getBalance reads SOL balance through the RPC client', async () => {
    const walletAddress = '11111111111111111111111111111111'
    const getBalance = vi.fn(() => ({
      send: vi.fn().mockResolvedValue({ value: 1_500_000_000n }),
    }))
    const client = new AltudeHttpClient('test-key', 'https://api.altude.so', 'devnet')

    vi.spyOn(client, 'getRpcClient').mockResolvedValue({
      rpc: { getBalance },
    } as never)

    const result = await client.getBalance({ address: walletAddress })

    expect(getBalance).toHaveBeenCalledWith(walletAddress)
    expect(result).toEqual({
      address: walletAddress,
      lamports: 1_500_000_000,
      amount: '1500000000',
      decimals: 9,
      uiAmount: 1.5,
    })
  })

  it('getBalance aggregates token accounts by owner and mint through RPC', async () => {
    const walletAddress = '11111111111111111111111111111111'
    const mintAddress = 'So11111111111111111111111111111111111111112'
    const getTokenAccountsByOwner = vi.fn(() => ({
      send: vi.fn().mockResolvedValue({
        value: [
          {
            account: {
              data: {
                parsed: {
                  info: {
                    tokenAmount: { amount: '1500000', decimals: 6 },
                  },
                },
              },
            },
          },
          {
            account: {
              data: {
                parsed: {
                  info: {
                    tokenAmount: { amount: '250000', decimals: 6 },
                  },
                },
              },
            },
          },
        ],
      }),
    }))
    const client = new AltudeHttpClient('test-key', 'https://api.altude.so', 'devnet')

    vi.spyOn(client, 'getRpcClient').mockResolvedValue({
      rpc: { getTokenAccountsByOwner },
    } as never)

    const result = await client.getBalance({ account: walletAddress, token: mintAddress })

    expect(getTokenAccountsByOwner).toHaveBeenCalledWith(walletAddress, { mint: mintAddress }, { encoding: 'jsonParsed' })
    expect(result).toEqual({
      address: walletAddress,
      amount: '1750000',
      decimals: 6,
      uiAmount: 1.75,
    })
  })

  it('getAccountInfo reads and normalizes RPC account data', async () => {
    const accountAddress = '11111111111111111111111111111111'
    const getAccountInfo = vi.fn(() => ({
      send: vi.fn().mockResolvedValue({
        value: {
          executable: false,
          lamports: 42n,
          owner: '11111111111111111111111111111111',
          rentEpoch: 7n,
          space: 165n,
          data: {
            parsed: {
              info: {
                tokenAmount: {
                  amount: '100',
                  decimals: 2,
                  uiAmount: 1,
                  uiAmountString: '1',
                },
              },
              type: 'account',
            },
            program: 'spl-token',
            space: 165n,
          },
        },
      }),
    }))
    const client = new AltudeHttpClient('test-key', 'https://api.altude.so', 'devnet')

    vi.spyOn(client, 'getRpcClient').mockResolvedValue({
      rpc: { getAccountInfo },
    } as never)

    const result = await client.getAccountInfo({ accountAddress })

    expect(getAccountInfo).toHaveBeenCalledWith(accountAddress, { encoding: 'jsonParsed' })
    expect(result).toEqual({
      accountAddress,
      exists: true,
      executable: false,
      lamports: 42,
      owner: '11111111111111111111111111111111',
      rentEpoch: '7',
      space: '165',
      data: {
        parsed: {
          info: {
            tokenAmount: {
              amount: '100',
              decimals: 2,
              uiAmount: 1,
              uiAmountString: '1',
            },
          },
          type: 'account',
        },
        program: 'spl-token',
        space: '165',
      },
    })
    expect(() => JSON.stringify(result)).not.toThrow()
  })
})

describe('AltudeGasStation facade', () => {
  it('creates with defaults (mock mode)', () => {
    const gs = new AltudeGasStation()
    expect(gs.client.isMockMode).toBe(true)
  })

  it('creates for devnet', () => {
    const gs = new AltudeGasStation({ network: 'devnet' })
    expect(gs.client.isMockMode).toBe(true) // no API key
  })

  it('creates with API key (live mode)', () => {
    const gs = new AltudeGasStation({ apiKey: 'test-key', network: 'devnet' })
    expect(gs.client.isMockMode).toBe(false)
  })

  it('getBlockhash returns a blockhash', async () => {
    const gs = new AltudeGasStation()
    const result = await gs.getBlockhash()
    expect(result.Blockhash).toBeTruthy()
  })

  it('getBalance returns balance data', async () => {
    const gs = new AltudeGasStation()
    const result = await gs.getBalance({ address: 'ALTn7gyjm29WthZGgs4z6WVAK2PK5U6w4FAtPg3TPY71' })
    expect(result.address).toBeTruthy()
  })

  it('exposes getConfig through the facade', async () => {
    const gs = new AltudeGasStation()
    const result = await gs.getConfig()
    expect(result.FeePayer).toBeTruthy()
  })

  it('getRpcClient requires an API key instead of using a public RPC fallback', async () => {
    const gs = new AltudeGasStation()

    await expect(gs.getRpcClient()).rejects.toMatchObject({
      code: 'RPC_ERROR',
      message: 'An Altude API key is required to resolve RPC node configuration.',
    })
  })

  it('does not initialize an RPC client without API-provided config', async () => {
    const gs = new AltudeGasStation()

    await expect(gs.getRpcClient()).rejects.toMatchObject({ code: 'RPC_ERROR' })
    await expect(gs.getRpcClient()).rejects.toMatchObject({ code: 'RPC_ERROR' })
  })

  it('exposes additional missing endpoints through the facade', async () => {
    const gs = new AltudeGasStation()

    const batchResult = await gs.sendBatchTransaction({ signedTransaction: 'base64encodedtx==' })
    const batchAliasResult = await gs.sendBatch({ signedTransaction: 'base64encodedtx==' })
    const accountInfo = await gs.getAccountInfo({ accountAddress: '11111111111111111111111111111111' })
    const history = await gs.getHistory({
      page: 1,
      pageSize: 10,
      walletAddress: '11111111111111111111111111111111',
    })

    expect(batchResult.Signature).toBeTruthy()
    expect(batchAliasResult.Signature).toBeTruthy()
    expect(accountInfo.accountAddress).toBe('11111111111111111111111111111111')
    expect(history.page).toBe(1)
  })

  it('init preloads relay config and rpc client', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({
        FeePayer: 'ALTn7gyjm29WthZGgs4z6WVAK2PK5U6w4FAtPg3TPY71',
        RpcUrl: 'https://rpc.altude.so',
        Token: 'runtime-token',
        RpcEnvironment: 'devnet',
        TokenExpiration: '2099-01-01T00:00:00Z',
      }),
    )
    const gs = new AltudeGasStation({ apiKey: 'test-key', network: 'devnet' })
    const configSpy = vi.spyOn(gs, 'getConfig')
    const rpcSpy = vi.spyOn(gs, 'getRpcClient')

    await gs.init()

    expect(configSpy).toHaveBeenCalledTimes(1)
    expect(rpcSpy).toHaveBeenCalledTimes(1)
  })

  it('manages instruction list state', () => {
    const gs = new AltudeGasStation()
    const firstInstruction = {
      programAddress: '11111111111111111111111111111111',
      accounts: [],
      data: new Uint8Array(),
    } as unknown as Instruction
    const secondInstruction = {
      programAddress: 'ComputeBudget111111111111111111111111111111',
      accounts: [],
      data: new Uint8Array(),
    } as unknown as Instruction

    gs.setInstructions([firstInstruction])
    gs.addInstruction(secondInstruction)
    expect(gs.getInstructions()).toHaveLength(2)

    const removed = gs.removeInstruction(0)
    expect(removed).toBe(firstInstruction)
    expect(gs.getInstructions()).toHaveLength(1)

    gs.clearInstructions()
    expect(gs.getInstructions()).toHaveLength(0)
  })

  it('serializeInstructionPayload throws when there are no managed instructions', async () => {
    const gs = new AltudeGasStation()
    await expect(gs.serializeInstructionPayload()).rejects.toThrow(
      'No instructions available. Add instructions before serializing.',
    )
  })

  it('partialSignTransactionMessage delegates to signer', async () => {
    const gs = new AltudeGasStation()
    const signature = new Uint8Array([1, 2, 3, 4])
    const signer = {
      address: '11111111111111111111111111111111',
      signTransactionMessage: vi.fn().mockResolvedValue(signature),
      signMessage: vi.fn().mockResolvedValue(new Uint8Array([9, 9])),
    }
    const txMessage = new Uint8Array([7, 8, 9])

    const result = await gs.partialSignTransactionMessage(txMessage, signer)

    expect(signer.signTransactionMessage).toHaveBeenCalledWith(txMessage)
    expect(result).toEqual(signature)
  })

  it('sign delegates to signTransactionMessage when available', async () => {
    const gs = new AltudeGasStation()
    const signature = new Uint8Array([4, 3, 2, 1])
    const signer = {
      address: '11111111111111111111111111111111',
      signTransactionMessage: vi.fn().mockResolvedValue(signature),
    }
    const txMessage = new Uint8Array([1, 9, 9])

    const result = await gs.sign(txMessage, signer)

    expect(signer.signTransactionMessage).toHaveBeenCalledWith(txMessage)
    expect(result).toEqual(signature)
  })

  it('partialSignTransactionMessage supports legacy sign() signer fallback', async () => {
    const gs = new AltudeGasStation()
    const signature = new Uint8Array([7, 7, 7])
    const signer = {
      address: '11111111111111111111111111111111',
      sign: vi.fn().mockResolvedValue(signature),
    }
    const txMessage = new Uint8Array([5, 6, 7])

    const result = await gs.partialSignTransactionMessage(txMessage, signer)

    expect(signer.sign).toHaveBeenCalledWith(txMessage)
    expect(result).toEqual(signature)
  })

  it('sendSerializedInstructionPayload relays payload through batch endpoint', async () => {
    const gs = new AltudeGasStation()
    const sendBatchSpy = vi.spyOn(gs, 'sendBatchTransaction')

    await gs.sendSerializedInstructionPayload('serialized-payload')

    expect(sendBatchSpy).toHaveBeenCalledWith({ signedTransaction: 'serialized-payload' })
  })

  it('sendBatch aliases sendBatchTransaction through the facade', async () => {
    const gs = new AltudeGasStation()
    const sendBatchTransactionSpy = vi.spyOn(gs, 'sendBatchTransaction')

    const result = await gs.sendBatch({ signedTransaction: 'serialized-payload' })

    expect(result.Signature).toBeTruthy()
    expect(sendBatchTransactionSpy).toHaveBeenCalledWith({ signedTransaction: 'serialized-payload' })
  })

  it('send partially signs on client side before relaying', async () => {
    const gs = new AltudeGasStation()
    const sendTransactionSpy = vi.spyOn(gs.client, 'sendTransaction')
    const signer = {
      address: 'ALTn7gyjm29WthZGgs4z6WVAK2PK5U6w4FAtPg3TPY71',
      signTransactionMessage: vi.fn().mockResolvedValue(new Uint8Array(64).fill(1)),
    }

    vi.spyOn(gs, 'getRpcClient').mockResolvedValue({
      rpc: {
        getLatestBlockhash: () => ({
          send: vi.fn().mockResolvedValue({
            value: {
              blockhash: 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N',
              lastValidBlockHeight: 100n,
            },
          }),
        }),
      },
      rpcSubscriptions: {},
    } as never)

    const result = await gs.send({
      sourceSigner: signer,
      to: 'ALTn7gyjm29WthZGgs4z6WVAK2PK5U6w4FAtPg3TPY71',
      amount: 1_000,
    })

    expect(signer.signTransactionMessage).toHaveBeenCalled()
    expect(sendTransactionSpy).toHaveBeenCalledOnce()
    expect(sendTransactionSpy.mock.calls[0]?.[0]?.transaction.length).toBeGreaterThan(0)
    expect(result.Signature).toBeTruthy()
  })

  it('send builds and signs a token transfer without Gill program subpaths', async () => {
    const gs = new AltudeGasStation()
    const sendTransactionSpy = vi.spyOn(gs.client, 'sendTransaction')
    const signer = {
      address: 'So11111111111111111111111111111111111111112',
      signTransactionMessage: vi.fn().mockResolvedValue(new Uint8Array(64).fill(1)),
    }

    vi.spyOn(gs, 'getRpcClient').mockResolvedValue({
      rpc: {
        getLatestBlockhash: () => ({
          send: vi.fn().mockResolvedValue({
            value: {
              blockhash: 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N',
              lastValidBlockHeight: 100n,
            },
          }),
        }),
      },
      rpcSubscriptions: {},
    } as never)

    const result = await gs.send({
      sourceSigner: signer,
      toAddress: 'ALTn7gyjm29WthZGgs4z6WVAK2PK5U6w4FAtPg3TPY71',
      token: 'So11111111111111111111111111111111111111112',
      amount: 1_000,
    })

    expect(signer.signTransactionMessage).toHaveBeenCalled()
    expect(sendTransactionSpy).toHaveBeenCalledOnce()
    expect(sendTransactionSpy.mock.calls[0]?.[0]?.transaction.length).toBeGreaterThan(0)
    expect(result.Signature).toBeTruthy()
  })

  it('send does not retry when relay throws blockhash not found', async () => {
    const gs = new AltudeGasStation()
    const sendTransactionSpy = vi
      .spyOn(gs.client, 'sendTransaction')
      .mockRejectedValueOnce(new Error('Transaction simulation failed: Blockhash not found'))
      .mockResolvedValueOnce({ Signature: 'RetriedSig', Status: 'Success', Message: '' })
    const signer = {
      address: 'ALTn7gyjm29WthZGgs4z6WVAK2PK5U6w4FAtPg3TPY71',
      signTransactionMessage: vi.fn().mockResolvedValue(new Uint8Array(64).fill(2)),
    }

    vi.spyOn(gs, 'getRpcClient').mockResolvedValue({
      rpc: {
        getLatestBlockhash: () => ({
          send: vi.fn().mockResolvedValue({
            value: {
              blockhash: 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N',
              lastValidBlockHeight: 100n,
            },
          }),
        }),
      },
      rpcSubscriptions: {},
    } as never)

    await expect(
      gs.send({
        sourceSigner: signer,
        toAddress: 'ALTn7gyjm29WthZGgs4z6WVAK2PK5U6w4FAtPg3TPY71',
        amount: 1_000,
      }),
    ).rejects.toThrow('Blockhash not found')

    expect(sendTransactionSpy).toHaveBeenCalledTimes(1)
  })

  it('send does not retry when relay response message contains blockhash not found', async () => {
    const gs = new AltudeGasStation()
    const sendTransactionSpy = vi
      .spyOn(gs.client, 'sendTransaction')
      .mockResolvedValueOnce({
        Signature: '',
        Status: 'Failed',
        Message: 'Transaction simulation failed: Blockhash not found',
      })
      .mockResolvedValueOnce({ Signature: 'RetriedSigFromResponse', Status: 'Success', Message: '' })
    const signer = {
      address: 'ALTn7gyjm29WthZGgs4z6WVAK2PK5U6w4FAtPg3TPY71',
      signTransactionMessage: vi.fn().mockResolvedValue(new Uint8Array(64).fill(3)),
    }

    vi.spyOn(gs, 'getRpcClient').mockResolvedValue({
      rpc: {
        getLatestBlockhash: () => ({
          send: vi.fn().mockResolvedValue({
            value: {
              blockhash: 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N',
              lastValidBlockHeight: 100n,
            },
          }),
        }),
      },
      rpcSubscriptions: {},
    } as never)

    const result = await gs.send({
      sourceSigner: signer,
      toAddress: 'ALTn7gyjm29WthZGgs4z6WVAK2PK5U6w4FAtPg3TPY71',
      amount: 1_000,
    })

    expect(sendTransactionSpy).toHaveBeenCalledTimes(1)
    expect(result.Status).toBe('Failed')
    expect(result.Message).toContain('Blockhash not found')
  })

  it('createAccount builds a transaction and relays it (mock mode)', async () => {
    const gs = new AltudeGasStation()
    const createAccountSpy = vi.spyOn(gs.client, 'createAccount')
    const getAccountInfo = vi.fn(() => ({
      send: vi.fn().mockResolvedValue({ value: null }),
    }))

    const signer = {
      address: WRAPPED_SOL_MINT_ADDRESS,
      signTransactionMessages: vi.fn().mockResolvedValue([{}]),
      signTransactionMessage: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
      signMessage: vi.fn().mockResolvedValue(new Uint8Array([9, 9])),
    }

    // Stub getRpcClient to avoid real network calls.
    vi.spyOn(gs, 'getRpcClient').mockResolvedValue({
      rpc: {
        getAccountInfo,
        getLatestBlockhash: () => ({
          send: vi.fn().mockResolvedValue({
            value: {
              blockhash: 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N',
              lastValidBlockHeight: 100n,
            },
          }),
        }),
      },
      rpcSubscriptions: {},
    } as never)

    const result = await gs.createAccount({
      account: WRAPPED_SOL_MINT_ADDRESS,
      tokens: [WRAPPED_SOL_MINT_ADDRESS],
      signer,
    })

    expect(getAccountInfo).toHaveBeenCalledOnce()
    expect(createAccountSpy).toHaveBeenCalledOnce()
    expect(signer.signTransactionMessage).toHaveBeenCalled()
    const callArg = createAccountSpy.mock.calls[0]?.[0]
    expect(typeof callArg?.signedTransaction).toBe('string')
    expect(callArg?.signedTransaction.length).toBeGreaterThan(0)
    expect(result.Signature).toBeTruthy()
  })

  it('createAccount returns success without signing or relaying when the ATA already exists', async () => {
    const gs = new AltudeGasStation()
    const createAccountSpy = vi.spyOn(gs.client, 'createAccount')
    const getLatestBlockhash = vi.fn()
    const getAccountInfo = vi.fn(() => ({
      send: vi.fn().mockResolvedValue({ value: {} }),
    }))
    const signer = {
      address: WRAPPED_SOL_MINT_ADDRESS,
      signTransactionMessage: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
    }

    vi.spyOn(gs, 'getRpcClient').mockResolvedValue({
      rpc: { getAccountInfo, getLatestBlockhash },
      rpcSubscriptions: {},
    } as never)

    const result = await gs.createAccount({ signer })

    expect(result).toEqual({
      Signature: '',
      Status: 'Success',
      Message: 'Account already exists',
    })
    expect(getAccountInfo).toHaveBeenCalledOnce()
    expect(getLatestBlockhash).not.toHaveBeenCalled()
    expect(signer.signTransactionMessage).not.toHaveBeenCalled()
    expect(createAccountSpy).not.toHaveBeenCalled()
  })

  it.each([
    { label: 'omitted', tokens: undefined },
    { label: 'empty', tokens: [] as string[] },
  ])('createAccount defaults $label tokens to WSOL', async ({ tokens }) => {
    const gs = new AltudeGasStation()
    const getAccountInfo = vi.fn(() => ({
      send: vi.fn().mockResolvedValue({ value: {} }),
    }))
    const signer = {
      address: 'ALTn7gyjm29WthZGgs4z6WVAK2PK5U6w4FAtPg3TPY71',
      signTransactionMessage: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
    }
    const [expectedAta] = await findAssociatedTokenPda({
      mint: address(WRAPPED_SOL_MINT_ADDRESS),
      owner: address(signer.address),
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    })

    vi.spyOn(gs, 'getRpcClient').mockResolvedValue({
      rpc: { getAccountInfo },
      rpcSubscriptions: {},
    } as never)

    await gs.createAccount({ signer, ...(tokens !== undefined && { tokens }) })

    expect(getAccountInfo).toHaveBeenCalledWith(expectedAta, {
      encoding: 'jsonParsed',
      commitment: 'confirmed',
    })
  })

  it('createAccount creates only missing ATAs when some requested accounts exist', async () => {
    const gs = new AltudeGasStation()
    const createAccountSpy = vi.spyOn(gs.client, 'createAccount')
    const missingMintAddress = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'
    const signer = {
      address: '11111111111111111111111111111111',
      signTransactionMessage: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
    }
    const [existingAta] = await findAssociatedTokenPda({
      mint: address(WRAPPED_SOL_MINT_ADDRESS),
      owner: address(signer.address),
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    })
    const [missingAta] = await findAssociatedTokenPda({
      mint: address(missingMintAddress),
      owner: address(signer.address),
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    })
    const getAccountInfo = vi.fn((ataAddress: string) => ({
      send: vi.fn().mockResolvedValue({
        value: ataAddress === existingAta ? {} : null,
      }),
    }))

    vi.spyOn(gs, 'getRpcClient').mockResolvedValue({
      rpc: {
        getAccountInfo,
        getLatestBlockhash: () => ({
          send: vi.fn().mockResolvedValue({
            value: {
              blockhash: 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N',
              lastValidBlockHeight: 100n,
            },
          }),
        }),
      },
      rpcSubscriptions: {},
    } as never)

    const result = await gs.createAccount({
      tokens: [WRAPPED_SOL_MINT_ADDRESS, missingMintAddress],
      signer,
    })

    expect(getAccountInfo).toHaveBeenCalledWith(existingAta, {
      encoding: 'jsonParsed',
      commitment: 'confirmed',
    })
    expect(getAccountInfo).toHaveBeenCalledWith(missingAta, {
      encoding: 'jsonParsed',
      commitment: 'confirmed',
    })
    const feePayer = address((await gs.getConfig()).FeePayer)
    const signedTransaction = createAccountSpy.mock.calls[0]?.[0]?.signedTransaction
    expect(signedTransaction).toBeTruthy()
    const expectedSigner = {
      address: address(signer.address),
      signTransactions: vi.fn((transactions: ReadonlyArray<{ messageBytes: Uint8Array }>) =>
        Promise.resolve(
          transactions.map(() => ({
            [address(signer.address)]: new Uint8Array([1, 2, 3]),
          })),
        ),
      ),
    }
    const expectedSignedTransaction = await transactionToBase64WithSigners(
      createTransaction(
        {
          version: 'legacy',
          feePayer,
          latestBlockhash: {
            blockhash: 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N',
            lastValidBlockHeight: 100n,
          },
          instructions: [
            getSetComputeUnitLimitInstruction({ units: 400_000 }),
            getCreateAssociatedTokenIdempotentInstruction({
              payer: createNoopSigner(feePayer),
              owner: address(signer.address),
              mint: address(missingMintAddress),
              ata: missingAta,
              tokenProgram: TOKEN_PROGRAM_ADDRESS,
            }),
            getSetAuthorityInstruction(
              {
                owned: missingAta,
                owner: expectedSigner as never,
                authorityType: AuthorityType.CloseAccount,
                newAuthority: feePayer,
              },
              { programAddress: TOKEN_PROGRAM_ADDRESS },
            ),
          ],
        } as never,
      ) as never,
    )

    expect(signer.signTransactionMessage).toHaveBeenCalledOnce()
    expect(createAccountSpy).toHaveBeenCalledOnce()
    expect(signedTransaction).toBe(expectedSignedTransaction)
    expect(result.Signature).toBeTruthy()
  })

  it('closeAccount builds a transaction and relays it (feePayer as close authority)', async () => {
    const gs = new AltudeGasStation()
    const closeAccountSpy = vi.spyOn(gs.client, 'closeAccount')

    // Stub getRpcClient to avoid real network calls.
    vi.spyOn(gs, 'getRpcClient').mockResolvedValue({
      rpc: {
        getLatestBlockhash: () => ({
          send: vi.fn().mockResolvedValue({
            value: {
              blockhash: 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N',
              lastValidBlockHeight: 100n,
            },
          }),
        }),
      },
      rpcSubscriptions: {},
    } as never)

    const result = await gs.closeAccount({
      accountAddress: 'So11111111111111111111111111111111111111112',
      destination: '11111111111111111111111111111111',
    })

    expect(closeAccountSpy).toHaveBeenCalledOnce()
    const callArg = closeAccountSpy.mock.calls[0]?.[0]
    expect(typeof callArg?.signedTransaction).toBe('string')
    expect(callArg?.signedTransaction.length).toBeGreaterThan(0)
    expect(result.Signature).toBeTruthy()
  })

  it('closeAccount builds a transaction and relays it (user as close authority)', async () => {
    const gs = new AltudeGasStation()
    const closeAccountSpy = vi.spyOn(gs.client, 'closeAccount')

    const signer = {
      address: '11111111111111111111111111111111',
      signTransactionMessages: vi.fn().mockResolvedValue([{}]),
      signTransactionMessage: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
      signMessage: vi.fn().mockResolvedValue(new Uint8Array([9, 9])),
    }

    // Stub getRpcClient to avoid real network calls.
    vi.spyOn(gs, 'getRpcClient').mockResolvedValue({
      rpc: {
        getLatestBlockhash: () => ({
          send: vi.fn().mockResolvedValue({
            value: {
              blockhash: 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N',
              lastValidBlockHeight: 100n,
            },
          }),
        }),
      },
      rpcSubscriptions: {},
    } as never)

    const result = await gs.closeAccount({
      accountAddress: 'So11111111111111111111111111111111111111112',
      destination: '11111111111111111111111111111111',
      signer,
    })

    expect(closeAccountSpy).toHaveBeenCalledOnce()
    expect(signer.signTransactionMessage).toHaveBeenCalled()
    const callArg = closeAccountSpy.mock.calls[0]?.[0]
    expect(typeof callArg?.signedTransaction).toBe('string')
    expect(result.Signature).toBeTruthy()
  })

  it('closeAccount supports Android-style account + tokens (auto-discovers ATAs)', async () => {
    const gs = new AltudeGasStation()
    const closeAccountSpy = vi.spyOn(gs.client, 'closeAccount')

    vi.spyOn(gs, 'getRpcClient').mockResolvedValue({
      rpc: {
        getLatestBlockhash: () => ({
          send: vi.fn().mockResolvedValue({
            value: {
              blockhash: 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N',
              lastValidBlockHeight: 100n,
            },
          }),
        }),
      },
      rpcSubscriptions: {},
    } as never)

    const result = await gs.closeAccount({
      account: 'So11111111111111111111111111111111111111112',
      tokens: ['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'],
    })

    expect(closeAccountSpy).toHaveBeenCalledOnce()
    const callArg = closeAccountSpy.mock.calls[0]?.[0]
    expect(typeof callArg?.signedTransaction).toBe('string')
    expect(callArg?.signedTransaction.length).toBeGreaterThan(0)
    expect(result.Signature).toBeTruthy()
  })

  it('send accepts Android-style toAddress and computeOptions', async () => {
    const gs = new AltudeGasStation()
    const sendTransactionSpy = vi.spyOn(gs.client, 'sendTransaction')
    const signer = {
      address: 'ALTn7gyjm29WthZGgs4z6WVAK2PK5U6w4FAtPg3TPY71',
      signTransactionMessage: vi.fn().mockResolvedValue(new Uint8Array(64).fill(1)),
    }

    vi.spyOn(gs, 'getRpcClient').mockResolvedValue({
      rpc: {
        getLatestBlockhash: () => ({
          send: vi.fn().mockResolvedValue({
            value: {
              blockhash: 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N',
              lastValidBlockHeight: 100n,
            },
          }),
        }),
      },
      rpcSubscriptions: {},
    } as never)

    const result = await gs.send({
      sourceSigner: signer,
      toAddress: 'ALTn7gyjm29WthZGgs4z6WVAK2PK5U6w4FAtPg3TPY71',
      amount: 1_000,
      computeOptions: { computeUnitLimit: 200_000, computeUnitPriceMicroLamports: 5000 },
    })

    expect(signer.signTransactionMessage).toHaveBeenCalled()
    expect(sendTransactionSpy).toHaveBeenCalledOnce()
    expect(result.Signature).toBeTruthy()
  })

  it('getBalance facade accepts Android-style account field', async () => {
    const gs = new AltudeGasStation()
    const result = await gs.getBalance({ account: 'ALTn7gyjm29WthZGgs4z6WVAK2PK5U6w4FAtPg3TPY71' })
    expect(result.address).toBeTruthy()
  })

  it('getAccountInfo facade accepts Android-style account field', async () => {
    const gs = new AltudeGasStation()
    const result = await gs.getAccountInfo({ account: '11111111111111111111111111111111' })
    expect(result.accountAddress).toBe('11111111111111111111111111111111')
  })

  it('getHistory facade accepts Android-style limit/offset fields', async () => {
    const gs = new AltudeGasStation()
    const result = await gs.getHistory({ account: '11111111111111111111111111111111', limit: 15, offset: 0 })
    expect(result.limit).toBe(15)
  })
})
