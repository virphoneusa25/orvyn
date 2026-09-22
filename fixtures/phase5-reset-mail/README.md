# Phase 5 acceptance fixture

A 150+ file billing/auth service used to exercise Qdrant-backed hybrid search.

The seeded defect is that password-reset mail is not delivered. Do not point ORION at a specific file when running acceptance.

Prove the fixture is red first:

```
node --test test/passwordReset.test.js
```

Expected: exit 1, `expected a reset email in the outbox`.
