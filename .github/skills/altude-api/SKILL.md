---
name: altude-api
description: Use when implementing Altude API clients, RPC initialization, gas-station flows, or API-key-authenticated blockchain operations.
---

# Altude API Integration

Treat Altude's API-key-scoped transaction config as the only source of
blockchain node configuration.

## Required RPC bootstrap

1. Send the Altude API key in `X-API-Key` to
   `GET {baseUrl}/api/transaction/config`.
2. Treat the response as authoritative:
   - `RpcUrl`: cluster RPC endpoint
   - `Token`: short-lived RPC JWT
   - `TokenExpiration`: JWT expiry
   - `FeePayer`: relay fee payer
   - `RpcEnvironment`: selected cluster
3. Create the RPC transport with `RpcUrl`.
4. Send `Token` as `Authorization: Bearer <Token>` on RPC requests.
5. Refresh config before `TokenExpiration` and retry one authenticated
   operation after a 401/403 by fetching fresh config.

## Never add fallbacks

Do not use public Solana endpoints, environment-provided RPC endpoints,
hard-coded fee payers, or network-name defaults when Altude config is missing
or invalid. Fail explicitly so a bad API-key or cluster configuration cannot
silently send a transaction to the wrong node.

Wrong:

```ts
const rpcUrl = config.RpcUrl || 'https://api.devnet.solana.com'
```

Right:

```ts
const config = await altudeClient.getConfig()
const rpc = createAltudeClient({
  rpcUrl: config.RpcUrl,
  rpcToken: config.Token,
})
```

Validate that the RPC URL is an HTTP(S) URL and that the JWT is present before
creating the transport. Treat sentinel values such as `cluster-not-found`,
`error-getting-cluster-config`, and `jwt_unavailable` as API errors, not usable
configuration.

## Tests

Cover:

- `X-API-Key` on the config request
- `RpcUrl` passed unchanged to the RPC transport
- `Token` sent as a bearer authorization header
- config caching and expiry refresh
- explicit rejection of missing or invalid node/JWT values
- absence of public Solana RPC URLs in production code

## API contract gaps

When the API returns success-shaped fallback configuration or cannot provide
the fields above, search `AltudePlatform/Altude-Platform-API` for an existing
issue. If none exists, file a focused issue with the endpoint, observed
response, expected non-2xx behavior, and client impact.
