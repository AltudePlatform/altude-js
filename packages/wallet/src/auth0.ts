import { createAuth0Client } from '@auth0/auth0-spa-js'
import { WebAuth } from 'auth0-js'
import type {
  Auth0Callback,
  Auth0DecodedHash,
  Auth0Error,
  Auth0UserProfile,
  PasswordlessLoginOptions,
} from 'auth0-js'
import type { WalletAuthProvider } from './types.js'

export interface Auth0WalletAuthOptions {
  /** Auth0 tenant domain, without a scheme (for example, `tenant.auth0.com`). */
  domain: string
  /** Auth0 Single Page Application client ID. */
  clientId: string
  /**
   * Client-safe Altude API key forwarded in Auth0 authorization parameters.
   * Never use a server secret.
   */
  apiKey: string
  /** API identifier configured in Auth0 and accepted by the Altude API. */
  audience: string
  /** Display names mapped to enabled Auth0 connections, such as `{ Google: 'google-oauth2' }`. */
  connections?: Readonly<Record<string, string>>
  /** Auth0 passwordless connections; defaults to `{ email: 'email', sms: 'sms' }`. Set a channel to `null` to disable it. */
  otpConnections?: Partial<Record<'email' | 'sms', string | null>>
  /** Defaults to the current origin. Register it in Auth0 Allowed Callback URLs and Web Origins. */
  redirectUri?: string
  /** Defaults to the OIDC scopes needed for profile identity and phone-enabled login. */
  scope?: string
}

export interface Auth0WalletAuth {
  auth: WalletAuthProvider
  socialProviders: readonly string[]
}

/**
 * Creates a browser Auth0 SPA adapter for the existing API-validated wallet
 * session flow. This does not use the native callback broker.
 */
export async function createAuth0WalletAuth(
  options: Auth0WalletAuthOptions,
): Promise<Auth0WalletAuth> {
  const domain = normalizeDomain(options.domain)
  const clientId = options.clientId.trim()
  const apiKey = options.apiKey
  const audience = options.audience.trim()
  const scope = options.scope?.trim() || 'openid profile email phone'
  const connections = normalizeConnections(options.connections ?? {})
  const otpConnections = {
    email: normalizeOtpConnection(options.otpConnections?.email, 'email'),
    sms: normalizeOtpConnection(options.otpConnections?.sms, 'sms'),
  }

  if (!clientId) throw new Error('An Auth0 SPA client ID is required.')
  if (!apiKey.trim()) throw new Error('A client-safe Altude API key is required.')
  if (!audience) throw new Error('An Auth0 API audience is required.')
  if (!scope.split(/\s+/).includes('openid')) {
    throw new Error('The Auth0 scope must include openid to return a stable user identifier.')
  }

  const redirectUri = options.redirectUri ?? window.location.origin
  const customParams = JSON.stringify({ walletApiKey: apiKey })
  const client = await createAuth0Client({
    domain,
    clientId,
    authorizationParams: {
      redirect_uri: redirectUri,
      audience,
      scope,
      customParams: JSON.stringify({ walletApiKey: apiKey }),
    },
    cacheLocation: 'memory',
  })
  const passwordless = new WebAuth({
    domain,
    clientID: clientId,
    redirectUri,
    audience,
    scope,
    responseType: 'token id_token',
  })

  const otpParameters = (channel: 'email' | 'sms', identifier: string) => {
    const connection = otpConnections[channel]
    if (!connection) {
      throw new Error(`No Auth0 ${channel} passwordless connection is configured.`)
    }
    const value = identifier.trim()
    if (channel === 'email') {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
        throw new Error('Enter an email address.')
      }
      return { connection, email: value }
    }
    const phoneNumber = value.replace(/[\s().-]/g, '')
    if (!/^\+[1-9]\d{6,14}$/.test(phoneNumber)) {
      throw new Error('Enter a phone number including its country code.')
    }
    return { connection, phoneNumber }
  }

  const signIn = async (
    connection: string,
  ): Promise<{ accessToken: string; identityKey: string }> => {
    const authorizationParams = {
      connection,
      audience,
      scope,
      customParams: JSON.stringify({ walletApiKey: apiKey }),
    }
    await client.loginWithPopup({ authorizationParams })
    const accessToken = await client.getTokenSilently({ authorizationParams })
    const user = await client.getUser()
    if (!accessToken) {
      throw new Error('Auth0 did not return an API-audience access token.')
    }
    if (!user?.sub?.trim()) {
      throw new Error('Auth0 did not return a stable user identifier.')
    }
    return { accessToken, identityKey: user.sub }
  }

  return {
    socialProviders: Object.freeze(Object.keys(connections)),
    auth: {
      supportsOtpChannel(channel) {
        return Boolean(otpConnections[channel])
      },
      async startOtp(channel, identifier) {
        const parameters = otpParameters(channel, identifier)
        const authParams = { audience, scope, customParams }
        await passwordlessRequest<unknown>((callback) => {
          passwordless.passwordlessStart({ ...parameters, send: 'code', authParams }, callback)
        })
      },
      async verifyOtp(channel, identifier, code) {
        const parameters = otpParameters(channel, identifier)
        const verificationCode = code.trim()
        if (!verificationCode) throw new Error('Enter the verification code.')
        // Auth0.js uses a hidden web_message iframe for popup:true in this flow,
        // not a visible popup or redirect. It validates OAuth state and ID-token nonce.
        const loginOptions: PasswordlessLoginOptions & {
          popup: true
          customParams: string
        } = {
          ...parameters,
          verificationCode,
          audience,
          scope,
          customParams,
          popup: true,
        }
        const result = await passwordlessRequest<Auth0DecodedHash | null>((callback) => {
          passwordless.passwordlessLogin(loginOptions, callback)
        })
        if (!result?.accessToken?.trim()) {
          throw new Error('Auth0 did not return an API-audience access token.')
        }
        const accessToken = result.accessToken
        const user = await passwordlessRequest<Partial<Pick<Auth0UserProfile, 'sub'>> | null>(
          (callback) => {
            passwordless.client.userInfo(accessToken, callback)
          },
        )
        if (!user?.sub?.trim()) {
          throw new Error('Auth0 did not return a stable user identifier.')
        }
        return { accessToken, identityKey: user.sub }
      },
      async signInWithSocial(provider) {
        const connection = connections[provider]
        if (!connection) {
          throw new Error(`No Auth0 connection is configured for ${provider}.`)
        }
        return signIn(connection)
      },
    },
  }
}

