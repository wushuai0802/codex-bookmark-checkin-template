# Check-in Fabric

Production is one check-in system with two clear layers: the execution layer
keeps the established site rules, browser profiles, retries and authoritative
receipts; the observation layer owns the run lease, Harvest reconciliation,
redacted reports, schedule supervision and dashboard. The old V1/V2 naming is
kept only in file names and audit history for compatibility; it is not a second
production execution path. No second set of site credentials or profiles is
needed.

Harvest supplies read-only PT status. After its daily task completes, every
registered PT site is reconciled once against the execution-layer result. A
missing, explicit failed, or still-unconfirmed status may queue one bounded
execution-layer recheck; confirmed success is status-only, and an uncertain
previous submission is never replayed. Harvest-only sites remain visible until
deliberately registered. See [PT status and fallback](docs/pt-status.md)
and [repository ownership](docs/repository-ownership.md).

The existing Windows task calls the observation gateway through `scripts/run-v1-engine.mjs` and
retains its schedule. For a quiet manual acceptance pass from this project:

```powershell
node scripts/run-v1-engine.mjs --dry-run
node scripts/run-v1-engine.mjs --execute
```

The gateway reports `no_new_final_report` without rewriting today's result
when a scheduled probe has nothing to run. See
[docs/v1-engine-integration.md](docs/v1-engine-integration.md) for ownership,
rollback and report semantics. A successful process exit is not evidence that
every site signed in; check the report's completed/unavailable/unresolved counts.

## Observation and audit data

- Imports the legacy bookmark plan, latest run result, site state, scheduler
  state, and health report.
- Builds a date-independent `planUnitId` for plan comparison and a dated
  `taskId` for each daily execution instance.
- Emits a redacted JSON snapshot suitable for NAS/control-plane integration.
- Optionally merges read-only PT status observations from Harvest or another
  observer, including sites that are outside the current V1 execution plan.
- Calculates health freshness and rejects credential-bearing fields.
- Projects the snapshot into an append-only shadow ledger and reports plan
  drift without granting a lease.

Observation data never contains credentials or browser state. Historical Canary
records remain available for audit but are not displayed as today's execution
result and cannot take ownership of a site.

## Local usage

Use **Node.js 24.x**, matching `.node-version`, the Docker image and CI. The
transport journal uses built-in `node:sqlite`; Node.js 20 is not supported.
CI runs from clean checkouts on both Linux and Windows. The only tracked fixture
under a `logs` directory is a reviewed synthetic `.example` receipt; actual
runtime logs, credentials and browser profiles remain excluded.

```powershell
$ExecutionRoot = 'PATH_TO_PRIVATE_EXECUTION_ROOT'
npm test
node src/bridge.mjs --legacy-root $ExecutionRoot `
  --health-file tmp\current-health.json `
  --pt-status-file tmp\harvest-pt-status.json `
  --out outputs\shadow-snapshot.json

npm run shadow -- --legacy-root $ExecutionRoot `
  --out outputs\shadow-beta-snapshot.json `
  --ledger outputs\shadow-ledger.jsonl `
  --pt-status-file tmp\harvest-pt-status.json `
  --previous outputs\previous-shadow-snapshot.json

npm run check:shadow-history -- --ledger outputs\shadow-ledger.jsonl --min-days 7

npm run smoke:live -- --legacy-root $ExecutionRoot `
  --health-file tmp\current-health.json
```

Unit tests use only fixed redacted fixtures. `smoke:live` is the separate,
read-only integration check for a deployed V1 runtime. The output directory is ignored by Git. The bridge also accepts
`CHECKIN_LEGACY_ROOT`; an explicit `--legacy-root` is preferred. A missing or
malformed legacy result is a hard error rather than an empty successful plan.
The shadow command is idempotent for the same source snapshot and refuses to
write anywhere under the legacy root. The history check is read-only and exits
with status 2 until the ledger contains the required consecutive fresh daily
runs with no invalid records or owner conflicts.

PT 状态观察输入格式和安全边界见 `docs/pt-status.md`。它更新快照中的
`ptStatus` 展示数据；完成 Harvest 对账后，已登记 PT 站点可以进入一次执行层
复核。观察层不会复制凭据、创建站点任务或盲目提交；面板上的站点标记只影响提醒，
不改变执行层的签到计划。

## Contract and rollout

Contracts live in `schemas/`. The active structure is in
`docs/project-structure.md`; historical migration experiments are in
`docs/migration-phases.md`. New PT site registration requires a reviewed
bookmark target and account/login binding, not a Harvest database ID.

The module boundaries and dependency rules are documented in
`docs/project-structure.md`. New site support must enter through an adapter;
site logic must not import the scheduler, dashboard, V1 executor or
notification sender.

The dashboard capability map and NAS reverse-proxy instructions are in
`docs/dashboard.md` and `docs/nas-deployment.md`.

## Historical code

Standalone adapter, migration and dry-worker modules are retained only for
auditable rollback and offline tests. They are not part of the active schedule.
See `docs/migration-phases.md` for historical context. Do not remove the mature
PT site rules or the user's registered browser profiles when cleaning this tree.
