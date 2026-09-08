# M1 foundations — configuration, desired plan, evidence

Implemented 2026-09-08. Still shadow-only. No V1 configuration, execution owner,
browser profile or notification sender is changed.

## Effective configuration

`loadEffectiveConfig()` reads the already compiled V1 `config/config.json`.
It does NOT shallow-merge `config.local.json`, because V1 does not do so at run
time. Missing/malformed production configuration fails closed. The bridge's
optional empty-config path is only for legacy exported fixtures/saved-plan input.
Current bookmark and identity probes require the runtime file. Profile resolution
is centralized, validates exclusive bindings, honors explicit service accounts,
and rejects locations outside dedicated data. Existing display observations with
a different binding hash are not silently rebound or promoted to verified.

V1's installer/source configuration remains unchanged. A future V2 native config
compiler with field-specific override semantics is a separate migration task;
this compatibility layer intentionally preserves the actual V1 configuration.

## Desired plan and reconciliation

The installed ops sync invokes `collect-desired-plan.mjs` on current bookmarks
using V1's read-only parser and the effective configuration. It includes configured
primary and supplemental accounts. It does not use bookmark backup fallback or
write V1's cached plan. A source failure retains the last good dashboard snapshot
instead of treating the plan as empty. The report contains only allowlisted plan
metadata and is not directly uploaded to NAS.

Bridge accepts `--desired-plan`; without it, the saved bookmark plan plus runtime
account configuration is the explicit compatibility source, not live discovery.
An explicitly requested exclusion is a reversible plan boundary. Hotaru is currently
excluded because the user removed it while the physical AccountBookmarks copy has
not caught up; its stale V1 result is counted as an unexpected historical result,
not reintroduced into the plan. Removing the exclusion after the source is restored
makes it eligible again; this boundary never deletes Chrome data.
Results are joined by exact origin/account key. Missing results become not_started
with no fabricated observation timestamp. Duplicate/ID-conflicting results become
needs_attention. Unexpected results are counted but cannot resurrect deleted tasks.
An incomplete latest report is not concealed behind an older complete report.
The plan hash is independent of missing/status-only results. A reconciliation
anomaly denies dry/candidate evaluation; monitoring never grants execution rights.

## Evidence

`normalizeEvidence()` preserves rawSource, originalSource and verification reason.
Known structured legacy adapters have explicit compatibility rules; missing,
unsupported, negative-authority, wrong-date and mismatched-identity evidence cannot
become authoritative just because status says signed. AnyRouter sign_in_response
and sign_in_already_claimed_contract now map to API; cached no-feature evidence
retains its original source and bounded age.

V1 reported status is preserved. The UI separately shows supported evidence and
unverified success counts, with raw types in details. This is not permission to
repeat the action. Eight current legacy successes lack structured evidence; this
release surfaces that gap instead of rewriting history or pretending to reconstruct
proof. Producing richer receipts inside future V2 adapters is still needed.

## Verification

Regression cases include overriding config maps, missing/empty run reports,
multiple accounts, duplicate results, deleted accounts, actual-ID mismatch, null
timestamps, unknown evidence, source mapping, age/date mismatch, read-only gates
and mobile missing-task filtering. Real read-only sync preserved 23 tasks and the
existing plan hash, with 0 missing/conflicting/unexpected results. No real check-in
was triggered by these tests. M2 transport and real execution remain unimplemented.
