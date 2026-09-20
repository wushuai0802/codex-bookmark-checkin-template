# Check-in Fabric

## Scope

This is one check-in project with an execution layer and an observation layer.
Production dispatches the established browser runner through
`scripts/run-v1-engine.mjs`, reusing its configuration and profiles in place.
The observation layer monitors Harvest, reconciles registered PT sites and
publishes redacted dashboard data. Historical standalone Canary execution is
fenced off. Do not copy browser state or run an unregistered task.

## Safety rules

- Never copy cookies, tokens, passwords, DPAPI stores, Chrome profiles, full
  screenshots, or private absolute paths into this repository.
- V1 engine gateway changes are in scope; preserve its site implementations,
  existing account bindings and unrelated configuration. Use `src/bridge.mjs`
  for bounded, redacted result import.
- Every task has one execution owner. Unified mode requires a V2 lease plus
  the V1 process/mutex locks. Retired account handoffs remain audit records.
- A success receipt requires an authoritative page/API/log signal supplied by
  the legacy result. A notification failure is not a reason to execute again.
- Keep generated reports under ignored `outputs/`, `logs/`, or `tmp/`.

## Verification

Run `npm test` before committing. Keep schemas backwards-compatible and update
`docs/migration-phases.md` when a phase boundary changes.
