# Production Boundary and Historical Work

The project now has one production execution owner. The Windows execution
package keeps the established browser profiles, site rules, retries and
authoritative results. The observation package leases a run, imports redacted
results, watches Harvest and serves the dashboard. Standalone adapter/canary
experiments cannot take over a site while this integration is selected.

The current observation history indicator requires three consecutive healthy,
fresh days on the same plan. A shorter display threshold does not override an
unhealthy day or the separate seven-day historical Canary gate, and it never
grants an execution lease in unified mode.

After Harvest's daily task completes, a missing, failed or unknown PT status
can queue one recheck for a unique daily-plan task or for an exact-scope PT
bookmark with the private monitoring-only fallback enabled. A catalog site
missing entirely from Harvest is included. Harvest success remains a
source-specific observation, while an origin outside the chosen bookmarks
cannot become a task. The daily attempt ledger prevents replaying an uncertain
submission or launching a worker when no new attempts remain. See
[PT status](pt-status.md) and [execution integration](v1-engine-integration.md).

Historical adapter, transport and migration designs remain in the archived
`v2` branch for audit. Their gates are not a second production schedule and
should not be presented as the current operating procedure. Removing their
offline source and fixtures requires a separate rollback review.
