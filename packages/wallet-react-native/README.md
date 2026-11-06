# @altude/wallet-react-native

Experimental React Native login-to-wallet orchestration with system-browser
authentication, authoritative wallet lookup, protected local signing keys,
proof-bound wallet sessions, and sponsored transfers. This package remains
private and outside the production release allowlist. The coordinated browser
bridge uses the same server association, not native JWTs or native platform adapters.

## Install platform adapters

The client uses the system authentication browser, a cryptographically secure
random source, and platform-protected refresh-token storage. Install and link
native modules in the consuming app, then adapt them at the SDK boundary:

```ts
import InAppBrowser from 'react-native-inappbrowser-reborn'
import * as Keychain from 'react-native-keychain'
import 'react-native-get-random-values'
import {
  AltudeNativeWallet,
  createCryptoRandomSource,
  createInAppBrowserAdapter,
  createKeychainRefreshTokenStore,
  createKeychainWalletKeyStore,
} from '@altude/wallet-react-native'

const wallet = new AltudeNativeWallet({
  apiKey: ALTUDE_API_KEY,
  apiBaseUrl: 'https://api.altude.so',
  browser: createInAppBrowserAdapter(InAppBrowser),
  refreshTokenStore: createKeychainRefreshTokenStore(Keychain),
  randomBytes: createCryptoRandomSource(globalThis.crypto),
  keyStore: createKeychainWalletKeyStore(Keychain),
})

wallet.onEvent((event) => {
  if (event.type === 'state') renderWalletState(event.state)
})

try {
  const state = await wallet.connect()
  // ready means the server's expected address has an available local signer.
  console.log(state.address)
} catch (error) {
  // RECOVERY_REQUIRED is not permission to create a different wallet.
  renderWalletError(error)
}

await wallet.sendTransfer(
  { kind: 'sol-transfer', recipient: RECIPIENT, amount: 1_000_000 },
  (intent) => showTransferApproval(intent),
)
await wallet.signOut()
```

Install and link these platform adapters in the React Native application:

```sh
pnpm add react-native-inappbrowser-reborn react-native-keychain react-native-get-random-values
```

Link `@altude/wallet-react-native` from this workspace while it remains
experimental and unpublished.

`react-native-inappbrowser-reborn` uses `ASWebAuthenticationSession` on iOS
and Custom Tabs/system browser support on Android. `react-native-keychain`
stores refresh credentials using device-protected Keychain/Keystore-backed
storage. Import the random-values polyfill before creating the client when the
React Native runtime does not provide `crypto.getRandomValues`.

The adapter interfaces are structural so applications may use equivalent
system-browser, secure-storage, and random-source modules. Do not substitute an
embedded WebView, unprotected preferences, or a non-cryptographic random
generator.

## SDK-owned wallet lifecycle

`AltudeNativeWallet` composes `NativeWalletClient`,
`NativeWalletSessionAdapter`, and `NativeWalletVault`. Applications provide
platform modules and a transfer approval UI, not identity-to-wallet session glue.
`connect()` signs in, looks up the authorized existing wallet, creates a key
only when the server explicitly reports no association, proves key possession,
and validates the resulting wallet session before exposing `ready`.
`restore()` rotates the refresh credential and repeats authoritative lookup
and signer setup. `lock()` immediately invalidates every active signer and clears
the derived session; `signOut()` also revokes the native family, even when a
state listener throws. Starting a new login first locks the old signer and
revokes its native family.

State distinguishes `authenticating`, `authenticated`, `creating`, `recovering`,
`recovery-required`, `locked`, `ready`, `failed`, and `disconnected`.
`setup:progress` events expose authentication, account lookup, device protection,
and completion. `recovering` means attempting to open the registered wallet's
local key, not that cross-device recovery has succeeded.

