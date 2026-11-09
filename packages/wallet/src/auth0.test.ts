// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Auth0WalletAuthOptions } from './auth0.js'

type PasswordlessRequest = (
  options: unknown,
  callback: (error: unknown, result?: unknown) => void,
) => void

const auth0Mocks = vi.hoisted(() => ({
  createAuth0Client: vi.fn(),
  loginWithPopup: vi.fn(),
  getTokenSilently: vi.fn(),
  getUser: vi.fn(),
  webAuth: vi.fn(),
  passwordlessStart: vi.fn<PasswordlessRequest>(),
  passwordlessLogin: vi.fn<PasswordlessRequest>(),
  userInfo: vi.fn<PasswordlessRequest>(),
}))

vi.mock('@auth0/auth0-spa-js', () => ({
  createAuth0Client: auth0Mocks.createAuth0Client,
}))
vi.mock('auth0-js', () => ({
  WebAuth: auth0Mocks.webAuth,
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
    auth0Mocks.webAuth.mockImplementation(() => ({
      passwordlessStart: auth0Mocks.passwordlessStart,
      passwordlessLogin: auth0Mocks.passwordlessLogin,
      client: { userInfo: auth0Mocks.userInfo },
    }))
    auth0Mocks.passwordlessStart.mockImplementation((_options, callback) => {
      callback(null, {})
    })
    auth0Mocks.passwordlessLogin.mockImplementation((_options, callback) => {
      callback(null, { accessToken: 'otp-access-token' })
    })
    auth0Mocks.userInfo.mockImplementation((_token, callback) => {
      callback(null, { sub: 'email|stable-user' })
    })
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

  it.each([
    ['email', ' user@example.test ', { email: 'user@example.test' }],
    ['sms', ' +1 (202) 555-0123 ', { phoneNumber: '+12025550123' }],
  ] as const)(
    'uses embedded %s code entry without hosted login',
    async (channel, identifier, contact) => {
      const auth0 = await createAuth0WalletAuth({
        domain: 'example.auth0.com',
        clientId: 'public-client-id',
        apiKey: 'publishable-api-key',
        audience: 'https://api.example.test',
        otpConnections: { email: 'email-custom', sms: 'sms-custom' },
      })

      expect(auth0.auth.supportsOtpChannel?.('email')).toBe(true)
      expect(auth0.auth.supportsOtpChannel?.('sms')).toBe(true)
      expect('signInWithOtp' in auth0.auth).toBe(false)
      await auth0.auth.startOtp?.(channel, identifier)
      expect(auth0Mocks.passwordlessStart).toHaveBeenCalledWith(
        {
          connection: `${channel}-custom`,
          ...contact,
          send: 'code',
          authParams: {
            audience: 'https://api.example.test',
            scope: 'openid profile email phone',
            customParams: JSON.stringify({ walletApiKey: 'publishable-api-key' }),
          },
        },
        expect.any(Function),
      )
      await expect(auth0.auth.verifyOtp?.(channel, identifier, ' 246810 ')).resolves.toEqual({
        accessToken: 'otp-access-token',
        identityKey: 'email|stable-user',
      })
      expect(auth0Mocks.passwordlessLogin).toHaveBeenCalledWith(
        {
          connection: `${channel}-custom`,
          ...contact,
          verificationCode: '246810',
          audience: 'https://api.example.test',
          scope: 'openid profile email phone',
          customParams: JSON.stringify({ walletApiKey: 'publishable-api-key' }),
          popup: true,
        },
        expect.any(Function),
      )
      expect(auth0Mocks.userInfo).toHaveBeenCalledWith('otp-access-token', expect.any(Function))
      expect(auth0Mocks.loginWithPopup).not.toHaveBeenCalled()
      expect(auth0Mocks.getTokenSilently).not.toHaveBeenCalled()
    },
  )

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
    await expect(auth0.auth.startOtp?.('sms', '+12025550123')).rejects.toThrow(
      'No Auth0 sms passwordless connection is configured.',
    )
    expect(auth0Mocks.loginWithPopup).not.toHaveBeenCalled()
  })

  it('rejects invalid identifiers and blank codes before contacting Auth0', async () => {
    const auth0 = await createAuth0WalletAuth({
      domain: 'example.auth0.com',
      clientId: 'public-client-id',
      apiKey: 'publishable-api-key',
      audience: 'https://api.example.test',
    })

    await expect(auth0.auth.startOtp?.('email', '  ')).rejects.toThrow('Enter an email address.')
    await expect(auth0.auth.startOtp?.('sms', '2025550123')).rejects.toThrow(
      'Enter a phone number including its country code.',
    )
    await expect(auth0.auth.verifyOtp?.('email', 'user@example.test', ' ')).rejects.toThrow(
      'Enter the verification code.',
    )
    expect(auth0Mocks.passwordlessStart).not.toHaveBeenCalled()
    expect(auth0Mocks.passwordlessLogin).not.toHaveBeenCalled()
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
      connections: { Google: 'google-oauth2' },
    })

    auth0Mocks.getTokenSilently.mockResolvedValueOnce('')
    await expect(auth0.auth.signInWithSocial?.('Google')).rejects.toThrow(
      'Auth0 did not return an API-audience access token.',
    )
    auth0Mocks.getUser.mockResolvedValueOnce({})
    await expect(auth0.auth.signInWithSocial?.('Google')).rejects.toThrow(
      'Auth0 did not return a stable user identifier.',
    )
  })

  it('rejects incomplete OTP token and identity responses', async () => {
    const { auth } = await createAuth0WalletAuth({
      domain: 'example.auth0.com',
      clientId: 'public-client-id',
      apiKey: 'publishable-api-key',
      audience: 'https://api.example.test',
    })
    auth0Mocks.passwordlessLogin.mockImplementationOnce((_options, callback) => {
      callback(null, null)
    })
    await expect(auth.verifyOtp?.('email', 'user@example.test', '123456')).rejects.toThrow(
      'Auth0 did not return an API-audience access token.',
    )
    auth0Mocks.userInfo.mockImplementationOnce((_token, callback) => {
      callback(null, {})
    })
    await expect(auth.verifyOtp?.('email', 'user@example.test', '123456')).rejects.toThrow(
      'Auth0 did not return a stable user identifier.',
    )
  })

  it.each(['start', 'verify', 'profile'])(
    'surfaces %s errors without leaking Auth0 response details',
    async (stage) => {
      const { auth } = await createAuth0WalletAuth({
        domain: 'example.auth0.com',
        clientId: 'public-client-id',
        apiKey: 'publishable-api-key',
        audience: 'https://api.example.test',
      })
      const mock =
        stage === 'start'
          ? auth0Mocks.passwordlessStart
          : stage === 'verify'
            ? auth0Mocks.passwordlessLogin
            : auth0Mocks.userInfo
      mock.mockImplementationOnce((_input, callback) => {
        callback({ error: 'request_error', error_description: 'sensitive-response' })
      })
      const operation =
        stage === 'start'
          ? auth.startOtp?.('email', 'user@example.test')
          : auth.verifyOtp?.('email', 'user@example.test', '123456')
      await expect(operation).rejects.toThrow('Auth0 passwordless sign-in failed.')
      expect(auth0Mocks.loginWithPopup).not.toHaveBeenCalled()
    },
  )
})
