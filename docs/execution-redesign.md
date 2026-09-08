# V2 execution redesign — implementation contract (2026-09-08)

Status: DESIGN / implementation backlog, not an execution release. V1 retains
all check-in ownership. No permission to execute is implied by this document.
The private operational inventory and per-account cutover sheet are external
deliverables, never public repository fixtures.

## 1. Verified starting point

- The beta dashboard, local file bridge, append-only JSONL ledger, PT bookmark
  inventory, read-only Harvest exporter, and display identity reports exist.
- The ops wrapper pushes snapshots/ledger to NAS over SSH. NAS does not currently
  schedule actual Windows check-ins. An observation refresh is not a new check-in.
- Candidate contracts and a one-shot dry-run journal exist. A production leased
  worker transport, adapters and execution ownership handoff are NOT implemented.
- The existing seven-day shadow gate and the proposed production trial are
  separate gates. Neither number of UI tests nor a healthy service replaces them.

## 2. Architecture decisions

Start with a modular monolith on NAS, one Windows worker, and versioned adapters.
Use the existing Node/browser stack. Python remains optional for OCR or read-only
connectors; do not rewrite working adapters just to change languages.

Target NAS storage: SQLite WAL on a local NAS filesystem volume, single writer,
foreign keys and migrations. Do not share a SQLite database over SMB or NFS.
Windows has its own durable local journal/outbox. JSONL remains an audit export,
not the future distributed work queue. Back up databases with an online-safe
backup operation and test restore before production migration.

Windows initiates authenticated TLS connections to NAS. The desktop needs no
public inbound port, CDP endpoint, shell endpoint or unrestricted command runner.
Bootstrap and revoke scoped worker credentials separately from dashboard sessions.
Secrets and browser profiles remain on the executing host. Workers accept only
registered adapter IDs, validated task envelopes and approved origin sets.

Keep arbitrary code/plugin execution outside the web settings surface. Adapters
are trusted deployed code with tests and pinned versions, not strings of JS from
bookmarks. Registration, arbitrary web games and automatic financial trades are
out of the initial execution scope and require independent policies/approval.

## 3. One authoritative configuration pipeline

V1 runtime currently reads config.json; display tools sometimes shallow-merge a
second local file. A top-level replacement can silently drop nested site mappings.
Before execution work, introduce a single effective-config contract used by plan,
execution, health and read-only identity probing. Define merge semantics per field:
maps merge by stable key, arrays replace unless explicitly keyed, deletion uses
explicit tombstones. Validate conflicting settings instead of guessing precedence.
Emit a non-secret config version/digest; never serialize the whole secret-bearing
configuration into NAS snapshots. Migration must reproduce the actual V1 runtime
configuration, not assume the override file is newer or authoritative.

## 4. Entities and ownership

- Site: internal stable ID, bookmark provenance, display title, verified aliases,
  service origins and adapter version. A related URL is not automatically the
  same service/account. A website platform replacement invalidates capability
  discovery, not silently just the login session.
- Account: internal key, service user ID and namespace, upstream identity key,
  execution profile binding/version, verification timestamp and source.
- Upstream session: provider plus exact upstream account, not just 'LinuxDO'.
- Desired task: site/account/action/business occurrence, enabled policy and owner.
- Observation-only membership: its own relation, no execution owner or lease.
- Daily instance: desired task plus the adapter's business-date/time boundary.
- Attempt: bounded actions with identity/config/adapter version and stage journal.
- Evidence: identity, business occurrence, action, source, timestamp, semantics.
- Delivery: destination reference, payload revision, idempotency key and receipt.

Plan first from the desired registry, then join results. Never create the desired
plan from results alone: an omitted task must remain visible as not_started.
Unknown same-origin multi-account entries must not get identities based on array
position. Display labels/cache identities are never permission to submit.

Each account/action/occurrence has exactly one owner. Harvest participation counts
as a possible external actor: V2 supplement must first query fresh state and be
explicitly enabled. Today's monitor-only imports never become execution candidates
merely because their status is unknown or not_signed.

## 5. Session reuse and isolation

