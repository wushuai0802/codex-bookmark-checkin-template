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
