import { describe, it, expect } from 'vitest'
import { createOWSGillSigner, createOWSWeb3Signer } from '../src/signers.js'

describe('createOWSGillSigner and createOWSWeb3Signer exports', () => {
  it('createOWSGillSigner is a function', () => {
    expect(typeof createOWSGillSigner).toBe('function')
  })

  it('createOWSWeb3Signer is a function', () => {
    expect(typeof createOWSWeb3Signer).toBe('function')
  })

  it('decodes hex signatures without Buffer polyfills', async () => {
    const vault = {
      getWallet: async () => ({
        id: 'wallet-1',
        accounts: [{ address: '11111111111111111111111111111111' }],
      }),
      sign: async () => ({ signature: '00ff10' }),
      signMessage: async () => ({ signature: 'abcd' }),
    }

    const signer = await createOWSGillSigner(vault as never, 'wallet-1', 'token')

    await expect(signer.signTransactionMessage(new Uint8Array([1, 2, 3]))).resolves.toEqual(new Uint8Array([0, 255, 16]))
    await expect(signer.signMessage(new Uint8Array([4, 5]))).resolves.toEqual(new Uint8Array([0xab, 0xcd]))
  })
})