Reuse upstream authentication only within a verified (provider, upstream-user-ID)
group. Different upstream users never share cookies; two target accounts on the
same service keep separate execution profiles. A service that awards quota on
relogin requires an exclusive session mutation lock even when upstream auth can
be reused for other services. Do not broadcast cookie copies to profiles.

One resolver determines bookmark->service->account->profile for all tools.
Probe sessions on demand; pool at most a measured small number of idle contexts.
Start with one active browser mutation, one per profile/account/origin and one
per shared upstream recovery group. Increase concurrency only with CPU/memory and
success evidence; unrelated stateless read probes can have a separate small budget.
Never reposition/terminate the user's ordinary Chrome. Dedicated profiles must
be proven healthy without routine main-Chrome fallback before their final cutover.

## 6. State machine and uncertainty

Normal path:

`planned -> leased -> identity_verified -> status_read -> prepared -> submitting
 -> verifying -> succeeded -> receipt_persisted -> reported`

Already done: status_read -> already_done. Disabled feature, maintenance and
operator-disabled task are distinct outcomes, not successful sign-ins.

Errors are orthogonal facts: stage, cause, retryability, actionMayHaveHappened,
nextEligibleAt, evidenceFreshness and recoveryBudget. Do not overload one status
string to represent login, connectivity, scheduling and business completion.

Submission is preceded by a durable intent record. If a request may have reached
the remote service but response is lost, enter submission_unknown and reconcile
the authoritative result. No blind POST replay or automatic failover to V1.
If the site cannot answer whether it succeeded, quarantine the mutation until a
safe next occurrence or explicit review. Distributed 'exactly once' cannot be
guaranteed against arbitrary third-party APIs without their idempotency support.

Lease expiry alone does not authorize duplicate mutation: use ownership epochs,
fencing on local workers, worker/profile locks, and mandatory reconciliation of
prepared/submitting instances. An offline worker stops accepting work and never
starts a new mutation on an expired lease. An in-flight action may finish; persist
its evidence locally and upload idempotently. Record clock skew and fail closed.

## 7. Adapter contract and evidence

Required: capabilities(), resolveIdentity(), readStatus(), submitOnce(),
verify(), classifyError(). Optional recoverSession() is distinct from submit.
Capabilities declare approved origins/endpoints, auth family, mutation side
effects, server business-day/reset rule, evidence version and maintenance policy.
Status probes may not call endpoints that silently perform sign-in.

Evidence reducers normalize supported raw sources without inferring authority
from a success string. Keep original source and mapped semantic type; unsupported
sources become unsupported_evidence, not a valid success or an unexplained failure.
No-result tasks, weak legacy success, disabled-feature cache and actual verified
success stay separate. For OCR, recognition confidence is not success proof.
Use API/calendar/log readback after submission or a stable site-specific page
receipt including the relevant day/account. Cache reuse requires matching account,
binding epoch, business date, adapter/evidence contract and freshness policy.

For PT multi-source display, identify account before merging; absent identity is
an unresolved association, not proof that Harvest and V1 are the same user.
Compare only relevant same-day authoritative sources for conflict. A newer unknown
probe must not silently erase an earlier confirmed same-day success; show both
business result and current connectivity. Do not change prior audit records.

## 8. Recovery budget

One coordinator owns the budget; adapters do not run nested retry loops.
Suggested initial budgets (configurable, validated, not installed by this plan):

| Failure | Recovery | Limit |
|---|---|---|
| DNS/TLS/timeout before mutation | bounded origin-level route probes | 2 probes then cooldown |
| 429 | respect Retry-After, jitter per origin | daily cap; no parallel login storm |
| Explicit login expired | same identity session recovery | 1 recovery per incident |
| Identity mismatch | block task and retain evidence | zero submission |
| Ordinary image OCR rejection | alternate OCR, refresh approved image | 2 attempts; no blind clicks |
| Interactive CAPTCHA/2FA | human-required state | no automated bypass |
| Maintenance/platform changed | capability quarantine with TTL | no repeated login |
| Submitted response missing | read-only reconcile | bounded queries; no blind POST |
| Notification failure | delivery outbox only | never rerun execution |

