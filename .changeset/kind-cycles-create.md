---
'@altude/gasstation': patch
---

Make `createAccount` idempotent by skipping existing associated token accounts, and default an omitted or empty token list to Wrapped SOL. The `closeAccount` default remains unchanged.
