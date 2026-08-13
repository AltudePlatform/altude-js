# @altude/core

Shared types, cryptographic primitives, and RPC client for the Altude SDK.

`@altude/core` is the foundational package used by the other `@altude/*` packages. Most
consumers install one of the higher-level packages ([`@altude/vault`](https://www.npmjs.com/package/@altude/vault),
[`@altude/gasstation`](https://www.npmjs.com/package/@altude/gasstation),
[`@altude/solana-adapter`](https://www.npmjs.com/package/@altude/solana-adapter),
[`@altude/nft`](https://www.npmjs.com/package/@altude/nft)) rather than depending on
`@altude/core` directly.

## Install

```bash
pnpm add @altude/core
# or
npm install @altude/core
```

## What's included

- **Types** — shared TypeScript types used across the Altude SDK.
- **Errors** — the Altude error taxonomy (`AltudeError` and subclasses).
- **Mnemonic** — BIP-39 mnemonic generation and BIP-44 key derivation via
  [`@scure/bip39`](https://github.com/paulmillr/scure-bip39) and
  [`@scure/bip32`](https://github.com/paulmillr/scure-bip32).
- **RPC** — a thin RPC client built on [Gill](https://gill.web3.builders/) with
  support for the API-key-scoped node URL and RPC JWT returned by Altude.

## React Native

The package publishes dedicated `react-native` and `browser` entrypoints. Metro
selects Gill's React Native build instead of its Node/WebSocket build, so
creating a client and using HTTP RPC methods does not require Node polyfills.

`createAltudeClient` creates its HTTP RPC transport immediately and initializes
RPC subscriptions only when `rpcSubscriptions` or a subscription-dependent
helper is accessed. Subscription use still requires the WebSocket capabilities
expected by Gill in the target runtime.

RPC clients must be constructed from the `RpcUrl` and `Token` returned by the
Altude transaction config API. The SDK intentionally does not fall back to
public Solana endpoints because the API key determines the cluster and JWT.

## Usage

```typescript
import { generateMnemonic, mnemonicToSeed, deriveSolanaKeypair } from '@altude/core'

const mnemonic = generateMnemonic()
const seed = await mnemonicToSeed(mnemonic)
const keypair = deriveSolanaKeypair(seed, 0)
```

See the [monorepo README](https://github.com/AltudePlatform/altude-js) for the full
SDK overview.

## License

MIT
