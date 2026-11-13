import { afterEach, describe, expect, it, vi } from 'vitest'
import { AltudeError } from '@altude/core'
import { AltudeHttpClient } from './client.js'

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('approved transfer dispatch', () => {
  it('dispatches an approved transfer on the expected network', async () => {
    const client = new AltudeHttpClient('key', 'https://api.example.test')
    let relays = 0
    const beforeDispatch = vi.fn()
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.endsWith('/api/transaction/config')) return Promise.resolve(response({
        FeePayer: 'fee', RpcUrl: 'https://rpc.example.test', Token: 'token',
        RpcEnvironment: 'mainnet', TokenExpiration: '2099-01-01T00:00:00Z',
      }))
      if (!url.endsWith('/api/Transaction/send')) throw new Error(`Unexpected request: ${url}`)
      relays++
      return Promise.resolve(response({ Signature: 'success', Status: 'Success' }))
    }))
    await expect(client.sendTransaction({
      transaction: 'signed', expectedNetwork: 'mainnet-beta', beforeDispatch,
    })).resolves.toMatchObject({ Signature: 'success' })
    expect(beforeDispatch).toHaveBeenCalledOnce()
    expect(relays).toBe(1)
  })

  it.each(['auth-refresh', 'fallback', 'network-retry'] as const)(
    'rechecks cancellation before %s dispatch',
    async (interleaving) => {
      const client = new AltudeHttpClient('key', 'https://api.example.test')
      let cancelled = false
      let relays = 0
      const cancelledError = new AltudeError({ code: 'RELAY_ERROR', message: 'Cancelled' })
      vi.stubGlobal('fetch', vi.fn((url: string) => {
        if (url.endsWith('/api/transaction/config')) {
          return Promise.resolve(response({
            FeePayer: 'fee', RpcUrl: 'https://rpc.example.test', Token: 'token',
            RpcEnvironment: 'devnet', TokenExpiration: '2099-01-01T00:00:00Z',
          }))
        }
        if (!url.endsWith('/api/Transaction/send')) throw new Error(`Unexpected request: ${url}`)
        relays++
        cancelled = true
        if (interleaving === 'network-retry') return Promise.reject(new Error('Network failed'))
        return Promise.resolve(response({ Error: 'failure' }, interleaving === 'auth-refresh' ? 401 : 400))
      }))
      await expect(client.sendTransaction({
        transaction: 'signed', expectedNetwork: 'devnet',
        beforeDispatch: () => { if (cancelled) throw cancelledError },
      })).rejects.toBe(cancelledError)
      expect(relays).toBe(1)
    },
  )

  it.each(['auth-refresh', 'fallback', 'network-retry'] as const)(
    'rejects a network change before %s dispatch',
    async (interleaving) => {
      const client = new AltudeHttpClient('key', 'https://api.example.test')
      let network = 'devnet'
      let relays = 0
      vi.stubGlobal('fetch', vi.fn((url: string) => {
        if (url.endsWith('/api/transaction/config')) {
          return Promise.resolve(response({
            FeePayer: 'fee', RpcUrl: 'https://rpc.example.test', Token: 'token',
            RpcEnvironment: network, TokenExpiration: '2099-01-01T00:00:00Z',
          }))
        }
        if (!url.endsWith('/api/Transaction/send')) throw new Error(`Unexpected request: ${url}`)
        relays++
        network = 'mainnet-beta'
        if (interleaving === 'network-retry') return Promise.reject(new Error('Network failed'))
        return Promise.resolve(response({ Error: 'failure' }, interleaving === 'auth-refresh' ? 401 : 400))
      }))
      await expect(client.sendTransaction({
        transaction: 'signed', expectedNetwork: 'devnet',
      })).rejects.toMatchObject({ code: 'RPC_ERROR' })
      expect(relays).toBe(1)
    },
  )

  it('does not fallback when the guard itself throws a relay error', async () => {
    const client = new AltudeHttpClient('key', 'https://api.example.test')
    const failure = new AltudeError({ code: 'RELAY_ERROR', message: 'Cancelled' })
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(response({
      FeePayer: 'fee', RpcUrl: 'https://rpc.example.test', Token: 'token',
      RpcEnvironment: 'devnet', TokenExpiration: '2099-01-01T00:00:00Z',
    })))
    vi.stubGlobal('fetch', fetch)
    await expect(client.sendTransaction({
      transaction: 'signed', expectedNetwork: 'devnet', beforeDispatch: () => { throw failure },
    })).rejects.toBe(failure)
    expect(fetch.mock.calls.every(([url]) => String(url).endsWith('/api/transaction/config'))).toBe(true)
  })
})
