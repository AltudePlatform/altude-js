# @altude/wallet

Browser wallet infrastructure for locally held Solana keys, Altude API sessions,
and optional Gas Station sponsorship. This package is in development and is
**not included in the production release allowlist**.

## Integration

`AltudeWallet` works headlessly or with the framework-independent managed UI.
Use `createBrowserWalletAuth` for Altude-managed broker authentication. Configure
only the client-safe API key and API base URL: the SDK discovers enabled methods
from the backend and keeps email/SMS identifier and code entry in the wallet UI.
Social login opens a popup through the broker's fixed callback.
The managed UI uses six numeric code inputs with automatic verification when
complete, paste/autofill support, and keyboard navigation.
Its shared screens follow the embedded-wallet demo's Altude design: compact
provider icons, flat surfaces, and an inline resend/error flow. Host pages can
load Manrope, DM Mono, and Montserrat for matching typography; the SDK uses
system fallbacks and makes no font-network requests. Existing `--altude-*`
theme tokens are respected, with the demo's light palette as the default.
The SDK does not accept profile claims as authentication. The broker validates
the identity server-side and issues a short-lived, single-use identity ticket.
The SDK looks up the authoritative application/user wallet before creating or
reusing a local signer, then signs a one-time access challenge and exchanges
the ticket, address, and proof for an opaque wallet session. Auth0 provider tokens
and client secrets never enter the broker consumer's browser.

