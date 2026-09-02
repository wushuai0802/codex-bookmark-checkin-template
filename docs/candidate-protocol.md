# V2.0 candidate protocol boundary

This document records the protocol-only step between shadow observation and a
real worker. It is not an execution enablement document. The current dashboard
and bridge remain read-only.

## Dispatch sequence

```text
snapshot + fresh health
        ↓
worker capability / origin allowlist
        ↓
single-use task lease
        ↓
dry-run decision
        ↓
authoritative receipt
        ↓
deduplicated notification outbox
```

The candidate gate denies `execute` until all of the following are explicitly
enabled in a later cutover:

- the V2 snapshot is still valid and its plan hash matches its tasks;
- health is fresh;
- the task is not already `signed` or `already_signed`;
- the worker heartbeat is fresh and profile isolation is true;
- the task origin is on the worker's explicit allowlist;
- the task execution owner has been cut over to `v2-worker`;
- an operator has enabled candidate execution.

## Idempotency and evidence

`idem_*` is stable for one task, business date, and action. A repeated receipt
with the same outcome is accepted as a duplicate; a conflicting outcome is
rejected. Successful receipts must carry authoritative, redacted evidence.
The notification outbox derives a `notice_*` dedupe key from the receipt and
does not contain credentials or browser state.

## Current acceptance result

The local protocol tests exercise lease expiry, worker heartbeat and allowlist
checks, dry-run versus execute gating, receipt idempotency, redaction, and
notification deduplication. No browser, worker process, lease service, or
notification sender is started by these tests.
