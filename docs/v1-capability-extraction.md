# V1 capability extraction (V2 migration input)

Generated from V1's effective `config.json` on 2026-09-09. This catalog is a
declarative migration input, not a copy of V1's executor. It records each site's
adapter family, expected evidence and mutation boundary so V2 can reimplement
one family at a time without inheriting V1's nested retry and login flow.

The catalog currently contains 17 unique origins and five reusable families:
standard New API calendar, OAuth reward log, OAuth status API, native PT browser,
and generic site discovery. AnyRouter dynamic routing and special platform changes
are separately gated as M3b work. Adapter definitions are observation-only and
`canaryReady=false` until a V2 adapter has identity/status fixtures, a real
read-only probe, a mutation proof, and a rollback test.

Extraction rules: use only V1's compiled `config.json`, map by normalized origin
and explicit rule keys, keep related URLs as aliases rather than new accounts,
and never copy local secrets or profile paths. PT and monitor-only sites have no
lease or submit capability. `POST` in the catalog only describes the old V1
boundary; the V2 read-only implementation sends no POST.

V2 still needs the reviewed adapter interface, site/account registry, worker
profile locks, intent and `submission_unknown` reconciliation, canary records,
first-attempt metrics and outbox integration. V1 remains rollback software until
all accounts in a family pass these gates; deleting it now would remove the only
proven executor and is outside this stage.

The clean V2 contract is now represented by `src/adapter-contract.mjs` and
`src/task-state.mjs`: adapters expose explicit identity/read/submit-once/verify/
error boundaries, while the coordinator owns transitions and retry policy. A
submission timeout is `submission_unknown`, never an invitation to POST again.
The state machine is currently library/test only; no live adapter is wired to the
worker and `executionEnabled` remains false.