```ts
import { AltudeWallet, createBrowserWalletAuth, mountWalletUI } from '@altude/wallet'

const apiKey = import.meta.env.VITE_ALTUDE_API_KEY
const apiBaseUrl = 'https://api.altude.so'
const broker = await createBrowserWalletAuth({ apiKey, apiBaseUrl })
const wallet = new AltudeWallet({
  apiKey,
  apiBaseUrl,
  network: 'devnet',
  auth: broker.auth,
})

const unmount = mountWalletUI(document.querySelector('#wallet')!, wallet, {
  presentation: 'modal', // "inline" or "fullscreen" are also supported
  title: 'Altude',
  socialProviders: broker.socialProviders,
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

### Browser broker deployment and protocol

The browser broker API must be deployed before using this adapter. Each app's
exact website origins must be enrolled by an operator through
`BrowserWallet:Applications:<AppId>:AllowedOrigins`; a publishable API key cannot
self-enroll a website. HTTPS is required in production. Development loopback
origins require explicit backend enrollment and
`BrowserWallet:AllowDevelopmentLoopback=true` in Development.
`localhost` and `127.0.0.1`, schemes, and ports are distinct origins. No callback
URL for each consumer website is registered in Auth0, and no Auth0 Management API
write happens at runtime.

The operator configures a dedicated confidential Auth0 Regular Web Application,
the fixed browser callback, enabled connections, six-digit passwordless OTP,
message providers, shared Redis (`NativeWallet:RedisConnection`)/Data Protection,
and exact-origin CORS. `BrowserWallet:Issuer` is the API HTTPS authority,
normalized without a trailing slash; paths, query, fragment, and credentials
are rejected. Browser authentication does not require native RSA or native
Auth0 client-secret settings. Client secrets
and provider tokens remain backend-only. Auth0 Actions must be compatible with
this dedicated client; the browser broker does not put API keys in Auth0 URLs.
This is separate from changing a SPA's application type to bypass Auth0 restrictions.

All browser requests use `X-API-Key`, the browser-supplied `Origin`, no cookies,
and no automatic redirect following or grant retries:

| Endpoint under `/api/browser-wallet` | Request / response |
| --- | --- |
| `GET /config` | `{AppId,SocialProviders,EmailOtp,SmsOtp,WalletAccessVersion:1}` |
| `POST /otp/start` | `{Method,Identifier,State,CodeChallenge,CodeChallengeMethod:'S256'}` -> `{ChallengeId,ExpiresIn}` |
| `POST /otp/verify` | `{ChallengeId,Code}` -> `{Code,State}` |
| `POST /authorize` | `{Provider,State,CodeChallenge,CodeChallengeMethod:'S256'}` -> `{AuthorizationUrl,TransactionId}` |
| `POST /redeem` | `{Code,CodeVerifier}` -> `{IdentityTicket,IdentityKey,ExpiresIn}` |
| `POST /wallet` | `{IdentityTicket}` -> `{AppId,UserId,IdentityKey,WalletAddress:null|string,ChallengeId,Message,ExpiresIn:60}`; ticket retained |
| `POST /session` | `{IdentityTicket,WalletAddress,ChallengeId,Signature}` -> opaque session with top-level `AppId`/`UserId` and matching `User.Id` |

**Wallet access binding v1 is required.** Absent or unsupported
`WalletAccessVersion` fails before authentication/key setup, with no unsigned
session fallback. Deploy the matching backend before upgrading the browser
SDK. The SDK validates the returned identity, application, API issuer/origin,
and challenge bindings, then signs the server's exact UTF-8 `Message` (LF
delimiters, no trailing LF), not a reconstructed message or transaction.
`Signature` is a standard padded-base64 64-byte Ed25519 signature. Registered
passkey-protected keys require a successful local passkey unlock before proof
and session creation.

Wallet sharing is limited to the **same tenant, AppId/API-key record, and
canonical wallet user**. Local records are scoped by API deployment, AppId,
and canonical UserId, not just provider `sub` or email. An existing server
address with missing, mismatched, or incomplete local key material reports
`RECOVERY_REQUIRED`; the SDK does not overwrite the association or generate a
replacement. The original device or an explicitly supported recovery method
is required; cross-device recovery is not implemented by this package.

The server atomically registers the first address. A competing
`409 wallet_conflict` supplies the canonical app/user/address. The SDK checks
only existing local key material: a mismatch requires recovery; a matching key
reports `WALLET_CONFLICT` and requires fresh sign-in. `/session` consumes both
ticket and challenge before validation and persistence, **including all
failures and conflicts**. Never retry an old ticket after a rejected or
ambiguous exchange. Fresh authentication/redeem is required; an interrupted
first setup may reuse its persisted local key. `/wallet` does not extend the
original ticket's 120-second expiry.

Scoped session restoration uses the server's top-level `AppId`/`UserId`
through `/api/EmbeddedWallet/session` and the matching scoped local record.
Legacy sessions/associations are not implicitly migrated or backfilled across
applications. `wallet_scope_migration_required` surfaces as
`WALLET_SCOPE_MIGRATION_REQUIRED` and blocks setup pending an explicit operator
migration.

Social authorization navigates a popup to `AuthorizationUrl`. The fixed broker
callback posts only `{Type:'altude:wallet:authorization',Code,State}` to the exact
enrolled origin. The SDK checks the message's exact broker origin, popup window,
and unpredictable state before redeeming once with S256 PKCE. The popup must
retain its opener; incompatible COOP policies will result in cancellation or
timeout, not a silent fallback. Listeners/timers are removed on completion,
closure, error, or the two-minute popup timeout.

OTP challenges expire after 300 seconds and are single-attempt, including failed
verification. Use **Resend code** after any failed/ambiguous verification; the
SDK never automatically sends another message. Handoff codes expire after 60
seconds; identity tickets expire after 120 seconds. Grants are single-use and
bound server-side to the selected app, tenant, origin, and PKCE attempt. Rate
limits, unsupported MFA/bot challenges, unavailable broker deployments, and
origin failures surface as explicit errors. There is no direct-Auth0 or hosted
OTP fallback. Session restoration and sign-out continue through
`/api/EmbeddedWallet/session` and `/api/EmbeddedWallet/signout`.

### Optional direct Auth0 SPA adapter

For applications explicitly managing their own Auth0 SPA, `createAuth0WalletAuth`
remains available. It returns API-audience access tokens to the unchanged
`POST /api/EmbeddedWallet/auth0` exchange instead of broker tickets:

```ts
import { createAuth0WalletAuth } from '@altude/wallet'

