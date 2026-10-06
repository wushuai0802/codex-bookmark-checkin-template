# Panel synchronization notifications

The private Windows scheduler can reuse `scripts/Sync-OperationsSupport.ps1`.
Load it after resolving the observation runtime and define `Write-SchedulerLog`
in the caller. The library does not start a scheduler, sync data, open a browser,
or perform a check-in when imported.

```powershell
. (Join-Path $config.v2ProjectRoot 'scripts/Sync-OperationsSupport.ps1')
# Called separately from synchronization, while holding the scheduler mutex:
if (Invoke-PendingNotification $state $config.legacyRoot (Get-Date)) {
    # Persist the updated state atomically using the scheduler's existing writer.
}
```

Use `success` for recovery and `failed` for a synchronization failure. Existing
queued `completed` notifications migrate to `success` on the next probe. Their
event key stays unchanged, preserving receiver deduplication; only their invalid
payload and retry delay are repaired. New outage/recovery transitions should use
distinct stable keys, such as a timestamp with milliseconds, rather than a key
shared by every event that day.

The notification configuration comes from the existing execution configuration,
with local notification overrides merged in. Display names use the unified
project terminology; the legacy internal task identifier remains compatible.
Delivery requires both a zero command exit and an explicit `accepted` or
`duplicate` boolean acknowledgement. Pretty-printed and single-line JSON are
supported. A failed acknowledgement retains the queue and uses bounded backoff;
it never changes synchronization retry state or restarts check-in execution.

Notification commands use the execution layer's shared `Invoke-BoundedCommand.ps1`
and honor the configured timeout. The scheduler passes completed, failed, timed-out
and start-failed child outcomes to `Set-SyncAttemptOutcome`, then persists the sync
state before sending notifications. Timeout uses exit code 124 and the same alert
and bounded retry path as other sync failures.

`Invoke-PtEvidenceRepair.ps1 -CatalogFile <current-catalog>` can run from the same
existing probe. It defaults to one reviewed PT page per probe (`-MaxSites` permits
1–4 sequential reads) and twice per site per business day, only for reported
completions whose evidence is missing. The wrapper waits for the worker to finish
and the worker invokes the read-only dashboard rebuild callback while holding the
PT repair lease; the rebuild also takes the global V1/V2 lease, so a concurrent
daily publication returns a bounded `runner_busy` result instead of mixing
generations. A dated `outputs/pt-evidence-repair-dirty-YYYY-MM-DD.json` marker is
written after every worker completion. The scheduler or NAS sync layer should use
that marker to schedule its normal status sync; the worker never uploads, sends a
notification, or submits a check-in.

The worker holds execution locks, never calls a submission path, publishes only
authoritative positive readbacks, and leaves original completion reports intact
when a read fails. Each attempt also writes a redacted, structured audit line with
`status`, `errorStage`, `errorCode`, and `submissionAttempted:false`. Native browser
fallback is limited to configured single-account profiles and the reviewed index
pages in the shared contract. No new scheduled task is needed.

`Invoke-SyncRemoteCommand` captures SSH stderr and returns an exit code plus a
safe failure category. Pass `-o ConnectTimeout=15 -o ServerAliveInterval=15
-o ServerAliveCountMax=2` to bound a disconnected SSH session. For tar uploads,
keep the binary pipeline inside the existing native shell; capture that shell's
result rather than passing tar bytes through PowerShell text pipes. Report the
upload and commit stages separately, preserving the existing atomic generation
publication and whole-sync backoff. Do not replay a check-in to repair transport.

Deploy the shared library before updating a private wrapper to import it. Keep
the wrapper backup and source hashes alongside the normal runtime release
manifest. The regression test exercises PowerShell 5.1 and 7 with isolated
notification executables; it never sends a real message or contacts a PT site.
