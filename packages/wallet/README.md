# @altude/wallet

Browser wallet infrastructure for locally held Solana keys, Altude API sessions,
and optional Gas Station sponsorship. This package is in development and is
**not included in the production release allowlist**.

## Integration

`AltudeWallet` works headlessly or with the framework-independent managed UI.
For browser apps using Auth0, the SDK includes a first-party SPA adapter for
hosted social and email/SMS passwordless login. The SDK does not accept profile
claims as authentication: it sends Auth0's API-audience access token to
`POST /api/EmbeddedWallet/auth0`, and the Altude API validates that token
before issuing a wallet session.

```ts
import { AltudeWallet, createAuth0WalletAuth, mountWalletUI } from '@altude/wallet'

const apiKey = import.meta.env.VITE_ALTUDE_API_KEY
const auth0 = await createAuth0WalletAuth({
  domain: 'your-tenant.auth0.com',
  clientId: 'your-public-spa-client-id',
  apiKey,
  audience: 'https://api.altude.so',
  connections: {
    Google: 'google-oauth2',
    Apple: 'apple',
  },
  otpConnections: {
    email: 'email',
    sms: 'sms',
  },
})
const wallet = new AltudeWallet({
  apiKey,
  apiBaseUrl: 'https://api.altude.so',
  network: 'devnet',
  auth: auth0.auth,
})

const unmount = mountWalletUI(document.querySelector('#wallet')!, wallet, {
  presentation: 'modal', // "inline" or "fullscreen" are also supported
  title: 'Altude',
  socialProviders: auth0.socialProviders,
  walletUi: await wallet.getWalletUiConfiguration(),
})

// The same typed methods are available to custom/headless interfaces.
const stopListening = wallet.onEvent((event) => {
  if (event.type === 'setup:progress') {
    // Track local wallet creation and server-session setup.
  } else if (event.type === 'transaction:confirmation') {
    // Render your own confirmation. Approve only after explicit user consent.
  }
})
```

Register the browser origin in the Auth0 SPA application's **Allowed Callback
URLs** and **Allowed Web Origins**, and enable the configured database/social
connections for that application. `apiKey` must be a client-safe Altude API
key: the SDK forwards it to Auth0 as
`customParams: JSON.stringify({ walletApiKey: apiKey })` on authorization
requests for Auth0 Actions that need the wallet API key. Never use a server
secret; this value is sent as an authorization parameter and is not a secret.
The `clientId` is public; never put an Auth0 client secret in browser code. The
helper keeps tokens in Auth0 SPA JS's in-memory cache. Email/SMS use Auth0-hosted
login and require the corresponding passwordless connections and message
delivery providers to be configured in Auth0. Use `null` for an
`otpConnections` channel to disable it; defaults are `email` and `sms`.

