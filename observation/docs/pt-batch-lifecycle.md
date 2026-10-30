# PT batch budgets and cancellation

The scheduled Harvest fallback has a 180-second work budget. Before starting
a site, and again before creating its write attempt, it requires at least
60 seconds of remaining budget. This is a minimum dispatch allowance, not a
guarantee that a site will finish. A budget deferral is stored separately in
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
