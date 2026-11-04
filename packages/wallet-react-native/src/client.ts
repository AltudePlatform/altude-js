import { NativeWalletError } from './errors.js'
import { createPkcePair, createState } from './crypto.js'
import type {
  NativeAuthBrowser,
  NativeBrowserResult,
  RandomBytesSource,
  RefreshTokenStore,
} from './platform.js'

export interface NativeWalletBrokerConfig {
  appId: string
  nativeScheme: string
  issuer: string
  audience: string
  authorizationUrl: string
  jwksUrl: string
}

export interface NativeWalletSession {
  accessToken: string
  expiresAt: number
  tokenType: 'Bearer'
}

export interface NativeWalletClientOptions {
  apiKey: string
  apiBaseUrl: string
  browser: NativeAuthBrowser
  refreshTokenStore: RefreshTokenStore
  randomBytes: RandomBytesSource
  fetch?: typeof fetch
  now?: () => number
  onSignedOut?: () => void | Promise<void>
}

interface TokenResponse {
  AccessToken: string
  RefreshToken: string
  ExpiresIn: number
  TokenType: 'Bearer'
}

interface ParsedUrl {
  protocol: string
  authority: string
  path: string
  query: string | null
  fragment: string | null
}

const API_PATH = '/api/native-wallet'

export class NativeWalletClient {
  readonly #apiKey: string
  readonly #apiBaseUrl: string
  readonly #apiOrigin: string
  readonly #browser: NativeAuthBrowser
  readonly #refreshTokenStore: RefreshTokenStore
  readonly #randomBytes: RandomBytesSource
  readonly #fetch: typeof fetch
  readonly #now: () => number
  readonly #onSignedOut: (() => void | Promise<void>) | undefined
  #configPromise: Promise<NativeWalletBrokerConfig> | undefined
  #accessToken: string | undefined
  #expiresAt = 0
  #loginPending = false
  #refreshPromise: Promise<NativeWalletSession | null> | undefined
  #generation = 0

  constructor(options: NativeWalletClientOptions) {
    if (!options.apiKey.trim()) {
      throw new NativeWalletError('CONFIGURATION', 'An existing Altude API key is required.')
    }
    const apiUrl = parseHttpUrl(options.apiBaseUrl)
    if (
      !apiUrl ||
      apiUrl.query !== null ||
      apiUrl.fragment !== null ||
      !isValidAuthority(apiUrl.authority) ||
      !isSecureProtocol(apiUrl.protocol, apiUrl.authority)
    ) {
      throw new NativeWalletError(
        'CONFIGURATION',
        'apiBaseUrl must be an absolute secure HTTP(S) URL without credentials, query, or fragment.',
      )
    }
    if (
      typeof options.browser.openAuthSession !== 'function' ||
      typeof options.refreshTokenStore.set !== 'function' ||
      typeof options.refreshTokenStore.remove !== 'function' ||
      typeof options.refreshTokenStore.get !== 'function' ||
      typeof options.randomBytes !== 'function'
    ) {
      throw new NativeWalletError(
        'CONFIGURATION',
        'A system browser, protected refresh-token store, and secure random source are required.',
      )
    }

    const normalizedOrigin = `${apiUrl.protocol.toLowerCase()}//${apiUrl.authority.toLowerCase()}`
    const basePath = apiUrl.path.replace(/\/+$/, '')
    const fetchImpl = options.fetch ?? globalThis.fetch
    if (typeof fetchImpl !== 'function') {
      throw new NativeWalletError(
        'CONFIGURATION',
        'Fetch is unavailable. Provide a fetch implementation for this React Native runtime.',
      )
    }

    this.#apiKey = options.apiKey
    this.#apiBaseUrl = `${normalizedOrigin}${basePath}`
    this.#apiOrigin = normalizedOrigin
    this.#browser = options.browser
    this.#refreshTokenStore = options.refreshTokenStore
    this.#randomBytes = options.randomBytes
    this.#fetch = fetchImpl.bind(globalThis)
    this.#now = options.now ?? Date.now
    this.#onSignedOut = options.onSignedOut
  }

