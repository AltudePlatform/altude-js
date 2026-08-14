import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const packageDirectories = ['core', 'gasstation']

for (const directory of packageDirectories) {
  const packageRoot = join(root, 'packages', directory)
  const packageJson = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
  const nativeEntry = packageJson.exports['.']['react-native']
  const browserEntry = packageJson.exports['.'].browser

  assert.equal(packageJson['react-native'], nativeEntry)
  assert.equal(packageJson.browser, browserEntry)

  const nativeArtifact = await readFile(join(packageRoot, nativeEntry), 'utf8')
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

const hermesLikeSource = `const Buffer = undefined;\nconst DOMException = undefined;\n${bundledSource}`
const bundledModuleUrl = `data:text/javascript;base64,${Buffer.from(hermesLikeSource).toString('base64')}`
const gasstation = await import(bundledModuleUrl)

const station = new gasstation.AltudeGasStation()
station.getRpcClient = async () => ({
  rpc: {
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
