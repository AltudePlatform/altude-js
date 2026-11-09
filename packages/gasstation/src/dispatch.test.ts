import { afterEach, describe, expect, it, vi } from 'vitest'
import { AltudeGasStation } from './gasstation.js'
import { AltudeHttpClient } from './client.js'
import { AltudeError } from '@altude/core'

const signerAddress = 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N'
const recipient = 'So11111111111111111111111111111111111111112'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((finish) => {
    resolve = finish
  })
  return { promise, resolve }
}

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('real facade and HTTP relay dispatch constraints', () => {
  it.each(['transfer', 'provisioning'] as const)(
    'never retries a %s guard error even when its code is RELAY_ERROR',
    async (operation) => {
      const client = new AltudeHttpClient('dispatch-test', 'https://api.example.test')
      const error = new AltudeError({ code: 'RELAY_ERROR', message: 'Cancelled by caller' })
      const beforeDispatch = vi.fn().mockImplementationOnce(() => {
        throw error
      })
      const fetch = vi.fn().mockResolvedValue(
        response({
          FeePayer: signerAddress,
          RpcUrl: 'https://rpc.example.test',
          Token: 'synthetic-token',
          RpcEnvironment: 'devnet',
          TokenExpiration: '2099-01-01T00:00:00Z',
        }),
      )
      vi.stubGlobal('fetch', fetch)
      const pending =
        operation === 'transfer'
          ? client.sendTransaction({
              transaction: 'synthetic-base64',
              beforeDispatch,
              expectedNetwork: 'devnet',
            })
          : client.createAccount({
              signedTransaction: 'synthetic-base64',
              beforeDispatch,
              expectedNetwork: 'devnet',
            })
      await expect(pending).rejects.toBe(error)
      expect(beforeDispatch).toHaveBeenCalledOnce()
      expect(fetch).toHaveBeenCalledOnce()
      expect(fetch.mock.calls[0]?.[0]).toContain('/api/transaction/config')
    },
  )

  for (const operation of ['transfer', 'provisioning'] as const) {
    it.each([
      'network-refresh',
      'cancel-post-sign',
      'cancel-auth-refresh',
      'network-fallback',
      'cancel-fallback',
      'cancel-network-retry',
    ] as const)(`${operation} prevents unsafe dispatch at %s`, async (interleaving) => {
      const gs = new AltudeGasStation({
        apiKey: 'dispatch-test',
        baseUrl: 'https://api.example.test',
      })
      let network = 'devnet'
      let signed = false
      let cancelled = false
      let pausing = true
      const entered = deferred()
      const release = deferred()
      const relays: string[] = []
      const failure = new Error('Approval cancelled before dispatch')
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init?: RequestInit) => {
          if (url.startsWith('https://rpc.example.test')) {
            const request: unknown = JSON.parse(typeof init?.body === 'string' ? init.body : '')
            if (
              !request ||
              typeof request !== 'object' ||
              !('method' in request) ||
              !('id' in request) ||
              typeof request.method !== 'string' ||
              (typeof request.id !== 'number' && typeof request.id !== 'string')
            )
              throw new Error('Invalid synthetic RPC request')
            if (request.method !== 'getAccountInfo' && request.method !== 'getLatestBlockhash')
              throw new Error(`Unexpected RPC method: ${request.method}`)
            return response({
              jsonrpc: '2.0',
              id: request.id,
              result: {
                context: { slot: 1 },
                value:
                  request.method === 'getAccountInfo'
                    ? null
                    : {
                        blockhash: 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N',
                        lastValidBlockHeight: 100,
                      },
              },
            })
          }
          if (url.endsWith('/api/transaction/config')) {
            if (
              pausing &&
              ((interleaving === 'cancel-post-sign' && signed) ||
                (interleaving === 'cancel-auth-refresh' && relays.length === 1))
            ) {
              pausing = false
              entered.resolve()
              await release.promise
            }
            return response({
              FeePayer: 'ALTn7gyjm29WthZGgs4z6WVAK2PK5U6w4FAtPg3TPY71',
              RpcUrl: 'https://rpc.example.test',
              Token: 'synthetic-token',
              RpcEnvironment: network,
              TokenExpiration: '2099-01-01T00:00:00Z',
            })
          }
          if (!url.endsWith('/api/Transaction/send') && !url.endsWith('/api/Account/create'))
            throw new Error(`Unexpected HTTP request: ${url}`)
          relays.push(network)
          if (relays.length === 1 && interleaving === 'network-fallback') {
            network = 'mainnet-beta'
            await gs.getConfig(true)
            return response({ Error: 'bad-payload' }, 400)
          }
          if (relays.length === 1 && interleaving === 'cancel-fallback') {
            cancelled = true
            return response({ Error: 'bad-payload' }, 400)
          }
          if (relays.length === 1 && interleaving === 'cancel-network-retry') {
            cancelled = true
            throw new Error('Synthetic network failure')
          }
          if (relays.length === 1 && interleaving !== 'cancel-post-sign') {
            if (interleaving === 'network-refresh') network = 'mainnet-beta'
            return response({ Error: 'expired-token' }, 401)
          }
          return response({ Signature: 'synthetic-relay', Status: 'Success' })
        }),
      )
      const sign = vi.fn(() => {
        signed = true
        return Promise.resolve(new Uint8Array(64).fill(3))
      })
      const constraints = {
        expectedNetwork: 'devnet' as const,
        beforeDispatch: () => {
          if (cancelled) throw failure
        },
      }
      const signer = { address: signerAddress, signTransactionMessage: sign }
      const pending =
        operation === 'transfer'
          ? gs.send({ ...constraints, sourceSigner: signer, toAddress: recipient, amount: 1 })
          : gs.createAccount({ ...constraints, signer, tokens: [recipient] })
      const outcome = pending.then(
        (value) => value,
        (error: unknown) => error,
      )
      if (interleaving === 'cancel-post-sign' || interleaving === 'cancel-auth-refresh') {
        await entered.promise
        expect(relays).toHaveLength(interleaving === 'cancel-post-sign' ? 0 : 1)
        cancelled = true
        release.resolve()
      }
      const error = await outcome
      if (interleaving === 'network-refresh' || interleaving === 'network-fallback')
        expect(error).toMatchObject({ code: 'RPC_ERROR' })
      else expect(error).toBe(failure)
      expect(relays).toEqual(interleaving === 'cancel-post-sign' ? [] : ['devnet'])
      expect(sign).toHaveBeenCalledOnce()
    })
  }
})
