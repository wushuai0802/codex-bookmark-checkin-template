# PT batch budgets and cancellation

The scheduled Harvest fallback retains its 180-second outer timeout and
35-second cooperative cleanup grace. Its inner admission budget is
`180 - 35 - 70 = 75` seconds. The 70-second minimum site allowance rounds up
the observed p95 of 66.884 seconds (177 normally completed, timed attempts
from 2026-09-20 through 2026-10-30; median 14.692 seconds).

The inner deadline stops admission of new sites; it does not cancel an
already-started site. The CLI reserves a further 70 seconds for that site,
leaving 35 seconds before the outer timeout. Both admission time and the
remaining site allowance are checked before browsing and before creating a
write attempt, including time spent refreshing Harvest. Direct library calls
without a separate site deadline retain their existing deadline semantics.
The allowance is based on p95, not a guarantee for every outlier; the existing
cooperative cleanup still protects a longer-running site.
A budget deferral is stored separately in
the daily audit's `deferrals` list as `deferred_budget`, with
`submissionAttempted=false`; it consumes no submission attempt.

The transport keeps a private stdin channel open only for a fallback launched
with `--cooperative-stop`. At the outer deadline it sends
`{"type":"pt_batch_cancel"}` and allows 35 seconds for cleanup before applying
the existing force-stop fallback. Other transport commands retain their
existing timeout behavior.

The observer persists an active write as `outcome_unknown` before waiting for
cleanup. Cancellation reaches the PT child through an AbortSignal and invokes
the existing lifecycle `cleanup()` with the original owner and Profile scope.
The existing ownership checks, shared-browser protection, execution leases,
account binding, and submission quarantine are unchanged. Successful cleanup
removes the lifecycle marker only after pipe closure; incomplete cleanup
leaves `cleanup_pending` for the next normal reconciliation. A missing receipt
is never converted into proof of non-submission.