  async getBrokerConfig(): Promise<NativeWalletBrokerConfig> {
    if (!this.#configPromise) {
      this.#configPromise = this.#fetchBrokerConfig().catch((error: unknown) => {
        this.#configPromise = undefined
        throw error
      })
    }
    return this.#configPromise
  }

  async signIn(): Promise<NativeWalletSession> {
    if (this.#loginPending || this.#refreshPromise) {
      throw new NativeWalletError(
        'CONCURRENT_OPERATION',
        'Another native wallet authentication operation is already in progress.',
      )
    }

    this.#loginPending = true
    const generation = ++this.#generation
    try {
      const config = await this.getBrokerConfig()
      this.#assertCurrentGeneration(generation)
      const state = createState(this.#randomBytes)
      const pkce = createPkcePair(this.#randomBytes)
      const redirectUrl = `${config.nativeScheme}://callback`
      const authorizationUrl = appendAuthorizationParameters(config.authorizationUrl, {
        app_id: config.appId,
        state,
        code_challenge: pkce.challenge,
        code_challenge_method: 'S256',
      })

      const result = await this.#openBrowser(authorizationUrl, redirectUrl)
      this.#assertCurrentGeneration(generation)
      if (result.type === 'cancel' || result.type === 'dismiss') {
        throw new NativeWalletError('CANCELLED', 'Native wallet sign-in was cancelled.')
      }

      const code = parseCallback(result.url, redirectUrl, state)
      const token = parseTokenResponse(
        await this.#request(`${API_PATH}/token`, {
          method: 'POST',
          body: {
            AppId: config.appId,
            Code: code,
            CodeVerifier: pkce.verifier,
          },
        }),
      )
      if (generation !== this.#generation) {
        await this.#discardLateToken(config.appId, token.RefreshToken)
        throw new NativeWalletError(
          'SESSION',
          'The native wallet sign-in was superseded before it completed.',
        )
      }
      await this.#persistRefreshToken(config.appId, token.RefreshToken, token.RefreshToken)
      if (generation !== this.#generation) {
        await this.#discardLateToken(config.appId, token.RefreshToken)
        throw new NativeWalletError(
          'SESSION',
          'The native wallet sign-in was superseded before it completed.',
        )
      }
      return this.#setSession(token)
    } finally {
      this.#loginPending = false
    }
  }

  async restoreSession(): Promise<NativeWalletSession | null> {
    return this.refreshSession()
  }

  async refreshSession(): Promise<NativeWalletSession | null> {
    if (this.#loginPending) {
      throw new NativeWalletError(
        'CONCURRENT_OPERATION',
        'A native wallet sign-in attempt is already in progress.',
      )
    }
    if (this.#refreshPromise) return this.#refreshPromise
    const generation = this.#generation
    const refresh = this.#restoreAndRefresh(generation)
    this.#refreshPromise = refresh
    try {
      return await refresh
    } finally {
      if (this.#refreshPromise === refresh) this.#refreshPromise = undefined
    }
  }

  async getAccessToken(): Promise<string | null> {
    if (this.#accessToken && this.#expiresAt > this.#now()) return this.#accessToken
    const session = await this.refreshSession()
    return session?.accessToken ?? null
  }

  async signOut(): Promise<void> {
    this.#generation += 1
    this.#accessToken = undefined
    this.#expiresAt = 0
    let config: NativeWalletBrokerConfig | undefined
    let refreshToken: string | null = null
    let configFailure: unknown
    let revokeFailure: unknown
    let storageFailure: unknown
    let callbackFailure: unknown

    try {
      config = await this.getBrokerConfig()
    } catch (error) {
      configFailure = error
    }
    if (config) {
      try {
        refreshToken = await this.#refreshTokenStore.get(config.appId)
      } catch (error) {
        revokeFailure = error
      }
      if (refreshToken) {
        try {
          await this.#request(`${API_PATH}/revoke`, {
            method: 'POST',
            body: { AppId: config.appId, RefreshToken: refreshToken },
          })
        } catch (error) {
          revokeFailure = error
        }
      }
      try {
        await this.#refreshTokenStore.remove(config.appId)
      } catch (error) {
        storageFailure = error
      }
    }
    try {
      await this.#onSignedOut?.()
    } catch (error) {
      callbackFailure = error
    }

    const failures = [configFailure, revokeFailure, storageFailure, callbackFailure].filter(
      (error): error is unknown => error !== undefined,
    )
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) {
      throw new NativeWalletError(
        storageFailure ? 'SECURE_STORAGE' : 'SESSION',
        'Sign-out completed locally, but one or more cleanup operations failed.',
        undefined,
        new AggregateError(failures),
      )
    }
  }

  #setSession(token: TokenResponse): NativeWalletSession {
    this.#accessToken = token.AccessToken
    this.#expiresAt = this.#now() + token.ExpiresIn * 1000
    return {
      accessToken: token.AccessToken,
      expiresAt: this.#expiresAt,
      tokenType: token.TokenType,
    }
  }

  async #restoreAndRefresh(generation: number): Promise<NativeWalletSession | null> {
    const config = await this.getBrokerConfig()
    let refreshToken: string | null
    try {
      refreshToken = await this.#refreshTokenStore.get(config.appId)
    } catch (cause) {
      if (cause instanceof NativeWalletError) throw cause
      throw new NativeWalletError(
        'SECURE_STORAGE',
        'The native refresh credential could not be read from protected storage.',
        undefined,
        cause,
      )
    }
    if (!refreshToken) return null
    return this.#refreshWith(config, refreshToken, generation)
  }

  async #refreshWith(
    config: NativeWalletBrokerConfig,
    refreshToken: string,
    generation: number,
  ): Promise<NativeWalletSession> {
    let token: TokenResponse
    try {
      token = parseTokenResponse(
        await this.#request(`${API_PATH}/refresh`, {
          method: 'POST',
          body: { AppId: config.appId, RefreshToken: refreshToken },
        }),
      )
    } catch (error) {
      const discardCredential =
        error instanceof NativeWalletError &&
        (error.status === 401 ||
          error.code === 'NETWORK' ||
          error.code === 'INVALID_RESPONSE' ||
          (error.code === 'API' && error.status !== undefined && error.status >= 500))
      if (discardCredential) {
        this.#accessToken = undefined
        this.#expiresAt = 0
        try {
          await this.#refreshTokenStore.remove(config.appId)
        } catch (cause) {
          throw new NativeWalletError(
            'SECURE_STORAGE',
            'The unusable refresh credential could not be removed from protected storage.',
            undefined,
            new AggregateError([error, cause]),
          )
        }
      }
      throw error
    }

    if (generation !== this.#generation) {
      await this.#discardLateToken(config.appId, token.RefreshToken)
      throw new NativeWalletError(
        'SESSION',
        'The native wallet refresh was superseded before it completed.',
      )
    }
    await this.#persistRefreshToken(config.appId, token.RefreshToken, token.RefreshToken)
    if (generation !== this.#generation) {
      await this.#discardLateToken(config.appId, token.RefreshToken)
      throw new NativeWalletError(
        'SESSION',
        'The native wallet refresh was superseded before it completed.',
      )
    }
    return this.#setSession(token)
  }

  async #persistRefreshToken(appId: string, token: string, tokenToRevoke: string): Promise<void> {
    try {
      await this.#refreshTokenStore.set(appId, token)
    } catch (cause) {
      let revokeFailure: unknown
      try {
        await this.#request(`${API_PATH}/revoke`, {
          method: 'POST',
          body: { AppId: appId, RefreshToken: tokenToRevoke },
        })
      } catch (error) {
        revokeFailure = error
      }
      throw new NativeWalletError(
        'SECURE_STORAGE',
        'The new refresh credential could not be stored securely; the session was not retained.',
        undefined,
        revokeFailure === undefined ? cause : new AggregateError([cause, revokeFailure]),
      )
    }
  }

  async #discardLateToken(appId: string, refreshToken: string): Promise<void> {
    let revokeFailure: unknown
    let storageFailure: unknown
    try {
      await this.#request(`${API_PATH}/revoke`, {
        method: 'POST',
        body: { AppId: appId, RefreshToken: refreshToken },
      })
    } catch (error) {
      revokeFailure = error
    }
    try {
      await this.#refreshTokenStore.remove(appId)
    } catch (error) {
      storageFailure = error
    }
    if (revokeFailure !== undefined || storageFailure !== undefined) {
      throw new NativeWalletError(
        storageFailure ? 'SECURE_STORAGE' : 'SESSION',
        'A superseded native wallet credential could not be fully cleaned up.',
        undefined,
        new AggregateError([revokeFailure, storageFailure].filter((error) => error !== undefined)),
      )
    }
  }

  #assertCurrentGeneration(generation: number): void {
    if (generation !== this.#generation) {
      throw new NativeWalletError(
        'SESSION',
        'The native wallet sign-in was superseded before it completed.',
      )
    }
  }

  async #fetchBrokerConfig(): Promise<NativeWalletBrokerConfig> {
    const response = await this.#request(`${API_PATH}/config`, {
      method: 'GET',
      apiKey: true,
    })
    return parseBrokerConfig(response, this.#apiOrigin, this.#apiBaseUrl)
  }

  async #openBrowser(authorizationUrl: string, redirectUrl: string): Promise<NativeBrowserResult> {
    try {
      return await this.#browser.openAuthSession(authorizationUrl, redirectUrl)
    } catch (cause) {
      if (cause instanceof NativeWalletError) throw cause
      throw new NativeWalletError(
        'BROWSER',
        'The native system browser failed during wallet sign-in.',
        undefined,
        cause,
      )
    }
  }

  async #request(
    path: string,
    options: {
      method: 'GET' | 'POST'
      apiKey?: boolean
      body?: Record<string, string>
    },
  ): Promise<unknown> {
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (options.apiKey) headers['X-API-Key'] = this.#apiKey
    if (options.body) headers['Content-Type'] = 'application/json'

    let response: Response
    try {
      response = await this.#fetch(`${this.#apiBaseUrl}${path}`, {
        method: options.method,
        headers,
        ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      })
    } catch (cause) {
      throw new NativeWalletError(
        'NETWORK',
        'The Altude native wallet API could not be reached.',
        undefined,
        cause,
      )
    }

    let data: unknown
    try {
      data = await response.json()
    } catch (cause) {
      if (response.ok) {
        throw new NativeWalletError(
          'INVALID_RESPONSE',
          'The Altude native wallet API returned invalid JSON.',
          response.status,
          cause,
        )
      }
    }
    if (!response.ok) {
      const apiError = stringField(data, 'Error')
      throw new NativeWalletError(
        'API',
        apiError
          ? `The Altude native wallet API rejected the request (${apiError}).`
          : `The Altude native wallet API request failed with HTTP ${String(response.status)}.`,
        response.status,
      )
    }
    return data
  }
}

