import { randomBytes, toArrayBuffer } from './crypto.js'
import { AltudeWalletError } from './errors.js'
import type { OtpChannel, WalletAuthProvider, WalletIdentityToken } from './types.js'

export interface BrowserWalletAuthOptions {
  apiKey: string
  apiBaseUrl: string
  fetch?: typeof fetch
}

export interface BrowserWalletAuth {
  auth: WalletAuthProvider
  socialProviders: readonly string[]
}

interface Attempt {
  state: string
  verifier: string
  challenge: string
}

interface OtpAttempt extends Attempt {
  channel: OtpChannel
  identifier: string
  challengeId: string
}

const PATH = '/api/browser-wallet'
const POPUP_TIMEOUT = 120_000

/** Uses the Altude confidential browser broker; Auth0 credentials remain server-side. */
export async function createBrowserWalletAuth(
  options: BrowserWalletAuthOptions,
): Promise<BrowserWalletAuth> {
  const apiKey = options.apiKey.trim()
  if (!apiKey) throw new AltudeWalletError('CONFIGURATION', 'An Altude API key is required.')
  const baseUrl = secureUrl(options.apiBaseUrl)
  const requestUrl = baseUrl.toString().replace(/\/$/, '')
  const fetchImpl = options.fetch ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') {
    throw new AltudeWalletError(
      'CONFIGURATION',
      'Fetch is not available. Provide a fetch implementation.',
    )
  }
  let busy = false
  let pendingOtp: OtpAttempt | undefined

  const request = async (path: string, body?: Record<string, unknown>) => {
    let response: Response
    try {
      response = await fetchImpl(`${requestUrl}${PATH}${path}`, {
        method: body ? 'POST' : 'GET',
        headers: {
          Accept: 'application/json',
          'X-API-Key': apiKey,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      })
    } catch (error) {
      throw new AltudeWalletError(
        'API',
        'Could not reach the browser wallet broker. Check the API URL, enrolled origin, CORS configuration, and network connection.',
        undefined,
        error,
      )
    }
    if (!response.ok) {
      const remediation =
        response.status === 403
          ? 'Check the API key and enroll this exact browser origin in the broker configuration.'
          : response.status === 429
            ? 'Too many attempts. Wait before trying again.'
            : response.status === 400 || response.status === 401
              ? 'The code or sign-in request is invalid or expired. Request a new code.'
              : 'Check the browser broker deployment and server-side Auth0 configuration.'
      throw new AltudeWalletError(
        'AUTHENTICATION',
        `Browser wallet sign-in failed (HTTP ${String(response.status)}). ${remediation}`,
        response.status,
      )
    }
    let data: unknown
    try {
      data = await response.json()
    } catch (error) {
      throw new AltudeWalletError(
        'INVALID_RESPONSE',
        'The browser broker returned invalid JSON.',
        undefined,
        error,
      )
    }
    if (!isObject(data)) throw invalidResponse()
    return data
  }
  const config = await request('/config')
  const providers = config['SocialProviders']
  if (
    typeof config['AppId'] !== 'string' ||
    !config['AppId'].trim() ||
    typeof config['EmailOtp'] !== 'boolean' ||
    typeof config['SmsOtp'] !== 'boolean' ||
    !isStringArray(providers)
  )
    throw invalidResponse()
  const socialProviders = Object.freeze([...new Set(providers)])
  const enabled = { email: config['EmailOtp'], sms: config['SmsOtp'] }

  const exclusive = async <T>(operation: () => Promise<T>): Promise<T> => {
    if (busy)
      throw new AltudeWalletError(
        'AUTHENTICATION',
        'Another browser sign-in operation is in progress.',
      )
    busy = true
    try {
      return await operation()
    } finally {
      busy = false
    }
  }
  const redeem = async (
    data: Record<string, unknown>,
    attempt: Attempt,
  ): Promise<WalletIdentityToken> => {
    if (data['State'] !== attempt.state) {
      throw new AltudeWalletError('AUTHENTICATION', 'The browser sign-in state did not match.')
    }
    const code = requiredString(data, 'Code')
    const identity = await request('/redeem', { Code: code, CodeVerifier: attempt.verifier })
    if (typeof identity['ExpiresIn'] !== 'number' || identity['ExpiresIn'] <= 0)
      throw invalidResponse()
    return {
      identityKey: requiredString(identity, 'IdentityKey'),
      broker: { identityTicket: requiredString(identity, 'IdentityTicket') },
    }
  }

  return {
    socialProviders,
    auth: {
      supportsOtpChannel: (channel) => enabled[channel],
      startOtp: (channel, identifier) =>
        exclusive(async () => {
          if (!enabled[channel]) {
            throw new AltudeWalletError(
              'AUTHENTICATION',
              `Browser broker ${channel} sign-in is disabled.`,
            )
          }
          pendingOtp = undefined
          const value = normalizeIdentifier(channel, identifier)
          const attempt = await createAttempt()
          const data = await request('/otp/start', {
            Method: channel,
            Identifier: value,
            State: attempt.state,
            CodeChallenge: attempt.challenge,
            CodeChallengeMethod: 'S256',
          })
          if (typeof data['ExpiresIn'] !== 'number' || data['ExpiresIn'] <= 0)
            throw invalidResponse()
          pendingOtp = {
            ...attempt,
            channel,
            identifier: value,
            challengeId: requiredString(data, 'ChallengeId'),
          }
        }),
      verifyOtp: (channel, identifier, code) =>
        exclusive(async () => {
          const attempt = pendingOtp
          if (
            !attempt ||
            attempt.channel !== channel ||
            attempt.identifier !== normalizeIdentifier(channel, identifier)
          ) {
            throw new AltudeWalletError(
              'AUTHENTICATION',
              'Request a code for this identifier before verifying.',
            )
          }
          if (!/^[0-9]{6}$/.test(code.trim())) {
            throw new AltudeWalletError('INVALID_INPUT', 'Enter the six-digit verification code.')
          }
          // The broker consumes each challenge before verification, including failed attempts.
          pendingOtp = undefined
          let data: Record<string, unknown>
          try {
            data = await request('/otp/verify', {
              ChallengeId: attempt.challengeId,
              Code: code.trim(),
            })
          } catch (error) {
            throw new AltudeWalletError(
              'AUTHENTICATION',
              error instanceof AltudeWalletError && error.status === 429
                ? 'Too many verification attempts. Wait before using Resend code to request a new code.'
                : 'Code verification failed. Use Resend code to request a new code before trying again.',
              error instanceof AltudeWalletError ? error.status : undefined,
              error,
            )
          }
          return redeem(data, attempt)
        }),
      signInWithSocial: (provider) =>
        exclusive(async () => {
          if (!socialProviders.includes(provider)) {
            throw new AltudeWalletError(
              'AUTHENTICATION',
              'This social provider is not enabled by the browser broker.',
            )
          }
          // Open synchronously within the user's click before awaiting network or PKCE work.
          const popup = window.open('about:blank', '_blank', 'popup,width=500,height=680')
          if (!popup)
            throw new AltudeWalletError('AUTHENTICATION', 'Allow popups to continue signing in.')
          try {
            const attempt = await createAttempt()
            const data = await request('/authorize', {
              Provider: provider,
              State: attempt.state,
              CodeChallenge: attempt.challenge,
              CodeChallengeMethod: 'S256',
            })
            const authorizationUrl = secureUrl(requiredString(data, 'AuthorizationUrl'), true)
            requiredString(data, 'TransactionId')
            const result = await waitForAuthorization(
              popup,
              baseUrl.origin,
              attempt.state,
              authorizationUrl.toString(),
            )
            return await redeem(result, attempt)
          } finally {
            popup.close()
          }
        }),
    },
  }
}

