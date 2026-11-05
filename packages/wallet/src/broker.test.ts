// @vitest-environment happy-dom
import { webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBrowserWalletAuth } from './broker.js'

const config = {
  AppId: '-17.42',
  EmailOtp: true,
  SmsOtp: true,
  SocialProviders: ['google-oauth2', 'apple'],
}
const identity = { IdentityTicket: 'single-use-ticket', IdentityKey: 'email|user', ExpiresIn: 120 }

describe('createBrowserWalletAuth', () => {
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>
  let state: string
  let requests: { path: string; body: Record<string, unknown> }[]

  beforeEach(() => {
    vi.stubGlobal('crypto', webcrypto)
    state = ''
    requests = []
    fetchMock = vi.fn<typeof fetch>((url, init) => {
      const path = (
        typeof url === 'string' ? url : url instanceof URL ? url.href : url.url
      ).replace('https://api.example.test/api/browser-wallet', '')
      const body = parseBody(init)
      requests.push({ path, body })
      if (typeof body['State'] === 'string') state = body['State']
      if (path === '/config') return Promise.resolve(json(config))
      if (path === '/otp/start')
        return Promise.resolve(json({ ChallengeId: 'challenge-1', ExpiresIn: 300 }))
      if (path === '/otp/verify')
        return Promise.resolve(json({ Code: 'one-time-code', State: state }))
      if (path === '/redeem') return Promise.resolve(json(identity))
      if (path === '/authorize')
        return Promise.resolve(
          json({
            AuthorizationUrl: 'https://tenant.auth0.com/authorize?transaction=id',
            TransactionId: 'transaction-1',
          }),
        )
      throw new Error(`Unexpected request: ${path}`)
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
    document.body.replaceChildren()
  })

  const create = () =>
    createBrowserWalletAuth({
      apiKey: 'client-safe-key',
      apiBaseUrl: 'https://api.example.test',
      fetch: fetchMock,
    })

  it('discovers methods and authenticates OTP with S256 and a ticket, never provider tokens', async () => {
    const broker = await create()
    expect(broker.socialProviders).toEqual(['google-oauth2', 'apple'])
    expect(Object.isFrozen(broker.socialProviders)).toBe(true)
    expect(broker.auth.supportsOtpChannel?.('email')).toBe(true)
    await broker.auth.startOtp?.('email', ' user@example.test ')
    const start = requests.find(({ path }) => path === '/otp/start')?.body
    expect(start).toMatchObject({
      Method: 'email',
      Identifier: 'user@example.test',
      CodeChallengeMethod: 'S256',
    })
    expect(start?.['State']).toMatch(/^[\w-]{43}$/)
    expect(start?.['CodeChallenge']).toMatch(/^[\w-]{43}$/)
    await expect(broker.auth.verifyOtp?.('email', 'user@example.test', '123456')).resolves.toEqual({
      identityKey: 'email|user',
      broker: { identityTicket: 'single-use-ticket' },
    })
    const redemption = requests.find(({ path }) => path === '/redeem')?.body
    expect(redemption).toMatchObject({ Code: 'one-time-code' })
    const verifier = redemption?.['CodeVerifier']
    expect(typeof verifier).toBe('string')
    const digest = await webcrypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(String(verifier)),
    )
    expect(Buffer.from(digest).toString('base64url')).toBe(start?.['CodeChallenge'])
    for (const [, init] of fetchMock.mock.calls) {
      expect(init).toMatchObject({
        headers: { 'X-API-Key': 'client-safe-key' },
        credentials: 'omit',
        redirect: 'error',
        cache: 'no-store',
      })
      expect(new Headers(init?.headers).has('Origin')).toBe(false)
    }
    await expect(broker.auth.verifyOtp?.('email', 'user@example.test', '123456')).rejects.toThrow(
      'Request a code',
    )
  })

  it('normalizes SMS and requires six digits with the matching challenge', async () => {
    const { auth } = await create()
    await auth.startOtp?.('sms', '+1 (415) 555-0100')
    expect(requests[1]?.body['Identifier']).toBe('+14155550100')
    await expect(auth.verifyOtp?.('email', 'user@example.test', '123456')).rejects.toThrow(
      'Request a code',
    )
    await expect(auth.verifyOtp?.('sms', '+14155550100', '12345')).rejects.toThrow('six-digit')
    await expect(auth.verifyOtp?.('sms', '+14155550100', '123456')).resolves.toHaveProperty(
      'broker',
    )
  })

  it('requires resend after failed verification or ambiguous redemption without automatic retries', async () => {
    const { auth } = await create()
    await auth.startOtp?.('email', 'user@example.test')
    fetchMock.mockResolvedValueOnce(json({}, 400))
    await expect(auth.verifyOtp?.('email', 'user@example.test', '654321')).rejects.toThrow(
      'Resend code',
    )
    await expect(auth.verifyOtp?.('email', 'user@example.test', '123456')).rejects.toThrow(
      'Request a code',
    )
    await auth.startOtp?.('email', 'user@example.test')
    fetchMock.mockResolvedValueOnce(json({ Code: 'code', State: state }))
    fetchMock.mockRejectedValueOnce(new TypeError('Network interrupted'))
    await expect(auth.verifyOtp?.('email', 'user@example.test', '123456')).rejects.toThrow(
      'Could not reach',
    )
    await expect(auth.verifyOtp?.('email', 'user@example.test', '123456')).rejects.toThrow(
      'Request a code',
    )
    expect(requests.filter(({ path }) => path === '/redeem')).toHaveLength(0)
  })

  it('rejects mismatched OTP state without redeeming', async () => {
    const { auth } = await create()
    await auth.startOtp?.('email', 'user@example.test')
    fetchMock.mockResolvedValueOnce(json({ Code: 'code', State: 'attacker' }))
    await expect(auth.verifyOtp?.('email', 'user@example.test', '123456')).rejects.toThrow(
      'state did not match',
    )
    expect(requests.some(({ path }) => path === '/redeem')).toBe(false)
  })

  it.each([
    { ...identity, IdentityTicket: '' },
    { ...identity, IdentityKey: '' },
    { ...identity, ExpiresIn: 0 },
  ])('rejects invalid redeemed identity tickets %#', async (value) => {
    const { auth } = await create()
    await auth.startOtp?.('email', 'user@example.test')
    fetchMock.mockResolvedValueOnce(json({ Code: 'code', State: state }))
    fetchMock.mockResolvedValueOnce(json(value))
    await expect(auth.verifyOtp?.('email', 'user@example.test', '123456')).rejects.toThrow(
      'invalid response',
    )
    await expect(auth.verifyOtp?.('email', 'user@example.test', '123456')).rejects.toThrow(
      'Request a code',
    )
  })

  it('uses fresh state and PKCE on resend and rejects overlapping operations', async () => {
    const { auth } = await create()
    const pending = auth.startOtp?.('email', 'user@example.test')
    await expect(auth.startOtp?.('email', 'user@example.test')).rejects.toThrow('in progress')
    await pending
    const first = state
    await auth.startOtp?.('email', 'user@example.test')
    expect(state).not.toBe(first)
    const attempts = requests.filter(({ path }) => path === '/otp/start')
    expect(attempts[0]?.body['CodeChallenge']).not.toBe(attempts[1]?.body['CodeChallenge'])
  })

  it('fails closed on unavailable config and on disabled methods', async () => {
    fetchMock.mockResolvedValueOnce(json({}, 403))
    await expect(create()).rejects.toThrow('enroll this exact browser origin')
    fetchMock.mockResolvedValueOnce(json({ ...config, EmailOtp: false, SocialProviders: [] }))
    const { auth } = await create()
    expect(auth.supportsOtpChannel?.('email')).toBe(false)
    await expect(auth.startOtp?.('email', 'user@example.test')).rejects.toThrow('disabled')
    await expect(auth.signInWithSocial?.('google-oauth2')).rejects.toThrow('not enabled')
  })

  it.each([
    { ...config, SocialProviders: [''] },
    { ...config, EmailOtp: 'true' },
    { ...config, AppId: '' },
  ])('rejects malformed configuration %#', async (value) => {
    fetchMock.mockResolvedValueOnce(json(value))
    await expect(create()).rejects.toThrow('invalid response')
  })

  it('does not open Auth0 or fall back when the broker is missing', async () => {
    const open = vi.spyOn(window, 'open')
    fetchMock.mockResolvedValueOnce(json({}, 404))
    await expect(create()).rejects.toThrow('deployment')
    expect(open).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('accepts a social handoff only from the popup and exact broker origin and state', async () => {
    const { popup, close } = mockPopup()
    const open = vi.spyOn(window, 'open').mockReturnValue(popup)
    const remove = vi.spyOn(window, 'removeEventListener')
    const { auth } = await create()
    const pending = auth.signInWithSocial?.('google-oauth2')
    expect(open).toHaveBeenCalledWith('about:blank', '_blank', expect.any(String))
    await vi.waitFor(() => {
      expect(popup.location.href).toBe('https://tenant.auth0.com/authorize?transaction=id')
    })
    const data = { Type: 'altude:wallet:authorization', Code: 'social-code', State: state }
    window.dispatchEvent(
      new MessageEvent('message', { origin: 'https://attacker.example', source: popup, data }),
    )
    window.dispatchEvent(
      new MessageEvent('message', { origin: 'https://api.example.test', source: window, data }),
    )
    expect(requests.some(({ path }) => path === '/redeem')).toBe(false)
    window.dispatchEvent(
      new MessageEvent('message', { origin: 'https://api.example.test', source: popup, data }),
    )
    await expect(pending).resolves.toEqual({
      identityKey: 'email|user',
      broker: { identityTicket: 'single-use-ticket' },
    })
    expect(close).toHaveBeenCalledTimes(1)
    expect(remove).toHaveBeenCalledWith('message', expect.any(Function))
    expect(requests.filter(({ path }) => path === '/redeem')).toHaveLength(1)
    window.dispatchEvent(
      new MessageEvent('message', { origin: 'https://api.example.test', source: popup, data }),
    )
    expect(requests.filter(({ path }) => path === '/redeem')).toHaveLength(1)
  })

  it('rejects a trusted popup message with wrong state and cleans up', async () => {
    const { popup, close } = mockPopup()
    vi.spyOn(window, 'open').mockReturnValue(popup)
    const { auth } = await create()
    const pending = auth.signInWithSocial?.('apple')
    await vi.waitFor(() => {
      expect(popup.location.href).toContain('/authorize')
    })
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: 'https://api.example.test',
        source: popup,
        data: { Type: 'altude:wallet:authorization', Code: 'code', State: 'wrong' },
      }),
    )
    await expect(pending).rejects.toThrow('state did not match')
    expect(close).toHaveBeenCalled()
    expect(requests.some(({ path }) => path === '/redeem')).toBe(false)
  })

  it('reports blocked and closed popups without fallback', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    const { auth } = await create()
    await expect(auth.signInWithSocial?.('apple')).rejects.toThrow('Allow popups')
    const { popup, close } = mockPopup(true)
    open.mockReturnValue(popup)
    await expect(auth.signInWithSocial?.('apple')).rejects.toThrow('cancelled')
    expect(close).toHaveBeenCalled()
  })

  it('closes the reserved popup when the authorization URL is unsafe', async () => {
    const { popup, close } = mockPopup()
    vi.spyOn(window, 'open').mockReturnValue(popup)
    const { auth } = await create()
    fetchMock.mockResolvedValueOnce(
      json({ AuthorizationUrl: 'javascript:alert(1)', TransactionId: 'id' }),
    )
    await expect(auth.signInWithSocial?.('apple')).rejects.toThrow('secure HTTP(S)')
    expect(close).toHaveBeenCalledTimes(1)
    expect(popup.location.href).toBe('')
    expect(requests.some(({ path }) => path === '/redeem')).toBe(false)
  })

  it('times out a popup and removes listeners', async () => {
    const { popup } = mockPopup()
    vi.spyOn(window, 'open').mockReturnValue(popup)
    const remove = vi.spyOn(window, 'removeEventListener')
    const { auth } = await create()
    vi.useFakeTimers()
    const timed = auth.signInWithSocial?.('apple')
    const rejected = expect(timed).rejects.toThrow('timed out')
    await vi.waitFor(() => {
      expect(popup.location.href).toContain('/authorize')
    })
    await vi.advanceTimersByTimeAsync(120_000)
    await rejected
    expect(remove).toHaveBeenCalledWith('message', expect.any(Function))
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects unsafe URLs before transmitting credentials', async () => {
    for (const apiBaseUrl of [
      'http://api.example.test',
      'https://user:pass@api.example.test',
      'https://api.example.test?key=secret',
    ]) {
      await expect(
        createBrowserWalletAuth({ apiKey: 'key', apiBaseUrl, fetch: fetchMock }),
      ).rejects.toThrow('secure HTTP(S)')
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function parseBody(init?: RequestInit): Record<string, unknown> {
  if (typeof init?.body !== 'string') return {}
  const data: unknown = JSON.parse(init.body)
  if (typeof data !== 'object' || data === null || Array.isArray(data))
    throw new Error('Invalid request body')
  return data as Record<string, unknown>
}

function mockPopup(closed = false) {
  const frame = document.createElement('iframe')
  document.body.append(frame)
  const popup = frame.contentWindow
  if (!popup) throw new Error('Missing test popup window')
  Object.defineProperty(popup, 'closed', { value: closed, configurable: true })
  let href = ''
  vi.spyOn(popup.location, 'href', 'set').mockImplementation((value) => {
    href = value
  })
  vi.spyOn(popup.location, 'href', 'get').mockImplementation(() => href)
  const close = vi.spyOn(popup, 'close').mockImplementation(() => undefined)
  return { popup, close }
}
