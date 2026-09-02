# codex-checkin-fabric-v2

## Scope

This repository is the independent V2 control-plane prototype for the daily
check-in automation. V2.0 beta remains read-only: it observes the legacy runner
and produces a redacted plan/result snapshot plus a local shadow ledger. It must not click a check-in
button, start a browser, send a notification, write to the legacy project, or
contact NAS services.

## Safety rules

- Never copy cookies, tokens, passwords, DPAPI stores, Chrome profiles, full
  screenshots, or private absolute paths into this repository.
- Treat the legacy project as read-only input. Use `src/bridge.mjs` for the
  bounded, redacted import.
- Every task has one execution owner. The shadow system's owner is
  `legacy-checkin`; V2 is an observer only.
- A success receipt requires an authoritative page/API/log signal supplied by
  the legacy result. A notification failure is not a reason to execute again.
- Keep generated reports under ignored `outputs/`, `logs/`, or `tmp/`.

## Verification

Run `npm test` before committing. Keep schemas backwards-compatible and update
`docs/migration-phases.md` when a phase boundary changes.
