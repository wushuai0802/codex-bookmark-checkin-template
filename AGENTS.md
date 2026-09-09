# codex-checkin-fabric-v2

## Scope

This repository is the independent V2 control plane and staged executor for the
daily check-in automation. Shadow mode remains the default. The explicitly
account-scoped Canary runner may use a dedicated V2 browser profile and submit
one approved task; all other accounts remain owned by the legacy runner. V2
never uses the user's normal Chrome profile, copies V1 browser state, or starts
an unregistered site task.

## Safety rules

- Never copy cookies, tokens, passwords, DPAPI stores, Chrome profiles, full
  screenshots, or private absolute paths into this repository.
- Treat the legacy project as read-only input. Use `src/bridge.mjs` for the
  bounded, redacted import.
- Every task has one execution owner. Non-migrated tasks are owned by
  `legacy-checkin`; a migrated task changes to `v2-worker` only after an
  authoritative V2 submission and verification.
- A success receipt requires an authoritative page/API/log signal supplied by
  the legacy result. A notification failure is not a reason to execute again.
- Keep generated reports under ignored `outputs/`, `logs/`, or `tmp/`.

## Verification

Run `npm test` before committing. Keep schemas backwards-compatible and update
`docs/migration-phases.md` when a phase boundary changes.
