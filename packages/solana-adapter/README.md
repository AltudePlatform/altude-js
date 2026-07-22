# @altude/solana-adapter

Bridge between the [`@altude/vault`](https://www.npmjs.com/package/@altude/vault)
OWS vault and standard Solana signer interfaces
([Gill](https://gill.web3.builders/) `KeyPairSigner` and legacy
`@solana/web3.js`).

## Install

```bash
pnpm add @altude/solana-adapter @altude/vault
# or
npm install @altude/solana-adapter @altude/vault
```

`@solana/web3.js` is an **optional peer dependency** — only install it if you
plan to use `createOWSWeb3Signer`.

## Usage

### With Gill (recommended)

```typescript
import { AltudeVault } from '@altude/vault'
import { createOWSGillSigner } from '@altude/solana-adapter'

const vault = new AltudeVault()
const signer = await createOWSGillSigner({
  vault,
  walletId: 'my-wallet-id',
  token: process.env.OWS_API_TOKEN!, // ows_key_...
})

// signer is a Gill KeyPairSigner — pass to any Gill transaction builder
```

### With legacy `@solana/web3.js`

```typescript
import { createOWSWeb3Signer } from '@altude/solana-adapter'

const web3Signer = await createOWSWeb3Signer({
  vault,
  walletId: 'my-wallet-id',
  token: process.env.OWS_API_TOKEN!,
})
```

The returned signer holds no private key material in memory — every signing
request is delegated to the OWS vault, which enforces any configured policies.

See the [monorepo README](https://github.com/AltudePlatform/altude-js) for the full
SDK overview.

## License

MIT
