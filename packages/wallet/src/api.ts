import { AltudeWalletError } from './errors.js'
import type { WalletSession, WalletUser } from './types.js'
import { assertPublicKey } from './crypto.js'

export interface BrowserWalletAccess {
  appId: string
  userId: string
  identityKey: string
  walletAddress: string | null
  challengeId: string
  message: string
}

export class BrowserWalletConflictError extends AltudeWalletError {
  constructor(
    readonly appId: string,
    readonly userId: string,
    readonly walletAddress: string,
  ) {
    super(
      'WALLET_CONFLICT',
      'Another device registered the wallet first. Restart sign-in to check the registered wallet; this ticket cannot be reused.',
      409,
    )
  }
}

export class EmbeddedWalletApi {
  readonly #apiKey: string
  readonly #baseUrl: string
  readonly #fetch: typeof fetch

  constructor(apiKey: string, apiBaseUrl: string, fetchImpl: typeof fetch = globalThis.fetch) {
    if (!apiKey.trim())
      throw new AltudeWalletError('CONFIGURATION', 'An Altude API key is required.')
    let baseUrl: URL
    try {
      baseUrl = new URL(apiBaseUrl)
    } catch {
      throw new AltudeWalletError('CONFIGURATION', 'apiBaseUrl must be an absolute HTTP(S) URL.')
    }
    if (
      (baseUrl.protocol !== 'https:' &&
        baseUrl.hostname !== 'localhost' &&
        baseUrl.hostname !== '127.0.0.1') ||
      baseUrl.username ||
      baseUrl.password ||
      baseUrl.search ||
      baseUrl.hash
    ) {
      throw new AltudeWalletError(
        'CONFIGURATION',
        'apiBaseUrl must be a secure HTTP(S) URL without credentials or query.',
      )
    }
    if (typeof fetchImpl !== 'function') {
      throw new AltudeWalletError(
        'CONFIGURATION',
        'Fetch is not available. Provide a fetch implementation.',
      )
    }
    this.#apiKey = apiKey
    this.#baseUrl = baseUrl.toString().replace(/\/$/, '')
    this.#fetch = fetchImpl.bind(globalThis)
  }

