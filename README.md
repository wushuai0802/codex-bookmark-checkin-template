# codex-checkin-fabric-v2

V2 is an independent control-plane project for the daily check-in automation.
The current release (`2.0.0-beta.3`) is deliberately a **read-only shadow
observer and ledger prototype**. The existing Windows runner remains the only
system allowed to execute check-ins.

## What the current shadow release does

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

It never launches Chrome, invokes a browser API, writes the legacy project, or
sends notifications.

## Local usage

Use **Node.js 24.x**, matching `.node-version`, the Docker image and CI. The
transport journal uses built-in `node:sqlite`; Node.js 20 is not supported.
CI runs from clean checkouts on both Linux and Windows. The only tracked fixture
under a `logs` directory is a reviewed synthetic `.example` receipt; actual
runtime logs, credentials and browser profiles remain excluded.

```powershell
npm test
node src/bridge.mjs --legacy-root D:\AIWorkspace\bots\chrome-daily-checkin `
  --health-file tmp\current-health.json `
  --pt-status-file tmp\harvest-pt-status.json `
  --out outputs\shadow-snapshot.json

npm run shadow -- --legacy-root D:\AIWorkspace\bots\chrome-daily-checkin `
  --out outputs\shadow-beta-snapshot.json `
  --ledger outputs\shadow-ledger.jsonl `
  --pt-status-file tmp\harvest-pt-status.json `
  --previous outputs\previous-shadow-snapshot.json

npm run check:shadow-history -- --ledger outputs\shadow-ledger.jsonl --min-days 7

npm run smoke:live -- --legacy-root D:\AIWorkspace\bots\chrome-daily-checkin `
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

PT 状态观察输入格式和安全边界见 `docs/pt-status.md`。它只更新快照中的
`ptStatus` 展示数据，不增加 v1 任务、不改变 `planHash`，也不会启动浏览器或
自动补签。只有新鲜、权威且没有来源冲突的“已确认未签到”才会显示为人工复核
候选；v2 beta 不授予补签执行权。

## Contract and rollout

Contracts live in `schemas/`. Architecture and the staged migration are in
`docs/architecture.md` and `docs/migration-phases.md`. Registration discovery
is intentionally not an alpha capability; it is planned for V2.1 after a
read-only review gate.

The module boundaries and dependency rules are documented in
`docs/project-structure.md`. New site support must enter through an adapter;
site logic must not import the scheduler, dashboard, V1 executor or
notification sender.

The dashboard capability map and NAS reverse-proxy instructions are in
`docs/dashboard.md` and `docs/nas-deployment.md`.

## Beta.3 stabilization

- Recomputes source-health and snapshot age plus Shanghai business date at dispatch time.
- Rejects unhealthy, future-dated, outdated and manually blocked tasks.
- Evaluates the latest recent daily window, retaining earlier failures for audit.
- Rejects invalid new ledger drift; never backdates or rewrites old failures.
- 42 account metadata no longer assumes one shared LinuxDO credential group.
- `npm run worker:dry-run -- --snapshot <file> --worker <file> --state <file> --legacy-root <directory>` runs a Windows-capable one-shot journal harness.
  It refuses execute, has no browser/network adapter and deduplicates across restarts.

This is not a production executor. See `docs/stabilization-2026-09-06.md`.
