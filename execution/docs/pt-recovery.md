# PT passive recovery

Use the bound existing account and Profile for every read. An uncertain prior
submission remains protected until a fresh authoritative account/day result
can be read; a transport or login failure supplies no negative daily proof.

PigGo uses its SPA `/calendar` page. The real page supplies fresh same-origin
`/v1/web/me` and `/v1/web/calendar` GET responses in the original isolated
Profile and proxy route; no token is exported or reconstructed. The numeric
site ID must match the existing expected-account configuration, never a
Harvest database user ID. Only today's exact selected/detail date and
`is_today: true` can yield `piggo_calendar_signed` (`checked`) or
`piggo_calendar_unsigned` (`today`) API evidence. Makeup, none and unknown
states remain unconfirmed. Historical intents remain intact. The usual fresh
unsigned-proof gate precedes a single real-button POST for today's date; only
a separate checked readback and durable finish establish completion. All old
PHP endpoints, other dates, automatic POST retries and unreviewed login or
CAPTCHA flows are blocked. Private opt-ins must migrate before use.

PigGo's supplied Vue login form has no method/action attributes, token-list
`autocomplete` values (optionally including `webauthn`) and a default submit
button. The form inspector accepts only the unique named username/password
pair and the unique visible “登录” submit button, with no other visible inputs,
iframe, CAPTCHA or OTP. The `u.needed.value` CAPTCHA branch and the separate
`c.value` OAuth account-completion form require manual handling. Invite-only
registration text and the non-submit passkey button grant no login capability.

`scripts/Diagnose-Piggo.mjs` defaults to help and never runs as part of the
scheduler. Only Claude's explicitly invoked `--run-anonymous-login` opens two
brand-new empty temporary Profiles to compare plugin assets blocked/allowed
under the same firewall; it reports request paths, failures and the actual
form inspection. No credentials are filled and no buttons are clicked.
Nested assets, the exact Rocket Loader path shape, plugin JS/CSS and root
images are permitted. External requests, telemetry POST, PHP and WebSockets
remain blocked. Telegram client, OAuth provider list, passkey options and
WS-ticket GETs stay blocked because the password form does not need them;
their effect on live page startup still needs anonymous verification.

First binding is manual: log in interactively in the dedicated, idle original
Profile, independently check the displayed account and numeric site ID, then
invoke `node scripts/Diagnose-Piggo.mjs --run-account-id --cdp-url <loopback-CDP-URL>`.
The diagnostic connects to that existing Chrome (it does not launch one),
opens a separate tab with service-worker bypass and an unarmed page firewall,
captures a fresh exact `/me` response from `/calendar`, closes the tab and
prints only the numeric candidate ID. It reads no vault/config/Profile files,
writes no binding, and supplies no check-in receipt. Claude and the user must
confirm the candidate against the independently checked account before manually
setting `oauthExpectedAccountIds`; a missing/invalid binding remains
`account_mismatch` in normal readers and submitters. Harvest IDs never bind an
account. `--runtime-root <dependency-root>` can resolve an existing Playwright
installation without reading that runtime's private configuration.

The native API reader recognizes a fresh, exact-origin redirect to login.php
as expired authentication. It does not follow that redirect or create an
attendance intent. A redirect after the attendance request preserves the
unknown submission and cannot cause an automatic retry.

Main Chrome's reviewed home-page read may reuse its existing browser route.
It does not change that route and remains limited to the approved passive
page. Write-capable callers still require the configured site proxy. Route
conflicts have a fixed public diagnostic instead of becoming missing evidence.

The fallback scheduler recognizes both ordinary daily-header readers and the
reviewed HDDolby account-header reader. HDDolby's negative proof must come
from log.php for the same bound account/day and be at most 30 seconds old.
The execution layer reads it again before a guarded supplement. Historical
uncertainty records are retained; an already-signed read ends recovery without
another submission.

Resolve built-in and private read policies through the established execution
reader before selecting a fallback engine. A native site's default policy
must retain its original engine and Profile without requiring another private
copy of that policy.

Current confirmed server/TLS faults also appear as site availability in the
regular task view and leave its success-rate denominator. The original task's
submission state and retry guards remain intact. Generic network failures do
not qualify for this exclusion.

If HDDolby's page connection fails, its configured passive reader can query a
validating public resolver through a separate anonymous request context. Only
an explicit DNSSEC failure for the exact configured domain becomes a site DNS
fault. This does not establish account/day status, change local DNS settings,
disable validation or authorize a submission. The shared site-fault contract
keeps PT classification and overview-rate exclusions consistent.
## Native recovery and explicit manual retries

The native HDDolby path keeps the parent's existing intent and account/Profile binding.
It reads, dispatches the mature site flow and reads back within one native browser
session. The original parent proof must have been fresh when that intent was created;
a new authenticated unsigned proof is published under the same owner before dispatch.
The mature submit guard therefore sees current evidence without relaxing its 30-second
HDDolby freshness rule. Native diagnostics carry only reviewed stages, error codes,
HTTP status and booleans, never page bodies, query strings or credentials.

Automatic daily budgets remain unchanged. An explicitly requested, single-site manual
retry carries its own durable request ID, performs another passive check and may use
the same guarded recovery path after the automatic budget is exhausted. One request
ID can create at most one attempt. Existing attempts are retained; current signed
evidence, identity differences, active intents and unreviewed readers still prevent
another submission. Dashboard retries use the queued operation ID. The CLI accepts
`--manual-recovery-id <UUID>` only with `--apply` and one `--only-origin`, in addition
to the existing fresh catalog/report hashes and live Harvest probe.
