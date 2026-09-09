# V2 project structure

V2 is split by responsibility. A module may consume data from an earlier
layer, but it must not reach backwards into V1 executor code.

| Area | Responsibility | Allowed side effects |
| --- | --- | --- |
| `src/contracts.mjs`, `src/task-state.mjs`, `src/evidence-contract.mjs` | IDs, state transitions, evidence semantics | None |
| `src/bridge.mjs`, `src/effective-config.mjs`, `src/desired-plan.mjs` | Redacted V1 import and desired plan | Read V1 only; write V2 outputs only |
| `src/*adapter*.mjs`, `src/new-api-*.mjs`, `src/anyrouter-readonly.mjs` | Site-family identity, status, submit and verification | Only injected browser/HTTP transport; no scheduler or notification |
| `src/task-coordinator.mjs`, `src/isolated-browser-worker.mjs` | One task's ordered execution and browser isolation | One bounded task context |
| `src/candidate-protocol.mjs`, `src/dry-transport-*.mjs`, `src/worker-gateway.mjs` | Worker authentication, lease and receipt transport | Dry-run only until explicit cutover |
| `src/shadow-*.mjs`, `src/pt-status.mjs` | Shadow ledger and monitor-only PT status | Read-only observation |
| `src/dashboard-server.mjs`, `public/` | Dashboard presentation and bounded controls | No browser launch or check-in |
| `scripts/` | Explicit operator commands and smoke checks | Must state mode and refuse unsafe defaults |

The V2 execution path is linear:

`desired plan -> task lease -> isolated profile -> identity -> status -> intent ->
submit once -> verify -> receipt -> notification`

Adapters do not own retries, leases, profile selection, notifications or
ownership changes. Monitor-only observations never produce an execution lease.
All new site support starts as a read-only adapter and must pass identity,
evidence and failure fixtures before a canary flag can be considered.
