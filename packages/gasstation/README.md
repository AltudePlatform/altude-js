# @altude/gasstation

Gasless Solana transaction relay via the Altude relay API.

`@altude/gasstation` lets you build, submit, and query Solana transactions where
the Altude relay pays the network fee. It works with an application-provided
signer or with pre-signed transaction bytes.

## Install

```bash
pnpm add @altude/gasstation
# or
npm install @altude/gasstation
```

You'll need an Altude API key. Get one at
[altude.io](https://altude.io) (or set `ALTUDE_API_KEY_DEVNET` for devnet
testing).

## React Native

The package includes a dedicated React Native/Hermes entrypoint selected by
Metro. HTTP operations and transaction-building flows use React Native-safe
Gill and Solana program entrypoints and do not require global `Buffer` or
`DOMException` polyfills. No Metro `extraNodeModules` override for Gill is
needed.

## Usage

```typescript
import { AltudeGasStation } from '@altude/gasstation'

const gasStation = new AltudeGasStation({
  apiKey: process.env.ALTUDE_API_KEY!,
  network: 'devnet',
})

// Resolves RpcUrl and the short-lived RPC JWT from /api/transaction/config.
await gasStation.init()

// Recent blockhash from the relay
const { blockhash } = await gasStation.getBlockhash()

// Native + SPL balances
const balance = await gasStation.getBalance({
  address: 'YOUR_WALLET_ADDRESS',
})
console.log('Balance:', balance.uiAmount, 'SOL')

// Send a gasless SOL transfer (SDK builds + signs the transaction)
const sig = await gasStation.send({
  sourceSigner: yourSigner,
  destination: 'RECIPIENT_ADDRESS',
  lamports: 1_000_000n,
})

// Or pass a fully signed transaction (relay only submits it)
const sig2 = await gasStation.send({
  signedTransaction: preSignedTxBytes,
})
```

## What's included

- `AltudeGasStation` — high-level client (`send`, `createAccount`, `closeAccount`,
  `getBalance`, `getAccountInfo`, `getHistory`, `swap`, `getBlockhash`, …).
- `AltudeHttpClient`, `createAltudeDevnetClient`, `createAltudeMainnetClient`
  — low-level HTTP client for the relay API.
- `ALTUDE_FEE_PAYER` — the relay's fee-payer address.

RPC operations require an API key. The SDK always uses the node URL and JWT
returned by Altude's transaction config API and never falls back to a public
Solana endpoint.

See the [monorepo README](https://github.com/AltudePlatform/altude-js) for the full
SDK overview.

## License

MIT
