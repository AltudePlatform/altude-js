import { describe, it, expect } from 'vitest'
import {
  AltudeError,
  walletNotFound,
  invalidPassphrase,
  policyDenied,
  apiKeyNotFound,
  apiKeyExpired,
  chainNotSupported,
  vaultPermissionError,
  vaultStorageError,
} from '../src/errors.js'

describe('AltudeError', () => {
  it('carries code, message, and remediation', () => {
    const err = new AltudeError({
      code: 'WALLET_NOT_FOUND',
      message: 'Not found',
      remediation: 'Check your wallet ID',
    })
    expect(err.code).toBe('WALLET_NOT_FOUND')
    expect(err.message).toBe('Not found')
    expect(err.remediation).toBe('Check your wallet ID')
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(AltudeError)
  })

  it('name is AltudeError', () => {
    expect(new AltudeError({ code: 'RELAY_ERROR', message: 'fail' }).name).toBe('AltudeError')
  })
})

describe('typed error constructors', () => {
  it('walletNotFound', () => {
    const e = walletNotFound('abc-123')
    expect(e.code).toBe('WALLET_NOT_FOUND')
    expect(e.message).toContain('abc-123')
  })

  it('invalidPassphrase', () => {
    expect(invalidPassphrase().code).toBe('INVALID_PASSPHRASE')
  })

  it('policyDenied', () => {
    const e = policyDenied('chain not allowed')
    expect(e.code).toBe('POLICY_DENIED')
    expect(e.message).toContain('chain not allowed')
  })

  it('apiKeyNotFound', () => {
    expect(apiKeyNotFound('k1').code).toBe('API_KEY_NOT_FOUND')
  })

  it('apiKeyExpired', () => {
    expect(apiKeyExpired('k2').code).toBe('API_KEY_EXPIRED')
  })

  it('chainNotSupported', () => {
    expect(chainNotSupported('ethereum').code).toBe('CHAIN_NOT_SUPPORTED')
  })

  it('vaultPermissionError', () => {
    expect(vaultPermissionError('/home/user/.ows').code).toBe('VAULT_PERMISSION_ERROR')
  })

  it('vaultStorageError wraps cause', () => {
    const cause = new Error('disk full')
    const e = vaultStorageError('write failed', cause)
    expect(e.code).toBe('VAULT_STORAGE_ERROR')
    expect(e.cause).toBe(cause)
  })
})
