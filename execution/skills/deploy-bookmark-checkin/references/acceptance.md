# Acceptance criteria

Deployment is complete only when all applicable checks pass:

- Preflight has no unaccepted blocking item.
- The user explicitly chose the Chrome profile, parent/container folders, and target child folders; every matching source is listed.
- Dry run discovers and deduplicates expected targets.
- The isolated profile is initialized without copying plaintext secrets.
- Every enabled site is `signed` or `already_signed`; `not_available` requires a current authoritative signal.
- Failures are retried and resume mode runs only unresolved or newly added targets.
- A second dry run proves a newly added synthetic test bookmark would be discovered, then the synthetic entry is removed without touching the user's real bookmark file; prefer a fixture test.
- Scheduled execution is hidden, unique, and configured for the requested time.
- Notification, if enabled, is tested with a non-secret preview and submitted once after recovery finishes.
- `npm run --silent health` exits with code `0`, reports `healthy=true`, has an empty `failedChecks` array, and refers to today's final run.
- Unit tests, dependency audit, and public-safety scan pass.
