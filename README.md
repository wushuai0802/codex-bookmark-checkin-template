# codex-checkin-fabric-v2

V2 is an independent control-plane project for the daily check-in automation.
The first release (`2.0.0-alpha.1`) is deliberately a **read-only shadow
observer**. The existing Windows runner remains the only system allowed to
execute check-ins.

## What alpha does

- Imports the legacy bookmark plan, latest run result, site state, scheduler
  state, and health report.
- Builds stable task identities from business date, logical site, account,
  action, and schedule occurrence.
- Emits a redacted JSON snapshot suitable for NAS/control-plane integration.
- Calculates health freshness and rejects credential-bearing fields.

It never launches Chrome, invokes a browser API, writes the legacy project, or
sends notifications.

## Local usage

```powershell
npm test
node src/bridge.mjs --legacy-root D:\AIWorkspace\bots\chrome-daily-checkin `
  --out outputs\shadow-snapshot.json
```

The output directory is ignored by Git. The bridge also accepts
`CHECKIN_LEGACY_ROOT`; an explicit `--legacy-root` is preferred. A missing or
malformed legacy result is a hard error rather than an empty successful plan.

## Contract and rollout

Contracts live in `schemas/`. Architecture and the staged migration are in
`docs/architecture.md` and `docs/migration-phases.md`. Registration discovery
is intentionally not an alpha capability; it is planned for V2.1 after a
read-only review gate.