function waitForAuthorization(
  popup: Window,
  origin: string,
  state: string,
  url: string,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      window.removeEventListener('message', onMessage)
      window.clearTimeout(timeout)
      window.clearInterval(closed)
    }
    const onMessage = (event: MessageEvent<unknown>) => {
      if (event.origin !== origin || event.source !== popup || !isObject(event.data)) return
      if (event.data['Type'] !== 'altude:wallet:authorization') return
      cleanup()
      if (event.data['State'] !== state) {
        reject(new AltudeWalletError('AUTHENTICATION', 'The browser sign-in state did not match.'))
      } else if (typeof event.data['Code'] !== 'string' || !event.data['Code'].trim()) {
        reject(
          new AltudeWalletError('AUTHENTICATION', 'The browser broker did not complete sign-in.'),
        )
      } else {
        resolve(event.data)
      }
    }
    const timeout = window.setTimeout(() => {
      cleanup()
      reject(new AltudeWalletError('AUTHENTICATION', 'Browser sign-in timed out. Try again.'))
    }, POPUP_TIMEOUT)
    const closed = window.setInterval(() => {
      if (!popup.closed) return
      cleanup()
      reject(new AltudeWalletError('AUTHENTICATION', 'Browser sign-in was cancelled.'))
    }, 250)
    window.addEventListener('message', onMessage)
    try {
      popup.location.href = url
    } catch (error) {
      cleanup()
      reject(
        new AltudeWalletError(
          'AUTHENTICATION',
          'Could not open the browser sign-in page.',
          undefined,
          error,
        ),
      )
    }
  })
}

async function createAttempt(): Promise<Attempt> {
  const state = base64Url(randomBytes(globalThis.crypto, 32))
  const verifier = base64Url(randomBytes(globalThis.crypto, 32))
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    toArrayBuffer(new TextEncoder().encode(verifier)),
  )
  return { state, verifier, challenge: base64Url(new Uint8Array(digest)) }
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

function normalizeIdentifier(channel: OtpChannel, identifier: string): string {
  const value = channel === 'email' ? identifier.trim() : identifier.trim().replace(/[\s().-]/g, '')
  if (
    !(channel === 'email'
      ? /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
      : /^\+[1-9]\d{6,14}$/.test(value))
  ) {
    throw new AltudeWalletError(
      'INVALID_INPUT',
      channel === 'email'
        ? 'Enter an email address.'
        : 'Enter a phone number including its country code.',
    )
  }
  return value
}

function secureUrl(value: string, allowQuery = false): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new AltudeWalletError(
      'CONFIGURATION',
      'The browser broker requires an absolute secure HTTP(S) URL.',
    )
  }
  if (
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) ||
    url.username ||
    url.password ||
    (!allowQuery && url.search) ||
    url.hash
  )
    throw new AltudeWalletError(
      'CONFIGURATION',
      'The browser broker requires a secure HTTP(S) URL without credentials, query, or fragment.',
    )
  return url
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item: unknown) => typeof item === 'string' && Boolean(item.trim()))
  )
}

function requiredString(data: Record<string, unknown>, key: string): string {
  const value = data[key]
  if (typeof value !== 'string' || !value.trim()) throw invalidResponse()
  return value
}

function invalidResponse(): AltudeWalletError {
  return new AltudeWalletError(
    'INVALID_RESPONSE',
    'The browser broker returned an invalid response.',
  )
}
