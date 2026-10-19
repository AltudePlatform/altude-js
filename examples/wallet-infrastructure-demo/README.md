# Wallet Infrastructure Playground

A small React app demonstrating the in-development `@altude/wallet` browser
SDK: locally held embedded keys, wallet custody state, a custom sign-in flow
using the SDK's typed auth adapter, external wallet adapters, and explicit
transfer approval.

## Run it

From the repository root:

```bash
pnpm install
pnpm --filter wallet-infrastructure-demo dev
```

Open the Vite URL, choose an email or SMS sign-in method, enter any identifier,
and use the displayed demo code `246810`. The embedded wallet key is generated
and persisted in this browser's IndexedDB. The local app can also connect to
injected Phantom or MetaMask providers when installed.

To exercise a transfer, connect the embedded wallet, review the recipient and
lamports, then request and explicitly approve the preview. The SDK emits the
confirmation event and the demo's relay adapter returns a simulated signature.

## Simulation boundary

This project intentionally uses local adapters for the identity exchange, API,
and Gas Station responses. It does not verify an identity, call the Altude API,
or submit a blockchain transaction. Its demo-only tokens and API key are
non-credentials. The local wallet key still uses the SDK's browser storage and
Web Crypto implementation; use a disposable browser profile if desired.

The Phantom and MetaMask adapters use their injected browser APIs to obtain an
address. They do not provide a `GaslessTransactionSigner`, so the example does
not offer sponsored sends from an external wallet. For a real application,
replace the demo auth/fetch/gas-station adapters with server-validated identity
tokens, the real API key and base URL, and a compatible wallet signer. Never
ship private API keys or treat client-side profile data as authentication.

The package is not published or included in the production SDK release set.
See [`packages/wallet/README.md`](../../packages/wallet/README.md) for the SDK
contracts and security boundaries.
