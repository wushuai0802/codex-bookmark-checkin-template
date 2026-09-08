# PT status observation

V2 can display PT check-in status without taking ownership of PT execution.
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
`failed`. A `not_signed` result is a supplement candidate only when its
evidence is authoritative, fresh (within 26 hours), and no other source
disagrees. The dashboard labels it `manual_review_only`; candidate execution
and automatic supplement remain disabled in beta.

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
node src/bridge.mjs --legacy-root D:\AIWorkspace\bots\chrome-daily-checkin `
  --health-file tmp\current-health.json `
  --pt-status-file tmp\harvest-pt-status.json `
  --out outputs\shadow-snapshot.json

npm run shadow -- --legacy-root D:\AIWorkspace\bots\chrome-daily-checkin `
  --health-file tmp\current-health.json `
  --pt-status-file tmp\harvest-pt-status.json `
  --out outputs\shadow-beta-snapshot.json `
  --ledger outputs\shadow-ledger.jsonl
```

The PT section is independent of `planHash`, so adding an external site does
not create a V1 task or alter the legacy execution plan. Snapshot IDs include
the observation state so the dashboard refreshes when a status changes.
