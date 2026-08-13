import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const rpcSubscriptions = { accountNotifications: vi.fn() }
  const sendAndConfirmTransaction = vi.fn()

  return {
    rpcSubscriptions,
    sendAndConfirmTransaction,
    createSolanaRpc: vi.fn(() => ({ getBalance: vi.fn() })),
    createSolanaClient: vi.fn(() => ({
      rpc: { getBalance: vi.fn() },
      rpcSubscriptions,
      sendAndConfirmTransaction,
      simulateTransaction: vi.fn(),
    })),
  }
})

vi.mock('gill', () => mocks)

import { createAltudeClient } from './rpc.js'

describe('createAltudeClient', () => {
  beforeEach(() => {
    mocks.createSolanaRpc.mockClear()
    mocks.createSolanaClient.mockClear()
  })

  it('creates only the HTTP RPC client initially', () => {
    const client = createAltudeClient({
      rpcUrl: 'https://rpc.example.com',
      rpcToken: 'runtime-token',
    })

    expect(mocks.createSolanaRpc).toHaveBeenCalledOnce()
    expect(mocks.createSolanaRpc).toHaveBeenCalledWith('https://rpc.example.com', {
      headers: { Authorization: 'Bearer runtime-token' },
    })
    expect(mocks.createSolanaClient).not.toHaveBeenCalled()
    expect(client.rpc).toBe(mocks.createSolanaRpc.mock.results[0]?.value)
  })

  it('creates and reuses the subscription-capable client on demand', () => {
    const client = createAltudeClient({
      rpcUrl: 'https://rpc.example.com',
      rpcToken: 'Bearer runtime-token',
    })

    const subscriptions = client.rpcSubscriptions
    const sendAndConfirmTransaction = client.sendAndConfirmTransaction

    expect(subscriptions).toBe(mocks.rpcSubscriptions)
    expect(sendAndConfirmTransaction).toBe(mocks.sendAndConfirmTransaction)
    expect(mocks.createSolanaClient).toHaveBeenCalledOnce()
  })

  it('rejects invalid API transaction config instead of using a public RPC fallback', () => {
    expect(() =>
      createAltudeClient({
        rpcUrl: 'cluster-not-found',
        rpcToken: 'runtime-token',
      }),
    ).toThrow('Altude transaction config returned an invalid RPC URL.')

    expect(() =>
      createAltudeClient({
        rpcUrl: 'https://rpc.example.com',
        rpcToken: 'jwt_unavailable',
      }),
    ).toThrow('Altude transaction config did not return a usable RPC JWT.')

    expect(mocks.createSolanaRpc).not.toHaveBeenCalled()
    expect(mocks.createSolanaClient).not.toHaveBeenCalled()
  })
})
