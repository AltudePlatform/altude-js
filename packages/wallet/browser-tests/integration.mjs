import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { build } from 'esbuild'
import { createHash, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto'

const edgeExecutable =
  process.env.EDGE_EXECUTABLE ??
  [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ].find((candidate) => existsSync(candidate))

if (!edgeExecutable || !existsSync(edgeExecutable)) {
  throw new Error('Microsoft Edge was not found. Set EDGE_EXECUTABLE to its executable path.')
}

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/index.ts', import.meta.url))],
  bundle: true,
  format: 'iife',
  globalName: 'AltudeWalletSDK',
  platform: 'browser',
  target: 'es2022',
  write: false,
})
const javascript = bundle.outputFiles[0]?.text
if (!javascript) throw new Error('The browser SDK bundle was empty.')

const server = createServer((request, response) => {
  if (request.url?.startsWith('/wrong-origin?')) {
    const target = new URL(request.url, 'http://localhost').searchParams.get('parent')
    response.writeHead(200, { 'Content-Type': 'text/html' })
    response.end(`<script>addEventListener('message', e => parent.postMessage(e.data, ${JSON.stringify(target)}))</script>`)
    return
  }
  if (request.url === '/wallet.js') {
    response.writeHead(200, { 'Content-Type': 'text/javascript' })
    response.end(javascript)
    return
  }
  response.writeHead(200, { 'Content-Type': 'text/html' })
  response.end(
    '<!doctype html><html><head></head><body><script src="/wallet.js"></script></body></html>',
  )
})

await new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', resolve)
})

