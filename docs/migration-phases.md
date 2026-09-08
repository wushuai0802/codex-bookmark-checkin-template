# Migration phases

V1 migration update (2026-09-09): `v1-adapter-catalog.mjs` and
[v1-capability-extraction.md](v1-capability-extraction.md) extract adapter
families from the V1 compiled runtime configuration. The catalog is declarative
and observe-only; it does not copy executor loops or secrets. V2 must reimplement
and canary each family before V1 can be retired.

Clean-core update (2026-09-09): [v2-clean-core.md](v2-clean-core.md) adds the
small adapter contract, coordinator state machine and explicit
`submission_unknown` boundary. It is library/test-only and cannot receive a
live lease yet.

M3a update (2026-09-08): [m3-readonly-adapters.md](m3-readonly-adapters.md) records
four read-only families and real identity/business evidence probes. Their results
are displayed independently in settings, not merged into execution. Protected PT,
special routing and missing-identity cases remain open. No submit adapter, browser
worker schedule or ownership cutover is enabled by this stage.

M2b update (2026-09-08): [m2-https-deployment.md](m2-https-deployment.md) records
real HTTPS auth/rotation/revocation, DPAPI credentials, separate transport storage
and low-frequency dry-worker lifecycle. It reuses the existing shadow scheduler;
a separate task could not be registered. Real execution remains disabled. M3
adapter identity/evidence work is next, with production hardening still listed.

M4 preparation: `src/canary-gate.mjs` now provides a fail-closed advisory gate.
It refuses incomplete shadow history, stale health, current-owner tasks, cached or
missing identity, unknown/missing results and non-execute worker capabilities. A
passing result still has `executionEnabled=false` until explicit ownership-cutover
approval and adapter acceptance.

M2a update (2026-09-08): [m2-dry-transport.md](m2-dry-transport.md) documents the
authenticated dry protocol, SQLite intent/outbox and failure-injection tests,
including real NAS round-trip via an SSH exec fixture relay. Direct production
HTTPS, credential enrollment and persistent worker rollout are still pending;
the dashboard and V1 execution remain unchanged.

2026-09-08 audit: the read-only Harvest connector is now installed in the ops
wrapper, but the production executor remains unimplemented. The redesign and
gates are specified in [execution-redesign.md](execution-redesign.md). Inventory
and design (M0) are complete; M1 configuration/desired-plan/evidence work is next.
The proposed 14-day execution canary does not replace the current 7-day shadow
gate. No ownership transfer or live execution was enabled by this audit.

M1 implementation update: [m1-foundations.md](m1-foundations.md) records the
effective-runtime config resolver, current desired-plan reconciliation and typed
evidence bridge. These are implemented and tested in shadow mode; M2 transport,
new execution adapters and evidence production in those adapters remain pending.

1. **V2.0-alpha (completed foundation):** read-only bridge, contracts, privacy scrub, and
   fixture tests. Legacy execution remains authoritative.
2. **V2.0-beta.3 (current shadow release):** NAS ledger, schedule gate,
   dashboard, and read-only PT status catalog in shadow mode; compare plans,
   ownership, freshness, receipts, and optional Harvest observations for at
   least seven recent consecutive daily runs of the same plan. The last
   observation must be current (at most 26 hours old and today/yesterday).
   `npm run check:shadow-history` recomputes timestamp freshness; a serialized
   fresh flag or an old successful week is insufficient.
   Unit tests use fixed redacted fixtures; live V1 integration is a separate
   smoke check. The local
   prototype never grants a lease, and no duplicate clicks are permitted. Site
   policy edits remain V2 metadata and are audited without affecting the legacy
   runner. Cross-day drift is keyed by stable `planUnitId`, while each dated
   execution keeps its own `taskId`.
3. **V2.0 candidate foundations (now):** protocol-only contracts and local
   acceptance for worker capabilities, single-use leases, dry-run/execute
   gating, idempotent evidence receipts, and notification outbox deduplication.
   PT supplement candidates remain review-only. A one-shot dry-run worker now
   tests durable deduplication, interruption, timeout and restart; it cannot
   run a browser, contact services or issue an execute lease.
4. **V2.0 candidate execution:** authenticated Windows worker leases one task
   at a time, uses isolated profiles, and reports evidence. Enable only for a
   small allowlist while legacy remains the rollback owner.
5. **V2.0 cutover:** after repeated parity and failure-injection acceptance,
   switch ownership site-by-site. Keep a reversible legacy fallback and make
   notification delivery an independent outbox operation.
6. **V2.1:** read-only new-site discovery and registration candidates. Human
   approval, adapter review, credential provisioning, and a dry-run are
   required before any candidate can become a task.

V2 uses the existing public repository's independent `v2` branch and checkout.
Publishing is an explicit step after local acceptance; production ownership
does not change merely because a commit or branch exists.
