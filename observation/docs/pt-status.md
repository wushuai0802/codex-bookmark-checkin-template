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
`failed`. A fresh explicit failure or an unknown status after Harvest's daily
task completes can enter a one-time execution-layer recheck. An unknown status
never authorizes a blind POST: the original site flow must first inspect the
site. Success still requires authoritative evidence.

## Unified V1-Engine Harvest Fallback

In production, the existing shadow sync reads
Harvest without its credentials and runs `scripts/harvest-fallback.mjs` against
the fresh local report and the exact PT bookmark catalog. A current-day
`failed` or `not_signed` record, a missing Harvest record, or an `unknown` record
after Harvest's daily task has completed can trigger one targeted execution-layer
recheck. Daily-plan PT sites use the normal gateway. Monitoring-only sites use
one exact same-origin bookmark URL, only after `ptFallbackOnlyEnabled: true` is
set in ignored `config/runtime.local.json`; it defaults to false.
The selected bookmark catalog is also checked for sites absent from Harvest's
result set; those sites cannot silently remain observation-only.
An explicit same-day page result or an increase in the site's own "签到已得"
counter within the same browser session can establish a verified supplement;
the counter's unchanged cumulative value alone cannot.
It also waits for V1's complete final report for the same Shanghai business
day; an older completed V1 result cannot suppress today's Harvest failure.
V1 then checks its own site account and authoritative result before any
submission. `unknown` never proves a failure or authorizes blind submission;
stale data, sites outside the selected PT bookmark folder and ambiguous
daily-plan accounts never create tasks. The monitoring-only path does not alter
the daily plan or overwrite its daily result. It records a prepared attempt
before invoking the original execution-layer site flow, with a single URL and
no automatic retry; uncertain outcomes are not replayed.
The read-only preview reports both eligible sites and `newAttempts` after the
daily attempt ledger is applied. The scheduler launches no fallback worker when
`newAttempts` is zero, even if older unresolved candidates remain visible.

Harvest's `userId` identifies the Harvest database owner, **not** the PT site
account. It is not used to match or reject a one-account-per-site fallback.
A Harvest positive record stays status-only. A monitored site may still need
its execution-layer Chrome session restored before a fallback can finish; a
login-required or unverified result is not labelled as a completed check-in.

The fallback runner uses the observation gateway lease, the execution layer's
existing profile and its site processing code. Monitoring-only results go to
`outputs/pt-fallback-results-YYYY-MM-DD.json`, which the next shadow sync
imports into PT status. No Harvest cookies, tokens,
passwords or browser profiles are copied. The sync worker previews candidates
before spawning the helper and binds the helper to SHA-256 hashes of the
observed report and catalog; changed inputs fail closed. The present dashboard
`manual_review_only` metadata remains an observation hint, not an execution
permission.

The report is optional. `--monitor-catalog` supplies the exact-scope bookmark
inventory. It retains a same-origin entry URL locally for fallback but exposes
only origin and display status on the NAS. Every inventory site is visible even without evidence;
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
