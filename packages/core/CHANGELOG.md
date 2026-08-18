# @altude/core

## 0.1.1

### Patch Changes

- d70d947: React Native / Hermes compatibility fix for Altude SDK package exports and Node-only runtime assumptions

## 0.1.0

### Minor Changes

- 6a6f41c: Require RPC node URLs and JWTs from Altude's API-key-scoped transaction config
  instead of falling back to public Solana endpoints.

### Patch Changes

- ec540e9: Add dedicated browser and React Native/Hermes entrypoints, lazy RPC subscription
  initialization, and Buffer-free native transaction construction.

## 0.0.2

### Patch Changes

- 572e582: Ensure pack and publish build package outputs before creating tarballs, and fix package export metadata ordering for published entrypoints.

## 0.0.1

### Patch Changes

- c65c42b: Add repository metadata and npm provenance publishing configuration to the published packages.

## 0.0.0

### Minor Changes

- 04c5e0d: Add RPC auth headers to core client and extend gas station with init, account info, history, close account, and batch transaction APIs.
