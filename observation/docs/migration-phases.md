# Production Boundary and Historical Work

The project now has one production execution owner. The Windows execution
package keeps the established browser profiles, site rules, retries and
authoritative results. The observation package leases a run, imports redacted
results, watches Harvest and serves the dashboard. Standalone adapter/canary
experiments cannot take over a site while this integration is selected.

After Harvest's daily task completes, a missing, failed or unknown PT status
can queue one recheck only for a uniquely registered execution-layer task.
Harvest success is displayed as a source-specific observation. Unregistered
sites require deliberate enrollment; a prior uncertain submission is not
replayed. See [PT status](pt-status.md) and
[execution integration](v1-engine-integration.md).

Historical adapter, transport and migration designs remain in the archived
`v2` branch for audit. Their gates are not a second production schedule and
should not be presented as the current operating procedure. Removing their
offline source and fixtures requires a separate rollback review.
