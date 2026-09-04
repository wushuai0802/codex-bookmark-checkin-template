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

The report is optional. Without it, PT targets identified from the V1 plan are
still shown using the latest V1 result, while PT sites outside that plan do not
appear until an observer supplies them.

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