  async exchangeAuth0(
    accessToken: string,
    walletAddress: string,
  ): Promise<{ token: string; user: WalletUser }> {
    if (!accessToken.trim())
      throw new AltudeWalletError('AUTHENTICATION', 'An Auth0 access token is required.')
    if (!walletAddress.trim())
      throw new AltudeWalletError('INVALID_INPUT', 'A local wallet address is required.')
    const data = await this.#request('/api/EmbeddedWallet/auth0', {
      method: 'POST',
      body: JSON.stringify({ accessToken, walletAddress }),
    })
    return normalizeExchange(data)
  }

  async exchangeBrowserBroker(
    identityTicket: string,
    walletAddress: string,
    challengeId: string,
    signature: string,
  ): Promise<{ token: string; user: WalletUser; appId: string; userId: string }> {
    if (!identityTicket.trim())
      throw new AltudeWalletError('AUTHENTICATION', 'A browser identity ticket is required.')
    if (!walletAddress.trim())
      throw new AltudeWalletError('INVALID_INPUT', 'A local wallet address is required.')
    const data = await this.#request('/api/browser-wallet/session', {
      method: 'POST',
      body: JSON.stringify({
        IdentityTicket: identityTicket,
        WalletAddress: walletAddress,
        ChallengeId: challengeId,
        Signature: signature,
      }),
    })
    const result = normalizeExchange(data)
    const scope = normalizeScope(data)
    if (!scope || result.user.id !== scope.userId) throw invalidBrowserResponse()
    return { ...result, ...scope }
  }

  async browserAppId(): Promise<string> {
    const data = await this.#request('/api/browser-wallet/config', { method: 'GET' })
    if (field(data, 'walletAccessVersion', 'WalletAccessVersion') !== 1) {
      throw new AltudeWalletError(
        'CONFIGURATION',
        'The browser broker must support wallet access binding v1. Upgrade the backend; unsigned session binding is not supported.',
      )
    }
    return requiredString(data, 'appId', 'AppId')
  }

  get browserOrigin(): string {
    return new URL(this.#baseUrl).origin
  }

  browserIdentityKey(appId: string, userId: string): string {
    return `altude:browser:v1:${JSON.stringify([this.#baseUrl, appId, userId])}`
  }

  async getBrowserWallet(identityTicket: string): Promise<BrowserWalletAccess> {
    const data = await this.#request('/api/browser-wallet/wallet', {
      method: 'POST',
      body: JSON.stringify({ IdentityTicket: identityTicket }),
    })
    const scope = normalizeScope(data)
    const walletAddress = field(data, 'walletAddress', 'WalletAddress')
    if (!scope || (walletAddress !== null && typeof walletAddress !== 'string'))
      throw invalidBrowserResponse()
    if (typeof walletAddress === 'string') validateAddress(walletAddress)
    const expiresIn = field(data, 'expiresIn', 'ExpiresIn')
    if (
      typeof expiresIn !== 'number' ||
      !Number.isFinite(expiresIn) ||
      expiresIn <= 0 ||
      expiresIn > 60
    )
      throw invalidBrowserResponse()
    const message = stringField(data, 'message', 'Message')
    if (!message) throw invalidBrowserResponse()
    return {
      ...scope,
      walletAddress,
      identityKey: requiredString(data, 'identityKey', 'IdentityKey'),
      challengeId: requiredString(data, 'challengeId', 'ChallengeId'),
      message,
    }
  }

  async getSession(token: string): Promise<WalletSession | null> {
    const data = await this.#request('/api/EmbeddedWallet/session', {
      method: 'GET',
      sessionToken: token,
    })
    if (field(data, 'isAuthenticated', 'IsAuthenticated') !== true) return null
    const user = normalizeUser(field(data, 'user', 'User'))
    if (!user) {
      throw new AltudeWalletError(
        'INVALID_RESPONSE',
        'The authenticated session did not include a valid user.',
      )
    }
    const scope = normalizeScope(data)
    if (scope && user.id !== scope.userId) throw invalidBrowserResponse()
    return {
      user,
      expiresAt: stringField(data, 'expiresAt', 'ExpiresAt') ?? null,
      ...scope,
    }
  }

  async signOut(token: string): Promise<void> {
    const data = await this.#request('/api/EmbeddedWallet/signout', {
      method: 'POST',
      sessionToken: token,
    })
    if (field(data, 'success', 'Success') === false) {
      throw new AltudeWalletError(
        'SESSION',
        stringField(data, 'message', 'Message') || 'The API could not revoke the wallet session.',
      )
    }
  }

  async #request(
    path: string,
    options: { method: 'GET' | 'POST'; body?: string; sessionToken?: string },
  ): Promise<unknown> {
    const headers = new Headers({
      Accept: 'application/json',
      'X-API-Key': this.#apiKey,
    })
    if (options.body !== undefined) headers.set('Content-Type', 'application/json')
    if (options.sessionToken) headers.set('Authorization', `Bearer ${options.sessionToken}`)
    let response: Response
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method: options.method,
        headers,
        credentials: 'omit',
        redirect: 'error',
        cache: 'no-store',
        ...(options.body !== undefined ? { body: options.body } : {}),
        signal: AbortSignal.timeout(30_000),
      })
    } catch (error) {
      throw new AltudeWalletError(
        'API',
        'Could not reach the Altude wallet API. Check the network and enrolled-origin CORS configuration.' +
          (path === '/api/browser-wallet/session'
            ? ' Restart sign-in; this identity ticket must not be retried after an ambiguous failure.'
            : ''),
        undefined,
        error,
      )
    }
    const data: unknown = await response.json().catch(() => null)
    if (!response.ok) {
      const error = stringField(data, 'error', 'Error')
      if (path.startsWith('/api/browser-wallet/') && error === 'wallet_scope_migration_required') {
        throw new AltudeWalletError(
          'WALLET_SCOPE_MIGRATION_REQUIRED',
          'This account requires an explicit wallet-scope migration. A new wallet will not be created; contact the application operator.',
          response.status,
        )
      }
      if (
        path === '/api/browser-wallet/session' &&
        response.status === 409 &&
        error === 'wallet_conflict'
      ) {
        const scope = normalizeScope(data)
        const address = requiredString(data, 'walletAddress', 'WalletAddress')
        validateAddress(address)
        if (!scope) throw invalidBrowserResponse()
        throw new BrowserWalletConflictError(scope.appId, scope.userId, address)
      }
      const message = isObject(data)
        ? stringField(data, 'message', 'Message') || stringField(data, 'title', 'Title')
        : undefined
      throw new AltudeWalletError(
        'API',
        (message || `The Altude wallet API request failed with HTTP ${String(response.status)}.`) +
          (path === '/api/browser-wallet/session'
            ? ' Restart sign-in; the identity ticket and proof challenge cannot be retried.'
            : ''),
        response.status,
      )
    }

    if (!isObject(data)) {
      throw new AltudeWalletError(
        'INVALID_RESPONSE',
        'The Altude wallet API returned an invalid response.',
      )
    }
    return data
  }
}

