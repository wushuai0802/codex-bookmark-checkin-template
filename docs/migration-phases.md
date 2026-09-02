# Migration phases

1. **V2.0-alpha (current):** read-only bridge, contracts, privacy scrub, and
   fixture tests. Legacy execution remains authoritative.
2. **V2.0-beta:** NAS ledger and schedule gate in shadow mode; compare plans,
   ownership, freshness, and receipts for at least seven daily runs. No
   duplicate clicks are permitted.
3. **V2.0 candidate:** authenticated Windows worker leases one task at a time,
   uses isolated profiles, and reports evidence. Enable only for a small
   allowlist while legacy remains the rollback owner.
4. **V2.0 cutover:** after repeated parity and failure-injection acceptance,
   switch ownership site-by-site. Keep a reversible legacy fallback and make
   notification delivery an independent outbox operation.
5. **V2.1:** read-only new-site discovery and registration candidates. Human
   approval, adapter review, credential provisioning, and a dry-run are
   required before any candidate can become a task.

The GitHub repository for V2 is intentionally independent from the existing
private runner. Publishing is a later, explicit step after local acceptance.
