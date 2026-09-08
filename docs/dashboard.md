# Dashboard capability map

Mobile navigation is limited to 60% of viewport width (192-232px), with scrollable
contents on short screens. Overview shortcuts use the main content container's
width to form equal-width 2/2/1, 3/2, or 5-column layouts. Touch targets retain a
44px minimum height and labels wrap without shrinking the font.
Overlay-only history changes do not rebuild task/PT lists or redundantly restore
scroll. Backdrops suppress full-screen native tap highlighting, root scrollbar
space stays stable, and automatic refresh pauses while an overlay is active.

Motion uses short, directional transitions: the left navigation exits left and
right-side details exit right. Focus and pointer ownership are released after
exit, not before it. Interrupted exits are cancelled on reopen. Supported mobile
browsers use CloseWatcher for menu close signals with history as the fallback.
Views fade in only when navigating, not during background data refresh. OS reduced
motion disables transitions and Web Animations. The browser's own predictive-back
preview remains browser-controlled; the document does not intercept edge swipes.

The shadow sync can load an allowlisted `--identity-file` observation report.
Observations are bound to origin, account key and configured browser profile via
a digest; profile/account changes, conflicts, future timestamps and observations
older than 30 days are rejected. This is display metadata only, never a credential
or an execution identity override. Live identity responses and browser-cache IDs
are distinguished in the UI, as are site IDs and service-returned LinuxDO IDs.
The regular shadow sync reads these observations without opening a browser.

Run history displays observation batches, status totals and task-level changes,
not execution claims based on a hash. New ledger entries include allowlisted
historical task identities and evidence. Older entries remain unchanged and
explicitly indicate that detailed history was not captured. Hashes are available
only in expandable technical details. Display metadata has its own record version
so a detailed record can be appended without rewriting an older summary record.

Views use History API state and hash deep links. Back/forward restore filters
and scroll; menu and detail drawers each occupy one history entry. Navigating
from a menu replaces its transient entry. Closing a drawer consumes only that
entry; the root view does not trap browser navigation outside the application.
Both desktop and mobile sidebars follow the selected light/dark theme.

Appearance is selectable from the sidebar: light, dark, or system (default).
Only the non-secret `fabricTheme` preference is stored locally. System changes
apply live in system mode, and the preference is applied before stylesheet paint.
Status chart segments and legend share a brighter categorical palette; counts
and labels remain available independently of color. Appearance does not affect
authentication, scheduling, task execution, or the shadow-mode boundary.

The V2 dashboard takes the useful parts of a Keeper-style operational view and
a Harvest-style history/reporting view, while keeping check-in execution
outside the web process.

## Current Beta features

- **Outcome-first overview:** separates successful, unavailable and unresolved
  check-ins. Completion rate excludes unavailable features; host health is not
  displayed as business success. The ring chart is derived from actual counts.
- **Attention and readiness:** shows unresolved items with evidence summaries,
  a filtered task shortcut and the recent seven-day observation gate.
- **Fresh data:** snapshot and health ages are checked at request time. PT
  supplement eligibility expires instead of trusting a stored fresh flag.
- **Consistent refresh:** `/api/overview` delivers one coherent view in one
  request. Visible pages refresh every minute, preserve filters, and defer
  refresh while editing. Auth and timeout failures remain explicit.
- **Mobile and keyboard:** the navigation drawer manages focus and inert state;
  overview cards fit phone widths without horizontal overflow. Existing secure
  remembered sessions remain unchanged.

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
`/api/overview`,
`/api/sites`, `/api/accounts`, `/api/ledger`, `/api/controls`, `/api/config`,
and `/api/health`. The only mutation is `POST /api/controls/sites`; it
validates a credential-free origin and one of the three metadata policies,
limits the note to 240 characters, and writes an audit entry.
