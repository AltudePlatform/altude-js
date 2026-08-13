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
    const client = createAltudeClient({ rpcUrl: 'https://rpc.example.com' })

    expect(mocks.createSolanaRpc).toHaveBeenCalledOnce()
    expect(mocks.createSolanaClient).not.toHaveBeenCalled()
    expect(client.rpc).toBe(mocks.createSolanaRpc.mock.results[0]?.value)
  })

  it('creates and reuses the subscription-capable client on demand', () => {
    const client = createAltudeClient({ rpcUrl: 'https://rpc.example.com' })

    const subscriptions = client.rpcSubscriptions
    const sendAndConfirmTransaction = client.sendAndConfirmTransaction

    expect(subscriptions).toBe(mocks.rpcSubscriptions)
    expect(sendAndConfirmTransaction).toBe(mocks.sendAndConfirmTransaction)
    expect(mocks.createSolanaClient).toHaveBeenCalledOnce()
  })
})
