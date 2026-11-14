import { NativeWalletError } from './errors.js'

export type NativeBrowserResult =
  | { type: 'success'; url: string }
  | { type: 'cancel' }
  | { type: 'dismiss' }

export interface NativeAuthBrowser {
  openAuthSession(authorizationUrl: string, redirectUrl: string): Promise<NativeBrowserResult>
}

export interface RefreshTokenStore {
  getAppId(apiBaseUrl: string, apiKeyFingerprint: string): Promise<string | null>
  setAppId(apiBaseUrl: string, apiKeyFingerprint: string, appId: string): Promise<void>
  get(apiBaseUrl: string, appId: string): Promise<string | null>
  set(apiBaseUrl: string, appId: string, token: string): Promise<void>
  remove(apiBaseUrl: string, appId: string): Promise<void>
}

export function normalizeApiBaseUrl(apiBaseUrl: string): string {
  const match = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]+)([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/i.exec(
    apiBaseUrl,
  )
  const protocol = match?.[1]?.toLowerCase()
  const authority = match?.[2]?.toLowerCase()
  if (!protocol || !authority || match?.[4] !== undefined || match?.[5] !== undefined) {
    throw new Error('An absolute API base URL without query or fragment is required.')
  }

  const authorityParts = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::(\d{1,5}))?$/i.exec(authority)
  const host = authorityParts?.[1]
  const port = authorityParts?.[2]
  if (!host) throw new Error('The API base URL authority is invalid.')
  const defaultPort = protocol === 'https' ? 443 : protocol === 'http' ? 80 : undefined
  const normalizedAuthority =
    port === undefined || Number(port) === defaultPort ? host : `${host}:${String(Number(port))}`
  const path = normalizeApiPath(match?.[3] || '/')
  return `${protocol}://${normalizedAuthority}${path.replace(/\/+$/, '')}`
}

export interface RandomBytesSource {
  (length: number): Uint8Array
}

export interface InAppBrowserModule<TOptions = Record<string, unknown>> {
  openAuth(
    authorizationUrl: string,
    redirectUrl: string,
    options?: TOptions,
  ): Promise<{ type: string; url?: string | null }>
}

export interface KeychainModule {
  ACCESSIBLE?: { WHEN_UNLOCKED_THIS_DEVICE_ONLY?: unknown }
  getGenericPassword(options: { service: string }): Promise<false | { password: string }>
  setGenericPassword(
    username: string,
    password: string,
    options: { service: string; accessible?: unknown },
  ): Promise<unknown>
  resetGenericPassword(options: { service: string }): Promise<unknown>
}

export interface CryptoRandomProvider {
  getRandomValues<T extends ArrayBufferView>(array: T): T
}

export function createInAppBrowserAdapter<TOptions = Record<string, unknown>>(
  browser: InAppBrowserModule<TOptions>,
  options?: TOptions,
): NativeAuthBrowser {
  if (typeof browser.openAuth !== 'function') {
    throw new NativeWalletError(
      'CONFIGURATION',
      'A system-browser module with openAuth is required.',
    )
  }

  return {
    async openAuthSession(authorizationUrl, redirectUrl) {
      let result: { type: string; url?: string | null }
      try {
        result = await browser.openAuth(authorizationUrl, redirectUrl, options)
      } catch (cause) {
        throw new NativeWalletError(
          'BROWSER',
          'The native system browser could not start the wallet sign-in flow.',
          undefined,
          cause,
        )
      }

      if (result.type === 'success' && typeof result.url === 'string') {
        return { type: 'success', url: result.url }
      }
      if (result.type === 'cancel') return { type: 'cancel' }
      if (result.type === 'dismiss') return { type: 'dismiss' }

      throw new NativeWalletError(
        'BROWSER',
        'The system browser returned an unsupported sign-in result.',
      )
    },
  }
}

