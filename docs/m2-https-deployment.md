# M2b: persistent HTTPS dry-worker deployment

Deployed and verified 2026-09-08. This extends M2a, not live check-in execution.

## Architecture

The existing HTTPS ingress delegates `/v2/dry/*` to a separately authenticated
handler in the same modular server process. No new public port, DNS record,
CDP endpoint, SSH forwarding permission or Lucky rule was added. The handler has
independent credentials, scope, rate budget and SQLite storage. It shares the
dashboard container lifecycle; it is not a separate fault-isolated microservice.

Enabled POST endpoints: claim, receipt and status. Anonymous/dashboard credentials
fail worker auth; worker keys cannot access dashboard APIs. Execute and successful
check-in receipts remain rejected. Status contains only per-worker job metadata.

Deployment requires BOTH compose files:

```
docker compose -f compose.nas.yaml -f compose.worker.yaml up -d --build
```

Using only the base file disables the opt-in worker handler. The overlay mounts
transport-config read-only and transport-data separately from nas-data. Registry
updates replace the file atomically in its mounted directory; requests reload and
validate it, so rotation/revocation is immediate without restarting the server.
NAS stores random credential SHA-256 digests. Windows uses CurrentUser DPAPI and
restricted directory ACLs. Plaintext keys never enter source, process arguments
or logs. There is no public enrollment API and no shared dashboard credential.

## Windows lifecycle

worker-once.mjs accepts the secret over stdin, runs one dry unit/outbox retry and
exits. Ops Run-DryWorker.ps1 decrypts in memory and starts Node with CreateNoWindow,
a mutex and a 30s timeout. No browser/site adapter is imported.

Windows denied new scheduled-task registration. No elevation, extra startup entry
or resident workaround was used. Existing V2 shadow scheduling now invokes
Invoke-DryWorkerIfDue.ps1 at most once per 15 minutes using the hidden VBS launcher.
The dry worker has its own attempt marker/failure handling and cannot cause V1 or
snapshot synchronization to rerun. The existing interactive user must be logged
in for scheduling and DPAPI. No operation while the PC is off is claimed.

Set enabled:false in the private worker config to stop scheduling. Remove its
registry entry to revoke access. Preserve local journal/outbox for investigation.
DPAPI credentials are not portable to another user/PC: re-enroll a new key.

## Verified evidence

- Real HTTPS with normal certificate checks: worker status 200.
- Execute request rejected: 400 execute_disabled.
- Key rotation: old key 401, new key 200; subsequent revocation 401.
- Windows dry worker: reported once, then idle, browserActions=0.
- SQLite online backup opened independently: integrity_check=ok, one job restored,
  original database unchanged.
- NAS container restart preserved accepted receipt; worker remained idle.
- Existing scheduled task actually triggered and exited with LastTaskResult=0.
- Anonymous worker endpoint 401; dashboard container healthy.
- Local tests verify dashboard/worker auth separation and live registry changes.

The test canary registration is revoked. Only the persistent Windows registration
remains, allowlisted to the approved current origins. New bookmarks do not silently
expand its allowed origins. It consumes only eligible shadow tasks as journal-only
dry units, never as real sign-ins. No second Telegram sender was installed.

## Remaining gates

M2b HTTPS/auth/storage/lifecycle is operational for dry-run. M3 adapter-level
identity and evidence validation, explicit ownership transfer and real canary
acceptance are still required. Long-term retention/metrics, actual disk-full and
power-loss tests, host reboot in flight, and a supported quarantine-review workflow
remain hardening work. Container restart and backup tests do not prove these.

Rollback: disable the dry worker, revoke registration, preserve the transport DBs,
then redeploy the previous image/base configuration if necessary. V1 remains owner.
Back up SQLite via its online backup API, not a hot copy that ignores WAL. Registry
is backed up separately. Invalid startup registry can stop the shared container,
so validate replacements and retain the prior registry/source backup.
