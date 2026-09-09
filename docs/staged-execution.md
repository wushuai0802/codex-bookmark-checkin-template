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
otherwise it is removed for a confirmed no-mutation result. Once a durable
intent is written, `pending_v2` is made non-expiring and remains quarantined for
review on `prepared` or `submission_unknown`; it is never handed back to V1 by
a timer. An `active` migration requires a permanent `v2_owned` marker and
preserves that ownership across later business days and already-signed results.

The daily entry is `scripts/run-v2-daily.mjs`. It is called by the existing V1
user scheduler as a temporary trigger because this machine does not permit a
new scheduled-task registration. The hook is account-scoped and hidden. A V2
failure does not stop the legacy scheduler.

Every profile is created under `data/v2-profiles/`; V1 cookies, passwords,
DPAPI stores and Chrome profiles are never copied. `src/execution-journal.mjs`
records `reserved`, `prepared`, `succeeded` and `submission_unknown` states so
a process restart cannot silently replay a submission.

V2 notification files are an independent outbox. `scripts/flush-v2-notifications.mjs`
retries due delivery entries through the configured V1 notification command and
never invokes a browser or check-in action. The V1 scheduler invokes this flush
from its hidden loop, including when the daily V2 attempt has already run.
