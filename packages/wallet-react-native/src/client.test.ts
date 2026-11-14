import { describe, expect, it, vi } from 'vitest'
import { NativeWalletClient } from './client.js'
import { NativeWalletError } from './errors.js'
import {
  createCryptoRandomSource,
  createInAppBrowserAdapter,
  createKeychainRefreshTokenStore,
} from './platform.js'
import type { RandomBytesSource, RefreshTokenStore } from './platform.js'

const brokerConfig = {
  AppId: '-17.42',
  NativeScheme: 'so.altude.wallet.tn17.a42',
  Issuer: 'https://api.altude.so/',
  Audience: 'urn:altude:wallet:app:-17.42',
  AuthorizationUrl: 'https://api.altude.so/api/native-wallet/authorize',
  JwksUrl: 'https://api.altude.so/api/native-wallet/jwks',
}

const accessResponse = {
  AccessToken: 'access-1',
  RefreshToken: 'refresh-1',
  ExpiresIn: 300,
  TokenType: 'Bearer',
}

function makeRandomBytes(): RandomBytesSource {
  let sequence = 0
  return (length) =>
    Uint8Array.from({ length }, (_, index) => {
      sequence += 1
      return (sequence + index) % 256
    })
}

function response(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
  } as Response
}

function makeStore(initial: string | null = null): RefreshTokenStore & { value: string | null } {
  return {
    value: initial,
    get() {
      return Promise.resolve(this.value)
    },
    set(_appId, token) {
      this.value = token
      return Promise.resolve()
    },
    remove() {
      this.value = null
      return Promise.resolve()
    },
  }
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

function makeClient(
  overrides: {
    fetch?: typeof fetch
    store?: RefreshTokenStore
    randomBytes?: RandomBytesSource
    onSignedOut?: () => void | Promise<void>
    openAuthSession?: (
      url: string,
      redirectUrl: string,
    ) => Promise<{ type: 'success'; url: string } | { type: 'cancel' } | { type: 'dismiss' }>
  } = {},
) {
  const fetcher: typeof fetch =
    overrides.fetch ??
    vi.fn<typeof fetch>((input) => {
      const url = requestUrl(input)
      if (url.endsWith('/config')) return Promise.resolve(response(brokerConfig))
      if (url.endsWith('/token')) return Promise.resolve(response(accessResponse))
      if (url.endsWith('/refresh')) return Promise.resolve(response(accessResponse))
      if (url.endsWith('/revoke')) return Promise.resolve(response({ Revoked: true }))
      return Promise.resolve(response({ Error: 'invalid_request' }, 400))
    })
  const browser = {
    openAuthSession:
      overrides.openAuthSession ??
      vi.fn((url: string, redirectUrl: string) => {
        const state = new URL(url).searchParams.get('state')
        return Promise.resolve({
          type: 'success' as const,
          url: `${redirectUrl}?code=broker-code&state=${state ?? ''}`,
        })
      }),
  }
  const store = overrides.store ?? makeStore()
  const client = new NativeWalletClient({
    apiKey: 'client-safe-key',
    apiBaseUrl: 'https://api.altude.so',
    browser,
    refreshTokenStore: store,
    randomBytes: overrides.randomBytes ?? makeRandomBytes(),
    fetch: fetcher,
    now: () => 1_000,
    ...(overrides.onSignedOut ? { onSignedOut: overrides.onSignedOut } : {}),
  })
  return { client, fetcher, browser, store }
}

describe('NativeWalletClient', () => {
  it('bootstraps using the existing API key and follows the broker PKCE contract', async () => {
    const { client, fetcher, browser } = makeClient({
      randomBytes: () => Uint8Array.from({ length: 32 }, (_, index) => index),
    })
    const session = await client.signIn()

    expect(session).toEqual({
      accessToken: 'access-1',
      expiresAt: 301_000,
      tokenType: 'Bearer',
    })
    const calls = vi.mocked(fetcher).mock.calls
    expect(calls[0]?.[0]).toBe('https://api.altude.so/api/native-wallet/config')
    expect(calls[0]?.[1]).toMatchObject({
      method: 'GET',
      headers: { Accept: 'application/json', 'X-API-Key': 'client-safe-key' },
    })
    expect(calls[1]?.[0]).toBe('https://api.altude.so/api/native-wallet/token')
    expect(calls[1]?.[1]).toMatchObject({
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    })
    const tokenBody = calls[1]?.[1]?.body
    expect(typeof tokenBody).toBe('string')
    if (typeof tokenBody !== 'string') throw new Error('Expected a JSON token request body.')
    expect(tokenBody).toContain(`"AppId":"${brokerConfig.AppId}"`)
    expect(tokenBody).toContain('"Code":"broker-code"')
    expect(tokenBody).toContain('"CodeVerifier":"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"')
    expect(calls[1]?.[1]?.headers).not.toHaveProperty('X-API-Key')

    const authorization = vi.mocked(browser.openAuthSession).mock.calls[0]?.[0]
    if (!authorization) throw new Error('Expected a system-browser authorization request.')
    expect(authorization).toContain('/api/native-wallet/authorize?')
    const parameters = new URL(authorization).searchParams
    expect(parameters.get('app_id')).toBe(brokerConfig.AppId)
    expect(parameters.get('state')).toBe('AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8')
    expect(parameters.get('code_challenge')).toBe('6oZqdX5MOLq_qBJ8vppAnT4fk6AP8UiP9zX8-Rev_9A')
    expect(parameters.get('code_challenge_method')).toBe('S256')
    expect(parameters.get('code_verifier')).toBeNull()
    expect(vi.mocked(browser.openAuthSession).mock.calls[0]?.[1]).toBe(
      'so.altude.wallet.tn17.a42://callback',
    )
  })

  it('rejects invalid app identity and broker URLs before opening a browser', async () => {
    const fetcher: typeof fetch = vi.fn<typeof fetch>(() =>
      Promise.resolve(response({ ...brokerConfig, AppId: '0.42' })),
    )
    const browser = { openAuthSession: vi.fn() }
    const client = new NativeWalletClient({
      apiKey: 'client-safe-key',
      apiBaseUrl: 'https://api.altude.so',
      browser,
      refreshTokenStore: makeStore(),
      randomBytes: makeRandomBytes(),
      fetch: fetcher,
    })

    await expect(client.signIn()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    expect(browser.openAuthSession).not.toHaveBeenCalled()
  })

  it('does not exchange callbacks with the wrong state, scheme, or duplicate parameters', async () => {
    for (const callback of [
      'so.altude.wallet.tn17.a42://callback?code=broker-code&state=wrong',
      'so.altude.wallet.other://callback?code=broker-code&state=expected',
      'so.altude.wallet.tn17.a42://callback?code=one&code=two&state=expected',
    ]) {
      const fetcher: typeof fetch = vi.fn<typeof fetch>((input) =>
        Promise.resolve(
          requestUrl(input).endsWith('/config') ? response(brokerConfig) : response(accessResponse),
        ),
      )
      const client = new NativeWalletClient({
        apiKey: 'client-safe-key',
        apiBaseUrl: 'https://api.altude.so',
        browser: {
          openAuthSession: () => Promise.resolve({ type: 'success', url: callback }),
        },
        refreshTokenStore: makeStore(),
        randomBytes: () => new Uint8Array(32).fill(1),
        fetch: fetcher,
      })
      await expect(client.signIn()).rejects.toBeInstanceOf(NativeWalletError)
      expect(fetcher).toHaveBeenCalledTimes(1)
    }
  })

  it('surfaces browser cancellation and makes no token request', async () => {
    const fetcher: typeof fetch = vi.fn<typeof fetch>(() => Promise.resolve(response(brokerConfig)))
    const { client } = makeClient({
      fetch: fetcher,
      openAuthSession: () => Promise.resolve({ type: 'cancel' }),
    })

    await expect(client.signIn()).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('serializes concurrent refresh operations and stores the rotated credential', async () => {
    let finishRefresh: ((value: Response) => void) | undefined
    const refreshResponse = new Promise<Response>((resolve) => {
      finishRefresh = resolve
    })
    const fetcher: typeof fetch = vi.fn<typeof fetch>((input) => {
      if (requestUrl(input).endsWith('/config')) return Promise.resolve(response(brokerConfig))
      if (requestUrl(input).endsWith('/refresh')) return refreshResponse
      return Promise.resolve(response({ Error: 'invalid_request' }, 400))
    })
    const store = makeStore('refresh-old')
    const { client } = makeClient({ fetch: fetcher, store })

    const first = client.refreshSession()
    const second = client.refreshSession()
    await Promise.resolve()
    finishRefresh?.(
      response({
        ...accessResponse,
        RefreshToken: 'refresh-rotated',
        AccessToken: 'access-rotated',
      }),
    )
    await expect(Promise.all([first, second])).resolves.toEqual([
      { accessToken: 'access-rotated', expiresAt: 301_000, tokenType: 'Bearer' },
      { accessToken: 'access-rotated', expiresAt: 301_000, tokenType: 'Bearer' },
    ])
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(store.value).toBe('refresh-rotated')
  })

  it('clears local credentials and invokes the wallet lock callback if revoke fails', async () => {
    const fetcher: typeof fetch = vi.fn<typeof fetch>((input) =>
      Promise.resolve(
        requestUrl(input).endsWith('/config')
          ? response(brokerConfig)
          : response({ Error: 'broker_unavailable' }, 503),
      ),
    )
    const store = makeStore('refresh-current')
    const onSignedOut = vi.fn()
    const client = new NativeWalletClient({
      apiKey: 'client-safe-key',
      apiBaseUrl: 'https://api.altude.so',
      browser: { openAuthSession: () => Promise.resolve({ type: 'cancel' }) },
      refreshTokenStore: store,
      randomBytes: makeRandomBytes(),
      fetch: fetcher,
      onSignedOut,
    })

    await expect(client.signOut()).rejects.toMatchObject({ code: 'API', status: 503 })
    expect(store.value).toBeNull()
    expect(onSignedOut).toHaveBeenCalledOnce()
  })

  it('discards an ambiguously consumed refresh credential instead of retrying it', async () => {
    const fetcher: typeof fetch = vi.fn<typeof fetch>((input) =>
      requestUrl(input).endsWith('/config')
        ? Promise.resolve(response(brokerConfig))
        : Promise.reject(new Error('connection lost')),
    )
    const store = makeStore('refresh-current')
    const { client } = makeClient({ fetch: fetcher, store })

    await expect(client.refreshSession()).rejects.toMatchObject({ code: 'NETWORK' })
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(store.value).toBeNull()
    await expect(client.refreshSession()).resolves.toBeNull()
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it.each([200, 503])(
    'rejects authentication and overlapping sign-out until delayed revocation settles (%s)',
    async (status) => {
      let finishRevoke: ((value: Response) => void) | undefined
      const revoke = new Promise<Response>((resolve) => {
        finishRevoke = resolve
      })
      const fetcher = vi.fn<typeof fetch>((input) => {
        const url = requestUrl(input)
        if (url.endsWith('/config')) return Promise.resolve(response(brokerConfig))
        if (url.endsWith('/revoke')) return revoke
        return Promise.resolve(response(accessResponse))
      })
      const store = makeStore()
      const { client, browser } = makeClient({ fetch: fetcher, store })
      await client.signIn()

      const signOut = client.signOut()
      const settled =
        status === 200
          ? expect(signOut).resolves.toBeUndefined()
          : expect(signOut).rejects.toMatchObject({ code: 'API', status: 503 })
      await vi.waitFor(() => {
        expect(fetcher.mock.calls.some(([input]) => requestUrl(input).endsWith('/revoke'))).toBe(
          true,
        )
      })
      const callsBefore = fetcher.mock.calls.length
      await expect(client.signIn()).rejects.toMatchObject({ code: 'CONCURRENT_OPERATION' })
      await expect(client.refreshSession()).rejects.toMatchObject({ code: 'CONCURRENT_OPERATION' })
      await expect(client.restoreSession()).rejects.toMatchObject({ code: 'CONCURRENT_OPERATION' })
      await expect(client.getAccessToken()).rejects.toMatchObject({ code: 'CONCURRENT_OPERATION' })
      await expect(client.signOut()).rejects.toMatchObject({ code: 'CONCURRENT_OPERATION' })
      expect(fetcher).toHaveBeenCalledTimes(callsBefore)
      expect(browser.openAuthSession).toHaveBeenCalledOnce()
      expect(store.value).toBe('refresh-1')

      if (!finishRevoke) throw new Error('Expected pending revocation.')
      finishRevoke(response(status === 200 ? { Revoked: true } : { Error: 'unavailable' }, status))
      await settled
      expect(store.value).toBeNull()
      await expect(client.getAccessToken()).resolves.toBeNull()
      await client.signIn()
      expect(store.value).toBe('refresh-1')
      await expect(client.getAccessToken()).resolves.toBe('access-1')
    },
  )

  it.each([
    ['signIn', 'during'],
    ['signIn', 'after'],
    ['refreshSession', 'during'],
    ['refreshSession', 'after'],
  ] as const)(
    'supersedes in-flight %s returning %s delayed sign-out cleanup',
    async (operation, timing) => {
      let finishAuth: ((value: Response) => void) | undefined
      let finishRevoke: ((value: Response) => void) | undefined
      const authResponse = new Promise<Response>((resolve) => {
        finishAuth = resolve
      })
      const revokeResponse = new Promise<Response>((resolve) => {
        finishRevoke = resolve
      })
      const fetcher = vi.fn<typeof fetch>((input, init) => {
        const url = requestUrl(input)
        if (url.endsWith('/config')) return Promise.resolve(response(brokerConfig))
        if (url.endsWith('/token') || url.endsWith('/refresh')) return authResponse
        if (url.endsWith('/revoke')) {
          return init?.body ===
            JSON.stringify({ AppId: brokerConfig.AppId, RefreshToken: 'refresh-old' })
            ? revokeResponse
            : Promise.resolve(response({ Revoked: true }))
        }
        return Promise.resolve(response({ Error: 'invalid_request' }, 400))
      })
      const store = makeStore('refresh-old')
      const { client } = makeClient({ fetch: fetcher, store })
      const authentication = client[operation]()
      const superseded = expect(authentication).rejects.toMatchObject({ code: 'SESSION' })
      const endpoint = operation === 'signIn' ? '/token' : '/refresh'
      await vi.waitFor(() => {
        expect(fetcher.mock.calls.some(([input]) => requestUrl(input).endsWith(endpoint))).toBe(
          true,
        )
      })

      const signOut = client.signOut()
      await vi.waitFor(() => {
        expect(fetcher.mock.calls.some(([input]) => requestUrl(input).endsWith('/revoke'))).toBe(
          true,
        )
      })
      await expect(client.signOut()).rejects.toMatchObject({ code: 'CONCURRENT_OPERATION' })
      await expect(client.refreshSession()).rejects.toMatchObject({ code: 'CONCURRENT_OPERATION' })
      if (!finishAuth || !finishRevoke)
        throw new Error('Expected pending authentication and revoke.')
      if (timing === 'during') {
        finishAuth(
          response({ ...accessResponse, AccessToken: 'access-late', RefreshToken: 'refresh-late' }),
        )
        await superseded
        await expect(client.signIn()).rejects.toMatchObject({ code: 'CONCURRENT_OPERATION' })
      }
      finishRevoke(response({ Revoked: true }))
      await signOut
      if (timing === 'after') {
        await expect(client.signIn()).rejects.toMatchObject({ code: 'CONCURRENT_OPERATION' })
        finishAuth(
          response({ ...accessResponse, AccessToken: 'access-late', RefreshToken: 'refresh-late' }),
        )
        await superseded
      }
      expect(store.value).toBeNull()
      await expect(client.getAccessToken()).resolves.toBeNull()
      expect(
        fetcher.mock.calls.filter(([input]) => requestUrl(input).endsWith('/revoke')),
      ).toHaveLength(2)

      fetcher.mockImplementation((input) =>
        Promise.resolve(
          response(requestUrl(input).endsWith('/revoke') ? { Revoked: true } : accessResponse),
        ),
      )
      await client.signIn()
      expect(store.value).toBe('refresh-1')
      await expect(client.getAccessToken()).resolves.toBe('access-1')
    },
  )

  it.each([false, true])(
    'keeps the sign-out guard through pending local cleanup and releases it on failure (%s)',
    async (failCleanup) => {
      let finishCleanup: (() => void) | undefined
      const cleanup = new Promise<void>((resolve) => {
        finishCleanup = resolve
      })
      const onSignedOut = vi.fn(async () => {
        await cleanup
        if (failCleanup) throw new Error('wallet lock failed')
      })
      const { client, fetcher } = makeClient({ onSignedOut })
      await client.signIn()
      const signOut = client.signOut()
      const settled = failCleanup
        ? expect(signOut).rejects.toThrow('wallet lock failed')
        : expect(signOut).resolves.toBeUndefined()
      await vi.waitFor(() => {
        expect(onSignedOut).toHaveBeenCalledOnce()
      })
      const callsBefore = vi.mocked(fetcher).mock.calls.length
      await expect(client.signIn()).rejects.toMatchObject({ code: 'CONCURRENT_OPERATION' })
      await expect(client.refreshSession()).rejects.toMatchObject({ code: 'CONCURRENT_OPERATION' })
      await expect(client.signOut()).rejects.toMatchObject({ code: 'CONCURRENT_OPERATION' })
      expect(fetcher).toHaveBeenCalledTimes(callsBefore)
      if (!finishCleanup) throw new Error('Expected pending local cleanup.')
      finishCleanup()
      await settled
      await client.signIn()
      await expect(client.getAccessToken()).resolves.toBe('access-1')
      if (failCleanup) {
        await expect(client.signOut()).rejects.toThrow('wallet lock failed')
      } else {
        await client.signOut()
      }
      expect(onSignedOut).toHaveBeenCalledTimes(2)
    },
  )

  it('discards a broker token returned after sign-out supersedes login', async () => {
    let finishBrowser: ((result: { type: 'success'; url: string }) => void) | undefined
    let finishToken: ((value: Response) => void) | undefined
    let authorizationUrl = ''
    let redirectUrl = ''
    const fetcher: typeof fetch = vi.fn<typeof fetch>((input) => {
      const url = requestUrl(input)
      if (url.endsWith('/config')) return Promise.resolve(response(brokerConfig))
      if (url.endsWith('/token')) {
        return new Promise<Response>((resolve) => {
          finishToken = resolve
        })
      }
      if (url.endsWith('/revoke')) return Promise.resolve(response({ Revoked: true }))
      return Promise.resolve(response({ Error: 'invalid_request' }, 400))
    })
    const browser = {
      openAuthSession: vi.fn((url: string, callbackUrl: string) => {
        authorizationUrl = url
        redirectUrl = callbackUrl
        return new Promise<{ type: 'success'; url: string }>((resolve) => {
          finishBrowser = resolve
        })
      }),
    }
    const store = makeStore()
    const client = new NativeWalletClient({
      apiKey: 'client-safe-key',
      apiBaseUrl: 'https://api.altude.so',
      browser,
      refreshTokenStore: store,
      randomBytes: makeRandomBytes(),
      fetch: fetcher,
    })

    const login = client.signIn()
    await vi.waitFor(() => {
      expect(browser.openAuthSession).toHaveBeenCalledOnce()
    })
    const state = new URL(authorizationUrl).searchParams.get('state')
    if (!state) throw new Error('Expected state in the authorization URL.')
    if (!finishBrowser) throw new Error('Expected a pending system-browser session.')
    finishBrowser({
      type: 'success',
      url: `${redirectUrl}?code=late-code&state=${state}`,
    })
    await vi.waitFor(() => {
      expect(fetcher).toHaveBeenCalledTimes(2)
    })

    await client.signOut()
    if (!finishToken) throw new Error('Expected a pending token exchange.')
    finishToken(response(accessResponse))

    await expect(login).rejects.toMatchObject({ code: 'SESSION' })
    expect(store.value).toBeNull()
    expect(fetcher).toHaveBeenCalledTimes(3)
  })
})

describe('native platform adapters', () => {
  it('maps InAppBrowser results into the SDK browser contract', async () => {
    const adapter = createInAppBrowserAdapter({
      openAuth: vi.fn(() =>
        Promise.resolve({
          type: 'success',
          url: 'so.altude.wallet.t1.a2://callback?code=one&state=two',
        }),
      ),
    })
    await expect(
      adapter.openAuthSession(
        'https://api.altude.so/authorize',
        'so.altude.wallet.t1.a2://callback',
      ),
    ).resolves.toEqual({
      type: 'success',
      url: 'so.altude.wallet.t1.a2://callback?code=one&state=two',
    })
  })

  it('uses device-only Keychain accessibility and app-scoped storage', async () => {
    let saved:
      | {
          username: string
          password: string
          options: { service: string; accessible?: unknown }
        }
      | undefined
    const keychain = {
      ACCESSIBLE: { WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'device-only' },
      getGenericPassword: vi.fn(
        (): Promise<false | { password: string }> =>
          Promise.resolve(saved ? { password: saved.password } : false),
      ),
      setGenericPassword: vi.fn(
        (
          username: string,
          password: string,
          options: { service: string; accessible?: unknown },
        ) => {
          saved = { username, password, options }
          return Promise.resolve(true)
        },
      ),
      resetGenericPassword: vi.fn(() => {
        saved = undefined
        return Promise.resolve(true)
      }),
    }
    const store = createKeychainRefreshTokenStore(keychain)

    await store.set('-17.42', 'refresh-secret')
    expect(saved).toMatchObject({
      username: 'altude-wallet-refresh',
      password: 'refresh-secret',
      options: {
        service: 'so.altude.wallet.refresh.-17.42',
        accessible: 'device-only',
      },
    })
    await expect(store.get('-17.42')).resolves.toBe('refresh-secret')
    await store.remove('-17.42')
    expect(saved).toBeUndefined()
  })

  it('requires a cryptographically secure random provider', () => {
    expect(() => createCryptoRandomSource({ getRandomValues: (array) => array })).not.toThrow()
    expect(() => createCryptoRandomSource(null)).toThrowError(NativeWalletError)
  })
})
