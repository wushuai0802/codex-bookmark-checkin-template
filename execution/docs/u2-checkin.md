# U2 automatic check-in

The established runner opens the question page, loads its image, resolves public
cover references, chooses only a reliable answer and submits once. Completion
still requires the bound account's daily header; a public shoutbox message is
not account evidence. Already-completed days use passive verification only.

Public references use isolated request contexts without the site's cookies,
tokens or Profile. A private `u2ReferenceProxyServer` may pin an existing,
credential-free loopback HTTP proxy. This applies only to approved AniList,
MyAnimeList and image CDN requests; it does not change system networking or site
login routing. Set it in ignored local configuration when unattended processes
cannot rely on inherited proxy variables. Validate the route without proxy
environment variables before relying on it in the scheduler.

U2 failures retain fixed diagnostic codes through the PT result projection:

- `u2_reference_unavailable` or `u2_reference_timeout`: public covers unavailable.
- `u2_visual_ambiguous`: no sufficiently reliable visual match.
- `u2_image_unavailable`: missing or unloaded challenge image.
- `u2_challenge_changed`: the expected form or answer is absent.
- `u2_question_expired`: the remaining validity window is insufficient.
- `u2_solver_failed`: an unexpected solver failure before submission.

These outcomes explicitly record `submissionAttempted:false`. They do not
authorize replay of an earlier uncertain write. Errors after answer submission
retain `submission_outcome_unknown` until an authoritative account/day readback.
The public reference transport closes after every solver run, including errors.

## Bounded question retries (before submission only)

`u2QuestionRetryCount` defaults to **2 additional questions** (at most 3 questions
in one visit). Finite numeric values are floored and clamped to 0–4; other values
use the public default. Setting it to 0 keeps the original single-question
`interactive_challenge` result. No recognition threshold changes: the match-gap
limit remains 0.01, distance ratio 1.22, and circle ratio 1.3.

Only `u2_visual_ambiguous`, `u2_reference_unavailable`, `u2_reference_timeout`,
`u2_image_unavailable`, and `u2_question_expired` allow another question. A changed
form (`u2_challenge_changed`) or unexpected solver failure stops immediately.
Retries are sequential with a fixed 1500 ms pause. Each new question is obtained
with GET `/showup.php`, without invoking `beforePtSubmit`; neither a POST response
nor answer parameters are reloaded. A completed U2 step stops the candidate loop,
so alternate bookmarks cannot create another question budget in that visit.

Screenshot bytes and the sorted option-text set are hashed in memory. An exact
repeat of both stops further retries before solving again. Option order, field
names and image URLs do not determine identity. If no screenshot can be obtained,
identity cannot be compared; the retry count and overall deadline still apply.
Question count includes an identical question that was loaded but not solved.
No hashes, option text or pictures are saved by this mechanism.

Each question retains the 100-second validity check, including a recheck directly
before the submission guard. `u2StepTimeoutMs` bounds the entire solver/retry/
submission-readback step: default 240000 ms, numeric positive values clamped to
1000–300000 ms. The public defaults and bounds live in `u2QuestionPolicy` in
`shared/checkin-contract.json`; private overrides belong in ignored local config.
The initial candidate navigation before the dedicated U2 handler is still bounded
by the existing navigation timeout. A total deadline retains the current result,
aborts public references and closes the current page. If submission has begun,
it always produces `submission_outcome_unknown`, never a new question.

Successful public cover vectors are cached **in memory for this U2 step**, keyed
by normalized work aliases (with source-local partial results), and rebound to
each new option position. A work with successful covers, including backup-only
covers, is not fetched again. Failed lookups
are not cached. Cache state is discarded at step completion, never persisted.

With retries enabled, exhausted/unreliable questions return `needs_attention`,
`submissionAttempted:false`, and the last question's failure code. No new
cross-run retry rule or `retryable:true` is introduced; existing status-based
retry policy applies. After the submission guard, any exception or uncertain
readback is `submission_outcome_unknown`, `submissionAttempted:true`,
`retryable:false`. Success still requires the same account's daily header.
An earlier guarded navigation or non-exempt click before reaching the U2 handler
also prevents solving/reloading/submitting; an exempt question-opener GET does not.

## Redacted diagnostics and projection boundary

Result rows and execution's `publicSupplementResult` carry `u2Diagnostics`:

| Field | Meaning |
| --- | --- |
| `questionCount` | Number of loaded questions, including a detected repeat |
| `questions` | Up to 5 per-question numeric/boolean/code records |
| `subreasons` | Fixed-code array, one per loaded question |
| `stopCode` | `u2_retry_limit`, `u2_question_unchanged` or `u2_step_timeout`, when applicable |
| `stepTimedOut` | Overall deadline reached |
| `questions[].subreason` | Fixed cause or `u2_answer_reliable` |
| `referenceCount`, `optionReferenceCounts` (per question) | Total covers and counts in current option order |
| `bestTotal`, `alternativeTotal`, `matchGap` (per question) | Best/next distinct ordered option-pair distances and gap |
| `distanceRatio`, `circleRatio` (per question) | Dot-side confidence measurements, only when that stage ran |
| `requests`, `failedRequests`, `timedOutRequests` (per question) | Actual reference-request counts; cache hits issue no requests |
| `timedOut`, `referenceDeadlineReached` (per question) | Request/image timeout and reference-budget exhaustion flags |
| `originalFailureCode` (per question) | Unknown solver code, only if matching `[a-z][a-z0-9_]{0,79}` |

Unavailable measurements are omitted, not guessed as zero. Visual ambiguity is
split into `u2_match_gap_insufficient`, `u2_dot_side_unclear`, and
`u2_no_best_match`, registered in `u2DiagnosticCodes`; the outward failure code
remains `u2_visual_ambiguous`. Unknown codes map to `u2_solver_failed`, not visual
ambiguity. Arbitrary exception text and solver fields are never copied.

**Current observation limitation:** `projectPtSiteResult`/`projectPtDiagnostic`
and `publishEngineReport` explicitly allowlist their fields and drop the entire
`u2Diagnostics` object. Thus the new measurements reach execution JSON reports
and the execution PT worker output, but not the observation snapshot/dashboard.
Observation implementation and cross-run retry/notification behavior are unchanged;
propagation needs a later work order after the pending observation changes merge.

## Not yet verified against the live site

Local synthetic fixtures prove the execution behavior, not U2's server policy.
It remains unverified whether GET `/showup.php` actually generates a new question,
or whether viewing/skipping questions affects failures or points. No live U2,
AniList, MyAnimeList or CDN requests are required by the tests. Start with the
bounded default only after the operator reviews those assumptions; use
`u2QuestionRetryCount: 0` if retaining the prior behavior is required.
