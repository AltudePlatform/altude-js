import { NativeWalletError } from './errors.js'

export type NativeBrowserResult =
  | { type: 'success'; url: string }
  | { type: 'cancel' }
  | { type: 'dismiss' }

export interface NativeAuthBrowser {
  openAuthSession(authorizationUrl: string, redirectUrl: string): Promise<NativeBrowserResult>
}

export interface RefreshTokenStore {
  get(appId: string): Promise<string | null>
  set(appId: string, token: string): Promise<void>
  remove(appId: string): Promise<void>
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
    async get(appId) {
      try {
        const credential = await keychain.getGenericPassword({ service: serviceFor(appId) })
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
    async set(appId, token) {
      try {
        const stored = await keychain.setGenericPassword('altude-wallet-refresh', token, {
          service: serviceFor(appId),
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
    async remove(appId) {
      try {
        const service = serviceFor(appId)
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

function serviceFor(appId: string): string {
  return `so.altude.wallet.refresh.${encodeURIComponent(appId)}`
}
