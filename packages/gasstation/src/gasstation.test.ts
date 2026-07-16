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
    expect(result.Signature).toBeTruthy()
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
          TokenExpiration: '2026-01-01T00:00:00Z',
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

  it('sendTransaction sends { SignedTransaction } body matching Android SDK', async () => {
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
      .mockResolvedValueOnce(jsonResponse({ Signature: 'TxSig123', Status: 'Success', Message: '' }))

    const client = new AltudeHttpClient('test-key', 'https://api.altude.so', 'devnet')
    const result = await client.sendTransaction({ transaction: 'base64tx==' })

    expect(result.Signature).toBe('TxSig123')
    const sentBody = JSON.parse(fetchSpy.mock.calls[1]?.[1]?.body as string) as Record<string, unknown>
    expect(sentBody).toEqual({ SignedTransaction: 'base64tx==' })
  })

  it('getBalance sends { accountAddress, mintAddress } body matching Android SDK', async () => {
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
      .mockResolvedValueOnce(jsonResponse({ address: 'wallet123', uiAmount: 1.0 }))

    const client = new AltudeHttpClient('test-key', 'https://api.altude.so', 'devnet')
    await client.getBalance({ address: 'wallet123', mint: 'mint456' })

    const sentBody = JSON.parse(fetchSpy.mock.calls[1]?.[1]?.body as string) as Record<string, unknown>
    expect(sentBody).toEqual({ accountAddress: 'wallet123', mintAddress: 'mint456' })
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

  it('createAccount builds a transaction and relays it (mock mode)', async () => {
    const gs = new AltudeGasStation()
    const createAccountSpy = vi.spyOn(gs.client, 'createAccount')

    const signer = {
      address: 'So11111111111111111111111111111111111111112',
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

    const result = await gs.createAccount({
      account: 'So11111111111111111111111111111111111111112',
      tokens: ['So11111111111111111111111111111111111111112'],
      signer,
    })

    expect(createAccountSpy).toHaveBeenCalledOnce()
    expect(signer.signTransactionMessage).toHaveBeenCalled()
    const callArg = createAccountSpy.mock.calls[0]?.[0]
    expect(typeof callArg?.signedTransaction).toBe('string')
    expect(callArg?.signedTransaction.length).toBeGreaterThan(0)
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
      accountAddress: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
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
      accountAddress: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      destination: '11111111111111111111111111111111',
      signer,
    })

    expect(closeAccountSpy).toHaveBeenCalledOnce()
    expect(signer.signTransactionMessage).toHaveBeenCalled()
    const callArg = closeAccountSpy.mock.calls[0]?.[0]
    expect(typeof callArg?.signedTransaction).toBe('string')
    expect(result.Signature).toBeTruthy()
  })
})