This package is browser-only. It uses the Auth0 SPA application and the existing
API-validated wallet session contract; it does not use the native callback
broker proposed in
[AltudePlatform/Altude-Platform-API#338](https://github.com/AltudePlatform/Altude-Platform-API/issues/338).
That separate API work explicitly excludes web SDK sign-in. Native iOS/Android
callback setup and token exchange belong to their respective mobile SDKs.
Applications using another identity provider can continue supplying a custom
`WalletAuthProvider` adapter.

## External wallets

External wallets are opt-in adapters and remain distinct from locally held
embedded wallets. The SDK includes provider identifiers for MetaMask, Phantom,
and WalletConnect; the application supplies each provider's connection and
disconnect implementation:

```ts
const wallet = new AltudeWallet({
  apiKey,
  apiBaseUrl,
  auth,
  externalWallets: [
    {
      id: 'phantom',
      label: 'Phantom',
      connect: async () => {
        const connection = await phantom.connect()
        return {
          address: connection.publicKey.toBase58(),
          chain: 'solana',
          signer: connection.signer,
        }
      },
      disconnect: () => phantom.disconnect(),
    },
  ],
})

await wallet.connectExternalWallet('phantom')
```

External connections do not create an Altude API session, store a local key, or
inherit embedded-wallet passkey protection. EVM addresses are exposed as
external custody only; Solana balance/history and sponsored transfers require
a Solana address, and sponsored transfers additionally require an adapter
signer compatible with `@altude/gasstation`. External wallets cannot provision
embedded accounts. `signOut()` disconnects the provider and clears wallet state.
The managed UI shows configured providers and labels external custody explicitly.

For apps that embed the hosted wallet in an iframe, use the typed provider. It
accepts messages only from the configured wallet origin and the expected iframe
window, posts to the exact origin, validates protocol/version/request IDs, and
expires unanswered requests.

```ts
import { WalletEmbedProvider } from '@altude/wallet'

const provider = new WalletEmbedProvider({
  walletUrl: 'https://wallet.example.com/embed',
  iframe: document.querySelector<HTMLIFrameElement>('#altude-wallet')!,
})
const state = await provider.init()
```

The custom provider adapter's `identityKey` must be a stable identifier from the
configured identity SDK. It is used only to find this browser's local key; it
does not authenticate the user. The access token is independently validated by
the API. The SDK supports the API's current Auth0 exchange/session/signout
contract; it does not invent native broker, OTP, social, or passkey API endpoints.

## Custody and passkeys

Wallet keys are generated in the browser and stored in IndexedDB under the
identity key. The SDK exposes the public address and transaction operations,
never a private-key getter. Email/social-only wallets are device-local until
protected with a passkey. `protectWithPasskey()` wraps the local key using a
WebAuthn PRF-derived AES-GCM key; `unlockWithPasskey()` reverses that operation.
The passkey PRF unlocks local storage only and never creates an API session.
Passkey API authentication must still return an access token from a
server-validated ceremony. A passkey and its relying-party origin must be
available to recover the protected key; clearing browser storage without a
backup can permanently lose access.

Device-local keys are stored unwrapped in the current browser's IndexedDB.
Same-origin JavaScript (including injected scripts) can access that origin's
storage, so applications should apply normal XSS protections and use a
dedicated wallet origin when they require an origin isolation boundary. The
SDK does not claim multi-device recovery.

`MemorySessionTokenStore` is the default; it intentionally does not persist
bearer tokens across page loads. Supply a `SessionTokenStore` implementation to
enable restoration, then call `restoreSession()`. The included
`BrowserSessionTokenStore` uses `sessionStorage` for convenience and is
accessible to same-origin JavaScript; use an application-appropriate store for
your threat model.

## Transactions and data

`requestTransaction()` accepts only structured SOL and standard SPL transfers.
It emits a `transaction:confirmation` event; a user must explicitly approve or
reject the request. The managed UI provides a confirmation surface, while a
headless UI can call `approveTransaction(id)` after its own confirmation. The
Gas Station SDK builds, locally signs, and submits supported requests. Opaque
instruction sets and Token-2022 transfers are rejected/not exposed until the
relay SDK supports them.

Approval claims the request immediately; concurrent `approveTransaction(id)`
calls reject with a `TRANSACTION` error rather than submit another transfer.
Requests stay cancellable while submitting. Changing identity, signing out, or
rejecting the request cancels its pending result and prevents a late relay
response from reporting completion. Cancellation cannot retract a transfer
already sent to the relay; check its status before requesting another transfer.

`createAccount()`, `getBalance()`, `getHistory()`, and `getTransaction()` use
Gas Station's supported account/RPC capabilities. Transaction lookup searches
the most recent 100 history entries; the current Gas Station API does not
provide a direct lookup endpoint.

`getWalletUiConfiguration()` reads the optional `walletUi` section from
`GET /api/transaction/config`. When that section exists, its enabled methods
act as an allowlist and are intersected with the app's configured auth handlers
and external-wallet adapters; an enabled method without an adapter is not shown.
When the API returns no wallet UI settings, use explicit developer configuration
as a fallback.

The managed UI places email/SMS first, configured social and passkey buttons
next, and an expandable Web3 wallet row last. The row lists only enabled,
configured providers. For Auth0, the SDK launches hosted login from the
corresponding sign-in action; other identity providers can use the custom
adapter methods.
During embedded sign-in, `setup:progress` reports local device-key protection,
account connection, and session finalization. The managed UI shows those
milestones and returns to the configured sign-in options after a failed login;
it does not imply that an unimplemented recovery mechanism was configured.
After sign-in, the managed UI shows the account contact, shortened address,
device/passkey protection state, connected app, and the configured Solana
explorer. Recovery is explicitly shown as not set up until a recovery feature
is implemented; the recovery control remains unavailable.

## Runtime and support

This package currently targets secure browser contexts with IndexedDB, Web
Crypto, and optional WebAuthn PRF. It is intentionally omitted from
`release-manifest.json` until browser runtime, API, and custody contracts are
fully reviewed and the package is promoted.

Run `pnpm --filter @altude/wallet test:browser` to exercise the browser entry
point with real browser Web Crypto and IndexedDB in Microsoft Edge. Set
`EDGE_EXECUTABLE` if Edge is installed outside its standard Windows locations.