let browser
try {
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('The browser test server did not start.')
  browser = await chromium.launch({ executablePath: edgeExecutable, headless: true })
  const page = await browser.newPage()
  let apiRequests = 0
  await page.route('https://api.example.test/**', async (route) => {
    apiRequests += 1
    const url = route.request().url()
    if (url.endsWith('/api/EmbeddedWallet/auth0')) {
      const requestBody = route.request().postDataJSON()
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          sessionToken: 'browser-session-token',
          user: { id: 'browser-user', walletAddress: requestBody.walletAddress },
        }),
      })
      return
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"success":true}' })
  })
  await page.goto(`http://127.0.0.1:${address.port}`)

  const result = await page.evaluate(async () => {
    const sdk = window.AltudeWalletSDK
    const embedded = new sdk.AltudeWallet({
      apiKey: 'browser-test-key',
      apiBaseUrl: 'https://api.example.test',
      auth: {},
    })
    const embeddedState = await embedded.connect({
      accessToken: 'browser-access-token',
      identityKey: 'browser-embedded-user',
    })
    const indexedDbStore = new sdk.IndexedDbWalletStore()
    const localRecord = await indexedDbStore.get('browser-embedded-user')

    let disconnected = false
    const external = new sdk.AltudeWallet({
      apiKey: 'browser-test-key',
      apiBaseUrl: 'https://api.example.test',
      auth: {},
      externalWallets: [
        {
          id: 'metamask',
          label: 'MetaMask',
          connect: async () => ({
            address: '0x1234567890123456789012345678901234567890',
            chain: 'evm',
          }),
          disconnect: async () => {
            disconnected = true
          },
        },
      ],
    })
    const externalState = await external.connectExternalWallet('metamask')
    const externalRecord = await indexedDbStore.get('browser-external-user')
    await external.signOut()
    return {
      secure: window.isSecureContext,
      hasWebCrypto: Boolean(window.crypto?.subtle),
      hasIndexedDb: Boolean(window.indexedDB),
      embeddedState,
      localRecordExists: Boolean(localRecord),
      externalState,
      externalRecordExists: Boolean(externalRecord),
      disconnected,
      finalExternalStatus: external.state.status,
    }
  })

  assert.equal(result.secure, true, 'the browser origin must be a secure context')
  assert.equal(result.hasWebCrypto, true, 'Web Crypto must be available in the real browser')
  assert.equal(result.hasIndexedDb, true, 'IndexedDB must be available in the real browser')
  assert.equal(result.embeddedState.custody, 'embedded')
  assert.equal(result.embeddedState.session.user.id, 'browser-user')
  assert.equal(result.localRecordExists, true, 'embedded key must persist to browser IndexedDB')
  assert.equal(result.externalState.custody, 'external')
  assert.equal(result.externalState.session, null)
  assert.equal(result.externalState.externalChain, 'evm')
  assert.equal(
    result.externalRecordExists,
    false,
    'external connection must not create a local key',
  )
  assert.equal(result.disconnected, true)
  assert.equal(result.finalExternalStatus, 'disconnected')
  assert.equal(apiRequests, 1, 'external connection must not exchange or create an API session')

  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'otp-test', use: 'sig', alg: 'RS256' }
  const otpRequests = []
  await page.route('https://auth.example.test/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    otpRequests.push(url.pathname)
    if (url.pathname === '/authorize') {
      assert.equal(url.searchParams.get('response_mode'), 'web_message')
      assert.equal(url.searchParams.get('prompt'), 'none')
      assert.equal(
        url.searchParams.get('custom_params'),
        JSON.stringify({ walletApiKey: 'browser-test-key' }),
      )
      const state = url.searchParams.get('state')
      const nonce = url.searchParams.get('nonce')
      assert.ok(state)
      assert.ok(nonce)
      const now = Math.floor(Date.now() / 1000)
      const header = Buffer.from(
        JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'otp-test' }),
      ).toString('base64url')
      const payload = Buffer.from(
        JSON.stringify({
          iss: 'https://auth.example.test/',
          aud: 'public-spa-id',
          sub: 'email|browser-otp-user',
          iat: now,
          exp: now + 300,
          nonce,
        }),
      ).toString('base64url')
      const unsigned = `${header}.${payload}`
      const idToken = `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), privateKey).toString('base64url')}`
      const response = {
        type: 'authorization_response',
        response: {
          access_token: 'otp-api-token',
          id_token: idToken,
          token_type: 'Bearer',
          expires_in: 300,
          state,
        },
      }
      await route.fulfill({
        contentType: 'text/html',
        body: `<script>parent.postMessage(${JSON.stringify(response)}, ${JSON.stringify(page.url().replace(/\/$/, ''))})</script>`,
      })
      return
    }
    let response
    if (url.pathname === '/passwordless/start') {
      const body = request.postDataJSON()
      assert.equal(body.send, 'code')
      assert.equal(body.connection, 'email')
      assert.equal(body.email, 'otp@example.test')
      response = { _id: 'otp-request' }
    } else if (url.pathname === '/co/authenticate') {
      const body = request.postDataJSON()
      assert.equal(body.otp, '246810')
      assert.equal(body.realm, 'email')
      response = { login_ticket: 'test-ticket', co_id: 'test-id', co_verifier: 'test-verifier' }
    } else if (url.pathname === '/.well-known/jwks.json') {
      response = { keys: [jwk] }
    } else if (url.pathname === '/userinfo') {
      response = { sub: 'email|browser-otp-user' }
    } else {
      throw new Error(`Unexpected Auth0 request: ${url.pathname}`)
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(response) })
  })
  let visiblePopups = 0
  page.on('popup', () => {
    visiblePopups += 1
  })
  await page.evaluate(async () => {
    const sdk = window.AltudeWalletSDK
    const { auth } = await sdk.createAuth0WalletAuth({
      domain: 'auth.example.test',
      clientId: 'public-spa-id',
      apiKey: 'browser-test-key',
      audience: 'https://api.example.test',
    })
    const wallet = new sdk.AltudeWallet({
      apiKey: 'browser-test-key',
      apiBaseUrl: 'https://api.example.test',
      auth,
    })
    const container = document.createElement('div')
    container.id = 'otp-wallet'
    document.body.append(container)
    sdk.mountWalletUI(container, wallet, {
      walletUi: {
        branding: { appName: 'Browser OTP' },
        authMethods: { emailOtp: true },
      },
    })
  })
  const otpWallet = page.locator('#otp-wallet')
  for (const width of [320, 375, 768]) {
    await page.setViewportSize({ width, height: 740 })
    const layout = await otpWallet.locator('.panel').evaluate((panel) => ({
      width: panel.getBoundingClientRect().width,
      scrollWidth: panel.scrollWidth,
      clientWidth: panel.clientWidth,
      font: getComputedStyle(panel).fontFamily,
      background: getComputedStyle(panel).backgroundImage,
    }))
    assert.ok(layout.width <= Math.min(420, width - 32) + 1)
    assert.ok(layout.scrollWidth <= layout.clientWidth, 'welcome screen must not overflow horizontally')
    assert.ok(layout.font.includes('Manrope'))
    assert.equal(layout.background, 'none', 'wallet surface must be flat')
  }
  await otpWallet.getByRole('textbox', { name: 'Email address' }).fill('otp@example.test')
  await otpWallet.getByRole('button', { name: 'Send code', exact: true }).click()
  await otpWallet.locator('.otp-fields input').first().waitFor()
  assert.equal(await otpWallet.locator('.otp-fields input').count(), 6)
  assert.equal(await otpWallet.getByRole('button', { name: 'Verify and continue' }).count(), 0)
  assert.equal(await otpWallet.getByRole('button', { name: 'Resend code' }).count(), 1)
  for (const width of [320, 375, 768]) {
    await page.setViewportSize({ width, height: 740 })
    const layout = await otpWallet.locator('.otp-fields').evaluate((fields) => ({
      width: fields.getBoundingClientRect().width,
      parentWidth: fields.parentElement.getBoundingClientRect().width,
      scrollWidth: fields.scrollWidth,
      clientWidth: fields.clientWidth,
    }))
    assert.ok(layout.width <= layout.parentWidth)
    assert.ok(layout.scrollWidth <= layout.clientWidth, 'code inputs must fit on mobile')
  }
  await otpWallet.getByRole('textbox', { name: 'Digit 1 of 6', exact: true }).pressSequentially('246810')
  await otpWallet.locator('.account-identity').waitFor()
  await page.setViewportSize({ width: 320, height: 740 })
  const accountFits = await otpWallet.locator('.panel').evaluate((panel) => panel.scrollWidth <= panel.clientWidth)
  assert.ok(accountFits, 'account summary must fit on mobile')
  assert.equal(visiblePopups, 0, 'email OTP must not open a visible Auth0 login popup')
  assert.ok(otpRequests.includes('/passwordless/start'))
  assert.ok(otpRequests.includes('/co/authenticate'))
  assert.ok(otpRequests.includes('/userinfo'))
  assert.ok(
    !otpRequests.includes('/oauth/token'),
    'browser OTP must not use the unsupported direct grant',
  )
  assert.equal(
    apiRequests,
    2,
    'verified OTP must exchange the API access token for a wallet session',
  )
  const consumerOrigin = new URL(page.url()).origin
  const brokerRequests = []
  let brokerAttempt
  let failNextOtp = true
  let brokerAddress
  let brokerMessage
  await page.route('https://api.example.test/api/browser-wallet/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname.replace('/api/browser-wallet', '')
    const body = request.method() === 'POST' ? request.postDataJSON() : {}
    brokerRequests.push({ path, body })
    assert.equal(request.headers()['x-api-key'], 'browser-broker-key')
    assert.equal(request.headers().origin, consumerOrigin)
    assert.equal(request.headers().cookie, undefined)
    let response
    let status = 200
    if (path === '/config') {
      response = { AppId: '-17.42', WalletAccessVersion: 1, EmailOtp: true, SmsOtp: true, SocialProviders: ['google-oauth2'] }
    } else if (path === '/otp/start' || path === '/authorize') {
      assert.match(body.State, /^[\w-]{43}$/)
      assert.match(body.CodeChallenge, /^[\w-]{43}$/)
      assert.equal(body.CodeChallengeMethod, 'S256')
      brokerAttempt = body
      if (path === '/otp/start') {
        assert.equal(body.Identifier, 'broker@example.test')
        response = { ChallengeId: 'broker-challenge', ExpiresIn: 300 }
      } else {
        assert.equal(body.Provider, 'google-oauth2')
        response = {
          AuthorizationUrl: `https://broker-auth.example.test/authorize?state=${body.State}`,
          TransactionId: 'browser-transaction',
        }
      }
    } else if (path === '/otp/verify') {
      assert.equal(body.ChallengeId, 'broker-challenge')
      if (failNextOtp) {
        assert.equal(body.Code, '111111')
        failNextOtp = false
        status = 400
        response = { Error: 'invalid_otp' }
      } else {
        assert.equal(body.Code, '246810')
        response = { Code: 'browser-handoff', State: brokerAttempt.State }
      }
    } else if (path === '/redeem') {
      assert.equal(body.Code, 'browser-handoff')
      assert.equal(createHash('sha256').update(body.CodeVerifier).digest('base64url'), brokerAttempt.CodeChallenge)
      response = { IdentityTicket: 'browser-identity-ticket', IdentityKey: 'auth0|broker-browser-user', ExpiresIn: 120 }
    } else if (path === '/wallet') {
      assert.deepEqual(body, { IdentityTicket: 'browser-identity-ticket' })
      brokerMessage = [
        'Altude Wallet Access Binding v1', 'Issuer: https://api.example.test',
        'AppId: -17.42', 'TenantId: -17', 'UserId: broker-browser-user',
        'IdentityKey: auth0|broker-browser-user', 'RefreshFamilyId: browser',
        `Origin: ${consumerOrigin}`,
        `IdentityTicket: ${createHash('sha256').update(body.IdentityTicket).digest('base64url')}`,
        'ChallengeId: browser-proof-challenge', `WalletAddress: ${brokerAddress ?? ''}`,
        'Nonce: random-browser-nonce',
      ].join('\n')
      response = {
        AppId: '-17.42', UserId: 'broker-browser-user', IdentityKey: 'auth0|broker-browser-user',
        WalletAddress: brokerAddress ?? null, ChallengeId: 'browser-proof-challenge',
        Message: brokerMessage, ExpiresIn: 60,
      }
    } else if (path === '/session') {
      assert.deepEqual(Object.keys(body).sort(), ['ChallengeId', 'IdentityTicket', 'Signature', 'WalletAddress'])
      assert.equal(body.IdentityTicket, 'browser-identity-ticket')
      assert.equal(body.ChallengeId, 'browser-proof-challenge')
      assert.match(body.WalletAddress, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/)
      let publicKeyNumber = 0n
      for (const character of body.WalletAddress) {
        publicKeyNumber = publicKeyNumber * 58n + BigInt('123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'.indexOf(character))
      }
      const rawKey = Buffer.from(publicKeyNumber.toString(16).padStart(64, '0'), 'hex')
      const publicKey = createPublicKey({
        key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), rawKey]),
        format: 'der', type: 'spki',
      })
      assert.match(body.Signature, /^[A-Za-z0-9+/]{86}==$/)
      assert.equal(verify(null, Buffer.from(brokerMessage, 'utf8'), publicKey, Buffer.from(body.Signature, 'base64')), true)
      if (brokerAddress) assert.equal(body.WalletAddress, brokerAddress, 'same identity must reuse its signer')
      brokerAddress = body.WalletAddress
      response = {
        Success: true, SessionToken: 'broker-opaque-session', AppId: '-17.42', UserId: 'broker-browser-user',
        User: { Id: 'broker-browser-user', Email: 'broker@example.test', WalletAddress: body.WalletAddress },
      }
    } else {
      throw new Error(`Unexpected browser broker request: ${path}`)
    }
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(response) })
  })
  await page.context().route('https://broker-auth.example.test/authorize**', async (route) => {
    const state = new URL(route.request().url()).searchParams.get('state')
    await route.fulfill({
      status: 302,
      headers: { Location: `https://api.example.test/api/browser-wallet/callback?state=${state}` },
    })
  })
  await page.context().route('https://api.example.test/api/browser-wallet/callback**', async (route) => {
    const state = new URL(route.request().url()).searchParams.get('state')
    await route.fulfill({
      contentType: 'text/html',
      body: `<script>window.opener.postMessage(${JSON.stringify({
        Type: 'altude:wallet:authorization', Code: 'browser-handoff', State: state,
      })}, ${JSON.stringify(consumerOrigin)});window.close()</script>`,
    })
  })
  await page.evaluate(async () => {
    const sdk = window.AltudeWalletSDK
    const broker = await sdk.createBrowserWalletAuth({
      apiKey: 'browser-broker-key', apiBaseUrl: 'https://api.example.test',
    })
    window.testBroker = broker
    const wallet = new sdk.AltudeWallet({
      apiKey: 'browser-broker-key', apiBaseUrl: 'https://api.example.test', auth: broker.auth,
    })
    window.testBrokerWallet = wallet
    const container = document.createElement('div')
    container.id = 'broker-wallet'
    document.body.append(container)
    sdk.mountWalletUI(container, wallet, {
      socialProviders: broker.socialProviders,
      walletUi: { authMethods: { emailOtp: true, socialProviders: ['google-oauth2'] } },
    })
  })
  const brokerWallet = page.locator('#broker-wallet')
  await brokerWallet.getByRole('textbox', { name: 'Email address' }).fill('broker@example.test')
  await brokerWallet.getByRole('button', { name: 'Send code', exact: true }).click()
  await brokerWallet.getByRole('textbox', { name: 'Digit 1 of 6', exact: true }).pressSequentially('111111')
  await brokerWallet.getByText('Code verification failed. Use Resend code to request a new code before trying again.').waitFor()
  assert.equal(visiblePopups, 0, 'broker OTP must preserve custom code-entry UI')
  await brokerWallet.getByRole('button', { name: 'Resend code', exact: true }).click()
  await page.waitForFunction(() => {
    const digit = document.querySelector('#broker-wallet .otp-fields input')
    return digit && !digit.disabled && digit.value === ''
  })
  await brokerWallet.getByRole('textbox', { name: 'Digit 1 of 6', exact: true }).pressSequentially('246810')
  await brokerWallet.locator('.account-identity').waitFor()
  assert.equal(await page.evaluate(() => window.testBrokerWallet.state.status), 'connected')
  await page.evaluate(() => {
    const sdk = window.AltudeWalletSDK
    const wallet = new sdk.AltudeWallet({
      apiKey: 'browser-broker-key', apiBaseUrl: 'https://api.example.test', auth: window.testBroker.auth,
    })
    window.testSocialBrokerWallet = wallet
    const container = document.createElement('div')
    container.id = 'broker-social'
    document.body.append(container)
    sdk.mountWalletUI(container, wallet, {
      socialProviders: window.testBroker.socialProviders,
      walletUi: { authMethods: { socialProviders: ['google-oauth2'] } },
    })
  })
  const socialWallet = page.locator('#broker-social')
  await socialWallet.getByRole('button', { name: 'Continue with Google', exact: true }).click()
  await socialWallet.locator('.account-identity').waitFor()
  assert.equal(await page.evaluate(() => window.testSocialBrokerWallet.state.status), 'connected')
  assert.equal(visiblePopups, 1, 'social broker must use one actual popup with a fixed callback')
  assert.equal(brokerRequests.filter(({ path }) => path === '/redeem').length, 2)
  assert.equal(brokerRequests.filter(({ path }) => path === '/session').length, 2)
  assert.equal(brokerRequests.filter(({ path }) => path === '/otp/start').length, 2, 'failed OTP requires explicit resend')
  assert.equal(apiRequests, 2, 'broker must never use the direct Auth0 exchange')
  await runCompletenessAcceptance(browser, `http://127.0.0.1:${address.port}`)
  console.log('Wallet real-browser integration passed in Microsoft Edge.')
} finally {
  await browser?.close()
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

async function runCompletenessAcceptance(browser, origin) {
  const page = await browser.newPage()
  await page.goto(origin)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.evaluate(() => {
    const sdk = window.AltudeWalletSDK
    window.testMount = (wallet, options = {}) => {
      window.unmountAcceptance?.()
      document.querySelector('#acceptance')?.remove()
      const container = document.createElement('div')
      container.id = 'acceptance'
      document.body.append(container)
      window.unmountAcceptance = sdk.mountWalletUI(container, wallet, options)
    }
    window.smsStarts = 0
    window.acceptanceWallet = new sdk.AltudeWallet({
      apiKey: 'acceptance', apiBaseUrl: 'https://api.example.test', auth: {
        startOtp: () => { window.smsStarts++; return new Promise((resolve) => { window.finishSms = resolve }) },
        verifyOtp: () => { throw new Error('Verification was not requested') },
      },
    })
    window.testMount(window.acceptanceWallet)
  })
  const root = page.locator('#acceptance')
  await root.getByText('No sign-in methods are configured for this wallet.').waitFor()
  assert.equal(await root.getByRole('textbox').count(), 0, 'absent configuration must not guess methods')
  await page.evaluate(() => {
    window.testMount(window.acceptanceWallet, {
      authMethods: { emailOtp: true },
      walletUi: { authMethods: { emailOtp: false, smsOtp: true },
        legal: { smsConsentText: 'I agree to receive a sign-in code.', termsUrl: 'https://legal.example/terms', privacyUrl: 'https://legal.example/privacy' } },
    })
  })
  assert.equal(await root.getByRole('textbox', { name: 'Email address' }).count(), 0, 'server allowlist overrides developer fallback')
  const phone = root.getByRole('textbox', { name: 'Phone number including country code' })
  const checkbox = root.getByRole('checkbox')
  await phone.fill('+12025550123')
  assert.equal(await checkbox.isChecked(), false)
  assert.equal(await root.getByRole('button', { name: 'Send code', exact: true }).isDisabled(), true)
  await root.locator('form').evaluate((form) => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  assert.equal(await page.evaluate(() => window.smsStarts), 0)
  await checkbox.check()
  await phone.fill('+12025550124')
  assert.equal(await checkbox.isChecked(), false, 'editing the number revokes consent')
  assert.equal(await root.getByRole('button', { name: 'Send code', exact: true }).isDisabled(), true)
  await checkbox.check()

  const focusEvidence = await page.evaluate(() => {
    const panel = document.querySelector('#acceptance [role=dialog]')
    return panel.contains(document.activeElement)
  })
  assert.equal(focusEvidence, true, 'modal owns focus, not the host launcher')
  const privacy = root.getByRole('link', { name: 'Privacy', exact: true })
  await privacy.focus()
  await page.keyboard.press('Tab')
  assert.equal(await phone.evaluate((element) => element === document.activeElement), true, 'legal link participates in modal focus wrap')
  await page.keyboard.press('Shift+Tab')
  assert.equal(await privacy.evaluate((element) => element === document.activeElement), true)
  await root.getByRole('button', { name: 'Send code', exact: true }).click()
  assert.equal(await page.evaluate(() => window.smsStarts), 1)
  const reducedMotion = await root.locator('button[type=submit]').evaluate((button) => ({
    element: getComputedStyle(button).animationName,
    pseudo: getComputedStyle(button, '::after').animationName,
  }))
  assert.equal(reducedMotion.element, 'none')
  assert.equal(reducedMotion.pseudo, 'none', 'pseudo-element spinners must stop too')
  await page.evaluate(() => window.finishSms())
  await root.getByRole('button', { name: 'Resend code', exact: true }).waitFor()

  await page.evaluate(() => {
    window.testMount(window.acceptanceWallet, { authMethods: { smsOtp: true } })
  })
  await root.getByText('SMS sign-in requires configured consent text.').waitFor()
  await root.getByRole('textbox').fill('+12025550123')
  assert.equal(await root.getByRole('button', { name: 'Send code', exact: true }).isDisabled(), true)
  assert.equal(await page.evaluate(() => window.smsStarts), 1, 'missing consent copy cannot send')

  await page.evaluate(() => {
    const sdk = window.AltudeWalletSDK
    window.providerConnections = 0
    window.unavailableWallet = new sdk.AltudeWallet({
      apiKey: 'acceptance', apiBaseUrl: 'https://api.example.test', auth: {},
      passkeys: { isAvailable: () => false, register: () => { throw new Error('Unavailable') }, deriveKey: () => { throw new Error('Unavailable') } },
      externalWallets: [{ id: 'phantom', label: 'Phantom', isAvailable: () => false, connect: () => { window.providerConnections++; throw new Error('Unavailable') } }],
    })
    window.testMount(window.unavailableWallet, { authMethods: { externalWallets: ['phantom'], passkey: true } })
  })
  await root.getByRole('button', { name: /Web3|wallets/i }).click()
  assert.equal(await root.getByRole('button', { name: 'Connect Phantom', exact: true }).isDisabled(), true)
  assert.equal(await root.getByRole('button', { name: 'Use a passkey', exact: true }).count(), 0)
  assert.equal(await page.evaluate(async () => {
    try { await window.unavailableWallet.connectExternalWallet('phantom'); return 'connected' }
    catch (error) { return error.code }
  }), 'CONFIGURATION')
  assert.equal(await page.evaluate(() => window.providerConnections), 0)

  for (const verified of [false, true]) {
    await page.evaluate((verified) => {
      window.testMount(window.unavailableWallet, { walletUi: { authMethods: {}, trust: {
        ikaRecoveryVerified: verified, soc2Verified: verified,
      } } })
    }, verified)
    assert.equal(await root.getByText('SOC 2', { exact: true }).count(), verified ? 1 : 0)
    assert.equal(await root.getByText('Secure recovery by Ika', { exact: true }).count(), verified ? 1 : 0)
  }
  await page.evaluate(() => {
    window.unmountAcceptance()
    const launcher = document.createElement('button')
    launcher.id = 'launcher'
    launcher.textContent = 'Open wallet'
    document.body.append(launcher)
    launcher.focus()
    window.testMount(window.unavailableWallet, { onClose: () => window.unmountAcceptance() })
  })
  await page.waitForFunction(() => document.querySelector('#acceptance [role=dialog]')?.contains(document.activeElement))
  await page.keyboard.press('Escape')
  assert.equal(await page.locator('#launcher').evaluate((button) => button === document.activeElement), true, 'Escape restores launcher focus')

  await page.evaluate(() => {
    const sdk = window.AltudeWalletSDK
    window.relayCalls = 0
    window.authCalls = 0
    window.authoritativeNetwork = 'devnet'
    window.balanceTokens = []
    window.localPasskeys = {
      isAvailable: () => true,
      register: async () => ({ credentialId: new Uint8Array([5]), kek: new Uint8Array(32).fill(7) }),
      deriveKey: async () => new Uint8Array(32).fill(7),
    }
    window.localGas = {
      getConfig: async () => ({ RpcEnvironment: window.authoritativeNetwork }),
      getBalance: async (options) => { window.balanceTokens.push(options.token); return { uiAmount: 7 } },
      createAccount: async () => { window.relayCalls++; return { Status: 'Success', Signature: '', Message: 'Account already exists' } },
      send: async () => { window.relayCalls++; return { Status: 'Success', Signature: 'synthetic-transfer' } },
    }
    window.localWallet = new sdk.AltudeWallet({
      apiKey: 'acceptance', apiBaseUrl: 'https://api.example.test', auth: {}, network: 'devnet', passkeys: window.localPasskeys, gasStation: window.localGas,
      fetch: async () => { window.authCalls++; throw new Error('Local-only wallet must not authenticate') },
    })
    window.testMount(window.localWallet, { authMethods: { passkey: true } })
  })
  await root.getByRole('button', { name: 'Create local wallet', exact: true }).click()
  await root.locator('.local-handle').waitFor()
  const local = await page.evaluate(async () => {
    const sdk = window.AltudeWalletSDK
    const state = window.localWallet.state
    const record = await new sdk.IndexedDbWalletStore().get(state.localIdentityKey)
    const signature = await window.localWallet.signMessage(new Uint8Array([1, 2, 3]))
    return { state, signature: Array.from(signature), recordHasSecret: 'secret' in record, hasCiphertext: record.ciphertext instanceof Uint8Array }
  })
  assert.equal(local.state.custody, 'local')
  assert.equal(local.state.session, null)
  assert.equal(local.recordHasSecret, false)
  assert.equal(local.hasCiphertext, true)
  assert.equal(verifyEd25519(local.state.address, Buffer.from([1, 2, 3]), Buffer.from(local.signature)), true)
  await root.getByRole('textbox', { name: 'Token mint (optional; leave empty for SOL)', exact: true }).fill('So11111111111111111111111111111111111111112')
  await root.getByRole('button', { name: 'Check balance', exact: true }).click()
  await page.waitForFunction(() => window.balanceTokens.length === 1)
  assert.equal(await page.evaluate(() => window.balanceTokens[0]), 'So11111111111111111111111111111111111111112')
  await root.getByRole('button', { name: 'Lock wallet', exact: true }).click()
  await root.getByRole('button', { name: 'Unlock with passkey', exact: true }).click()
  await root.getByRole('button', { name: 'Create token account', exact: true }).click()
  await root.getByRole('button', { name: 'Confirm and create', exact: true }).waitFor()
  assert.equal(await page.evaluate(() => window.relayCalls), 0, 'provisioning needs separate explicit approval')
  await root.getByRole('button', { name: 'Cancel', exact: true }).click()
  assert.equal(await page.evaluate(() => window.relayCalls), 0)
  await root.getByRole('button', { name: 'Create token account', exact: true }).click()
  await root.getByRole('button', { name: 'Confirm and create', exact: true }).click()
  await page.waitForFunction(() => window.relayCalls === 1)
  await root.getByText('Account already exists', { exact: true }).waitFor()
  await page.evaluate(() => {
    window.transactionOutcome = window.localWallet.requestTransaction({
      kind: 'sol-transfer', recipient: 'Vote111111111111111111111111111111111111111', amount: 1,
    }).then(() => 'submitted', (error) => error.code)
  })
  const transaction = root.getByRole('group', { name: /^Transaction confirmation/ })
  await transaction.waitFor()
  await transaction.getByText('Network: devnet', { exact: true }).waitFor()
  await transaction.getByRole('button', { name: 'Cancel', exact: true }).click()
  assert.equal(await page.evaluate(() => window.transactionOutcome), 'TRANSACTION')
  await page.evaluate(() => {
    window.transactionOutcome = window.localWallet.requestTransaction({
      kind: 'sol-transfer', recipient: 'Vote111111111111111111111111111111111111111', amount: 2,
    }).then(() => 'submitted', (error) => error.code)
  })
  await transaction.getByText('Network: devnet', { exact: true }).waitFor()
  await page.evaluate(() => { window.authoritativeNetwork = 'mainnet-beta' })
  await transaction.getByRole('button', { name: 'Confirm and submit', exact: true }).click()
  assert.equal(await page.evaluate(() => window.transactionOutcome), 'TRANSACTION', 'network changes invalidate reviewed approval')
  assert.equal(await page.evaluate(async () => {
    try { await window.localWallet.requestTransaction({ kind: 'sol-transfer', recipient: 'Vote111111111111111111111111111111111111111', amount: 1 }); return 'submitted' }
    catch (error) { return error.code }
  }), 'TRANSACTION')
  assert.equal(await page.evaluate(() => window.relayCalls), 1)
  await page.evaluate(async () => {
    window.authoritativeNetwork = 'devnet'
    await window.localWallet.signOut()
    const wallet = new window.AltudeWalletSDK.AltudeWallet({
      apiKey: 'acceptance', apiBaseUrl: 'https://api.example.test', auth: {}, passkeys: window.localPasskeys,
      fetch: async () => { window.authCalls++; throw new Error('No API authentication') },
    })
    window.reopenedLocalWallet = wallet
    window.testMount(wallet, { authMethods: { passkey: true } })
  })
  await root.getByRole('textbox', { name: 'Local wallet handle', exact: true }).fill(local.state.localIdentityKey)
  await root.getByRole('button', { name: 'Open local wallet', exact: true }).click()
  await root.locator('.local-handle').waitFor()
  assert.equal(await page.evaluate(() => window.reopenedLocalWallet.state.address), local.state.address)
  assert.equal(await page.evaluate(() => window.authCalls), 0)

  await testPersistentCreationRace(page)
  await testIframeSources(page, origin)
  await testLegacySocialOutcomes(page)
  await page.close()
}

async function testLegacySocialOutcomes(page) {
  let outcome = 'denied'
  let authorizations = 0
  await page.context().route('https://spa-acceptance.example.test/**', async (route) => {
    const url = new URL(route.request().url())
    assert.equal(url.pathname, '/authorize')
    assert.equal(url.searchParams.get('connection'), 'google-oauth2')
    assert.equal(url.searchParams.get('audience'), 'https://api.example.test')
    assert.equal(url.searchParams.get('customParams'), JSON.stringify({ walletApiKey: 'acceptance' }))
    authorizations++
    const state = url.searchParams.get('state')
    const target = new URL(page.url()).origin
    const response = { type: 'authorization_response', response: {
      state, error: 'access_denied', error_description: 'Consent denied for this test.',
    } }
    await route.fulfill({ contentType: 'text/html', body: outcome === 'denied'
      ? `<script>window.opener.postMessage(${JSON.stringify(response)}, ${JSON.stringify(target)});setTimeout(() => window.close(), 50)</script>`
      : '<script>window.close()</script>' })
  })
  await page.evaluate(async () => {
    const sdk = window.AltudeWalletSDK
    const adapter = await sdk.createAuth0WalletAuth({
      domain: 'spa-acceptance.example.test', clientId: 'acceptance-spa', apiKey: 'acceptance',
      audience: 'https://api.example.test', connections: { 'google-oauth2': 'google-oauth2' },
      otpConnections: { email: null, sms: null },
    })
    window.legacyApiCalls = 0
    const wallet = new sdk.AltudeWallet({
      apiKey: 'acceptance', apiBaseUrl: 'https://api.example.test', auth: adapter.auth,
      fetch: async () => { window.legacyApiCalls++; throw new Error('Rejected login cannot exchange a session') },
    })
    window.testMount(wallet, { socialProviders: adapter.socialProviders, authMethods: { socialProviders: ['google-oauth2'] } })
    window.legacyOutcomeWallet = wallet
  })
  const root = page.locator('#acceptance')
  await root.getByRole('button', { name: 'Continue with Google', exact: true }).click()
  await root.getByRole('alert').waitFor({ timeout: 5_000 }).catch(async (error) => {
    throw new Error(`Social denial did not surface (${authorizations} authorizations): ${await root.textContent()}`, { cause: error })
  })
  assert.match(await root.getByRole('alert').textContent(), /Consent denied/, `Auth0 popup attempts: ${authorizations}`)
  outcome = 'closed'
  await root.getByRole('button', { name: 'Try again', exact: true }).click()
  await root.getByRole('button', { name: 'Continue with Google', exact: true }).click()
  await root.getByRole('alert').filter({ hasText: /closed|cancel/i }).waitFor()
  assert.equal(authorizations, 2, 'legacy social retry is an explicit new popup action')
  assert.equal(await page.evaluate(() => window.legacyApiCalls), 0)
  assert.equal(await page.evaluate(() => window.legacyOutcomeWallet.state.status), 'disconnected')
}

async function testPersistentCreationRace(page) {
  const race = await page.evaluate(async () => {
    const sdk = window.AltudeWalletSDK
    const base = new sdk.IndexedDbWalletStore()
    let committed
    let release
    const committedPromise = new Promise((resolve) => { committed = resolve })
    const releasePromise = new Promise((resolve) => { release = resolve })
    let delay = true
    const delayedStore = {
      get: (key) => base.get(key), getByServerUserId: (id) => base.getByServerUserId(id),
      put: (record) => base.put(record), delete: (key) => base.delete(key),
      update: (key, update) => base.update(key, update),
      async createIfAbsent(record) {
        const result = await base.createIfAbsent(record)
        if (delay) { delay = false; committed(); await releasePromise }
        return result
      },
    }
    let exchanges = 0
    const makeWallet = (store) => new sdk.AltudeWallet({
      apiKey: 'race', apiBaseUrl: 'https://api.example.test', auth: {}, store,
      fetch: async (_url, request) => {
        exchanges++
        return new Response(JSON.stringify({ Success: true, SessionToken: 'race-session', User: {
          Id: 'race-owner', WalletAddress: JSON.parse(request.body).walletAddress,
        } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      },
    })
    const identity = { identityKey: 'real-idb-adopted-key-race', accessToken: 'synthetic' }
    const first = makeWallet(delayedStore)
    const cancelled = first.connect(identity)
    await committedPromise
    const adopted = await makeWallet(base).connect(identity)
    const newer = first.connect(identity)
    await new Promise((resolve) => setTimeout(resolve, 30))
    const beforeRelease = exchanges
    release()
    await cancelled
    const winner = await newer
    const reloaded = await makeWallet(new sdk.IndexedDbWalletStore()).connect(identity)
    const record = await base.get(identity.identityKey)
    const signature = await first.signMessage(new Uint8Array([8]))
    return { beforeRelease, adopted: adopted.address, winner: winner.address, reloaded: reloaded.address, stored: record.publicKey, signature: Array.from(signature) }
  })
  assert.equal(race.beforeRelease, 1, 'same-vault successor must wait for the pending committed write')
  assert.equal(race.adopted, race.winner)
  assert.equal(race.reloaded, race.winner, 'cancelled creation must not delete an adopted persisted key')
  assert.equal(race.stored, race.winner)
  assert.equal(verifyEd25519(race.winner, Buffer.from([8]), Buffer.from(race.signature)), true)
}

function verifyEd25519(address, message, signature) {
  let number = 0n
  for (const character of address) number = number * 58n + BigInt('123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'.indexOf(character))
  const key = createPublicKey({ key: Buffer.concat([
    Buffer.from('302a300506032b6570032100', 'hex'),
    Buffer.from(number.toString(16).padStart(64, '0'), 'hex'),
  ]), format: 'der', type: 'spki' })
  return verify(null, message, key, signature)
}

async function testIframeSources(page, origin) {
  const events = await page.evaluate(async (origin) => {
    const sdk = window.AltudeWalletSDK
    const makeFrame = (url) => new Promise((resolve) => {
      const frame = document.createElement('iframe')
      frame.onload = () => resolve(frame)
      frame.src = url
      document.body.append(frame)
    })
    const trusted = await makeFrame(`${origin}/trusted-frame`)
    const wrongSource = await makeFrame(`${origin}/wrong-source`)
    const wrongOrigin = await makeFrame(`${origin.replace('127.0.0.1', 'localhost')}/wrong-origin?parent=${encodeURIComponent(origin)}`)
    const provider = new sdk.WalletEmbedProvider({ walletUrl: `${origin}/trusted-frame`, iframe: trusted })
    const received = []
    let acceptTrusted
    const trustedReceived = new Promise((resolve) => { acceptTrusted = resolve })
    provider.on('session.changed', (event) => { received.push(event.state.address); acceptTrusted() })
    const envelope = { channel: sdk.WALLET_EMBED_CHANNEL, version: sdk.WALLET_EMBED_VERSION, id: 'unsolicited', type: 'session.changed', payload: { status: 'connected', address: 'test-address' } }
    const sender = `addEventListener('message', e => parent.postMessage(e.data, ${JSON.stringify(origin)}))`
    for (const frame of [trusted, wrongSource]) frame.contentWindow.eval(sender)
    let invalidDeliveries = 0
    let acceptInvalid
    const invalidReceived = new Promise((resolve, reject) => {
      acceptInvalid = resolve
      setTimeout(() => reject(new Error('Both untrusted frames must actually deliver messages')), 5_000)
    })
    const observe = (event) => {
      if (event.data?.type === 'session.changed' &&
        (event.source === wrongSource.contentWindow || event.source === wrongOrigin.contentWindow)) {
        if (++invalidDeliveries === 2) acceptInvalid()
      }
    }
    window.addEventListener('message', observe)
    // Both untrusted messages are delivered by real browser frame windows.
    wrongOrigin.contentWindow.postMessage(envelope, new URL(wrongOrigin.src).origin)
    wrongSource.contentWindow.postMessage(envelope, origin)
    await invalidReceived
    const afterWrongSources = received.length
    trusted.contentWindow.postMessage(envelope, origin)
    await trustedReceived
    window.removeEventListener('message', observe)
    provider.destroy()
    for (const frame of [trusted, wrongSource, wrongOrigin]) frame.remove()
    return { afterWrongSources, received }
  }, origin)
  assert.equal(events.afterWrongSources, 0, 'real same-origin wrong-source and cross-origin frames are ignored')
  assert.deepEqual(events.received, ['test-address'], 'only the exact configured frame can change wallet state')
}
