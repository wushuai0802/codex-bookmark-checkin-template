# PT status observation

The observation layer can display PT check-in status without taking ownership of
the execution-layer browser session.
The bridge accepts an optional redacted observation report from Harvest, the
legacy runner, or a future read-only observer. The report is copied into the
shadow snapshot and then into the NAS dashboard; it never contains cookies,
credentials, browser profiles, or raw screenshots.

## Input contract

Pass a JSON report with `--pt-status-file`:

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-09-04T04:00:00.000Z",
  "businessDate": "2026-09-04",
  "source": "harvest",
  "sites": [
    {
      "origin": "https://pt.example",
      "displayName": "示例 PT",
      "status": "signed",
      "observedAt": "2026-09-04T03:58:00.000Z",
      "accountRef": "acct_0123456789abcdef",
      "evidence": {
        "source": "api",
        "authoritative": true,
        "summary": "今日签到成功"
      }
    }
  ]
}
```

`status` may be `signed`, `already_signed`, `not_signed`, `unknown`,
`login_required`, `unreachable`, `needs_attention`, `not_available`, or
`failed`. A `not_signed` result is a recheck candidate only when its evidence is
authoritative, fresh (within 26 hours), and no other source disagrees. After
Harvest's daily task completes, the execution layer can recheck one already
registered PT task; the normal identity, submit-once and verification rules
still apply.

## Unified V1-Engine Harvest Fallback

In production, the existing shadow sync reads
Harvest without its credentials and runs `scripts/harvest-fallback.mjs` against
the fresh local report and the exact PT bookmark catalog. A current-day
`failed` or `not_signed` record, a missing Harvest record, or an `unknown` record
after Harvest's daily task has completed can trigger one targeted execution-layer
recheck for a unique, already registered PT task.
It also waits for V1's complete final report for the same Shanghai business
day; an older completed V1 result cannot suppress today's Harvest failure.
V1 then checks its own site account and authoritative result before any
submission. `unknown` never proves a failure or authorizes blind submission;
stale data, Harvest-only sites and ambiguous V1 account origins never create
tasks. A prepared attempt is recorded before invoking V1;
uncertain outcomes are not replayed automatically.

Harvest's `userId` identifies the Harvest database owner, **not** the PT site
account. Therefore a Harvest positive record is only a read-only Harvest
observation; it cannot certify the separately configured V1 account or skip
V1's own identity/status check. Conversely, V1 completion after a fallback
does not prove Harvest's account completed unless Harvest later reports its
own positive receipt. Harvest-only failed sites require deliberate V1
registration and login before automatic fallback is possible.

The fallback runner uses V2's existing lease, V1's original site/profile
configuration and the normal V1 retry/report path. No Harvest cookies, tokens,
passwords or browser profiles are copied. The sync worker previews candidates
before spawning the helper and binds the helper to SHA-256 hashes of the
observed report and catalog; changed inputs fail closed. The present dashboard
`manual_review_only` metadata remains an observation hint, not an execution
permission.

The report is optional. `--monitor-catalog` supplies a separate, origin-only
bookmark inventory. Every inventory site is visible even without evidence;
missing evidence is `unknown` with a null observation time, not a failed sign-in.
The inventory never enters `tasks`, retry queues, leases or `planHash`.

The installed shadow-sync wrapper selects the configured bookmark folder by
exact parent/folder IDs and reads Harvest SQLite with `mode=ro` and `query_only`.
Only mirror origin, nickname, username, user ID and today's `sign_info` are read.
No cookies, passkeys, session storage or credentials are selected or uploaded.
Deleted bookmark-only sites disappear on the next sync. An unavailable Harvest
source leaves the inventory visible with unknown status; no browser is launched.
Only an explicit positive daily receipt establishes success. Yesterday's evidence
is stale at Shanghai midnight even when younger than 26 hours.

Display identity is now an optional allowlisted field separate from execution
identity. Account IDs come from actual result metadata, never from old key names.
The authenticated dashboard groups default accounts by origin so unrelated sites
cannot collapse into a single hashed account. Metadata does not change plan hashes.

## Bridge and shadow run

```powershell
$ExecutionRoot = 'PATH_TO_PRIVATE_EXECUTION_ROOT'
node src/bridge.mjs --legacy-root $ExecutionRoot `
  --health-file tmp\current-health.json `
  --pt-status-file tmp\harvest-pt-status.json `
  --out outputs\shadow-snapshot.json

npm run shadow -- --legacy-root $ExecutionRoot `
  --health-file tmp\current-health.json `
  --pt-status-file tmp\harvest-pt-status.json `
  --out outputs\shadow-beta-snapshot.json `
  --ledger outputs\shadow-ledger.jsonl
```

The PT section is independent of `planHash`, so adding an external site does
not create a V1 task or alter the legacy execution plan. Snapshot IDs include
the observation state so the dashboard refreshes when a status changes.