All actions share a wall-clock deadline. Adapter timeout and daily scheduler caps
are not multiplied. Maintenance/no-feature detection has a revisit time and must
invalidate on platform version change. Do not globally change DNS/proxy to repair
a single site's routing. OCR fallback sends only the necessary challenge image
to an explicitly configured provider, never account cookies or a full screenshot.

## 9. Customization and observability

Basic settings: monitor/enabled, account, time, notice preferences.
Advanced: allowed adapters, reset timezone, budgets, concurrency, session group,
supported OCR providers. Developer tier: reviewed adapter packages with tests.
Every change has preview, validation, version, audit and rollback. Secret inputs
use local secret references, not plaintext source-controlled settings.

Dashboard reads the same instance/evidence records as notifications. Separate
last business success, last observed connectivity, last session verification and
metadata source. Show stage duration and reason-specific next action. Refreshing
the dashboard does not refresh credentials, perform login or execute sign-in.

Metrics: first-attempt success, end-of-window success, human interventions per
100 instances, P50/P95 time, browser-active minutes, recovery count, notification
latency, duplicate mutations, wrong-account mutations, false success claims.
Store raw denominator and exclusions; external outage remains visible in overall
completion. Historical merged reports cannot establish first-attempt success.

## 10. Delivery stages and gates

M0: inventory, entity/config/evidence decisions, private cutover sheet (this work).
M1: single resolver + desired-plan/result reconciliation + typed evidence. Pure
read/dry-run tests first; no live execution. Build reproducible fixtures from past
bugs with all credentials removed. Measure a new baseline rather than inventing it.
M2: authenticated transport, durable local journal/outbox, ownership epochs,
timeouts and crash/reconnect injection. Still dry-run against production tasks.
M3: adapter read-only probes; one standard API account first, one multi-account
family next. Migration sheet must record dependency, identity and evidence gates.
M4: explicitly approved canary ownership transfer for one account/action. Drain
old V1 instances first; V1 is rollback standby, not concurrent executor.
M5: proposed minimum 14 calendar days of canary observation, at least 10 actual
mutation occurrences when possible, an authenticated session-expiry recovery test,
network loss after submission, process crash/reboot, NAS offline, midnight/reset,
duplicate message and notification loss. Sites where opportunities are unavailable
remain unaccepted; prior/already-done receipts cannot substitute for mutations.
M6: expand by family after gates, then package V2 with clean install/export/restore
tests and versioned docs. No GitHub publication inferred from a local design edit.

Non-negotiable: zero wrong-account submissions, false-success claims and avoidable
duplicate submissions in acceptance. Suggested SLO: >=99% automatic completion on
eligible available instances over a sufficiently large measured window, <=1 human
intervention / 100 instances; report confidence/sample size and overall rate too.
These are targets, not claims or guarantees of external site availability.

Rollback: stop assigning, drain/verify outstanding instances, persist terminal
receipts, increment ownership epoch, then re-enable V1 only for known-unsubmitted
or reconciled instances. Prepared/submission_unknown tasks cannot be bulk replayed.
Storage/migration rollback and task-ownership rollback are different procedures.

## 11. Required regression cases

R01 missing result remains not_started; R02 account-key/actual-ID mismatch;
R03 config overlay drops nested mapping; R04 unrelated default accounts;
R05 shared auth group with different upstream identity; R06 platform/domain change;
R07 timezone/reset boundary; R08 OCR correct but submission rejected;
R09 unsupported evidence source; R10 missing evidence but success string;
R11 request timeout after remote success; R12 crash after intent before receipt;
R13 expired lease with in-flight worker; R14 lost outbox acknowledgement;
R15 deleted bookmark never resurrected from retry/cache; R16 monitor-only never
leases; R17 Harvest/V1 account mismatch; R18 newer unknown vs same-day success;
R19 NAS offline/PC reboot; R20 regular Chrome focus/window isolation;
R21 stale lock recovery with process-start identity; R22 empty/invalid source
retains last good view but blocks new execution; R23 accessibility/keyboard/reduced
motion independent of executor; R24 pristine install and database restore.

Each case requires fixture/input, expected state, forbidden side effects, and
evidence of observed result. A test merely asserting service health is insufficient.