const auth0 = await createAuth0WalletAuth({
  domain: 'your-tenant.auth0.com',
  clientId: 'your-public-spa-client-id',
  apiKey,
  audience: 'https://api.altude.so',
  connections: { Google: 'google-oauth2', Apple: 'apple' },
  otpConnections: { email: 'email', sms: 'sms' },
})
// Pass auth0.auth and auth0.socialProviders instead of the broker values above.
```

Only for this direct adapter, register the browser origin in the Auth0 SPA application's **Allowed Callback
URLs**, **Allowed Web Origins**, and **Allowed Origins (CORS)**, and enable the configured passwordless/social
connections for that application. `apiKey` must be a client-safe Altude API
key: the SDK forwards it to Auth0 as
`customParams: JSON.stringify({ walletApiKey: apiKey })` on authorization
requests for Auth0 Actions that need the wallet API key. Never use a server
secret; this value is sent as an authorization parameter and is not a secret.
Auth0.js normalizes the OTP authorization query key to `custom_params`;
the JSON value still contains `walletApiKey`. A wallet Post-Login Action must
accept that key as well as the social SPA flow's `customParams`.
The `clientId` is public; never put an Auth0 client secret in browser code. The
helper uses Auth0 SPA JS for hosted social login. Email/SMS use Auth0.js
`passwordlessStart`/`passwordlessLogin` through `startOtp`/`verifyOtp`, keeping
identifier and code entry in the wallet UI. Verification completes through a
hidden `web_message` iframe, not a visible Auth0 login popup. Auth0.js manages
OAuth state and validates ID-token signatures and nonces. OTP tokens are used
only in memory for the Altude session exchange, not added to the SPA JS cache.
This requires embedded/cross-origin authentication to be enabled, RS256 ID tokens,
the appropriate application grant settings, and compatible browser cookies.
A same-site Auth0 custom domain is recommended; blocked third-party cookies
or consent requirements can prevent embedded completion and are surfaced as errors,
not silently replaced with hosted login. No browser code calls the direct
passwordless `/oauth/token` grant, which Auth0 does not support for SPAs.
Email/SMS require the corresponding passwordless connections and message
delivery providers to be configured in Auth0. Use `null` for an
`otpConnections` channel to disable it; defaults are `email` and `sms`.

The `walletUi` contract matches
[AltudePlatform/Altude-Platform-API#340](https://github.com/AltudePlatform/Altude-Platform-API/pull/340):
`branding` holds app name, tagline and logo; `legal` holds terms, privacy and SMS
consent; `authMethods` is the sign-in allowlist (including `externalWallets`);
`trust` holds the platform-verified Ika/SOC 2 flags. The managed UI only offers
enabled methods with matching local adapters and only shows verified badges
when their flag is exactly `true`. Unknown optional fields are ignored.

This package is browser-only. The browser broker and its opaque sessions stay
separate from the native callback broker in
[AltudePlatform/Altude-Platform-API#338](https://github.com/AltudePlatform/Altude-Platform-API/issues/338).
Native iOS/Android callback setup, native JWTs, and native refresh/revoke are not
used by this browser adapter. Browser/native wallet associations can converge
within the same app/user scope, but their credentials and login transports
remain separate. The optional direct Auth0 exchange is legacy; it neither
establishes broker interoperability nor selects broker-scoped local keys.
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
does not authenticate the user. Access tokens or browser identity tickets are
independently validated by the API. Custom adapters return either
`{identityKey,accessToken}` or `{identityKey,broker:{identityTicket}}`, never both.
Passkey API authentication still needs a separately implemented server-validated
ceremony; local key protection is not remote authentication.

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

For **local-only access without API authentication**, enable the passkey method
in the managed UI, or use the headless lifecycle:

```ts
const state = await wallet.createLocalWallet()
// Retain this public, opaque handle to reopen the same browser's stored wallet.
const handle = state.localIdentityKey!
const signature = await wallet.signMessage(new TextEncoder().encode('My application message'))
await wallet.signOut()
await wallet.openLocalWallet(handle)
```

These wallets have `custody: 'local'`, `session: null`, and a passkey-protected
record before their address/handle is exposed. `signMessage(bytes)` and
`signTransactionMessage(bytes)` sign a copy locally and return only the
signature. They do not authenticate, provision, or relay anything. Applications
must explain the exact message to the user before requesting a signature.
`getPasskeyAvailability()` refreshes capability discovery; both the default
browser adapter and injected adapters must explicitly advertise PRF support.
Actual ceremonies still verify the PRF result and reject unsupported or
cancelled authenticators. Availability is not proof of recovery, portability,
or a server-verified passkey login.

The managed UI exposes local creation, returning access by handle, handle
copying, lock/unlock, balance selection, and independently confirmed provisioning.
The handle is not a backup: it cannot recreate a deleted IndexedDB record or
unlock a wallet on another origin/device. A retained API session must be signed
out before entering local-only or external custody.

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

Confirmation is **asynchronous**: the SDK first reads fresh authoritative
`RpcEnvironment` from transaction config. Always wait for the event rather than
assuming an ID is available immediately after requesting a transfer.
The confirmation carries an immutable intent with that network. An explicitly
configured wallet network is a constraint, not permission to override the
server. Changes are rejected before signing and again before relay; the
Gas Station execution and its HTTP retry/fallback boundaries receive the same
`expectedNetwork`. Without an explicit
constraint, the server selects the network. Missing/unsupported config fails
closed rather than falling back to a public RPC or guessed cluster.

Approval claims the request immediately; concurrent `approveTransaction(id)`
calls reject with a `TRANSACTION` error rather than submit another transfer.
Requests stay cancellable while submitting. Changing identity, signing out, or
rejecting the request cancels its pending result, prevents HTTP submission or
retry after cancellation (including during a final config refresh), and prevents
a late relay response from reporting completion. Cancellation cannot retract a transfer
already sent to the relay; check its status before requesting another transfer.

`createAccount(tokens?, signal?)` now **requests** provisioning; it does not immediately
submit. Headless consumers must handle `provisioning:confirmation`, display
its frozen token list and network, then call `approveProvisioning(id)` or
`rejectProvisioning(id)`. The returned promise settles only after that decision
and execution. Do not await it inside a UI busy wrapper that disables the
confirmation controls. Duplicate approvals cannot submit twice; rejection,
identity change and sign-out cancel pending work. A successful existing-account
no-op returns `Status: 'Success'`, `Message: 'Account already exists'`, and an
empty `Signature`, with no new relay submission.
An optional `AbortSignal` also cancels preparation before a confirmation exists.
The managed UI aborts that preparation on teardown and rejects unsubmitted
confirmations, while leaving already submitting operations alone.

`getBalance()` selects SOL; `getBalance(mintAddress)` selects an SPL token.
The managed balance form accepts an optional token mint. These methods,
`getHistory()`, and `getTransaction()` use Gas Station's supported account/RPC
capabilities. Transaction lookup searches
the most recent 100 history entries; the current Gas Station API does not
provide a direct lookup endpoint.

`getWalletUiConfiguration()` reads the optional `walletUi` section from
`GET /api/transaction/config`. When that section exists, its enabled methods
act as an allowlist and are intersected with the app's configured auth handlers
and external-wallet adapters; an enabled method without an adapter is not shown.
When the API returns no wallet UI settings, use explicit developer configuration
as a fallback (`authMethods` and `legal`, or a supplied `walletUi` object).
With neither source configured, the UI offers no guessed login methods.
Unavailable external providers are hidden, and capability checks also apply
to headless connection attempts. SMS send/resend requires initially unchecked
consent and configured copy; editing the phone number or channel clears consent.

The managed UI places email/SMS first, configured social and passkey buttons
next, and an expandable Web3 wallet row last. The row lists only enabled,
configured providers. Auth0 email/SMS use the wallet's identifier and code
forms; social sign-in launches hosted login. Other identity providers can use
the custom adapter methods.
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
The suite covers custom OTP/resend/social popup exchange, consent, configuration
precedence, unavailable methods, local PRF-protected signing, managed approval,
persistent-key adoption races, keyboard/legal focus, reduced-motion pseudo
elements, trust gating, and actual iframe wrong-origin/wrong-source messages.
Identity/API/PRF/relay services are synthetic; this is not physical-authenticator,
live Auth0 delivery, backend deployment, SQL Server concurrency, recovery, or
live-transfer acceptance evidence.
