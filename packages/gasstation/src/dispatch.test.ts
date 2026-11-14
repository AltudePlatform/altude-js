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

  it.each(['response-lost', 'auth-error', 'bad-request', 'server-error', 'invalid-json', 'invalid-response'] as const)(
    'does not resubmit when relay outcome is uncertain: %s',
    async (failure) => {
      const client = new AltudeHttpClient('key', 'https://api.example.test')
      let relays = 0
      let configCalls = 0
      const beforeDispatch = vi.fn()
      vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
        if (url.endsWith('/api/transaction/config')) {
          configCalls++
          return Promise.resolve(response({
            FeePayer: 'fee', RpcUrl: 'https://rpc.example.test', Token: 'token',
            RpcEnvironment: 'devnet', TokenExpiration: '2099-01-01T00:00:00Z',
          }))
        }
        if (!url.endsWith('/api/Transaction/send')) throw new Error(`Unexpected request: ${url}`)
        relays++
        expect(init?.body).toBe(JSON.stringify({ SignedTransaction: 'signed' }))
        if (failure === 'response-lost') return Promise.reject(new Error('Response lost after acceptance'))
        if (failure === 'invalid-json') return Promise.resolve(new Response('not json'))
        if (failure === 'invalid-response') return Promise.resolve(response({}))
        return Promise.resolve(response({ Error: 'failure' }, failure === 'auth-error' ? 401 : failure === 'bad-request' ? 400 : 500))
      }))
      await expect(client.sendTransaction({
        transaction: 'signed', expectedNetwork: 'devnet', beforeDispatch,
      })).rejects.toMatchObject({
        code: 'RELAY_SUBMISSION_UNCERTAIN',
        message: 'The relay submission outcome is uncertain; the transaction may have been submitted.',
        remediation: 'Check the transaction status on the approved network before deciding whether to submit again. Do not retry automatically.',
      })
      expect(relays).toBe(1)
      expect(configCalls).toBe(2)
      expect(beforeDispatch).toHaveBeenCalledOnce()
    },
  )

  it('rejects a network change before dispatch', async () => {
    const client = new AltudeHttpClient('key', 'https://api.example.test')
    let configCalls = 0
    let relays = 0
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.endsWith('/api/transaction/config')) {
        configCalls++
        return Promise.resolve(response({
          FeePayer: 'fee', RpcUrl: 'https://rpc.example.test', Token: 'token',
          RpcEnvironment: configCalls === 1 ? 'devnet' : 'mainnet-beta', TokenExpiration: '2099-01-01T00:00:00Z',
        }))
      }
      relays++
      throw new Error(`Unexpected request: ${url}`)
    }))
    await expect(client.sendTransaction({
      transaction: 'signed', expectedNetwork: 'devnet',
    })).rejects.toMatchObject({ code: 'RPC_ERROR' })
    expect(relays).toBe(0)
  })

  it('preserves normal config network retries before relay dispatch', async () => {
    const client = new AltudeHttpClient('key', 'https://api.example.test')
    let configCalls = 0
    let relays = 0
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.endsWith('/api/transaction/config')) {
        configCalls++
        if (configCalls === 1) return Promise.reject(new Error('Network failed'))
        return Promise.resolve(response({
          FeePayer: 'fee', RpcUrl: 'https://rpc.example.test', Token: 'token',
          RpcEnvironment: 'devnet', TokenExpiration: '2099-01-01T00:00:00Z',
        }))
      }
      relays++
      return Promise.resolve(response({ Signature: 'success' }))
    }))
    await expect(client.sendTransaction({ transaction: 'signed', expectedNetwork: 'devnet' }))
      .resolves.toMatchObject({ Signature: 'success' })
    expect(configCalls).toBe(3)
    expect(relays).toBe(1)
  })

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
