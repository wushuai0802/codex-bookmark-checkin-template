# Check-in project structure

Production path: Windows schedule -> observation-layer lease -> execution-layer
runner -> authoritative result -> redacted bridge/ledger -> dashboard/NAS.
Only the execution layer performs browser interactions and check-ins. The
observation layer calls that runner as a child and never owns browser state.

| Active area | Responsibility |
| --- | --- |
| `src/legacy-engine.mjs`, `scripts/run-v1-engine.mjs` | Execution-layer dispatch, lease, fresh report check |
| `src/bridge.mjs`, `src/evidence-contract.mjs`, `src/shadow-*.mjs` | Redacted V1 plan/result import and history |
| `src/dashboard-server.mjs`, `public/`, `scripts/sync-v2-status.ps1` | Observation dashboard and NAS status projection |
| V1 runtime `src/`, `scripts/Run-Checkin.ps1` | Sole browser/check-in implementation |

After Harvest's daily task reports completion, `src/harvest-fallback.mjs`
compares its observations with the exact PT monitoring bookmarks and same-day
execution results. Completed sites remain status-only. Daily-plan PT tasks use
the existing gateway; the other monitored sites use `execution/src/pt-supplement.mjs`
only after private opt-in, with one URL, no automatic retry and both execution
locks. Their redacted results remain separate from the daily plan and appear on
the next dashboard sync. An uncertain prior submission is never replayed.

The dashboard can change a site's reminder policy and note. It cannot submit a
browser check-in, change a login or register a Harvest-only site. Those actions
require the execution layer's account binding and identity checks.

Historical standalone adapter, migration and dry-worker modules remain in the
source tree only for audit and rollback tests, not in the scheduled production
path. Their history is documented in `docs/migration-phases.md`; remove or move
them only after the single-repository integration and rollback review.
