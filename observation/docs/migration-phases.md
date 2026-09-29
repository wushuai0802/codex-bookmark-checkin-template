# Production Boundary and Historical Work

The project has one production execution owner. The Windows execution package
keeps the established browser profiles, site rules, retries and authoritative
results. The observation package leases a run, imports redacted results,
watches Harvest and serves the dashboard. Standalone adapter and Canary
experiments cannot take over a site while this integration is selected.

The old V1/V2 labels remain only in compatibility file names and historical
audit records. They are not separate production versions. The complete project
is published from the default `main` branch as `execution/` and `observation/`.
The final standalone controller history is preserved by the
`archive-v2-final-20260922` tag instead of a permanent `v2` branch.

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

Historical adapter, transport and migration modules remain offline for audit
and rollback tests. Their gates are not a second production schedule and must
not be presented as the current operating procedure. Removing those modules or
fixtures requires a separate rollback review.

## Reliability batch: 2026-09-29

- A fresh, authoritative PT completion receipt takes precedence over a later
  unverified failure. Conflicting authoritative evidence still needs review.
- Native Chrome readers now produce bounded same-day page evidence, and every
  confirmed preflight branch preserves it. This fixes future receipt loss; it
  does not invent evidence for historical terminal records.
- OpenCD readback recognizes both simplified and traditional daily-header
  text without submitting again. The exact monitor catalog and complete
  execution plan determine PT ownership, not a legacy folder label.
- `shadow-run --pt-status-cache-file` accepts only a validated same-day
  Harvest report for display continuity. It retains original evidence times.
  A cached report never authorizes fallback dispatch; a successful live
  Harvest read and the existing submission safeguards remain required.

These changes do not complete the larger scheduler migration. Shared Harvest
write gating for regular PT runs, generalized cross-midnight intent recovery,
atomic multi-file generations, and safe plan-metadata migration remain
separate acceptance items. Do not remove historical compatibility modules
before their live and dynamic callers have been accounted for.

## Fallback write boundary: 2026-09-29

The live fallback CLI now requires a fresh Harvest query before **each** PT
candidate. A new or active task, newly confirmed success, stale or unreachable
query stops the candidate before creating a submission intent. The Windows
sync launcher supplies its existing SSH alias and configured read-only
Harvest database path. The display-only cache cannot satisfy this gate.

An attempt carries the business date, start/end time and sanitized outcome.
A response crossing the Shanghai day boundary is saved in the attempt
journal, excluded from the previous day's completed report, and blocks another
write until read-only reconciliation. A new day's fallback also checks for
unresolved earlier attempts. The named-account login continuation needs a
fresh same-day recovery signal after the last failed attempt, a one-minute
cooldown, a 30-minute signal lifetime and at most two resumptions.

The recovery signal is only a wake-up hint: the execution layer must still
confirm login and today's status. This change does not prove a cross-system
transaction with Harvest. Existing old uncertain records require
case-by-case read-only confirmation. Neither the PT bookmark catalog nor
private account/profile bindings were modified.

## Regular PT plan write gate

The private opt-in in the execution binding enables a live Harvest check for
the exact monitored PT origin before the first navigation and again before
potential browser actions. It holds no execution lock while waiting for
Harvest; a missing or active daily result produces a bounded deferred
outcome. A matching authoritative same-day Harvest success is represented as
observed already signed, with its user ID deliberately ignored for PT account
binding. Failed, missing and unknown Harvest site entries proceed to the
existing execution adapter only after Harvest's completed daily task is
verified. Ambiguous multi-account origins and missing catalog/probe state stop
before submission. Non-PT targets keep their existing schedule.

The current production PT targets have no native WAF preflight overlap. If a
new PT target later gains a native preflight path, extend this gate to that
path before enrolling the target. There is no cross-process transaction with
Harvest; a new Harvest task can still start after the last read. The next
natural scheduler run must verify intended PT deferrals and identity-bound
receipts without replaying completed actions.
