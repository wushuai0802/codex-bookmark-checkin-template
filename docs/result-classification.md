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
| Harvest still running | Wait for its result before considering a supplement. |
| Prior submission outcome unknown | Keep the quarantine; only read back status. Maintenance or an expired entitlement does not clear this state. |
| Login, identity or local execution problem | Keep the specific attention/error result and the appropriate recovery path. |
| Reported completion missing evidence | Perform a bounded passive recheck; do not submit again or invent a receipt. |

Notifications separate external conditions from local recovery and unknown-result
verification. The panel offers matching external/verification filters and labels.
Business incompleteness remains visible; reclassification never turns an outage,
expired entitlement, or unknown submission into a successful check-in.

Native page evidence uses the same success predicate as the result producer and
retains the matched signal before diagnostic text truncation. A reviewed,
authenticated daily header may confirm the current day; arbitrary page text,
cumulative counters, different origins, stale dates, and challenge/login pages do
not. Passive reads that cross the business-day boundary are rejected.
