---
'@altude/gasstation': patch
---

Make `createAccount` idempotent by skipping existing associated token accounts, and change its null or omitted mint default from USDC to Wrapped SOL. The `closeAccount` default remains unchanged.
