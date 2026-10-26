# Results and external conditions

One shared contract defines disabled-feature evidence for JavaScript and
PowerShell. A confirmed disabled feature ends the current task without another
submission; unknown evidence does not qualify as disabled or successful.

| Observation | Handling |
| --- | --- |
| Feature explicitly disabled | Show unavailable; preserve evidence and the existing periodic recheck. |
| Site maintenance notice | Pause automatic submissions for the business day; check again next day. |
| Temporary upstream outage | Keep the existing bounded probes, shared-upstream circuit breaker and late recovery window. Show waiting for the site, not a local execution failure. |
| Rate limit | Honor the cooldown and daily cap. |
| Harvest still running | Evaluate the site's owner and reviewed recovery capability; a whole-batch wait is not required for execution-owned or guarded recovery paths. A display cache never authorizes a write. |
| Prior submission outcome unknown | Read back using the actual execution Profile. A fresh authenticated, exact daily unsigned control can authorize one new guarded attempt; an inconclusive read cannot. Maintenance or an expired entitlement does not clear this state. |
| Login, identity or local execution problem | Keep the specific attention/error result and the appropriate recovery path. |
| Reported completion missing evidence | Perform a bounded passive recheck; do not submit again or invent a receipt. |

Notifications separate external conditions from local recovery and unknown-result
verification. The panel offers matching external/verification filters and labels.
Business incompleteness remains visible; reclassification never turns an outage,
expired entitlement, or unknown submission into a successful check-in.

Notifications include the same privately authorized PT-only inventory as the
dashboard, deduplicate ordinary tasks, and retain the original report and
unknown-submit history. Current bound maintenance and the shared site-fault
codes are external context, not completion or permission to submit. A temporary
observation outage falls back to an explicitly labelled regular-task scope.

Calendar history selects observations made within their own Shanghai business
day. A post-midnight sync that still references yesterday's run remains in the
audit ledger but cannot replace yesterday's finalized PT receipts or health.
Historical evidence gaps remain unconfirmed; they never authorize today's
retries or acquire success from another day's receipt. Calendar site faults are
listed separately and excluded from its eligible-task denominator.

Consecutive identical ledger states remain deduplicated. A return to an earlier
healthy state after a failure is a new append-only recovery event; an older
replayed observation cannot move the latest history forward.

Native page evidence uses the same success predicate as the result producer and
retains the matched signal before diagnostic text truncation. A reviewed,
authenticated daily header may confirm the current day; arbitrary page text,
cumulative counters, different origins, stale dates, and challenge/login pages do
not. Passive reads that cross the business-day boundary are rejected.

Native readbacks retain the actual account and Profile binding in a separate
durable receipt. A current negative receipt does not rewrite an older day's
unknown submission as failed or successful. The preflight registers the receipt
and rechecks the gate before continuing; a completion counts only when the
owned write intent is successfully confirmed in the journal.

CAPTCHA handlers run after navigating to the question as well as on the initial
page. Explicit refusal is checked before a page change can erase it; an unknown
submitted result never reloads an attendance endpoint as a verification step.
A passive final read keeps the full operation classified as an actual check-in
when it followed a submission. Public reference images use a separate request
context, the existing valid local proxy, and bounded request deadlines.

Single-account passive receipts keep their configured Profile and reconciliation
scope after the numeric site identity is removed from public reports. Importing
that receipt preserves the daily plan identity, so a new completion replaces the
old failure. Browser-generated connection or certificate error pages are not
tracker content and cannot provide either signed or unsigned evidence.

An explicitly reviewed native API fallback may reuse its existing isolated
Profile and configured local proxy. Its index read uses strict TLS, a fresh
server date and inert HTML parsing. A formal recovery still registers that
account's unsigned receipt, rechecks the gate and persists an intent before
one already-registered attendance GET. It performs no POST discovery, follows
no redirects and stops when the response or durable confirmation is unclear.
