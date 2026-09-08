# Beta.3 stabilization and cutover boundary

Historical checkpoint. Update 2026-09-08: the Harvest read-only connector is now
installed and tested through the ops sync wrapper; that remaining item below is
no longer open. Live worker transport/execution remains pending. See
[execution-redesign.md](execution-redesign.md) for the next implementation gates.

V1 remains the only check-in executor. This iteration does not enable a lease
service, automatic supplements, registrations or a second Telegram sender.

## Safeguards

Decisions check actual source timestamps, snapshot age, Shanghai business date
and health. Unknown owners and manual-attention tasks are denied. Leases are
invalid before issuance. Dry-run receipts cannot claim successful check-ins.

History acceptance selects each day's latest observation from the most recent
window, requires seven consecutive days of a stable plan, and a current final
observation. Earlier stale/invalid records remain intact for audit, not silently
repaired or backdated. Invalid new drift is refused. A change in health state
changes the snapshot identity so recovery is not lost to deduplication.

42 retains independent account tasks without an origin-only shared-credential
label. Unknown or explicitly non-authoritative evidence cannot become proof.

## Dry-run worker

The one-shot process in `src/dry-run-worker.mjs` has an atomic journal and an
exclusive lock. It accepts redacted snapshots and capability manifests only;
it never reads V1 credentials/profiles or calls a browser/network/notification
adapter. Execute mode is rejected.

Completed jobs deduplicate across process restarts. Prepared or interrupted
jobs stop for review. Tests inject offline, timeout, interruption, conflicting
worker binding and concurrent claims. An orphan lock from an OS hard kill is
fail-closed and needs operator review, never a second execution.

State files must remain outside V1 and cannot traverse symlink ancestors.
Stopping/removing the dry-run deployment leaves V1 unaffected.

## Remaining acceptance

Seven qualifying recent days have not accumulated. Keep actual execution
disabled. The next separate phase needs authenticated worker transport and
explicit per-account ownership cutover, not a browser shell command runner.
External Harvest input also needs a real read-only connector; a schema alone
does not provide live Harvest synchronization.
