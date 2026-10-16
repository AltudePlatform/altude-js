import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { build } from 'esbuild'

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
  console.log('Wallet real-browser integration passed in Microsoft Edge.')
} finally {
  await browser?.close()
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}
