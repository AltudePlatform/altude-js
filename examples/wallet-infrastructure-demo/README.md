# Wallet UI Modal Example

A minimal Vite app showing how to open the `@altude/wallet` managed UI as a
modal with `mountWalletUI`.

## Run

From the repository root:

```bash
pnpm install
pnpm --filter wallet-infrastructure-demo dev
```

Choose email or SMS in the modal, enter any identifier, and use the demo OTP
`246810`.

## Key integration

The sample creates the wallet with an app-provided auth adapter, then opens the
SDK modal:

```ts
const wallet = new AltudeWallet({
  apiKey: 'demo-only-api-key',
  apiBaseUrl: 'https://wallet-api.demo.invalid',
  auth: demoAuth,
  fetch: demoApiFetch,
  gasStation: new DemoGasStation(),
})

const unmount = mountWalletUI(document.body, wallet, {
  presentation: 'modal',
  title: 'Wallet access',
  onClose: () => unmount(),
})
```

`demoAuth`, `demoApiFetch`, and `DemoGasStation` are local simulations: the
example does not send OTP messages, call the Altude API, or submit blockchain
transactions. Replace them with a server-validated identity adapter, the real
API key/base URL, and the real Gas Station client in an application. Never
ship private API keys or treat client-side profile data as authentication.

The wallet package is experimental and is not included in the production
release set. See [`packages/wallet/README.md`](../../packages/wallet/README.md)
for its integration and security details.
