# Check-in Fabric

One check-in project, organized by responsibility rather than version:

| Directory | Responsibility |
| --- | --- |
| `execution/` | Browser sessions, site rules, retries, authoritative receipts and notifications |
| `observation/` | Scheduling lease, Harvest/PT reconciliation, redacted ledger and NAS dashboard |

The deployed Windows runner uses its existing private configuration and Chrome
profiles. The observation package calls that runner through a bounded lease;
the NAS dashboard does not hold credentials or execute browser actions. After
Harvest's daily task completes, sites in the explicitly selected PT monitoring
bookmarks without a confirmed result may receive one execution-layer recheck.
Monitoring-only sites use a separate PT result file and do not join the regular
daily plan. A prior uncertain submission is never replayed automatically. This
site-only fallback is disabled by default until the private runtime and its
browser profile have been accepted.

The historical `v2` branch and standalone adapter experiments remain available
for audit. They are not a second production engine. Do not copy private runtime
data into this repository or force-merge unrelated Git histories.

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
The dashboard's manual controls manage reminders and review notes; actual
single-site check-ins still run through the Windows execution layer.
