# @altude/vault

OWS-conformant encrypted key vault — a TypeScript implementation of the
[Open Wallet Standard (OWS)](https://github.com/AltudePlatform/OWS-core) vault
component.

## Install

```bash
pnpm add @altude/vault
# or
npm install @altude/vault
```

## What it implements

- **Storage format v2** — `~/.ows/wallets/`, `~/.ows/keys/`, `~/.ows/policies/`,
  `~/.ows/logs/` with OWS-mandated filesystem permissions (`chmod 700`/`600`).
- **AES-256-GCM + scrypt** — passphrase-derived wallet encryption
  (`N=65536, r=8, p=1`).
- **HKDF-SHA256** — API key token encryption (`info = "ows-api-key-v1"`).
- **Policy engine** — declarative rules (`allowed_chains`, `expires_at`,
  `allowed_typed_data_contracts`) plus custom executable Node.js policies.
- **Audit log** — append-only JSONL at `~/.ows/logs/audit.jsonl`.
- **Backup / restore** — AES-256-GCM encrypted tar archives.
- **Signing interface** — `sign()` and `signMessage()` (Ed25519).

Wallet files created by `@altude/vault` are **byte-for-byte compatible** with those
produced by the `ows` CLI and `@open-wallet-standard/core` Node.js bindings.

## Access model

| Mode  | Credential                    | Policies enforced |
| ----- | ----------------------------- | ----------------- |
| Owner | Passphrase                    | No — full access  |
| Agent | OWS API token (`ows_key_*`)   | Yes               |

## Usage

```typescript
import { AltudeVault } from '@altude/vault'

const vault = new AltudeVault()

// Create a wallet (owner mode — passphrase required)
const wallet = await vault.createWallet({
  name: 'my-wallet',
  passphrase: 'your-strong-passphrase',
})
console.log('Solana address:', wallet.accounts[0].address)

// Create an API key for agent use
const { token } = await vault.createApiKey({
  name: 'my-agent',
  walletId: wallet.id,
  passphrase: 'your-strong-passphrase',
})

// Sign with the agent token (policies enforced)
const sig = await vault.signMessage(wallet.id, 'Hello Altude', token)
```

See the [monorepo README](https://github.com/AltudePlatform/altude-js) for the full
SDK overview.

## License

MIT
