# Check-in Fabric

文档索引：[架构](docs/architecture.md) · [术语](docs/glossary.md) · [发布与恢复](docs/release-and-recovery.md) · [排障与可靠性](docs/reliability-hardening.md)。

One check-in project, organized by responsibility rather than version:

Unified release series: **1.1**. Start with [中文快速开始](docs/quickstart.md)
and [发布与恢复](docs/release-and-recovery.md). See
[执行可靠性与人工接管](docs/reliability-hardening.md) for click, storage,
OAuth diagnostics and site-address change handling.

| Directory | Responsibility |
| --- | --- |
| `execution/` | Browser sessions, site rules, retries, authoritative receipts and notifications |
| `observation/` | Scheduling lease, Harvest/PT reconciliation, redacted ledger and NAS dashboard |

The deployed Windows runner uses its existing private configuration and Chrome
profiles. The observation package calls that runner through a bounded lease;
the NAS dashboard does not hold credentials or execute browser actions. Harvest
reconciliation uses each site's owner and current result. Confirmed sites remain
status-only. Execution-owned tasks and reviewed guarded recovery paths can proceed
without waiting for the whole Harvest batch; each candidate still uses a fresh
Harvest observation and the existing account/day submission guards. Sites without
a reviewed passive capability retain their established first-dispatch conditions.
Monitoring-only sites use a separate PT result file and do not join the regular
execution plan. Authorized PT supplements are included once in the dashboard's
global counts and task filters; pure monitoring, configured pauses and site-side
faults keep their separate classifications. Uncertain submissions are never blindly replayed: audited fresh
daily-state evidence may permit bounded recovery after another executor check. This
site-only fallback is disabled by default until the private runtime and its
browser profile have been accepted.

The final standalone controller history is preserved by the
`archive-v2-final-20260922` tag. Historical adapter experiments remain offline
for audit; they are not a second production engine. Do not copy private runtime
data into this repository or force-merge unrelated Git histories.

## Active and historical paths

The scheduled Windows entry invokes `observation/scripts/run-v1-engine.mjs`,
which holds the observation lease and launches the configured private
execution runner. `observation/src/harvest-fallback.mjs` reads the completed
Harvest report and exact PT bookmark catalog before a bounded recheck.
`observation/src/bridge.mjs` publishes redacted status to the dashboard.
Their names include `v1` for compatibility with the installed scheduler; there
is one execution owner. Historical Canary, migration, adapter experiment and
transport modules remain available for audit and rollback tests and have no
second production schedule. The ownership map and rollback boundary are in
`observation/docs/project-structure.md` and
`observation/docs/migration-phases.md`.

## Local Checks

Use Node.js 24 for the observation package. Install and test each package from
its own directory:

```powershell
npm ci --prefix execution
npm ci --prefix observation
npm test
pwsh -NoProfile -File execution/scripts/Scan-PublicSafety.ps1 -Root .
```

The existing production paths and rollback controls are documented in
`observation/docs/project-structure.md` and `observation/docs/nas-deployment.md`.
The dashboard queues supported read-only verification, bounded PT retry,
bound login-window and login-continuation requests. Windows revalidates the
account, day, scope and locks before using the existing runner. The NAS never
owns browser profiles or submits site actions itself.

Calendar views include recorded PT history and deduplicate regular PT tasks.
Older days without PT detail are marked incomplete. Shared definitions live in
`shared/checkin-contract.json`; `npm run contracts` generates the package-local
copies required by separate runtime installations. CI rejects definition drift.
Superseded workflows are archived; only the root CI workflow is active.
