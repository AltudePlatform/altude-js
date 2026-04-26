import { describe, it, expect } from 'vitest'
import { createOWSGillSigner, createOWSWeb3Signer } from '../src/signers.js'

describe('createOWSGillSigner and createOWSWeb3Signer exports', () => {
  it('createOWSGillSigner is a function', () => {
    expect(typeof createOWSGillSigner).toBe('function')
  })

  it('createOWSWeb3Signer is a function', () => {
    expect(typeof createOWSWeb3Signer).toBe('function')
  })
})
