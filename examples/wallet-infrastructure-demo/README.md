# Wallet UI Modal Example

A minimal Vite app showing how to open the `@altude/wallet` managed UI as a
modal with `mountWalletUI`.

## Run

From the repository root:

```bash
pnpm install
pnpm --filter wallet-infrastructure-demo dev
```

Select **Simulated demo** to try email/SMS with any identifier and the demo OTP
`246810`. Select **Live backend** to use a publishable API key and your Auth0
SPA application. The SDK's Auth0 adapter handles hosted email/SMS passwordless
and social sign-in; no Auth0 adapter code is implemented by the demo. The
**Social login** switch controls whether configured Google and Apple Auth0
connections are offered.

The **Web3 wallets** switch enables Phantom and MetaMask options in either mode.
Phantom connects as a Solana external wallet; MetaMask connects as an EVM
external wallet. The options remain visible even if an extension is missing;
selecting one without its browser extension reports how to install it. These
connections are external custody: they do not create an Altude API session, and
the demo does not provide their transaction-signing adapters or sponsored
transfers.

When the API returns `walletUi` from transaction config, its enabled methods
filter the buttons shown in the sign-in modal. The example's switches and
configured Auth0 connections are an explicit fallback for APIs that do not yet
return wallet UI settings; a server setting cannot show a method without its
corresponding local adapter/provider.

In live mode, choose **Use API config** to preview the server's `enabledMethods`
unchanged, or **Override API methods** to preview the methods selected by the
demo's Social login and Web3 switches. The override is applied in memory to the
wallet UI settings passed to `mountWalletUI`; it does not modify or save the
transaction config on the server. Branding, legal links, and trust badges
continue to come from the API response.

Live setup requires an Auth0 SPA domain and client ID. Configure its email and
SMS passwordless connections (defaults: `email` and `sms`) and message delivery
providers in Auth0. For social sign-in, enter at least one enabled connection
name. Register the exact example origin shown by Vite in Auth0's **Allowed
Callback URLs** and **Allowed Web Origins**. The API base URL is also used as
the Auth0 audience; it must match the audience accepted by the API. Do not
enter an Auth0 client secret or server-secret API key in the browser.

## Key integration

The SDK sends `X-API-Key` with its wallet session requests to
`/api/EmbeddedWallet/auth0`, `/api/EmbeddedWallet/session`, and
`/api/EmbeddedWallet/signout`. In live mode, `createAuth0WalletAuth` from `@altude/wallet` uses Auth0 SPA JS to
handle hosted login, then supplies an API-audience access token and stable Auth0
subject to the wallet SDK. The Altude API validates that token before
establishing a wallet session. Browser sign-in uses the existing API contract;
it does not call the native callback broker proposed in
[AltudePlatform/Altude-Platform-API#338](https://github.com/AltudePlatform/Altude-Platform-API/issues/338).
That native-only work is separate from this browser SDK example. The example
also uses the real Gas Station client
in live mode, which may make real sponsored transaction requests if you approve
them in the wallet UI. Gas Station loads the API-key-scoped
`/api/transaction/config` for its RPC URL and token before RPC operations. Only
use an API key and Auth0 application configured for the intended network.

```ts
import { AltudeWallet, createAuth0WalletAuth, mountWalletUI } from '@altude/wallet'

const auth0 = await createAuth0WalletAuth({
  domain: 'your-tenant.auth0.com',
  clientId: 'your-public-spa-client-id',
  audience: 'https://api.altude.so',
  connections: { Google: 'google-oauth2' },
  otpConnections: { email: 'email', sms: 'sms' },
})

const wallet = new AltudeWallet({
  apiKey,
  apiBaseUrl: 'https://api.altude.so',
  auth: auth0.auth,
  externalWallets: injectedWalletAdapters,
  // Omit fetch and gasStation so the SDK uses its real API clients.
})

const unmount = mountWalletUI(document.body, wallet, {
  presentation: 'modal',
  title: 'Embedded wallet',
  onClose: () => unmount(),
})
```

**Simulated mode** uses a local demo OTP, `demoApiFetch`, and `DemoGasStation`;
it does not send OTP messages, call the Altude API, or submit blockchain
transactions. **Live mode** uses the SDK-provided Auth0 SPA adapter and the
Altude backend/Gas Station. Live email/SMS use Auth0-hosted passwordless login
and require the corresponding connections and message delivery providers in
Auth0. Never ship server-secret API keys or treat client-side profile data as
authentication.

The wallet package is experimental and is not included in the production
release set. See [`packages/wallet/README.md`](../../packages/wallet/README.md)
for its integration and security details.
