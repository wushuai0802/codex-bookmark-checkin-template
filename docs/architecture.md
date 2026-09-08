# V2 architecture (alpha boundary)

Historical foundation description. For the current execution target and explicit
implemented/unimplemented boundaries, see [execution-redesign.md](execution-redesign.md).
The ops deployment now includes a real read-only Harvest connector and allowlisted
username/ID display metadata. The earlier statement below excluding all account
labels describes the alpha export, not the present authenticated dashboard.
Credentials and browser profiles still never enter dashboard snapshots.

```text
legacy Windows runner (sole executor)
        | read-only files
        v
V2 bridge -> redacted plan/tasks/receipts/health snapshot
        ^ optional redacted PT status observations (Harvest or observer)
        | shadow ledger + schedule gate (beta, no lease)
        | later: authenticated, leased envelopes
        v
NAS control plane + dashboard (ledger, schedule gate, health, notifications)
```

## Ownership and identity

The stable plan-unit identity is:

```text
logicalSiteKey + accountKey + actionType + scheduleOccurrence
```

The bridge hashes this tuple into a `unit_...` identifier. A dated execution
instance hashes `businessDate + planUnitId` into a `task_...` identifier. A site with five
AgentRouter accounts therefore produces five distinct execution units while
remaining one logical site. `accountKey` is a stable internal identity; no
password, cookie, token, profile path, or account label is shared.

`planHash` and cross-day drift use the stable plan units. Receipts and daily
execution state continue to use the dated task IDs.

## Logical grouping

The alpha bridge preserves groups needed for safe scheduling. The two ABR DNS
origins map to `abrdns-welfare`; the LinuxDO-authenticated welfare origins map
to the shared `linuxdo-shared` credential group. Grouping is metadata only in
alpha/beta and does not trigger a login or a check-in.

## Shadow ledger and schedule gate

The beta prototype stores one JSONL ledger record per unique snapshot, records
plan additions/removals/status changes, and rejects duplicate task IDs or
conflicting execution owners. The schedule gate can explain why a task would
be denied (stale health, terminal legacy result, or alpha execution disabled),
but it always returns `executable=false` and `leaseGranted=false`.

PT status observations are a separate, read-only catalog. They may include
sites outside the V1 bookmark plan and never enter `tasks` or change
`planHash`. A fresh authoritative `not_signed` observation is marked as a
manual supplement candidate only when no source disagrees; no browser action
or automatic supplement is enabled in beta.

## Evidence and health

Receipts contain a status and a redacted evidence summary. Raw result payloads
are never copied. Production shadow sync runs the V1 read-only health command
immediately before import and passes that JSON as an ephemeral input. An old
cached `health.json` cannot be reported as current merely because it says
`healthy: true`.

## Explicit non-goals

Alpha/beta does not run a worker, open a remote browser endpoint,
discover/register new sites, mutate bookmarks, retry tasks, or send Telegram
messages. The dashboard's site policies are metadata until a future worker
cutover explicitly consumes them.