Keys are stored separately by API deployment URL, AppId, server wallet user, and address, with
device-only Keychain/Keystore protection. A first-wallet candidate is persisted
before server registration. Concurrent first logins use the server's atomic
winner; a loser re-looks up that address and never overwrites it. Interrupted
registration therefore does not discard an already registered key. A different
device without the winning key reports `RECOVERY_REQUIRED` and exposes no signer.
Recovery/device provisioning is not implemented; Ika recovery is separately
tracked in [#79](https://github.com/AltudePlatform/altude-js/issues/79).
An identity credential cannot reconstruct a Solana key. Device storage protection
is not a passkey authentication or cross-device recovery claim.

Transfers snapshot and freeze the recipient, amount and mint before local
approval. Session validity is checked before approval and again before signing.
Account switching, lock, expiry, refresh failure, or revocation invalidate the
signer and stale completions. Gas Station builds and relays using Altude's
existing transaction configuration, fresh blockhash and configured fee payer;
the wallet does not introduce a public RPC fallback or retry ambiguous relay
submission. Cancellation cannot retract a transaction already relayed.

## Coordinated wallet-access contract

The bridge is owned by
[AltudePlatform/Altude-Platform-API#338](https://github.com/AltudePlatform/Altude-Platform-API/issues/338)
/ [AltudePlatform/Altude-Platform-API#370](https://github.com/AltudePlatform/Altude-Platform-API/pull/370);
native orchestration is owned by
[#77](https://github.com/AltudePlatform/altude-js/issues/77) /
[#78](https://github.com/AltudePlatform/altude-js/pull/78), with coordinated
browser changes in [#76](https://github.com/AltudePlatform/altude-js/pull/76).
These are coordinated branch contracts, not deployment evidence.

Wallet sharing requires the same validated **tenant, AppId (API-key record),
and wallet user**. The server verifies the native JWT's exact issuer,
app audience, signature, expiry, user and signed refresh-family binding,
then checks the API key selects that exact AppId. No decoded JWT, email
match, provider token, browser ticket, or opaque session substitutes for this.
Existing native JWTs without the family claim require fresh sign-in after rollout.

`GET /api/native-wallet/wallet` sends `X-API-Key` and the native bearer JWT.
Its PascalCase response is:

```ts
{
  AppId: string
  UserId: string
  IdentityKey: string
  WalletAddress: string | null
  ChallengeId: string
  Message: string
  ExpiresIn: number // up to 60 seconds
}
```

The SDK signs the exact UTF-8 `Message` with the expected local Ed25519 key.
`POST /api/native-wallet/wallet/session`, using the same headers, sends
`{ ChallengeId, WalletAddress, Signature }`, with standard base64 `Signature`.
The one-time challenge is bound to the app/user/family/address. Success returns
`{ Success: true, AppId, UserId, SessionToken, User: { Id, WalletAddress, ... }, ExpiresIn }`.
The returned opaque session is kept only in memory and is never passed to a
native token endpoint. Validation uses `GET /api/EmbeddedWallet/session` with
`X-API-Key` and that opaque bearer, enforcing exact app/user/address/family scope.
The SDK requires the response's top-level `AppId` and `UserId` to match the
lookup as well as `User.Id` and `User.WalletAddress`.

Before any key creation or signing, the SDK validates the exact
`Altude Wallet Access Binding v1` proof format, trusted bootstrap issuer,
AppId/tenant, wallet user, identity, challenge, canonical address, and native
family binding. Browser Origin/IdentityTicket fields must be empty; browser
proofs and arbitrary messages are rejected. The server remains responsible
for cryptographic identity/family authorization; the SDK does not trust a
decoded JWT as authority.

The deployment-qualified device key namespace replaces the earlier experimental
AppId/user-only namespace. The SDK does not automatically copy keys from an
ambiguous legacy namespace into a deployment; existing installations must
explicitly provision the original key or report recovery required.

Derived sessions expire no later than their native family's remaining lifetime.
Family revocation/replay makes them unusable at the server; already issued native
access JWTs retain their documented five-minute lifetime but cannot bypass the
bridge's live family check. The SDK locks on derived expiry or validation failure.
It cannot detect offline remote revocation before its next server check.

`409 wallet_conflict` never registers a second address; the SDK re-looks up
the canonical association and opens that key or reports recovery required.
`409 wallet_scope_migration_required` maps to
`WALLET_SCOPE_MIGRATION_REQUIRED` and blocks creation until an operator enrolls
the legacy tenant-wide address for an approved AppId. There is no automatic
legacy backfill or cross-app sharing. This requires a tenant migration for
app-scoped wallet associations and derived session scope before SDK rollout.
Browser broker lookup/proof changes are a coordinated breaking contract update,
not an additive release of the old ticket/address-only session flow.

## Native callback scheme

`GET /api/native-wallet/config` uses the existing API key in `X-API-Key` and
returns the public `AppId`, `NativeScheme`, `Issuer`, `Audience`,
`AuthorizationUrl`, and `JwksUrl`. The API derives `AppId` from existing
tenant/API-key record IDs; it is not the API-key value. The SDK opens the
returned authorization URL in the system browser and validates the callback
scheme, `callback` host, and saved state before exchanging its short-lived
code and PKCE verifier.

Register the returned `NativeScheme` in the installed application. A runtime
JavaScript library cannot alter an installed app's native manifest.

For iOS, add the returned scheme to `Info.plist`:

```xml
<key>CFBundleURLTypes</key>
<array>
  <dict>
    <key>CFBundleURLSchemes</key>
    <array><string>so.altude.wallet.t17.a42</string></array>
  </dict>
</array>
```

For Android, add an intent filter to the React Native activity that receives
deep links:

```xml
<intent-filter>
  <action android:name="android.intent.action.VIEW" />
  <category android:name="android.intent.category.DEFAULT" />
  <category android:name="android.intent.category.BROWSABLE" />
  <data android:scheme="so.altude.wallet.t17.a42" android:host="callback" />
</intent-filter>
```

Replace the example scheme with the exact `NativeScheme` returned by bootstrap,
then rebuild the native app. Do not register a developer-provided redirect with
Auth0.

Private-use URL schemes can be intercepted by another installed app. PKCE
prevents an interceptor from redeeming a code without the original verifier;
it does not attest which app initiated a new login. Verified Universal Links,
App Links, and app attestation are outside this broker contract.

## Low-level broker client

`NativeWalletClient` remains available for broker-only consumers and does not
generate signing keys. Its methods below do not return a ready wallet:

- `signIn()` bootstraps configuration, opens the system browser with random
  state and S256 PKCE, validates the return URL, and redeems the code at
  `/api/native-wallet/token`.
- `restoreSession()` rotates the stored refresh credential at
  `/api/native-wallet/refresh`; it returns `null` when no refresh credential is
  stored. Refresh is serialized in the client.
- `getAccessToken()` returns a still-valid in-memory access token or performs a
  refresh. Access tokens are not persisted by the SDK.
- `signOut()` calls `/api/native-wallet/revoke`, removes the local refresh
  credential, and invokes `onSignedOut` even if server revocation fails. Wire
  `onSignedOut` to lock any application-owned local wallet key. Cleanup errors
  are surfaced; sign-out is not reported as fully successful when local cleanup
  fails.

The low-level API key is used only for configuration bootstrap and is never
placed in the authorization URL. Wallet-access requests additionally require
that key to enforce app scope. Broker requests use the documented `AppId` and
PascalCase payloads. The SDK does not retry ambiguous code exchanges or refresh
requests because the server may already have consumed the credential.

The returned Altude access token is an identity credential, not an embedded
wallet session or proof of local key possession. Developer backends must
validate its signature, exact issuer and audience, expiry, and app/tenant
claims using the trusted `JwksUrl` from bootstrap. The low-level client does not
perform backend JWT validation or create wallet keys. The high-level wallet
does not provision on-chain token accounts automatically or authorize existing
dashboard/platform endpoints.

## Errors and validation

Operations reject with `NativeWalletError`, which provides a typed `code` and
optional HTTP `status`. Cancellation, API errors, invalid broker responses,
browser failures, and secure-storage failures are explicit; credentials and
callback contents are not included in error messages.

Run package checks with:

```sh
pnpm --filter @altude/wallet-react-native test
pnpm --filter @altude/wallet-react-native typecheck
pnpm --filter @altude/wallet-react-native lint
pnpm --filter @altude/wallet-react-native build
pnpm test:react-native
```

The broker contract is tracked in
[AltudePlatform/Altude-Platform-API#338](https://github.com/AltudePlatform/Altude-Platform-API/issues/338)
and currently documented by
[API PR #370](https://github.com/AltudePlatform/Altude-Platform-API/pull/370).
Reconcile against the accepted and deployed API contract before release.

## Integrated release gates

Do not mark the native wallet experience complete or publish this package until:

- First, repeated, concurrent and interrupted logins converge on one intended
  server association; legacy enrollment never changes an existing address.
- Wrong tenant, app, user, token type, expired proof and revoked family are
  rejected by real API-boundary tests.
- Web-to-iOS and web-to-Android resolve the same approved app/user/address.
  Missing keys report recovery required; supported provisioning must prove it
  restores the original signer before any recovery capability is advertised.
- Cancellation, expiry, refresh failure, sign-out/revoke failure, account
  switching and late completions cannot expose the previous user's signer.
- Real iOS and Android sample applications use the SDK-owned flow against
  the non-production broker and complete a locally approved sponsored transfer.
  Mocks, local sample snippets and Hermes smoke checks do not prove device,
  provider delivery, custody recovery, API deployment or a live transfer.

Current automated coverage exercises the native wallet lifecycle with synthetic
API responses and independently verifies its Ed25519 signatures. The Hermes-like
bundle check executes login, proof binding, restore, and lock without browser
APIs or Node `Buffer`. These are SDK contract checks, not actual HTTP
interoperability with the backend. The backend currently has no runnable
loopback wallet-bridge fixture; SDK/backend HTTP validation, non-production
deployment, actual device samples and live transfers remain explicitly blocked.
