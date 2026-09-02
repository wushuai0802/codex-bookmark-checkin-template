# V2 architecture (alpha boundary)

```text
legacy Windows runner (sole executor)
        | read-only files
        v
V2 bridge -> redacted plan/tasks/receipts/health snapshot
        | later: authenticated, leased envelopes
        v
NAS control plane (ledger, schedule gate, health, notifications)
```

## Ownership and identity

The canonical task identity is:

```text
businessDate + logicalSiteKey + accountKey + actionType + scheduleOccurrence
```

The bridge hashes this tuple into a `task_...` identifier. A site with five
AgentRouter accounts therefore produces five distinct execution units while
remaining one logical site. `accountKey` is a stable internal identity; no
password, cookie, token, profile path, or account label is shared.

## Logical grouping

The alpha bridge preserves groups needed for safe scheduling. The two ABR DNS
origins map to `abrdns-welfare`; the LinuxDO-authenticated welfare origins map
to the shared `linuxdo-shared` credential group. Grouping is metadata only in
alpha and does not trigger a login or a check-in.

## Evidence and health

Receipts contain a status and a redacted evidence summary. Raw result payloads
are never copied. Health includes the source timestamp and a freshness verdict;
an old `health.json` cannot be reported as current merely because it says
`healthy: true`.

## Explicit non-goals

Alpha does not run a worker, open a remote browser endpoint, discover/register
new sites, mutate bookmarks, retry tasks, or send Telegram messages.
