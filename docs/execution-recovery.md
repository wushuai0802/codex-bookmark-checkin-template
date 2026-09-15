# V2 execution recovery

The normal path is still one read, one durable intent, one submit, and one
authoritative verification. Recovery is deliberately narrower than a retry
queue:

- A `blocked` or `submit_rejected` task can be reopened at most twice only when
  its durable outcome proves zero mutations. The old outcome remains in
  `execution_recovery_audit`.
- A `submission_unknown` task can be reopened only after a fresh,
  account-bound, same-day authoritative `not_signed` observation. This avoids
  replaying a request that may already have been accepted.
- An unknown submission can be reconciled to success when a later
  account-bound authoritative `already_done` observation is available. The
  original unknown outcome remains in `execution_reconciliation_audit` and no
  second submission is made.
- An already-signed result can be adopted only through the explicit operator
  path when the sign-in was completed in the V2 dedicated profile. The record
  is marked `operator_confirmed_v2_login`; it is not represented as an
  automated submission.

The helper entry points are:

```powershell
node scripts/recover-v2-execution.mjs --task outputs\canary-ACCOUNT-DATE.json --observation outputs\canary-observation-ACCOUNT-DATE.json
node scripts/recover-v2-execution.mjs --task outputs\canary-ACCOUNT-DATE.json --non-mutating-rejection
node scripts/reconcile-v2-execution.mjs --task outputs\canary-ACCOUNT-DATE.json --observation outputs\canary-observation-ACCOUNT-DATE.json
node scripts/adopt-v2-checkin.mjs --task outputs\canary-ACCOUNT-DATE.json --observation outputs\canary-observation-ACCOUNT-DATE.json --operator-confirmed
```

The recovery commands require an exact task/account/date binding. They never
copy V1 cookies, tokens, passwords, profiles, or DPAPI data. A V2 ownership
record is activated only after the corresponding successful or explicitly
operator-confirmed record is durable.
