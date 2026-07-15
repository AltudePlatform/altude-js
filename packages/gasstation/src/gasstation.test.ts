import { afterEach, describe, expect, it, vi } from 'vitest'
import { AltudeGasStation } from '../src/gasstation.js'
import { AltudeHttpClient } from '../src/client.js'
import type { Instruction } from 'gill'

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
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
    expect(result.signature).toBeTruthy()
  })

  it('createAccount returns a mock signature', async () => {
    const client = new AltudeHttpClient()
    const result = await client.createAccount({ newAccountPubkey: '11111111111111111111111111111111' })
    expect(result.signature).toBeTruthy()
  })

  it('sendBatchTransaction returns a mock signature', async () => {
    const client = new AltudeHttpClient()
    const result = await client.sendBatchTransaction({ signedTransaction: 'base64encodedtx==' })
    expect(result.signature).toBeTruthy()
  })

  it('closeAccount returns a mock signature', async () => {
    const client = new AltudeHttpClient()
    const result = await client.closeAccount({ signedTransaction: 'base64encodedtx==' })
    expect(result.signature).toBeTruthy()
  })

  it('getBalance returns mock data', async () => {
    const client = new AltudeHttpClient()
    const result = await client.getBalance({ address: '11111111111111111111111111111111' })
    expect(result.address).toBe('11111111111111111111111111111111')
    expect(result.lamports).toBeGreaterThan(0)
  })

  it('getAccountInfo returns mock data', async () => {
    const client = new AltudeHttpClient()
    const result = await client.getAccountInfo({ accountAddress: '11111111111111111111111111111111' })
    expect(result.accountAddress).toBe('11111111111111111111111111111111')
  })

  it('getHistory returns mock data', async () => {
    const client = new AltudeHttpClient()
    const result = await client.getHistory({
      page: 1,
      pageSize: 10,
      walletAddress: '11111111111111111111111111111111',
    })
    expect(result.page).toBe(1)
    expect(result.pageSize).toBe(10)
  })

  it('swap returns a mock signature', async () => {
    const client = new AltudeHttpClient()
    const result = await client.swap({
      inputMint: 'So11111111111111111111111111111111111111112',
      outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      amount: 1_000_000,
      userPublicKey: '11111111111111111111111111111111',
    })
    expect(result.signature).toBeTruthy()
  })

  it('getRpcClient returns a Gill SolanaClient in mock mode', async () => {
    const client = new AltudeHttpClient()
    const rpc = await client.getRpcClient()
    expect(rpc).toHaveProperty('rpc')
    expect(rpc).toHaveProperty('rpcSubscriptions')
  })
})

describe('AltudeHttpClient — live mode', () => {
  it('prefetches and caches runtime config', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({
        FeePayer: 'ALTn7gyjm29WthZGgs4z6WVAK2PK5U6w4FAtPg3TPY71',
        RpcUrl: 'https://rpc.altude.so',
        Token: 'runtime-token',
        RpcEnvironment: 'devnet',
        TokenExpiration: '2026-01-01T00:00:00Z',
      }),
    )

    const client = new AltudeHttpClient('test-key', 'https://api.altude.so', 'devnet')
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
          TokenExpiration: '2026-01-01T00:00:00Z',
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ signature: 'LiveBatchSig' }))

    const client = new AltudeHttpClient('test-key', 'https://api.altude.so', 'devnet')
    const result = await client.sendBatchTransaction({ signedTransaction: 'base64encodedtx==' })

    expect(result.signature).toBe('LiveBatchSig')
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('https://api.altude.so/api/transaction/config')
    expect(fetchSpy.mock.calls[1]?.[0]).toBe('https://api.altude.so/api/transaction/sendbatch')
  })

  it('getRpcClient returns a client initialised from config RpcUrl', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({
        FeePayer: 'ALTn7gyjm29WthZGgs4z6WVAK2PK5U6w4FAtPg3TPY71',
        RpcUrl: 'https://rpc.altude.so',
        Token: 'runtime-token',
        RpcEnvironment: 'devnet',
        TokenExpiration: '2026-01-01T00:00:00Z',
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
        TokenExpiration: '2026-01-01T00:00:00Z',
      }),
    )

    const client = new AltudeHttpClient('test-key', 'https://api.altude.so', 'devnet')
    const first = await client.getRpcClient()
    const second = await client.getRpcClient()
    expect(first).toBe(second)
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

  it('getRpcClient returns a Gill SolanaClient in mock mode', async () => {
    const gs = new AltudeGasStation()
    const rpc = await gs.getRpcClient()
    expect(rpc).toHaveProperty('rpc')
    expect(rpc).toHaveProperty('rpcSubscriptions')
  })

  it('getRpcClient returns same instance on repeated calls in mock mode', async () => {
    const gs = new AltudeGasStation()
    const first = await gs.getRpcClient()
    const second = await gs.getRpcClient()
    expect(first).toBe(second)
  })

  it('exposes additional missing endpoints through the facade', async () => {
    const gs = new AltudeGasStation()

    const batchResult = await gs.sendBatchTransaction({ signedTransaction: 'base64encodedtx==' })
    const closeResult = await gs.closeAccount({ signedTransaction: 'base64encodedtx==' })
    const accountInfo = await gs.getAccountInfo({ accountAddress: '11111111111111111111111111111111' })
    const history = await gs.getHistory({
      page: 1,
      pageSize: 10,
      walletAddress: '11111111111111111111111111111111',
    })

    expect(batchResult.signature).toBeTruthy()
    expect(closeResult.signature).toBeTruthy()
    expect(accountInfo.accountAddress).toBe('11111111111111111111111111111111')
    expect(history.page).toBe(1)
  })

  it('init preloads relay config and rpc client', async () => {
    const gs = new AltudeGasStation()
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

  it('sendSerializedInstructionPayload relays payload through batch endpoint', async () => {
    const gs = new AltudeGasStation()
    const sendBatchSpy = vi.spyOn(gs, 'sendBatchTransaction')

    await gs.sendSerializedInstructionPayload('serialized-payload')

    expect(sendBatchSpy).toHaveBeenCalledWith({ signedTransaction: 'serialized-payload' })
  })
})
