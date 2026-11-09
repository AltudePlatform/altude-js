import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import { build } from 'esbuild'
import { createHash, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto'
import { createRequire } from 'node:module'

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
  stdin: {
    contents: "export * from './src/index.ts'; export { AltudeGasStation } from '../gasstation/src/index.ts'",
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
    loader: 'ts',
  },
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
  await testDemo(browser)
  console.log('Wallet real-browser integration passed in Microsoft Edge.')
} finally {
  await browser?.close()
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

async function testDemo(browser) {
  const demoRoot = fileURLToPath(new URL('../../../examples/wallet-infrastructure-demo/', import.meta.url))
  const require = createRequire(new URL('../../../examples/wallet-infrastructure-demo/package.json', import.meta.url))
  const vitePackage = pathToFileURL(require.resolve('vite/package.json'))
  const { createServer: createViteServer } = await import(new URL('./dist/node/index.js', vitePackage))
  const vite = await createViteServer({
    root: demoRoot, configFile: false, logLevel: 'silent',
    server: { host: '127.0.0.1', port: 0, strictPort: false },
  })
  let page
  try {
    await vite.listen()
    const port = vite.httpServer.address().port
    const origin = `http://127.0.0.1:${port}`
    page = await browser.newPage()
    const external = []
    await page.route('**/*', async (route) => {
      if (new URL(route.request().url()).origin !== origin) {
        external.push(route.request().url())
        await route.abort()
      } else await route.continue()
    })
    await page.goto(origin)
    await page.getByRole('button', { name: 'Open wallet', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('textbox', { name: 'Email address' }).fill('demo@example.test')
    await dialog.getByRole('button', { name: 'Send code', exact: true }).click()
    await dialog.getByRole('textbox', { name: 'Digit 1 of 6', exact: true }).pressSequentially('246810')
    await dialog.locator('.account-identity').waitFor()
    await dialog.getByRole('button', { name: 'Create token account', exact: true }).click()
    await dialog.getByRole('button', { name: 'Confirm and create', exact: true }).click()
    await dialog.getByText('Simulated token account creation. No transaction was sent to Solana.', { exact: true }).waitFor()
    const evidence = await page.evaluate(async () => {
      const { createDemoWallet } = await import('/src/main.ts')
      const wallet = createDemoWallet('demo-only-api-key', 'https://api.demo.invalid', [])
      const state = await wallet.connect({
        identityKey: 'wallet-demo:demo@example.test',
        accessToken: 'demo-token:demo%40example.test',
      })
      const confirmations = []
      wallet.onEvent((event) => {
        if (event.type === 'transaction:confirmation') {
          confirmations.push(event.intent)
          void wallet.approveTransaction(event.id)
        } else if (event.type === 'provisioning:confirmation') {
          confirmations.push({ operation: 'provision', network: event.network, tokens: event.tokens })
          void wallet.approveProvisioning(event.id)
        }
      })
      const recipient = 'Vote111111111111111111111111111111111111111'
      const mint = 'So11111111111111111111111111111111111111112'
      const provision = await wallet.createAccount([mint])
      const sol = await wallet.requestTransaction({ kind: 'sol-transfer', recipient, amount: 25 })
      const spl = await wallet.requestTransaction({ kind: 'spl-transfer', recipient, mint, amount: 31 })
      return { address: state.address, confirmations, provision, sol, spl }
    })
    const messages = [
      { result: evidence.provision, payload: { operation: 'provision', tokens: ['So11111111111111111111111111111111111111112'] } },
      { result: evidence.sol, payload: { operation: 'transfer', recipient: 'Vote111111111111111111111111111111111111111', amount: 25, token: null } },
      { result: evidence.spl, payload: { operation: 'transfer', recipient: 'Vote111111111111111111111111111111111111111', amount: 31, token: 'So11111111111111111111111111111111111111112' } },
    ]
    assert.equal(evidence.confirmations.length, 3)
    for (const { result, payload } of messages) {
      const message = JSON.stringify({ domain: 'altude-wallet-demo-simulation-v1', network: 'devnet', signer: evidence.address, ...payload })
      assert.equal(verifyEd25519(evidence.address, Buffer.from(message), Buffer.from(result.Signature ?? result.signature, 'base64')), true)
      assert.match(result.Message ?? result.message, /Simulated/)
    }
    assert.deepEqual(external, [], 'simulated demo must make no external requests')
  } finally {
    await page?.close()
    await vite.close()
  }
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
        verifyOtp: () => new Promise((resolve) => { window.finishVerify = resolve }),
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
  await page.evaluate(() => window.finishSms())
  await root.getByRole('button', { name: 'Resend code', exact: true }).waitFor()
  await root.getByRole('checkbox').uncheck()
  assert.equal(await root.getByRole('button', { name: 'Resend code', exact: true }).isDisabled(), true)
  assert.equal(await page.evaluate(() => window.smsStarts), 1)
  await root.getByRole('checkbox').check()
  await root.getByRole('button', { name: 'Resend code', exact: true }).click()
  assert.equal(await page.evaluate(() => window.smsStarts), 2)
  await page.evaluate(() => window.finishSms())
  await root.getByRole('textbox', { name: 'Digit 1 of 6', exact: true }).pressSequentially('246810')
  await root.locator('.setup-orb').waitFor()
  const reducedMotion = await root.evaluate((container) => ({
    orb: getComputedStyle(container.querySelector('.setup-orb'), '::after').animationName,
    spinner: getComputedStyle(container.querySelector('.setup-step-spinner')).animationName,
  }))
  assert.equal(reducedMotion.orb, 'none', 'the real setup orb pseudo-element stops')
  assert.equal(reducedMotion.spinner, 'none', 'the real setup-step spinner stops')
  await page.evaluate(() => window.unmountAcceptance())

  await page.evaluate(() => {
    window.testMount(window.acceptanceWallet, { authMethods: { smsOtp: true } })
  })
  await root.getByText('SMS sign-in requires configured consent text.').waitFor()
  await root.getByRole('textbox').fill('+12025550123')
  assert.equal(await root.getByRole('button', { name: 'Send code', exact: true }).isDisabled(), true)
  assert.equal(await page.evaluate(() => window.smsStarts), 2, 'missing consent copy cannot send')

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
  assert.equal(await root.getByRole('button', { name: /Web3|wallets/i }).count(), 0)
  assert.equal(await root.getByRole('button', { name: 'Connect Phantom', exact: true }).count(), 0)
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
      send: async (options) => {
        window.relayCalls++
        const bytes = new TextEncoder().encode('synthetic approved transfer')
        const signature = await options.sourceSigner.signTransactionMessage(bytes)
        options.beforeDispatch?.()
        window.transferSignature = Array.from(signature)
        window.transferOptions = { account: options.account, recipient: options.toAddress, amount: options.amount, network: options.expectedNetwork }
        return { Status: 'Success', Signature: 'synthetic-transfer' }
      },
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
  await page.evaluate(() => {
    window.authoritativeNetwork = 'devnet'
    window.transactionOutcome = window.localWallet.requestTransaction({
      kind: 'sol-transfer', recipient: 'Vote111111111111111111111111111111111111111', amount: 3,
    })
  })
  await transaction.getByText('Network: devnet', { exact: true }).waitFor()
  await transaction.getByRole('button', { name: 'Confirm and submit', exact: true }).click()
  const completed = await page.evaluate(async () => ({
    result: await window.transactionOutcome,
    signature: window.transferSignature,
    options: window.transferOptions,
  }))
  assert.equal(completed.result.signature, 'synthetic-transfer')
  assert.deepEqual(completed.options, { account: local.state.address, recipient: 'Vote111111111111111111111111111111111111111', amount: 3, network: 'devnet' })
  assert.equal(verifyEd25519(local.state.address, Buffer.from('synthetic approved transfer'), Buffer.from(completed.signature)), true)
  assert.equal(await page.evaluate(() => window.relayCalls), 2)
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
  await testIdentityAndPresentations(page)
  await testStaleRestore(page)
  await testConnectBeforeRestore(page)
  await testRealRelayCancellation(page)
  await testRealRelayNetworkChange(page)
  await testIframeSources(page, origin)
  await testLegacySocialOutcomes(page)
  await page.close()
}

async function testConnectBeforeRestore(page) {
  const result = await page.evaluate(async () => {
    const sdk = window.AltudeWalletSDK
    const base = new sdk.IndexedDbWalletStore()
    let pauseRead = false
    let readReached, releaseRead, exchangeReached, releaseExchange
    const readWaiting = new Promise((resolve) => { readReached = resolve })
    const readGate = new Promise((resolve) => { releaseRead = resolve })
    const exchangeWaiting = new Promise((resolve) => { exchangeReached = resolve })
    const exchangeGate = new Promise((resolve) => { releaseExchange = resolve })
    const store = {
      get: async (key) => {
        const record = await base.get(key)
        if (pauseRead) { pauseRead = false; readReached(); await readGate }
        return record
      },
      getByServerUserId: (id) => base.getByServerUserId(id),
      put: (record) => base.put(record),
      delete: (key) => base.delete(key),
      update: (key, fn) => base.update(key, fn),
      createIfAbsent: (record) => base.createIfAbsent(record),
    }
    let exchangeCount = 0
    let user
    const wallet = new sdk.AltudeWallet({
      apiKey: 'connect-restore-race', apiBaseUrl: 'https://api.example.test', auth: {}, store,
      fetch: async (url, request) => {
        if (url.endsWith('/auth0')) {
          exchangeCount++
          const address = JSON.parse(request.body).walletAddress
          if (exchangeCount === 2) { exchangeReached(); await exchangeGate }
          user = { Id: 'connect-restore-user', WalletAddress: address }
          return new Response(JSON.stringify({ Success: true, SessionToken: 'persisted-restore-token', User: user }))
        }
        if (url.endsWith('/session')) {
          if (new Headers(request.headers).get('Authorization') !== 'Bearer persisted-restore-token')
            throw new Error('Restore must use the persisted session token')
          return new Response(JSON.stringify({ IsAuthenticated: true, User: user }))
        }
        throw new Error(`Unexpected request ${url}`)
      },
    })
    const identity = { identityKey: 'connect-before-restore-identity', accessToken: 'synthetic' }
    const initial = await wallet.connect(identity)
    const persisted = await base.get(identity.identityKey)
    const connect = wallet.connect(identity)
    await exchangeWaiting
    pauseRead = true
    let restoreFinished = false
    const restore = wallet.restoreSession().finally(() => { restoreFinished = true })
    await readWaiting
    releaseExchange()
    await connect
    const pendingAtConnectCompletion = !restoreFinished
    releaseRead()
    const restored = await restore
    const signature = await wallet.signMessage(new TextEncoder().encode('connect before restore'))
    return { initial, persisted: persisted?.publicKey, pendingAtConnectCompletion, restored, final: wallet.state, signature: Array.from(signature), exchangeCount }
  })
  assert.equal(result.persisted, result.initial.address, 'initial key must be persisted in IndexedDB')
  assert.equal(result.exchangeCount, 2)
  assert.equal(result.pendingAtConnectCompletion, true, 'older connect must finish while restore local read is blocked')
  assert.equal(result.restored.status, 'connected')
  assert.equal(result.restored.address, result.initial.address)
  assert.equal(result.final.session.user.id, 'connect-restore-user')
  assert.equal(result.final.status, 'connected')
  assert.equal(verifyEd25519(result.final.address, Buffer.from('connect before restore'), Buffer.from(result.signature)), true)
}

async function testStaleRestore(page) {
  const result = await page.evaluate(async () => {
    const sdk = window.AltudeWalletSDK
    const base = new sdk.IndexedDbWalletStore()
    let pause = false
    let release
    let reached
    const waiting = new Promise((resolve) => { reached = resolve })
    const gate = new Promise((resolve) => { release = resolve })
    const store = {
      get: async (key) => {
        const record = await base.get(key)
        if (pause) { pause = false; reached(); await gate }
        return record
      },
      getByServerUserId: (id) => base.getByServerUserId(id),
      put: (record) => base.put(record),
      delete: (key) => base.delete(key),
      update: (key, fn) => base.update(key, fn),
      createIfAbsent: (record) => base.createIfAbsent(record),
    }
    let user
    const wallet = new sdk.AltudeWallet({
      apiKey: 'restore-race', apiBaseUrl: 'https://api.example.test', auth: {}, store,
      fetch: async (url, request) => {
        if (url.endsWith('/auth0')) {
          user = { Id: 'restore-race-user', WalletAddress: JSON.parse(request.body).walletAddress }
          return new Response(JSON.stringify({ Success: true, SessionToken: 'restore-race-token', User: user }))
        }
        if (url.endsWith('/session')) return new Response(JSON.stringify({ IsAuthenticated: true, User: user }))
        throw new Error(`Unexpected restore request ${url}`)
      },
    })
    const identity = { identityKey: 'restore-race-identity', accessToken: 'synthetic' }
    const initial = await wallet.connect(identity)
    pause = true
    const restoring = wallet.restoreSession()
    await waiting
    const newer = wallet.connect(identity)
    release()
    await restoring
    const connected = await newer
    const signature = await wallet.signMessage(new TextEncoder().encode('restore race winner'))
    return { initial, connected, final: wallet.state, signature: Array.from(signature) }
  })
  assert.equal(result.connected.address, result.initial.address)
  assert.equal(result.final.status, 'connected', 'stale restore must not lock a newer session')
  assert.equal(verifyEd25519(result.final.address, Buffer.from('restore race winner'), Buffer.from(result.signature)), true)
}

async function testRealRelayCancellation(page) {
  let relayCount = 0
  let configCount = 0
  let reachedRefresh
  let releaseRefresh
  const refreshReached = new Promise((resolve) => { reachedRefresh = resolve })
  const refreshRelease = new Promise((resolve) => { releaseRefresh = resolve })
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' }
  await page.route('https://relay-acceptance.example.test/**', async (route) => {
    const request = route.request()
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
    const path = new URL(request.url()).pathname
    if (path === '/api/transaction/config') {
      configCount++
      if (relayCount) {
        reachedRefresh()
        await refreshRelease
      }
      await route.fulfill({ headers: cors, contentType: 'application/json', body: JSON.stringify({
        FeePayer: 'ALTn7gyjm29WthZGgs4z6WVAK2PK5U6w4FAtPg3TPY71',
        RpcUrl: 'https://rpc-acceptance.example.test',
        Token: 'synthetic-rpc-token', TokenExpiration: null, RpcEnvironment: 'devnet',
      }) })
    } else if (path.toLowerCase() === '/api/transaction/send') {
      relayCount++
      assert.equal(request.method(), 'POST')
      assert.ok(Object.values(request.postDataJSON()).some((value) => typeof value === 'string' && value.length > 40), 'real facade must relay a signed transaction')
      await route.fulfill({ status: 401, headers: cors, body: 'expired synthetic authorization' })
    } else throw new Error(`Unexpected relay request ${path}`)
  })
  await page.route('https://rpc-acceptance.example.test/**', async (route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
    const body = route.request().postDataJSON()
    assert.equal(body.method, 'getLatestBlockhash')
    assert.equal(route.request().headers().authorization, 'Bearer synthetic-rpc-token')
    await route.fulfill({ headers: cors, contentType: 'application/json', body: JSON.stringify({
      jsonrpc: '2.0', id: body.id,
      result: { context: { slot: 1 }, value: { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 100 } },
    }) })
  })
  try {
    await page.evaluate(async () => {
      const sdk = window.AltudeWalletSDK
      const gasStation = new sdk.AltudeGasStation({ apiKey: 'real-relay-test', baseUrl: 'https://relay-acceptance.example.test', network: 'devnet' })
      const wallet = new sdk.AltudeWallet({
        apiKey: 'real-relay-test', apiBaseUrl: 'https://api.example.test', auth: {}, network: 'devnet', gasStation,
        fetch: async (url, request) => {
          if (url.endsWith('/auth0')) return new Response(JSON.stringify({
            Success: true, SessionToken: 'relay-session',
            User: { Id: 'relay-user', WalletAddress: JSON.parse(request.body).walletAddress },
          }), { headers: { 'Content-Type': 'application/json' } })
          if (url.endsWith('/signout')) return new Response('{"Success":true}', { headers: { 'Content-Type': 'application/json' } })
          throw new Error(`Unexpected identity request ${url}`)
        },
      })
      await wallet.connect({ identityKey: 'real-relay-identity', accessToken: 'synthetic' })
      window.realRelayWallet = wallet
      wallet.onEvent((event) => {
        if (event.type === 'transaction:confirmation')
          window.realRelayApproval = wallet.approveTransaction(event.id).then(() => 'submitted', (error) => error.code)
      })
      window.realRelayOutcome = wallet.requestTransaction({
        kind: 'sol-transfer', recipient: 'Vote111111111111111111111111111111111111111', amount: 1,
      }).then(() => 'submitted', (error) => { window.realRelayError = error.message; return error.code })
    })
    await Promise.race([refreshReached, page.waitForFunction(() => window.realRelayError, null, { timeout: 15_000 }).then(async () => { throw new Error(`Real relay failed: ${await page.evaluate(() => window.realRelayError)}`) })])
    await page.evaluate(() => window.realRelayWallet.signOut())
    releaseRefresh()
    assert.equal(await page.evaluate(() => window.realRelayOutcome), 'SESSION')
    assert.equal(await page.evaluate(() => window.realRelayApproval), 'SESSION')
    assert.equal(relayCount, 1, 'sign-out during refresh must prevent the authenticated retry')
    assert.ok(configCount >= 2, 'real dispatcher must refresh configuration after relay 401')
  } finally {
    releaseRefresh()
    await page.unroute('https://relay-acceptance.example.test/**')
    await page.unroute('https://rpc-acceptance.example.test/**')
  }
}

async function testRealRelayNetworkChange(page) {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' }
  for (const operation of ['transfer', 'provision']) {
    let relayCount = 0
    const configNetworks = []
    const rpcMethods = []
    const base = `https://network-${operation}.example.test`
    const rpc = `https://rpc-network-${operation}.example.test`
    await page.route(`${base}/**`, async (route) => {
      const request = route.request()
      if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
      assert.equal(request.headers()['x-api-key'], `network-${operation}`)
      const path = new URL(request.url()).pathname.toLowerCase()
      if (path === '/api/transaction/config') {
        const network = relayCount ? 'mainnet-beta' : 'devnet'
        configNetworks.push(network)
        await route.fulfill({ headers: cors, contentType: 'application/json', body: JSON.stringify({
          FeePayer: 'ALTn7gyjm29WthZGgs4z6WVAK2PK5U6w4FAtPg3TPY71',
          RpcUrl: rpc, Token: 'synthetic-network-token', TokenExpiration: null, RpcEnvironment: network,
        }) })
      } else {
        assert.equal(path, operation === 'transfer' ? '/api/transaction/send' : '/api/account/create')
        relayCount++
        const body = request.postDataJSON()
        const signed = body.SignedTransaction ?? body.signedTransaction
        assert.equal(typeof signed, 'string')
        assert.ok(Buffer.from(signed, 'base64').length > 100, 'actual facade must submit a signed transaction')
        await route.fulfill({ status: 401, headers: cors, body: 'synthetic expired authorization' })
      }
    })
    await page.route(`${rpc}/**`, async (route) => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
      assert.equal(route.request().headers().authorization, 'Bearer synthetic-network-token')
      const body = route.request().postDataJSON()
      rpcMethods.push(body.method)
      const value = body.method === 'getAccountInfo'
        ? null
        : body.method === 'getLatestBlockhash'
          ? { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 100 }
          : undefined
      assert.notEqual(value, undefined, `Unexpected RPC method ${body.method}`)
      await route.fulfill({ headers: cors, contentType: 'application/json', body: JSON.stringify({
        jsonrpc: '2.0', id: body.id, result: { context: { slot: 1 }, value },
      }) })
    })
    try {
      const evidence = await page.evaluate(async ({ operation, base }) => {
        const sdk = window.AltudeWalletSDK
        const gasStation = new sdk.AltudeGasStation({ apiKey: `network-${operation}`, baseUrl: base, network: 'devnet' })
        const wallet = new sdk.AltudeWallet({
          apiKey: `network-${operation}`, apiBaseUrl: 'https://api.example.test', network: 'devnet', auth: {}, gasStation,
          fetch: async (url, request) => {
            if (!url.endsWith('/auth0')) throw new Error(`Unexpected identity request ${url}`)
            return new Response(JSON.stringify({
              Success: true, SessionToken: 'network-session',
              User: { Id: `network-${operation}`, WalletAddress: JSON.parse(request.body).walletAddress },
            }))
          },
        })
        await wallet.connect({ identityKey: `network-refresh-${operation}`, accessToken: 'synthetic' })
        let approval
        let confirmedNetwork
        wallet.onEvent((event) => {
          if (event.type === 'transaction:confirmation' || event.type === 'provisioning:confirmation') {
            confirmedNetwork = event.type === 'transaction:confirmation' ? event.intent.network : event.network
            const promise = event.type === 'transaction:confirmation'
              ? wallet.approveTransaction(event.id) : wallet.approveProvisioning(event.id)
            approval = promise.then(() => ({ success: true }), (error) => ({ code: error.code, message: error.message }))
          }
        })
        const request = operation === 'transfer'
          ? wallet.requestTransaction({ kind: 'sol-transfer', recipient: 'Vote111111111111111111111111111111111111111', amount: 1 })
          : wallet.createAccount(['So11111111111111111111111111111111111111112'])
        const outcome = await request.then(() => ({ success: true }), (error) => ({ code: error.code, message: error.message }))
        return { confirmedNetwork, outcome, approval: await approval }
      }, { operation, base })
      assert.equal(evidence.confirmedNetwork, 'devnet')
      assert.equal(evidence.outcome.code, 'RPC_ERROR')
      assert.equal(evidence.approval.code, 'RPC_ERROR')
      assert.match(evidence.outcome.message, /environment changed/i)
      assert.equal(relayCount, 1, `${operation}: no retry or fallback after refreshed network changes`)
      assert.equal(configNetworks.at(-1), 'mainnet-beta')
      assert.ok(configNetworks.includes('devnet'))
      assert.ok(rpcMethods.includes('getLatestBlockhash'))
      if (operation === 'provision') assert.ok(rpcMethods.includes('getAccountInfo'))
    } finally {
      await page.unroute(`${base}/**`)
      await page.unroute(`${rpc}/**`)
    }
  }
}

async function testIdentityAndPresentations(page) {
  for (const presentation of ['inline', 'fullscreen']) {
    await page.evaluate((presentation) => {
      const sdk = window.AltudeWalletSDK
      const sessions = new Map()
      window.presentationRequests = []
      const wallet = new sdk.AltudeWallet({
        apiKey: `presentation-${presentation}`, apiBaseUrl: 'https://api.example.test',
        auth: {
          startOtp: async () => {},
          verifyOtp: async (_channel, identifier) => ({ identityKey: `identity:${presentation}:${identifier}`, accessToken: identifier }),
        },
        fetch: async (url, request) => {
          const path = new URL(url).pathname
          window.presentationRequests.push(path)
          let data
          if (path.endsWith('/auth0')) {
            const body = JSON.parse(request.body)
            const user = { id: body.accessToken, email: body.accessToken, walletAddress: body.walletAddress }
            const token = `token:${body.accessToken}`
            sessions.set(token, user)
            data = { Success: true, SessionToken: token, User: user }
          } else if (path.endsWith('/session')) {
            const token = new Headers(request.headers).get('Authorization').replace('Bearer ', '')
            data = { IsAuthenticated: true, User: sessions.get(token) }
          } else throw new Error(`Unexpected request ${path}`)
          return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } })
        },
      })
      window.presentationWallet = wallet
      window.testMount(wallet, { presentation, authMethods: { emailOtp: true } })
    }, presentation)
    const root = page.locator('#acceptance')
    assert.equal(await root.getByRole('region').count(), 1)
    assert.equal(await root.getByRole('dialog').count(), 0)
    const email = root.getByRole('textbox', { name: 'Email address' })
    await email.fill('')
    await email.fill('first@example.test')
    await root.getByRole('button', { name: 'Send code', exact: true }).click()
    await root.getByRole('textbox', { name: 'Digit 1 of 6', exact: true }).pressSequentially('246810')
    await root.getByText('first@example.test', { exact: true }).waitFor()
    const identities = await page.evaluate(async (presentation) => {
      const wallet = window.presentationWallet
      const first = wallet.state
      const second = await wallet.connect({ identityKey: `identity:${presentation}:second@example.test`, accessToken: 'second@example.test' })
      const signature = await wallet.signMessage(new TextEncoder().encode('identity switch'))
      const restored = await wallet.restoreSession()
      const restoredSignature = await wallet.signMessage(new TextEncoder().encode('identity restore'))
      return { first, second, restored, signature: Array.from(signature), restoredSignature: Array.from(restoredSignature) }
    }, presentation)
    assert.notEqual(identities.first.address, identities.second.address)
    assert.equal(identities.second.session.user.id, 'second@example.test')
    assert.equal(identities.restored.address, identities.second.address)
    assert.equal(identities.restored.session.user.id, 'second@example.test')
    assert.equal(verifyEd25519(identities.second.address, Buffer.from('identity switch'), Buffer.from(identities.signature)), true)
    assert.equal(verifyEd25519(identities.second.address, Buffer.from('identity restore'), Buffer.from(identities.restoredSignature)), true)
    await root.getByText('second@example.test', { exact: true }).waitFor()
    assert.deepEqual(await page.evaluate(() => window.presentationRequests), [
      '/api/EmbeddedWallet/auth0', '/api/EmbeddedWallet/auth0', '/api/EmbeddedWallet/session',
    ])
  }
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
    const provider = new sdk.WalletEmbedProvider({ walletUrl: `${origin}/trusted-frame`, iframe: trusted })
    const received = []
    let acceptTrusted
    const trustedReceived = new Promise((resolve) => { acceptTrusted = resolve })
    provider.on('session.changed', (event) => { received.push(event.state.address); acceptTrusted() })
    const envelope = { channel: sdk.WALLET_EMBED_CHANNEL, version: sdk.WALLET_EMBED_VERSION, id: 'unsolicited', type: 'session.changed', payload: { status: 'connected', address: 'test-address' } }
    const sender = `addEventListener('message', e => parent.postMessage(e.data, ${JSON.stringify(origin)}))`
    for (const frame of [trusted, wrongSource]) frame.contentWindow.eval(sender)
    const observed = (source, expectedOrigin) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Expected frame message was not delivered')), 5_000)
      const listener = (event) => {
        if (event.data?.type !== 'session.changed' || event.source !== source || event.origin !== expectedOrigin) return
        clearTimeout(timer)
        window.removeEventListener('message', listener)
        resolve()
      }
      window.addEventListener('message', listener)
    })
    const wrongSourceDelivered = observed(wrongSource.contentWindow, origin)
    wrongSource.contentWindow.postMessage(envelope, origin)
    await wrongSourceDelivered
    trusted.contentWindow.postMessage(envelope, origin)
    await trustedReceived
    const otherOrigin = origin.replace('127.0.0.1', 'localhost')
    await new Promise((resolve) => {
      trusted.onload = resolve
      trusted.src = `${otherOrigin}/wrong-origin?parent=${encodeURIComponent(origin)}`
    })
    const wrongOriginDelivered = observed(trusted.contentWindow, otherOrigin)
    trusted.contentWindow.postMessage({ ...envelope, payload: { status: 'connected', address: 'wrong-origin' } }, otherOrigin)
    await wrongOriginDelivered
    provider.destroy()
    for (const frame of [trusted, wrongSource]) frame.remove()
    return received
  }, origin)
  assert.deepEqual(events, ['test-address'], 'reject wrong source and wrong origin even when the source is the configured frame')
}
