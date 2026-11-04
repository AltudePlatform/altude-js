# @altude/wallet-react-native

React Native client for the Altude native wallet callback broker. This
experimental package is not included in the production release allowlist.
It is a separate native sign-in flow and does not change the browser-only
`@altude/wallet` package.

## Install platform adapters

The client uses the system authentication browser, a cryptographically secure
random source, and platform-protected refresh-token storage. Install and link
native modules in the consuming app, then adapt them at the SDK boundary:

```ts
import InAppBrowser from 'react-native-inappbrowser-reborn'
import * as Keychain from 'react-native-keychain'
import 'react-native-get-random-values'
import {
  NativeWalletClient,
  createCryptoRandomSource,
  createInAppBrowserAdapter,
  createKeychainRefreshTokenStore,
} from '@altude/wallet-react-native'

const walletAuth = new NativeWalletClient({
  apiKey: ALTUDE_API_KEY,
  apiBaseUrl: 'https://api.altude.so',
  browser: createInAppBrowserAdapter(InAppBrowser),
  refreshTokenStore: createKeychainRefreshTokenStore(Keychain),
  randomBytes: createCryptoRandomSource(globalThis.crypto),
  onSignedOut: () => localWallet.lock(),
})

const session = await walletAuth.signIn()
const accessToken = await walletAuth.getAccessToken()
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

## Session lifecycle

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

The API key is used only for the configuration bootstrap and is never placed in
the authorization URL. Broker requests use the documented `AppId` and
PascalCase payloads. The SDK does not retry ambiguous code exchanges or refresh
requests because the server may already have consumed the credential.

The returned Altude access token is an identity credential, not an embedded
wallet session or proof of local key possession. Developer backends must
validate its signature, exact issuer and audience, expiry, and app/tenant
claims using the trusted `JwksUrl` from bootstrap. The SDK does not perform
backend JWT validation, create wallet keys, provision on-chain accounts, or
authorize existing dashboard/platform endpoints.

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