function passwordlessRequest<T>(request: (callback: Auth0Callback<T>) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    request((error, result) => {
      if (error) reject(passwordlessError(error))
      else resolve(result)
    })
  })
}

function passwordlessError(error: Auth0Error): Error {
  switch (error.code ?? error.error) {
    case 'too_many_attempts':
    case 'too_many_requests':
      return new Error('Too many verification attempts. Wait a few minutes and try again.')
    case 'invalid_password':
    case 'invalid_grant':
    case 'unauthorized':
      return new Error('The verification code is invalid or expired. Request a new code.')
    case 'timeout':
    case 'login_required':
    case 'origin_mismatch':
    case 'unauthorized_client':
    case 'access_denied':
    case 'consent_required':
      return new Error(
        'Auth0 could not complete embedded sign-in. Check the passwordless connection, allowed origins, consent, and browser cookie settings.',
      )
    default:
      return new Error(
        'Auth0 passwordless sign-in failed. Try again or check the Auth0 configuration.',
      )
  }
}

function normalizeDomain(value: string): string {
  const domain = value.trim()
  if (!domain || domain.includes('://')) {
    throw new Error('Enter the Auth0 domain without a URL scheme.')
  }

  let parsed: URL
  try {
    parsed = new URL(`https://${domain}`)
  } catch {
    throw new Error('Enter a valid Auth0 domain without a URL scheme.')
  }
  if (
    parsed.hostname.length === 0 ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error('Enter an Auth0 domain without a path, credentials, query, or fragment.')
  }
  return parsed.host
}

function normalizeConnections(
  input: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const connections: Record<string, string> = {}
  for (const [rawProvider, rawConnection] of Object.entries(input)) {
    const provider = rawProvider.trim()
    const connection = rawConnection.trim()
    if (!provider || !connection) {
      throw new Error('Auth0 provider names and connection names must not be empty.')
    }
    if (Object.hasOwn(connections, provider)) {
      throw new Error(`Duplicate Auth0 provider name: ${provider}.`)
    }
    connections[provider] = connection
  }
  return Object.freeze(connections)
}

function normalizeOtpConnection(value: string | null | undefined, channel: 'email' | 'sms') {
  if (value === null) return undefined
  const connection = value?.trim() ?? channel
  return connection || undefined
}