function parseBrokerConfig(
  value: unknown,
  apiOrigin: string,
  apiBaseUrl: string,
): NativeWalletBrokerConfig {
  const appId = stringField(value, 'AppId')
  const nativeScheme = stringField(value, 'NativeScheme')
  const issuer = stringField(value, 'Issuer')
  const audience = stringField(value, 'Audience')
  const authorizationUrl = stringField(value, 'AuthorizationUrl')
  const jwksUrl = stringField(value, 'JwksUrl')
  const appIdParts = appId ? /^(-?(?:[1-9]\d*))\.([1-9]\d*)$/.exec(appId) : null
  const tenantId = appIdParts?.[1]
  const keyId = appIdParts?.[2]
  if (
    !appId ||
    tenantId === undefined ||
    keyId === undefined ||
    !isValidAppId(tenantId, keyId) ||
    !nativeScheme ||
    !/^[a-z][a-z0-9+.-]*$/.test(nativeScheme) ||
    !issuer ||
    audience !== `urn:altude:wallet:app:${appId}` ||
    !authorizationUrl ||
    !jwksUrl ||
    !isExpectedApiUrl(authorizationUrl, `${apiBaseUrl}${API_PATH}/authorize`, apiOrigin) ||
    !isExpectedApiUrl(jwksUrl, `${apiBaseUrl}${API_PATH}/jwks`, apiOrigin) ||
    !parseTrustedIssuer(issuer, apiOrigin)
  ) {
    throw new NativeWalletError(
      'INVALID_RESPONSE',
      'The native wallet config response is missing valid broker metadata.',
    )
  }

  return { appId, nativeScheme, issuer, audience, authorizationUrl, jwksUrl }
}

