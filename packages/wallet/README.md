# @altude/wallet

Browser wallet infrastructure for locally held Solana keys, Altude API sessions,
and optional Gas Station sponsorship. This package is in development and is
**not included in the production release allowlist**.

## Integration

`AltudeWallet` works headlessly or with the framework-independent managed UI.
Integrators provide their existing identity SDK adapter; the wallet SDK does
not accept profile claims as authentication. It sends the provider's API-
audience access token to `POST /api/EmbeddedWallet/auth0`, and the Altude API
validates that token before issuing a wallet session.

```ts
import { AltudeWallet, mountWalletUI } from '@altude/wallet'

const wallet = new AltudeWallet({
  apiKey: import.meta.env.VITE_ALTUDE_API_KEY,
  apiBaseUrl: 'https://api.altude.so',
  network: 'devnet',
  auth: {
    // Implement these with the supported auth SDK/flow for your application.
    startOtp: (channel, identifier) => auth.startOtp(channel, identifier),
    verifyOtp: async (channel, identifier, code) => {
      const result = await auth.verifyOtp(channel, identifier, code)
      return {
        accessToken: result.accessToken,
        identityKey: result.stableSubject,
      }
    },
    signInWithSocial: (provider) => auth.signInWithSocial(provider),
    signInWithPasskey: () => auth.signInWithPasskey(),
  },
})

const unmount = mountWalletUI(document.querySelector('#wallet')!, wallet, {
  presentation: 'modal', // "inline" or "fullscreen" are also supported
  socialProviders: ['Google', 'Apple'],
})

// The same typed methods are available to custom/headless interfaces.
const stopListening = wallet.onEvent((event) => {
  if (event.type === 'transaction:confirmation') {
    // Render your own confirmation. Approve only after explicit user consent.
  }
})
```

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

The provider adapter's `identityKey` must be a stable identifier from the
configured identity SDK. It is used only to find this browser's local key; it
does not authenticate the user. The access token is independently validated by
the API. The SDK supports the API's current Auth0 exchange/session/signout
contract; it does not invent native OTP, social, or passkey API endpoints.

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

The managed UI offers email/SMS OTP, configured social/passkey sign-in, local
passkey protection, transaction confirmation, account provisioning, and
balance display. Authentication itself is delegated to the app's supported
identity SDK; no API secrets are embedded in browser code.

## Runtime and support

This package currently targets secure browser contexts with IndexedDB, Web
Crypto, and optional WebAuthn PRF. It is intentionally omitted from
`release-manifest.json` until browser runtime, API, and custody contracts are
fully reviewed and the package is promoted.
