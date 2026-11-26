---
'@altude/core': patch
'@altude/gasstation': patch
---

Avoid automatic transaction resubmission after an ambiguous relay failure and
return an actionable `RELAY_SUBMISSION_UNCERTAIN` error.
