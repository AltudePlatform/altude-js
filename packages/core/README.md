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
  support for propagating an Altude auth token via `Authorization` headers.

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
