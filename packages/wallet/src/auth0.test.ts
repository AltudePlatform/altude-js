// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Auth0WalletAuthOptions } from './auth0.js'

const auth0Mocks = vi.hoisted(() => ({
  createAuth0Client: vi.fn(),
  loginWithPopup: vi.fn(),
  getTokenSilently: vi.fn(),
  getUser: vi.fn(),
}))

vi.mock('@auth0/auth0-spa-js', () => ({
  createAuth0Client: auth0Mocks.createAuth0Client,
}))

import { createAuth0WalletAuth } from './auth0.js'

describe('createAuth0WalletAuth', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    auth0Mocks.createAuth0Client.mockResolvedValue({
      loginWithPopup: auth0Mocks.loginWithPopup,
      getTokenSilently: auth0Mocks.getTokenSilently,
      getUser: auth0Mocks.getUser,
    })
    auth0Mocks.loginWithPopup.mockResolvedValue(undefined)
    auth0Mocks.getTokenSilently.mockResolvedValue('api-access-token')
    auth0Mocks.getUser.mockResolvedValue({ sub: 'auth0|stable-user' })
  })

  it('configures an in-memory SPA client and returns API token and stable subject', async () => {
    const auth0 = await createAuth0WalletAuth({
      domain: ' example.auth0.com ',
      clientId: 'public-client-id',
      apiKey: 'publishable-api-key',
      audience: 'https://api.example.test',
      connections: { Google: 'google-oauth2' },
      redirectUri: 'https://app.example.test/auth/callback',
    })

    expect(auth0Mocks.createAuth0Client).toHaveBeenCalledWith({
      domain: 'example.auth0.com',
      clientId: 'public-client-id',
      authorizationParams: {
        redirect_uri: 'https://app.example.test/auth/callback',
        audience: 'https://api.example.test',
        scope: 'openid profile email phone',
        customParams: JSON.stringify({ walletApiKey: 'publishable-api-key' }),
      },
      cacheLocation: 'memory',
    })
    expect(auth0.socialProviders).toEqual(['Google'])
    expect(Object.isFrozen(auth0.socialProviders)).toBe(true)

    await expect(auth0.auth.signInWithSocial?.('Google')).resolves.toEqual({
      accessToken: 'api-access-token',
      identityKey: 'auth0|stable-user',
    })
    expect(auth0Mocks.loginWithPopup).toHaveBeenCalledWith({
      authorizationParams: {
        connection: 'google-oauth2',
        audience: 'https://api.example.test',
        scope: 'openid profile email phone',
        customParams: JSON.stringify({ walletApiKey: 'publishable-api-key' }),
      },
    })
    expect(auth0Mocks.getTokenSilently).toHaveBeenCalledWith({
      authorizationParams: {
        connection: 'google-oauth2',
        audience: 'https://api.example.test',
        scope: 'openid profile email phone',
        customParams: JSON.stringify({ walletApiKey: 'publishable-api-key' }),
      },
    })
  })

  it('rejects a blank client-safe API key before creating the Auth0 client', async () => {
    await expect(
      createAuth0WalletAuth({
        domain: 'example.auth0.com',
        clientId: 'public-client-id',
        apiKey: '  ',
        audience: 'https://api.example.test',
      }),
    ).rejects.toThrow('A client-safe Altude API key is required.')
    expect(auth0Mocks.createAuth0Client).not.toHaveBeenCalled()
  })

  it('uses configured hosted passwordless connections with an identifier hint', async () => {
    const auth0 = await createAuth0WalletAuth({
      domain: 'example.auth0.com',
      clientId: 'public-client-id',
      apiKey: 'publishable-api-key',
      audience: 'https://api.example.test',
      otpConnections: { email: 'email-custom', sms: 'sms-custom' },
    })

    expect(auth0.auth.supportsOtpChannel?.('email')).toBe(true)
    expect(auth0.auth.supportsOtpChannel?.('sms')).toBe(true)
    await expect(auth0.auth.signInWithOtp?.('sms', ' +12025550123 ')).resolves.toEqual({
      accessToken: 'api-access-token',
      identityKey: 'auth0|stable-user',
    })
    expect(auth0Mocks.loginWithPopup).toHaveBeenCalledWith({
      authorizationParams: {
        connection: 'sms-custom',
        audience: 'https://api.example.test',
        scope: 'openid profile email phone',
        customParams: JSON.stringify({ walletApiKey: 'publishable-api-key' }),
        login_hint: '+12025550123',
      },
    })
  })

  it('allows an OTP channel to be disabled without changing the other default', async () => {
    const auth0 = await createAuth0WalletAuth({
      domain: 'example.auth0.com',
      clientId: 'public-client-id',
      apiKey: 'publishable-api-key',
      audience: 'https://api.example.test',
      otpConnections: { sms: null },
    })

    expect(auth0.auth.supportsOtpChannel?.('email')).toBe(true)
    expect(auth0.auth.supportsOtpChannel?.('sms')).toBe(false)
    await expect(auth0.auth.signInWithOtp?.('sms', '+12025550123')).rejects.toThrow(
      'No Auth0 sms passwordless connection is configured.',
    )
    expect(auth0Mocks.loginWithPopup).not.toHaveBeenCalled()
  })

  it('rejects an empty identifier before starting hosted authentication', async () => {
    const auth0 = await createAuth0WalletAuth({
      domain: 'example.auth0.com',
      clientId: 'public-client-id',
      apiKey: 'publishable-api-key',
      audience: 'https://api.example.test',
    })

    await expect(auth0.auth.signInWithOtp?.('email', '  ')).rejects.toThrow(
      'Enter an email address.',
    )
    expect(auth0Mocks.loginWithPopup).not.toHaveBeenCalled()
  })

  const invalidConfigurations: Array<[string, Partial<Auth0WalletAuthOptions>]> = [
    ['scheme in domain', { domain: 'https://example.auth0.com' }],
    ['path in domain', { domain: 'example.auth0.com/path' }],
    ['missing client ID', { clientId: ' ' }],
    ['missing audience', { audience: ' ' }],
    ['missing OIDC scope', { scope: 'profile email' }],
    ['empty connection name', { connections: { ' ': 'google' } }],
    ['empty provider connection', { connections: { Google: ' ' } }],
  ]

  it.each(invalidConfigurations)('rejects invalid configuration: %s', async (_label, override) => {
    await expect(
      createAuth0WalletAuth({
        domain: 'example.auth0.com',
        clientId: 'public-client-id',
        apiKey: 'publishable-api-key',
        audience: 'https://api.example.test',
        connections: {},
        ...override,
      }),
    ).rejects.toThrow()
    expect(auth0Mocks.createAuth0Client).not.toHaveBeenCalled()
  })

  it('rejects a missing API-audience token or stable Auth0 subject', async () => {
    const auth0 = await createAuth0WalletAuth({
      domain: 'example.auth0.com',
      clientId: 'public-client-id',
      apiKey: 'publishable-api-key',
      audience: 'https://api.example.test',
    })

    auth0Mocks.getTokenSilently.mockResolvedValueOnce('')
    await expect(auth0.auth.signInWithOtp?.('email', 'user@example.test')).rejects.toThrow(
      'Auth0 did not return an API-audience access token.',
    )
    auth0Mocks.getUser.mockResolvedValueOnce({})
    await expect(auth0.auth.signInWithOtp?.('email', 'user@example.test')).rejects.toThrow(
      'Auth0 did not return a stable user identifier.',
    )
  })
})