function parseTokenResponse(value: unknown): TokenResponse {
  const accessToken = stringField(value, 'AccessToken')
  const refreshToken = stringField(value, 'RefreshToken')
  const expiresIn = numberField(value, 'ExpiresIn')
  const tokenType = stringField(value, 'TokenType')
  if (
    !accessToken ||
    !refreshToken ||
    expiresIn === undefined ||
    !Number.isFinite(expiresIn) ||
    expiresIn <= 0 ||
    tokenType !== 'Bearer'
  ) {
    throw new NativeWalletError(
      'INVALID_RESPONSE',
      'The native wallet API returned an invalid token response.',
    )
  }
  return {
    AccessToken: accessToken,
    RefreshToken: refreshToken,
    ExpiresIn: expiresIn,
    TokenType: 'Bearer',
  }
}

function appendAuthorizationParameters(
  authorizationUrl: string,
  parameters: Record<string, string>,
): string {
  const parsed = parseHttpUrl(authorizationUrl)
  if (!parsed || parsed.query !== null || parsed.fragment !== null) {
    throw new NativeWalletError(
      'INVALID_RESPONSE',
      'The native wallet authorization URL is malformed.',
    )
  }
  const query = Object.entries(parameters)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&')
  return `${authorizationUrl}?${query}`
}

