import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const packageDirectories = ['core', 'gasstation', 'wallet-react-native']

for (const directory of packageDirectories) {
  const packageRoot = join(root, 'packages', directory)
  const packageJson = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
  const nativeEntry = packageJson.exports['.']['react-native']
  assert.equal(packageJson['react-native'], nativeEntry)
  const nativeArtifact = await readFile(join(packageRoot, nativeEntry), 'utf8')
  if (directory === 'wallet-react-native') {
    assert.doesNotMatch(nativeArtifact, /\b(?:Buffer|ws)\b/)
    assert.doesNotMatch(nativeArtifact, /(?:from|require\() ['"]node:/)
    continue
  }

  const browserEntry = packageJson.exports['.'].browser
  assert.equal(packageJson.browser, browserEntry)
  const browserArtifact = await readFile(join(packageRoot, browserEntry), 'utf8')

  assert.match(nativeArtifact, /from 'gill\/react-native'/)
  assert.match(browserArtifact, /from 'gill\/browser'/)
  assert.doesNotMatch(nativeArtifact, /(?:from|require\() ['"]gill['"]/)
  assert.doesNotMatch(nativeArtifact, /\b(?:Buffer|ws)\b/)
}

async function bundleNativePackage(directory) {
  const bundle = await build({
    entryPoints: [join(root, 'packages', directory, 'dist', 'index.native.js')],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    conditions: ['react-native'],
    treeShaking: true,
  })
  const source = bundle.outputFiles[0].text

  assert.doesNotMatch(source, /node_modules[\\/]ws[\\/]/)
  assert.doesNotMatch(source, /from ['"]ws['"]/)
  assert.doesNotMatch(source, /\bBuffer\b/)

  return source
}

await bundleNativePackage('core')
const bundledSource = await bundleNativePackage('gasstation')
const walletNativeSource = await bundleNativePackage('wallet-react-native')
assert.doesNotMatch(walletNativeSource, /\bBuffer\b/)
assert.doesNotMatch(walletNativeSource, /(?:from|require\() ['"](?:ws|node:)/)

assert.doesNotMatch(
  walletNativeSource,
  /node_modules[\\/](?:auth0-js|@auth0[\\/]auth0-spa-js)[\\/]/,
)
const nativeWalletHermesSource = `const Buffer = undefined;
const TextEncoder = undefined;
const URL = undefined;
const DOMException = undefined;
const document = undefined;
const window = undefined;
const indexedDB = undefined;
${walletNativeSource}`
const nativeWalletModuleUrl = `data:text/javascript;base64,${Buffer.from(nativeWalletHermesSource).toString('base64')}`
const nativeWallet = await import(nativeWalletModuleUrl)
assert.equal(typeof nativeWallet.NativeWalletClient, 'function')
assert.equal(typeof nativeWallet.AltudeNativeWallet, 'function')

const keys = new Map()
let nativeRefreshToken = null
let nativeAddress = null
let randomCounter = 1
const wallet = new nativeWallet.AltudeNativeWallet({
  apiKey: 'smoke-api-key',
  apiBaseUrl: 'https://api.altude.so',
  randomBytes: (length) => new Uint8Array(length).fill(randomCounter++),
  refreshTokenStore: {
    get: async () => nativeRefreshToken,
    set: async (_appId, token) => {
      nativeRefreshToken = token
    },
    remove: async () => {
      nativeRefreshToken = null
    },
  },
  keyStore: {
    read: async (_scope, address) => keys.get(address)?.slice() ?? null,
    write: async (_scope, address, secret) => {
      keys.set(address, secret.slice())
    },
  },
  browser: {
    openAuthSession: async (url, callback) => ({
      type: 'success',
      url: `${callback}?code=smoke-code&state=${/[?&]state=([^&]+)/.exec(url)[1]}`,
    }),
  },
  fetch: async (url, options) => {
    let data
    if (url.endsWith('/config')) {
      data = {
        AppId: '17.42',
        NativeScheme: 'so.altude.wallet.t17.a42',
        Issuer: 'https://api.altude.so/',
        Audience: 'urn:altude:wallet:app:17.42',
        AuthorizationUrl: 'https://api.altude.so/api/native-wallet/authorize',
        JwksUrl: 'https://api.altude.so/api/native-wallet/jwks',
      }
    } else if (url.endsWith('/token') || url.endsWith('/refresh')) {
      data = {
        AccessToken: 'native-jwt',
        RefreshToken: 'refresh',
        ExpiresIn: 300,
        TokenType: 'Bearer',
      }
    } else if (url.endsWith('/native-wallet/wallet')) {
      assert.equal(options.headers.Authorization, 'Bearer native-jwt')
      data = {
        AppId: '17.42',
        UserId: 'smoke-user',
        IdentityKey: 'smoke-identity',
        WalletAddress: nativeAddress,
        ChallengeId: 'smoke-challenge',
        Message: [
          'Altude Wallet Access Binding v1',
          'Issuer: https://api.altude.so/',
          'AppId: 17.42',
          'TenantId: 17',
          'UserId: smoke-user',
          'IdentityKey: smoke-identity',
          'RefreshFamilyId: smoke-family',
          'Origin: ',
          'IdentityTicket: ',
          'ChallengeId: smoke-challenge',
          `WalletAddress: ${nativeAddress ?? ''}`,
          'Nonce: smoke-nonce',
        ].join('\n'),
        ExpiresIn: 60,
      }
    } else if (url.endsWith('/native-wallet/wallet/session')) {
      const proof = JSON.parse(options.body)
      assert.equal(proof.ChallengeId, 'smoke-challenge')
      assert.equal(Buffer.from(proof.Signature, 'base64').length, 64)
      nativeAddress = proof.WalletAddress
      data = {
        Success: true,
        AppId: '17.42',
        UserId: 'smoke-user',
        SessionToken: 'opaque-wallet-session',
        User: { Id: 'smoke-user', WalletAddress: nativeAddress },
        ExpiresIn: 120,
      }
    } else if (url.endsWith('/EmbeddedWallet/session')) {
      assert.equal(options.headers.Authorization, 'Bearer opaque-wallet-session')
      data = {
        IsAuthenticated: true,
        AppId: '17.42',
        UserId: 'smoke-user',
        User: { Id: 'smoke-user', WalletAddress: nativeAddress },
      }
    } else {
      throw new Error(`Unexpected smoke API request: ${url}`)
    }
    return { ok: true, status: 200, json: async () => data }
  },
})
assert.equal((await wallet.connect()).status, 'ready')
assert.equal(keys.size, 1)
assert.equal((await wallet.restore()).address, nativeAddress)
assert.equal(keys.size, 1)
wallet.lock()
assert.equal(wallet.state.status, 'locked')

const hermesLikeSource = `const Buffer = undefined;\nconst DOMException = undefined;\n${bundledSource}`
const bundledModuleUrl = `data:text/javascript;base64,${Buffer.from(hermesLikeSource).toString('base64')}`
const gasstation = await import(bundledModuleUrl)

const station = new gasstation.AltudeGasStation()
station.getRpcClient = async () => ({
  rpc: {
    getAccountInfo: () => ({
      send: async () => ({ value: null }),
    }),
    getLatestBlockhash: () => ({
      send: async () => ({
        value: {
          blockhash: 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N',
          lastValidBlockHeight: 100n,
        },
      }),
    }),
  },
})
station.client.createAccount = async ({ signedTransaction }) => {
  assert.ok(signedTransaction.length > 0)
  return { Signature: 'mock-signature' }
}

const signer = {
  address: 'So11111111111111111111111111111111111111112',
  signTransactionMessage: async () => new Uint8Array([1, 2, 3]),
  signMessage: async () => new Uint8Array([9, 9]),
}
const result = await station.createAccount({
  account: signer.address,
  tokens: ['So11111111111111111111111111111111111111112'],
  signer,
})

assert.equal(result.Signature, 'mock-signature')

station.client.sendTransaction = async ({ transaction }) => {
  assert.ok(transaction.length > 0)
  return { Signature: 'mock-token-signature' }
}
const tokenResult = await station.send({
  sourceSigner: {
    ...signer,
    signTransactionMessage: async () => new Uint8Array(64).fill(1),
  },
  toAddress: 'ALTn7gyjm29WthZGgs4z6WVAK2PK5U6w4FAtPg3TPY71',
  token: 'So11111111111111111111111111111111111111112',
  amount: 1_000,
})

assert.equal(tokenResult.Signature, 'mock-token-signature')

console.log('React Native export and Hermes smoke checks passed.')
