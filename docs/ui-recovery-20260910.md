# Dashboard recovery — 2026-09-10

## Cause

The notice UI change duplicated a function and its closing block, removed the
DOMContentLoaded initializer, and called an API not implemented by the actual
dashboard-server.mjs service. Subsequent line-number-based edits removed valid
code and collapsed the source into one line. A line comment then swallowed most
of the program: syntax-only success was not evidence of a working dashboard.

## Recovery

- Reconstructed app.js from the pre-incident Git version, retaining existing
  navigation, calendar, identity views and execution boundaries.
- Added a small presentation-only notice state module. Acknowledgement is stored
  in this browser, keyed by business date, task ID and status, bounded to 2,000
  entries. New dates/status changes are unread. Storage failure uses an in-memory
  fallback and never blocks startup. Reading never changes task success.
- Repeated attention clicks avoid unnecessary rerenders and scroll resets.
- Moved failed, unused repair scripts and source backups out of the deployable
  source tree into a separate recoverable backup. No check-in data was removed.
- Added real desktop/mobile interaction checks to deployment and Linux CI.

## Verification

- 224 unit/integration tests passed; syntax and module-boundary checks passed.
- Headless Chrome at 1440x1000 and 390x844: calendar, all navigation, refresh,
  back/reload, read persistence, repeated visible-button clicks, no JS errors.
- NAS deployment preserved data, secrets and worker configuration.
- Authenticated production browser verified 8 views and refresh; served app.js
  matched the repaired local source. Before/after counts: 17 sites, 22 account
  tasks, 30 ledger entries. The page outage did not mean those data were lost.

Cross-device read-state synchronization is not implemented. Browser-local read
state is intentionally independent of authoritative check-in status.
