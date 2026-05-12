# altude-js

[![CI](https://github.com/AltudePlatform/altude-js/actions/workflows/ci.yml/badge.svg)](https://github.com/AltudePlatform/altude-js/actions/workflows/ci.yml)

TypeScript SDK for Altude — gasless Solana infrastructure with an OWS-conformant vault.

## Packages

| Package | Description |
|---|---|
| [`@altude/core`](./packages/core) | Shared types, BIP-39/BIP-44 key derivation, RPC client, error taxonomy |
| [`@altude/vault`](./packages/vault) | **OWS vault** — encrypted key storage, API key management, policy engine |
| [`@altude/solana-adapter`](./packages/solana-adapter) | Bridge: OWS vault → Gill / `@solana/web3.js` signer |
| [`@altude/gasstation`](./packages/gasstation) | Gasless transaction relay via the Altude API |
| [`@altude/nft`](./packages/nft) | Gasless NFT ops — Metaplex Core, compressed NFTs (cNFTs) |

## Quick Start

```bash
pnpm add @altude/vault @altude/gasstation @altude/solana-adapter
```

```typescript
import { AltudeVault } from '@altude/vault'
import { AltudeGasStation } from '@altude/gasstation'
import { createOWSGillSigner } from '@altude/solana-adapter'

// 1. Initialize the OWS vault (uses ~/.ows by default)
const vault = new AltudeVault()

// 2. Create a wallet
const wallet = await vault.createWallet({
  name: 'my-wallet',
  passphrase: 'your-strong-passphrase',
})
console.log('Solana address:', wallet.accounts[0].address)

// 3. Create an API key for agent use (no passphrase required at sign time)
const { token } = await vault.createApiKey({
  name: 'my-agent',
  walletId: wallet.id,
  passphrase: 'your-strong-passphrase',
})
console.log('Agent token (store securely):', token)

// 4. Sign with the agent token (policies enforced)
const sig = await vault.signMessage(wallet.id, 'Hello Altude', token)
console.log('Signature:', sig.signature)

// 5. Gasless transaction relay
const gasStation = new AltudeGasStation({
  apiKey: process.env.ALTUDE_API_KEY,
  network: 'devnet',
})
const blockhash = await gasStation.getBlockhash()
const balance = await gasStation.getBalance({ address: wallet.accounts[0].address })
console.log('Balance:', balance.uiAmount, 'SOL')
```

## OWS Vault

`@altude/vault` is a TypeScript implementation of the [Open Wallet Standard (OWS)](https://github.com/AltudePlatform/OWS-core) vault component.

### What it implements

- **Storage format v2** — `~/.ows/wallets/`, `~/.ows/keys/`, `~/.ows/policies/`, `~/.ows/logs/` with OWS-mandated filesystem permissions (`chmod 700`/`600`)
- **AES-256-GCM + scrypt** — passphrase-derived wallet encryption (`N=65536, r=8, p=1`)
- **HKDF-SHA256** — API key token encryption (`info = "ows-api-key-v1"`)
- **Policy engine** — `allowed_chains`, `expires_at`, `allowed_typed_data_contracts` declarative rules; custom executable policies (Node.js)
- **Audit log** — append-only JSONL at `~/.ows/logs/audit.jsonl`
- **Backup/restore** — AES-256-GCM encrypted tar archive
- **Signing interface** — `sign()`, `signMessage()` (Ed25519)

### Vault file compatibility

Wallet files created by `@altude/vault` are **byte-for-byte compatible** with those produced by the `ows` CLI and `@open-wallet-standard/core` Node.js bindings.

### Access model

| Mode | Credential | Policies enforced |
|---|---|---|
| Owner | Passphrase | ❌ No — full access |
| Agent | OWS API token (`ows_key_*`) | ✅ Yes |

### API key creation protocol

Follows the 9-step OWS protocol:

1. Owner enters passphrase → vault decrypts wallet secret
2. Generates random token: `ows_key_<256 random bits>`
3. `HKDF-SHA256(salt, token, "ows-api-key-v1")` → 32-byte key
4. Re-encrypts wallet secret with derived key (AES-256-GCM)
5. Writes key file with `token_hash: SHA256(token)` and encrypted copy
6. Returns token **once** — never stored in plaintext

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

- CI runs on every PR and push via `.github/workflows/ci.yml`.
- Publishing is automated by `.github/workflows/release.yml` on every merge to `main`.
- Configure npm credentials in a repository secret named `NPM_TOKEN` (used as `NODE_AUTH_TOKEN` by the release job).
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
