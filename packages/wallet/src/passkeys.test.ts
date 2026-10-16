import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserPasskeyAdapter } from './passkeys.js'

const registerInput = {
  challenge: new Uint8Array([1]),
  userId: new Uint8Array([2]),
  userName: 'user@example.com',
  rpId: 'localhost',
  rpName: 'Altude',
  prfSalt: new Uint8Array([3]),
}

const deriveInput = {
  challenge: new Uint8Array([1]),
  credentialId: new Uint8Array([2]),
  rpId: 'localhost',
  prfSalt: new Uint8Array([3]),
}

describe('BrowserPasskeyAdapter ceremony errors', () => {
  const create = vi.fn()
  const get = vi.fn()
  const adapter = new BrowserPasskeyAdapter()

  beforeEach(() => {
    create.mockReset()
    get.mockReset()
    vi.stubGlobal('isSecureContext', true)
    vi.stubGlobal('PublicKeyCredential', function PublicKeyCredential() {})
    vi.stubGlobal('location', { hostname: 'localhost' })
    vi.stubGlobal('navigator', { credentials: { create, get } })
  })

  afterEach(() => vi.unstubAllGlobals())

  it.each(['NotAllowedError', 'AbortError'])(
    'maps %s from credential creation to a typed cancellation',
    async (name) => {
      const cause = Object.assign(new Error('Browser ceremony ended.'), { name })
      create.mockRejectedValue(cause)

      await expect(adapter.register(registerInput)).rejects.toMatchObject({
        name: 'AltudeWalletError',
        code: 'PASSKEY_CANCELLED',
        cause,
      })
    },
  )

  it.each(['NotAllowedError', 'AbortError'])(
    'maps %s from credential retrieval to a typed cancellation',
    async (name) => {
      const cause = Object.assign(new Error('Browser ceremony ended.'), { name })
      get.mockRejectedValue(cause)

      await expect(adapter.deriveKey(deriveInput)).rejects.toMatchObject({
        name: 'AltudeWalletError',
        code: 'PASSKEY_CANCELLED',
        cause,
      })
    },
  )

  it('preserves unrelated credential creation failures', async () => {
    const failure = new Error('Authenticator unavailable.')
    create.mockRejectedValue(failure)

    await expect(adapter.register(registerInput)).rejects.toBe(failure)
  })

  it('preserves unrelated credential retrieval failures', async () => {
    const failure = new Error('Authenticator unavailable.')
    get.mockRejectedValue(failure)

    await expect(adapter.deriveKey(deriveInput)).rejects.toBe(failure)
  })

})
