# altude-js

[![CI](https://github.com/AltudePlatform/altude-js/actions/workflows/ci.yml/badge.svg)](https://github.com/AltudePlatform/altude-js/actions/workflows/ci.yml)

Production TypeScript SDK for Altude gasless Solana infrastructure.

## Production packages

| Package | Description |
|---|---|
| [`@altude/core`](./packages/core) | Shared types, BIP-39/BIP-44 key derivation, RPC client, error taxonomy |
| [`@altude/gasstation`](./packages/gasstation) | Gasless transaction relay via the Altude API |

Only packages in this table are supported and published. Experimental package
work does not live on the production branch and carries no release commitment.

## Quick Start

```bash
pnpm add @altude/gasstation
```

```typescript
import { AltudeGasStation } from '@altude/gasstation'

const gasStation = new AltudeGasStation({
  apiKey: process.env.ALTUDE_API_KEY,
  network: 'devnet',
})

await gasStation.init()

const balance = await gasStation.getBalance({
  address: 'YOUR_WALLET_ADDRESS',
})
console.log('Balance:', balance.uiAmount, 'SOL')
```

Applications retain custody of user keys and provide the signer used for
transaction-building operations. Altude supplies the fee payer and relays the
locally signed transaction.

## Development

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm build

# Run all tests
pnpm test

# Typecheck
pnpm typecheck
```

### Requirements

- Node.js ≥ 18
- pnpm ≥ 9

## Releases

### Publish manifest

`release-manifest.json` at the repo root is the single source of truth for which packages are published to npm:

```json
{ "publish": ["@altude/core", "@altude/gasstation"] }
```

The manifest is an explicit release allowlist. A workspace package is not
publishable unless it is listed there.

To promote a package, add its name to `publish` and run:

```bash
pnpm manifest:sync   # applies the manifest to package.json + .changeset/config.json
pnpm manifest:check  # verifies everything is in sync (run in CI)
```

The release workflow builds, lints, typechecks and tests only the packages listed in the manifest.

### Workflow

- CI runs on every PR and push via `.github/workflows/ci.yml`.
- PRs that change publishable packages must include a Changeset; CI verifies this before merge.
- Publishing is automated by `.github/workflows/release.yml` on every merge to `main`, and the workflow can also be re-run manually with `workflow_dispatch`.
- Configure npm credentials in a repository secret named `NPM_TOKEN`; the release job exposes it to pnpm/npm as `NODE_AUTH_TOKEN`.
- Version bumps are handled with Changesets. Add a changeset in feature PRs (`pnpm changeset`) and the release workflow will:
  - open/update a release PR with incremented versions and changelogs
  - publish to npm and create release tags when that release PR is merged to `main`

## Architecture

Built on:
- **[Gill](https://gill.web3.builders/)** — ergonomic Solana client (built on `@solana/kit`)
- **[@scure/bip39](https://github.com/paulmillr/scure-bip39)** + **[@scure/bip32](https://github.com/paulmillr/scure-bip32)** — audited BIP-39/BIP-44
- **[@noble/ed25519](https://github.com/paulmillr/noble-ed25519)** — audited Ed25519

## License

MIT
