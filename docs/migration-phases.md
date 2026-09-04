# Migration phases

1. **V2.0-alpha (current):** read-only bridge, contracts, privacy scrub, and
   fixture tests. Legacy execution remains authoritative.
2. **V2.0-beta.2 (current shadow release):** NAS ledger, schedule gate,
   dashboard, and read-only PT status catalog in shadow mode; compare plans,
   ownership, freshness, receipts, and optional Harvest observations for at
   least seven daily runs. `npm run check:shadow-history` is a read-only gate
   for the required consecutive fresh and healthy history.
   Unit tests use fixed redacted fixtures; live V1 integration is a separate
   smoke check. The local
   prototype never grants a lease, and no duplicate clicks are permitted. Site
   policy edits remain V2 metadata and are audited without affecting the legacy
   runner. Cross-day drift is keyed by stable `planUnitId`, while each dated
   execution keeps its own `taskId`.
3. **V2.0 candidate foundations (now):** protocol-only contracts and local
   acceptance for worker capabilities, single-use leases, dry-run/execute
   gating, idempotent evidence receipts, and notification outbox deduplication.
   PT supplement candidates remain review-only; no worker or execute lease is
   active yet.
4. **V2.0 candidate execution:** authenticated Windows worker leases one task
   at a time, uses isolated profiles, and reports evidence. Enable only for a
   small allowlist while legacy remains the rollback owner.
5. **V2.0 cutover:** after repeated parity and failure-injection acceptance,
   switch ownership site-by-site. Keep a reversible legacy fallback and make
   notification delivery an independent outbox operation.
6. **V2.1:** read-only new-site discovery and registration candidates. Human
   approval, adapter review, credential provisioning, and a dry-run are
   required before any candidate can become a task.

The GitHub repository for V2 is intentionally independent from the existing
private runner. Publishing is a later, explicit step after local acceptance.
