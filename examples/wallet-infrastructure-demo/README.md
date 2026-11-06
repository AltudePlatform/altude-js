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
`246810`. Select **Live backend** to use a publishable API key and the
**Altude browser broker** (the default authentication mode). The SDK discovers
enabled methods, handles email/SMS delivery and verification in the wallet's
six-input code screen, and opens social sign-in in a popup. The demo contains
no broker authentication logic. **Social login** controls whether discovered
providers are offered.

The **Web3 wallets** switch enables Phantom and MetaMask options in either mode.
Phantom connects as a Solana external wallet; MetaMask connects as an EVM
external wallet. The options remain visible even if an extension is missing;
selecting one without its browser extension reports how to install it. These
connections are external custody: they do not create an Altude API session, and
the demo does not provide their transaction-signing adapters or sponsored
transfers.

When the API returns `walletUi` from transaction config, its enabled methods
filter the buttons shown in the sign-in modal. The example's switches and
broker-discovered providers (or explicit direct Auth0 connections) are a fallback for APIs that do not yet
return wallet UI settings; a server setting cannot show a method without its
corresponding local adapter/provider.

In live mode, choose **Use API config** to preview the server's `authMethods`
unchanged, or **Override API methods** to preview the methods selected by the
demo's Social login and Web3 switches. The override is applied in memory to the
wallet UI settings passed to `mountWalletUI`; it does not modify or save the
transaction config on the server. Branding, legal links, and trust badges
continue to come from the API response.

### Default browser broker setup

Set the Altude API base URL and a client-safe API key. An operator must deploy
`/api/browser-wallet` and enroll the exact Vite origin in
`BrowserWallet:Applications:<AppId>:AllowedOrigins` with exact-origin CORS.
No consumer Auth0 domain, SPA client ID, audience, or callback registration is
required in this mode. The broker operator configures its confidential Auth0
application, one fixed callback, email/SMS connections, six-digit OTP, message
providers, and backend secrets. Enrollment is not public self-registration.
An undeployed broker or rejected origin produces an explicit error; the demo
does not silently switch to direct Auth0 or simulation.

Challenges are single-attempt, including incorrect codes; use **Resend code**
after verification fails. Handoff codes last 60 seconds and the SDK redeems
them with S256 PKCE for a 120-second, one-time identity ticket. The SDK uses the
ticket to look up the authoritative application/user wallet before selecting a
local signer, then signs the exact server challenge with Ed25519 and binds the
ticket/address/proof for an opaque session. The backend must advertise
`WalletAccessVersion:1`; older unsigned session endpoints are not supported.
Provider tokens remain server-side.

If the registered wallet's key is missing from this browser, setup reports
recovery-required instead of creating a different wallet. Use the original
device or a supported recovery method; this demo does not implement
cross-device recovery. Protected local keys must unlock with their passkey
before session binding. A conflict or any failed/ambiguous `/session` exchange
consumes the ticket and requires fresh sign-in (for OTP, explicitly resend).
An operator-controlled legacy scope migration may be required; no legacy
address is automatically copied across applications.

### Optional direct Auth0 setup

Select **Direct Auth0 SPA (advanced)** to expose the domain/client/audience and
connection fields. Only this mode requires an Auth0 SPA domain and client ID.
Configure its email and
SMS passwordless connections (defaults: `email` and `sms`) and message delivery
providers in Auth0. For social sign-in, enter at least one enabled connection
name. Register the exact example origin shown by Vite in Auth0's **Allowed
Callback URLs**, **Allowed Web Origins**, and **Allowed Origins (CORS)**.
Enable embedded/cross-origin authentication and configure RS256 ID tokens.
Embedded OTP completion uses a hidden Auth0 iframe; cookie restrictions or
consent requirements cause explicit errors, not a hosted-login fallback.
A same-site Auth0 custom domain is recommended. Set **Auth0 API audience** to the
API identifier registered in Auth0 and accepted by the backend (default:
`https://api.altude.so`). It is configured independently of the API base URL;
identifiers such as URNs and values with trailing slashes are passed unchanged
apart from trimming surrounding whitespace. Changing it recreates the demo's
Auth0 adapter on the next wallet open. This public identifier is not a secret,
and editing it does not relax backend issuer, signature, audience, or expiry
validation. The field is required only in direct Auth0 mode and ignored in
broker/simulated modes. Do not
enter an Auth0 client secret or server-secret API key in the browser. The SDK
also forwards the client-safe key to Auth0 as
`customParams: JSON.stringify({ walletApiKey: apiKey })` for the configured
wallet Auth0 Action.
For embedded OTP, Auth0.js serializes the authorization query key as
`custom_params` with the same JSON value; the Action must accept both names.

## Key integration

The SDK sends `X-API-Key` with browser-broker requests to
`/api/browser-wallet/config`, `/otp/start`, `/otp/verify`, `/authorize`, `/redeem`, `/wallet`,
and `/session` (all under that namespace). The browser supplies its real Origin;
no cookies or Auth0 provider tokens are involved. Existing
`/api/EmbeddedWallet/session` and `/api/EmbeddedWallet/signout` handle opaque
session restoration/revocation. Direct mode alone uses
`/api/EmbeddedWallet/auth0` with an API-audience access token.
The example also uses the real Gas Station client
in live mode, which may make real sponsored transaction requests if you approve
them in the wallet UI. Gas Station loads the API-key-scoped
`/api/transaction/config` for its RPC URL and token before RPC operations. Only
use an API key configured for the intended network.

```ts
import { AltudeWallet, createBrowserWalletAuth, mountWalletUI } from '@altude/wallet'

const apiBaseUrl = 'https://api.altude.so'
const broker = await createBrowserWalletAuth({ apiKey, apiBaseUrl })

const wallet = new AltudeWallet({
  apiKey,
  apiBaseUrl,
  auth: broker.auth,
  externalWallets: injectedWalletAdapters,
  // Omit fetch and gasStation so the SDK uses its real API clients.
})

const unmount = mountWalletUI(document.body, wallet, {
  presentation: 'modal',
  title: 'Embedded wallet',
  socialProviders: broker.socialProviders,
  onClose: () => unmount(),
})
```

**Simulated mode** uses a local demo OTP, `demoApiFetch`, and `DemoGasStation`;
it does not send OTP messages, call the Altude API, or submit blockchain
transactions. **Live mode** defaults to the SDK-provided browser broker and the
Altude backend/Gas Station. Live email/SMS keep code entry in the wallet UI
and require the broker operator's connections and message delivery providers in
Auth0. Never ship server-secret API keys or treat client-side profile data as
authentication.

Server-driven UI follows the nested `walletUi.branding`, `legal`, `authMethods`,
and `trust` contract from
[AltudePlatform/Altude-Platform-API#340](https://github.com/AltudePlatform/Altude-Platform-API/pull/340).
The native system-browser flow in
[AltudePlatform/Altude-Platform-API#370](https://github.com/AltudePlatform/Altude-Platform-API/pull/370)
is separate and belongs to `@altude/wallet-react-native`; browser broker tickets
are not native JWTs or refresh credentials.

The wallet package is experimental and is not included in the production
release set. See [`packages/wallet/README.md`](../../packages/wallet/README.md)
for its integration and security details.