function parseCallback(url: string, redirectUrl: string, expectedState: string): string {
  const prefix = `${redirectUrl}?`
  if (!url.startsWith(prefix) || url.includes('#')) {
    throw new NativeWalletError(
      'AUTHENTICATION',
      'The native wallet callback did not match the expected scheme and callback host.',
    )
  }
  const query = url.slice(prefix.length)
  const values = new Map<string, string>()
  for (const entry of query.split('&')) {
    if (!entry) {
      throw new NativeWalletError('AUTHENTICATION', 'The native wallet callback is malformed.')
    }
    const separator = entry.indexOf('=')
    if (separator <= 0) {
      throw new NativeWalletError('AUTHENTICATION', 'The native wallet callback is malformed.')
    }
    let key: string
    let value: string
    try {
      key = decodeURIComponent(entry.slice(0, separator).replace(/\+/g, ' '))
      value = decodeURIComponent(entry.slice(separator + 1).replace(/\+/g, ' '))
    } catch (cause) {
      throw new NativeWalletError(
        'AUTHENTICATION',
        'The native wallet callback contains invalid encoding.',
        undefined,
        cause,
      )
    }
    if ((key !== 'code' && key !== 'state') || values.has(key)) {
      throw new NativeWalletError(
        'AUTHENTICATION',
        'The native wallet callback contains unexpected or duplicate parameters.',
      )
    }
    values.set(key, value)
  }

  const code = values.get('code')
  const state = values.get('state')
  if (!code || !state || state !== expectedState) {
    throw new NativeWalletError(
      'AUTHENTICATION',
      'The native wallet callback state is invalid or does not match this sign-in attempt.',
    )
  }
  return code
}

function parseHttpUrl(value: string): ParsedUrl | null {
  const match = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]+)([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/i.exec(value)
  const protocol = match?.[1]
  const authority = match?.[2]
  if (!protocol || !authority) return null
  return {
    protocol: `${protocol.toLowerCase()}:`,
    authority,
    path: match[3] || '/',
    query: match[4] ?? null,
    fragment: match[5] ?? null,
  }
}

function isExpectedApiUrl(value: string, expected: string, apiOrigin: string): boolean {
  const actual = parseHttpUrl(value)
  const expectedUrl = parseHttpUrl(expected)
  return (
    actual !== null &&
    expectedUrl !== null &&
    isSecureProtocol(actual.protocol, actual.authority) &&
    `${actual.protocol}//${actual.authority.toLowerCase()}` === apiOrigin &&
    actual.path === expectedUrl.path &&
    actual.query === null &&
    actual.fragment === null
  )
}

function parseTrustedIssuer(value: string, apiOrigin: string): boolean {
  const parsed = parseHttpUrl(value)
  return (
    parsed !== null &&
    isSecureProtocol(parsed.protocol, parsed.authority) &&
    isValidAuthority(parsed.authority) &&
    parsed.path === '/' &&
    `${parsed.protocol}//${parsed.authority.toLowerCase()}` === apiOrigin &&
    parsed.query === null &&
    parsed.fragment === null
  )
}

function isValidAuthority(authority: string): boolean {
  const match = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::(\d{1,5}))?$/i.exec(authority)
  const host = match?.[1]
  const port = match?.[2]
  if (!host || host.startsWith('.') || host.endsWith('.') || host.includes('..')) return false
  if (port === undefined) return true
  const portNumber = Number(port)
  return portNumber > 0 && portNumber <= 65_535
}

function isSecureProtocol(protocol: string, authority: string): boolean {
  return (
    protocol === 'https:' ||
    (protocol === 'http:' && /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(authority))
  )
}

function isValidAppId(tenantId: string, keyId: string): boolean {
  const tenant = Number(tenantId)
  const key = Number(keyId)
  return (
    Number.isInteger(tenant) &&
    tenant !== 0 &&
    tenant >= -2_147_483_648 &&
    tenant <= 2_147_483_647 &&
    Number.isInteger(key) &&
    key > 0 &&
    key <= 2_147_483_647
  )
}

function stringField(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const field = (value as Record<string, unknown>)[key]
  return typeof field === 'string' ? field : undefined
}

function numberField(value: unknown, key: string): number | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const field = (value as Record<string, unknown>)[key]
  return typeof field === 'number' ? field : undefined
}
