# Check-in Fabric

One check-in project, organized by responsibility rather than version:

Unified release series: **1.1**. Start with [中文快速开始](docs/quickstart.md)
and [发布与恢复](docs/release-and-recovery.md).

| Directory | Responsibility |
| --- | --- |
| `execution/` | Browser sessions, site rules, retries, authoritative receipts and notifications |
| `observation/` | Scheduling lease, Harvest/PT reconciliation, redacted ledger and NAS dashboard |

The deployed Windows runner uses its existing private configuration and Chrome
profiles. The observation package calls that runner through a bounded lease;
the NAS dashboard does not hold credentials or execute browser actions. After
Harvest's daily task completes, sites in the explicitly selected PT monitoring
bookmarks without a confirmed result may receive a bounded execution-layer
recheck after a fresh read of Harvest for each candidate. Regular monitored PT
tasks use the same Harvest completion gate before browser actions when enabled
in their private runtime binding.
Monitoring-only sites use a separate PT result file and do not join the regular
daily plan. Uncertain submissions are never blindly replayed: audited fresh
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
