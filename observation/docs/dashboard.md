# Dashboard capability map

## Glass appearance

The article-inspired appearance is the dashboard default. `?glass=off` locally
restores the previous plain surfaces without changing the API or execution state;
`?glass=1` retains the earlier, cooler glass draft for comparison. Appearance
uses the existing light/dark/system preference. Glass is limited to navigation,
the top bar and overview surfaces; tables and detail reading areas remain opaque.
Reduced-transparency, high-contrast and unsupported-backdrop browsers use opaque
surfaces.

The light appearance follows the referenced Liquid Glass article's warm-apricot / cool-blue ambient
gradients, `#F7F9FC` base, `#2868D8` action color, and graded surfaces:
42% white / 24px blur navigation, 58% / 18px toolbar, 72% / no blur cards,
86% / 30px blur login overlay, and near-solid reading areas. Browser-local
theme selection remains available; dark mode uses corresponding warmer/cooler
surfaces. Account tasks and evidence are never changed by appearance parameters.

The overview attention queue groups accounts only when business date, origin,
status and evidence reason match. It previews four distinct causes, retains the
task-level total and unread state, and routes "View all" to the pending task
filter. This bounds overview height without hiding the remaining tasks.

The dashboard merges same-day execution-layer receipts with the current plan.
Successful overlays require authoritative evidence; Harvest remains a separate
read-only reconciliation source.
The synchronized `dashboard-runtime.json` contains only public receipt fields
and hashed account references with registered ownership; private migration files
and browser paths never leave the Windows runtime. The existing five-minute
shadow scheduler detects receipt, delivery and ownership changes and uploads this
bundle atomically before the snapshot. The read-only web process does not execute
check-ins; account workers may already be active independently of expansion gates.

Success receipts and verified successes are separate. Verified completion uses
verified successes divided by total tasks minus verified unavailable tasks. All
unverified success/unavailability claims remain visible, without authorizing retries.
History retains up to 400 recent public V2 receipts, rather than only 30.
Snapshot freshness also requires its Shanghai business date to be today; a newly
resynced previous-day legacy result does not become today's completion claim.

The sticky header is now compact by default: 64px on wide screens, 56px on
mobile without recent pages, or 92px with its shortcut row. Scrolling past 96px
reduces it to 48px; it expands again within 12px of the page top. A stable flow
slot and non-intercepting transparent area avoid scroll anchoring or blocked
content when it shrinks. Touch menu and refresh stay visible. Keyboard-focused
shortcuts remain reachable; reduced motion disables transitions.

The sidebar is the full directory. The top bar shows only home plus up to five
recently visited pages, horizontally scrollable on narrow screens. The
`fabricRecentViews` localStorage value contains allowlisted view names only,
never searches, task IDs, account IDs or tokens. Unavailable storage falls back
to memory. No empty shortcut row is displayed on a first visit.

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

The dashboard combines an operational execution view with Harvest history while
keeping browser control and check-in execution in the execution layer.

## Current features

- **Outcome-first overview:** separates successful, unavailable and unresolved
  check-ins. Completion rate excludes unavailable features; host health is not
  displayed as business success. The ring chart is derived from actual counts.
- **Attention and reconciliation:** shows unresolved items with evidence
  summaries, Harvest/PT reconciliation and a filtered task shortcut.
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
- **Calendar:** one latest redacted execution receipt per Shanghai business day,
  fetched independently from the last 30 run-audit entries. It retains up to
  180 recorded days, shows completed/unavailable/pending proportions and opens
  pending tasks first with filters for the other outcomes. An absent day stays
  empty; Harvest observations are not counted as execution receipts.
- **PT status:** status catalog for PT sites from the execution layer, Harvest,
  or another observer. It distinguishes regular PT tasks from sites in the
  separate PT-only fallback scope, with source-by-source status, freshness and
  discrepancies. After Harvest completion, unresolved in-scope sites may enter
  one execution-layer recheck; the panel itself never opens a browser. On phones,
  each site exposes its source and next action in a stacked row without
  horizontal table scrolling.
- **Sites:** per-site execution-unit progress, logical groups, and a bounded
  policy control (`monitor`, `review`, `pause`) with a short note and audit
  history. Pause suppresses immediate attention for 24 hours, 3 days, or 7
  days; it expires automatically, remains visible in the task ledger, and
  never changes the signed/failed status or pauses the V1 runner.
- **Accounts:** isolated account references and per-account task/status
  summaries. Verified site usernames and site user IDs may be shown to
  distinguish accounts; passwords, cookies, tokens, upstream login secrets and
  raw credential values are never shown. Site user IDs and upstream provider
  IDs (for example LinuxDO IDs) are separate identities.
- **Run history:** append-only shadow-ledger records, plan drift, status
  changes, task counts, and health state.
- **Settings:** explicit display of the execution/observation boundary, Harvest
  completion rule, recheck rule and available reminder controls.
- **Mobile access:** the navigation becomes an off-canvas drawer on narrow
  screens, with an overlay and Escape/close controls. The dashboard exchanges
  the administrator token for a signed HttpOnly session cookie; the default
  browser session is bounded to 12 hours, and explicit remember-me is bounded
  to 7 days. The administrator token is never kept in browser storage or in
  the cookie.

## Deliberately deferred

- Live browser control, credential editing, bookmark mutation and direct task
  execution are intentionally outside the web process. The panel does support
  manual reminder policy changes (`monitor`, `review`, `pause`) and audit notes;
  a real recheck still runs through the execution layer's existing site flow.
- Trend charts, duration/ROI analytics, and export jobs can be added after at
  least seven shadow runs establish stable history.
- New-site discovery/registration remains V2.1 and always requires human
  approval, adapter review, and a dry run.

## API surface

All `/api/*` routes require the dashboard token when the service is not
loopback-only. `GET /healthz` is a minimal unauthenticated container health
probe. Read APIs are `/api/summary`, `/api/calendar`, `/api/tasks`, `/api/pt-status`,
`/api/overview`,
`/api/sites`, `/api/accounts`, `/api/ledger`, `/api/controls`, `/api/config`,
and `/api/health`. The only mutation is `POST /api/controls/sites`; it
validates a credential-free origin and one of the three metadata policies,
limits the note to 240 characters, bounds pause duration, and writes an audit
entry. The paused attention state persists across browsers but does not change
the original V1 result or execution schedule.
Only `/api/*` requests consume the dashboard's per-client request budget;
static modules and styles remain available during repeated refreshes.
