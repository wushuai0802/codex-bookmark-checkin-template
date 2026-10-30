# Gateway health records

The PowerShell gateway records unsuccessful controller exits and local
pre-dispatch/lease exceptions in `data/gateway-events.jsonl`. Each record has
only `schemaVersion`, UTC `time`, a fixed `stage`, a fixed `errorCode`, and
`exitCode`. Controller stderr is interpreted only through a small structured
error allowlist; raw messages, arguments, URLs, Profile paths and configuration
contents are not persisted in these records.

Each file holds at most 256 records; `.1`, `.2` and `.3` are the retained older
files. Rotation is serialized by a separate diagnostic mutex, which never
grants or replaces an execution lease. Diagnostics cannot authorize replay or
change the original gateway exit code.

Only outer scheduled probes update `data/gateway-health.json`; manual calls
and lease-validation re-entry do not increment the streak. Two consecutive
failures with the same code enqueue one blockage notice in the existing
notification outbox. Further failures reuse that incident until a successful
probe enqueues its one recovery notice. An executor-busy skip is not recovery.
Notification mode `none` stays disabled. Delivery uses the existing outbox
adapter, acknowledgement, retry and event-key deduplication; notification
failures never trigger a site replay or change the gateway exit code.

Gateway event keys have their own incident scope, so the daily report cannot
supersede an undelivered blockage or recovery notice. A bounded outbox flush
also runs on blocked scheduled probes, because the ordinary scheduler's
notification loop has not yet been entered in that case.
