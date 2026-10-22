import { AltudeWalletError } from './errors.js'
import type { WalletSession, WalletUser } from './types.js'

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
    return {
      user,
      expiresAt: stringField(data, 'expiresAt', 'ExpiresAt') ?? null,
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
    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      method: options.method,
      headers,
      ...(options.body !== undefined ? { body: options.body } : {}),
    })
    const data: unknown = await response.json().catch(() => null)
    if (!response.ok) {
      const message = isObject(data)
        ? stringField(data, 'message', 'Message') || stringField(data, 'title', 'Title')
        : undefined
      throw new AltudeWalletError(
        'API',
        message || `The Altude wallet API request failed with HTTP ${String(response.status)}.`,
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