export function createKeychainRefreshTokenStore(keychain: KeychainModule): RefreshTokenStore {
  const accessible = keychain.ACCESSIBLE?.WHEN_UNLOCKED_THIS_DEVICE_ONLY
  if (accessible === undefined) {
    throw new NativeWalletError(
      'CONFIGURATION',
      'The Keychain module must expose WHEN_UNLOCKED_THIS_DEVICE_ONLY protection.',
    )
  }

  return {
    async getAppId(apiBaseUrl, apiKeyFingerprint) {
      try {
        const association = await keychain.getGenericPassword({
          service: associationServiceFor(apiBaseUrl, apiKeyFingerprint),
        })
        return association === false ? null : association.password
      } catch (cause) {
        throw new NativeWalletError(
          'SECURE_STORAGE',
          'The native wallet storage association could not be read.',
          undefined,
          cause,
        )
      }
    },
    async setAppId(apiBaseUrl, apiKeyFingerprint, appId) {
      try {
        const stored = await keychain.setGenericPassword('altude-wallet-app', appId, {
          service: associationServiceFor(apiBaseUrl, apiKeyFingerprint),
          accessible,
        })
        if (stored === false) {
          throw new Error('The Keychain provider declined the storage association write.')
        }
      } catch (cause) {
        throw new NativeWalletError(
          'SECURE_STORAGE',
          'The native wallet storage association could not be saved.',
          undefined,
          cause,
        )
      }
    },
    async get(apiBaseUrl, appId) {
      try {
        const credential = await keychain.getGenericPassword({
          service: serviceFor(apiBaseUrl, appId),
        })
        return credential === false ? null : credential.password
      } catch (cause) {
        throw new NativeWalletError(
          'SECURE_STORAGE',
          'The native refresh credential could not be read from protected storage.',
          undefined,
          cause,
        )
      }
    },
    async set(apiBaseUrl, appId, token) {
      try {
        const stored = await keychain.setGenericPassword('altude-wallet-refresh', token, {
          service: serviceFor(apiBaseUrl, appId),
          accessible,
        })
        if (stored === false) {
          throw new Error('The Keychain provider declined the credential write.')
        }
      } catch (cause) {
        throw new NativeWalletError(
          'SECURE_STORAGE',
          'The native refresh credential could not be saved to protected storage.',
          undefined,
          cause,
        )
      }
    },
    async remove(apiBaseUrl, appId) {
      try {
        const service = serviceFor(apiBaseUrl, appId)
        const stored = await keychain.getGenericPassword({ service })
        if (stored === false) return
        const removed = await keychain.resetGenericPassword({ service })
        if (removed === false) {
          throw new Error('The Keychain provider declined the credential removal.')
        }
      } catch (cause) {
        throw new NativeWalletError(
          'SECURE_STORAGE',
          'The native refresh credential could not be removed from protected storage.',
          undefined,
          cause,
        )
      }
    },
  }
}

export function createCryptoRandomSource(
  cryptoProvider: CryptoRandomProvider | null | undefined,
): RandomBytesSource {
  if (!cryptoProvider || typeof cryptoProvider.getRandomValues !== 'function') {
    throw new NativeWalletError(
      'CONFIGURATION',
      'A cryptographically secure getRandomValues implementation is required.',
    )
  }

  return (length) => {
    const bytes = new Uint8Array(length)
    cryptoProvider.getRandomValues(bytes)
    return bytes
  }
}

function serviceFor(apiBaseUrl: string, appId: string): string {
  return `so.altude.wallet.refresh.v2.${encodeURIComponent(normalizeApiBaseUrl(apiBaseUrl))}.${encodeURIComponent(appId)}`
}

function associationServiceFor(apiBaseUrl: string, apiKeyFingerprint: string): string {
  return `so.altude.wallet.app.v1.${encodeURIComponent(normalizeApiBaseUrl(apiBaseUrl))}.${encodeURIComponent(apiKeyFingerprint)}`
}

function normalizeApiPath(path: string): string {
  const segments = path.replace(/\\/g, '/').split('/')
  const normalized: string[] = []
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index] ?? ''
    const lowerSegment = segment.toLowerCase()
    const isDot = segment === '.' || lowerSegment === '%2e'
    const isDotDot =
      segment === '..' ||
      lowerSegment === '.%2e' ||
      lowerSegment === '%2e.' ||
      lowerSegment === '%2e%2e'
    if (isDot) {
      if (index === segments.length - 1) normalized.push('')
      continue
    }
    if (isDotDot) {
      if (normalized.length > 1) normalized.pop()
      if (index === segments.length - 1) normalized.push('')
      continue
    }
    normalized.push(segment)
  }
  const result = normalized.join('/')
  return result.startsWith('/') ? result : `/${result}`
}
