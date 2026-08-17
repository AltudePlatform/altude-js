# @altude/gasstation

## 2.1.0

### Minor Changes

- d70d947: React Native / Hermes compatibility fix for Altude SDK package exports and Node-only runtime assumptions

### Patch Changes

- Updated dependencies [d70d947]
  - @altude/core@0.1.1

## 2.0.0

### Major Changes

- 6a6f41c: Require RPC node URLs and JWTs from Altude's API-key-scoped transaction config
  instead of falling back to public Solana endpoints.

### Patch Changes

- ec540e9: Add dedicated browser and React Native/Hermes entrypoints, lazy RPC subscription
  initialization, and Buffer-free native transaction construction.
- Updated dependencies [6a6f41c]
- Updated dependencies [ec540e9]
  - @altude/core@0.1.0

## 1.0.0

### Major Changes

- b1478d5: fix "blockhas not found error" and improved partial transaction generation

## 0.0.2

### Patch Changes

- 572e582: Ensure pack and publish build package outputs before creating tarballs, and fix package export metadata ordering for published entrypoints.
- Updated dependencies [572e582]
  - @altude/core@0.0.2

## 0.0.1

### Patch Changes

- c65c42b: Add repository metadata and npm provenance publishing configuration to the published packages.
- Updated dependencies [c65c42b]
  - @altude/core@0.0.1

## 0.0.0

### Minor Changes

- 04c5e0d: Add RPC auth headers to core client and extend gas station with init, account info, history, close account, and batch transaction APIs.

### Patch Changes

- Updated dependencies [04c5e0d]
  - @altude/core@0.0.0
