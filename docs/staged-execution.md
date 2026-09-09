# Staged V2 execution

V2 runs in two modes:

- `v2_daily_read_only` inspects registered profiles and today's state without
  a mutation.
- `v2_daily_execute` is limited to migration records in `candidate` or
  `active` state, one account at a time, inside the configured time window.

Before a mutation the runner checks the V1 lock and scheduler state, reserves a
durable idempotency key, and writes an account-level `pending_v2` handoff
marker. V1 reads that marker when it starts and skips only that account. The
marker becomes `v2_owned` only after V2 receives authoritative same-day proof;
otherwise it is removed, except for `submission_unknown`, which remains
quarantined for review.

The daily entry is `scripts/run-v2-daily.mjs`. It is called by the existing V1
user scheduler as a temporary trigger because this machine does not permit a
new scheduled-task registration. The hook is account-scoped and hidden. A V2
failure does not stop the legacy scheduler.

Every profile is created under `data/v2-profiles/`; V1 cookies, passwords,
DPAPI stores and Chrome profiles are never copied. `src/execution-journal.mjs`
records `reserved`, `prepared`, `succeeded` and `submission_unknown` states so
a process restart cannot silently replay a submission.
