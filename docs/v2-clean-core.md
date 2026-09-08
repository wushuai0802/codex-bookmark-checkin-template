# V2 clean core

Implemented as pre-execution groundwork on 2026-09-09. This is the intended
replacement boundary for V1; it is not yet a live signer.

V2 takes only these V1 inputs: the current bookmark plan, explicitly configured
account metadata, redacted result evidence and health/monitor observations. It
does not import V1's browser runner, login helpers, nested retry loops, site-state
cache or notification scheduler into the V2 execution path.

Each adapter has one small contract: `identity`, `read_status`, `submit_once`,
`verify`, and `classify_error`. The coordinator owns the common sequence:

```text
planned → identity_verified → status_read → prepared → submitting
       → verifying → succeeded / already_done / not_available
```

An uncertain response is `submission_unknown`; only a later read-only reconcile
can leave that state. No adapter may hide a retry loop or turn an unknown result
into success. Read-only adapters declare zero mutation capability and are never
eligible for leases.

The clean core is currently library/test only. No live site adapter is wired to
the worker; `executionEnabled` remains false. This separation lets V2 inherit
the proven site knowledge from V1 while avoiding its accumulated orchestration
complexity. V1 remains the rollback executor until each adapter family and each
account passes the independent canary gates.

The next implementation unit is a real adapter family built against the contract,
starting with standard New API accounts. It must pass identity, same-day status,
submit-once, post-submit verification, timeout/reconcile, profile isolation and
rollback tests before any canary flag is considered.
