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
  console.log('Wallet real-browser integration passed in Microsoft Edge.')
} finally {
  await browser?.close()
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}
