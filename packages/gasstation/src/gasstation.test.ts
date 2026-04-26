import { describe, it, expect } from 'vitest'
import { AltudeGasStation } from '../src/gasstation.js'
import { AltudeHttpClient } from '../src/client.js'

describe('AltudeHttpClient — mock mode', () => {
  it('operates in mock mode when no API key is given', () => {
    const client = new AltudeHttpClient()
    expect(client.isMockMode).toBe(true)
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

  it('getBalance returns mock data', async () => {
    const client = new AltudeHttpClient()
    const result = await client.getBalance({ address: '11111111111111111111111111111111' })
    expect(result.address).toBe('11111111111111111111111111111111')
    expect(result.lamports).toBeGreaterThan(0)
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
})