function invalidBrowserResponse(): AltudeWalletError {
  return new AltudeWalletError(
    'INVALID_RESPONSE',
    'The browser broker returned an invalid wallet access response.',
  )
}

function requiredString(data: unknown, camel: string, pascal: string): string {
  const value = stringField(data, camel, pascal)
  if (!value || value !== value.trim() || /[\r\n]/.test(value)) throw invalidBrowserResponse()
  return value
}

function validateAddress(address: string): void {
  try {
    assertPublicKey(address, 'Registered wallet address')
  } catch {
    throw invalidBrowserResponse()
  }
}

function normalizeScope(data: unknown): { appId: string; userId: string } | undefined {
  const app = field(data, 'appId', 'AppId')
  const user = field(data, 'userId', 'UserId')
  if (app == null && user == null) return undefined
  const appId = requiredString(data, 'appId', 'AppId')
  const userId = requiredString(data, 'userId', 'UserId')
  return { appId, userId }
}

function normalizeExchange(data: unknown): { token: string; user: WalletUser } {
  const success = field(data, 'success', 'Success') === true
  const tokenValue = field(data, 'sessionToken', 'SessionToken')
  const token = typeof tokenValue === 'string' ? tokenValue : ''
  const user = normalizeUser(field(data, 'user', 'User'))
  if (!success || !token || !user) {
    throw new AltudeWalletError(
      'AUTHENTICATION',
      stringField(data, 'message', 'Message') ||
        'The API did not establish an authenticated wallet session.',
    )
  }
  return { token, user }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function field(object: unknown, camelCase: string, pascalCase: string): unknown {
  if (!isObject(object)) return undefined
  return object[camelCase] ?? object[pascalCase]
}

function stringField(object: unknown, camelCase: string, pascalCase: string): string | undefined {
  const value = field(object, camelCase, pascalCase)
  return typeof value === 'string' ? value : undefined
}

function normalizeUser(value: unknown): WalletUser | null {
  if (!isObject(value)) return null
  const id = value['id'] ?? value['Id']
  const email = value['email'] ?? value['Email']
  const phoneNumber = value['phoneNumber'] ?? value['PhoneNumber']
  const walletAddress = value['walletAddress'] ?? value['WalletAddress']
  if (typeof id !== 'string') return null
  return {
    id,
    ...(typeof email === 'string' || email === null ? { email } : {}),
    ...(typeof phoneNumber === 'string' || phoneNumber === null ? { phoneNumber } : {}),
    ...(typeof walletAddress === 'string' || walletAddress === null ? { walletAddress } : {}),
  }
}
