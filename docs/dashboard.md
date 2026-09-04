# Dashboard capability map

The V2 dashboard takes the useful parts of a Keeper-style operational view and
a Harvest-style history/reporting view, while keeping check-in execution
outside the web process.

## Current Beta features

- **Overview:** logical-site count, execution-unit count, status mix, latest
  plan hash, execution/business completeness, and health freshness.
- **Tasks:** searchable/filterable task ledger with account references,
  evidence source, authoritative flag, and execution owner.
- **PT status:** read-only status catalog for PT sites from V1, Harvest, or
  another observer. It includes external-only sites, source-by-source status,
  freshness, discrepancies, and bounded manual supplement candidates without
  granting execution permission.
- **Sites:** per-site execution-unit progress, logical groups, and a bounded
  policy control (`monitor`, `review`, `pause`) with a short note and audit
  history. These policies are V2 metadata only and do not pause the legacy
  runner yet.
- **Accounts:** isolated account references and per-account task/status
  summaries; account IDs and labels are deliberately not exposed.
- **Run history:** append-only shadow-ledger records, plan drift, status
  changes, task counts, and health state.
- **Settings:** explicit display of execution ownership, read-only mode, and
  disabled lease/notification boundaries.
- **Mobile access:** the navigation becomes an off-canvas drawer on narrow
  screens, with an overlay and Escape/close controls. The dashboard exchanges
  the administrator token for a signed HttpOnly session cookie; the default
  browser session is bounded to 12 hours, and explicit remember-me is bounded
  to 7 days. The administrator token is never kept in browser storage or in
  the cookie.

## Deliberately deferred

- Live browser control, retry buttons, bookmark mutation, credential editing,
  Telegram configuration, automatic PT supplement, and task execution are not
  available in the web process.
- Trend charts, duration/ROI analytics, and export jobs can be added after at
  least seven shadow runs establish stable history.
- New-site discovery/registration remains V2.1 and always requires human
  approval, adapter review, and a dry run.

## API surface

All `/api/*` routes require the dashboard token when the service is not
loopback-only. `GET /healthz` is a minimal unauthenticated container health
probe. Read APIs are `/api/summary`, `/api/tasks`, `/api/pt-status`,
`/api/sites`, `/api/accounts`, `/api/ledger`, `/api/controls`, `/api/config`,
and `/api/health`. The only mutation is `POST /api/controls/sites`; it
validates a credential-free origin and one of the three metadata policies,
limits the note to 240 characters, and writes an audit entry.
