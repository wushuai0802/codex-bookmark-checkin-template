# V2 execution adapters

The V2 worker has one contract for every site:

\`identity -> read_status -> submit_once -> verify\`

The coordinator owns the lease, durable intent, retry budget, and
\`submission_unknown\` state. An adapter may not replay a mutating request or
fall back to the user's normal Chrome profile.

## Implemented families

| Adapter | Use | Success evidence |
| --- | --- | --- |
| \`new-api.execute.v1\` | Standard New API calendar sites | current-day, account-bound calendar record |
| \`new-api-captcha.execute.v1\` | New API sites with an ordinary image CAPTCHA | CAPTCHA submission followed by current-day calendar readback |
| \`oauth-reward.execute.v1\` | AgentRouter-style relogin rewards | current-day typed reward log and account ID |
| \`oauth-api.execute.v1\` | OAuth status/action APIs such as x666 | current-day status record and account ID |
| \`pt-native.execute.v1\` | NexusPHP/PT attendance pages | current-day page signal and account ID |
| \`anyrouter.execute.v1\` | AnyRouter dynamic DNS/SNI route | current-day status or typed reward log |
| \`vibe-entitlement.execute.v1\` | Vibe entitlement pages | dated claim evidence; an active entitlement alone is not a daily sign-in |

All adapters reject cross-origin redirects, ambiguous identities, and
unbounded response bodies. Complex hCaptcha, Turnstile, and 2FA remain
human-required; there is no stealth or challenge bypass.

## CAPTCHA solver boundary

The worker accepts a solver function only through the task context or the
explicit \`captchaSolver\` option. The image is passed in memory and candidates
are normalized to a bounded alphabet. Without a solver the result is
\`captcha_solver_not_configured\`; no empty answer is submitted.

For a local offline solver, install the optional Python requirements and expose
an absolute executable path:

\`\`\`powershell
python -m pip install -r requirements-ocr.txt
$env:CHECKIN_CAPTCHA_SOLVER_COMMAND = 'C:\Path\to\python.exe'
$env:CHECKIN_CAPTCHA_SOLVER_ARGS_JSON = '["D:\\AIWorkspace\\projects\\codex-checkin-fabric-v2\\scripts\\captcha-solver.py","--length","5"]'
\`\`\`

\`run-v2-canary.mjs\` and \`run-v2-daily.mjs\` read these two environment variables.
The command is started without a shell, receives the image on stdin, and may
return only a code or JSON containing \`code\`/\`candidates\`. OCR confidence
never proves a sign-in; the adapter must still verify the site's authoritative
state.

An external OCR provider can be supplied as a function by an operator-side
worker. Credentials for that provider stay outside the repository and outside
task envelopes. A second opinion can only select a code already present in the
primary solver's candidate list.

## Site mapping

\`src/v1-adapter-catalog.mjs\` classifies related service origins separately from
bookmark origins. In particular, \`x666.me\` maps to the allowlisted
\`up.x666.me\` API, and configured \`/attendance.php\` targets map to the PT
adapter. \`src/execution-adapter-registry.mjs\` is the only factory boundary.
Unknown generic-discovery sites stay blocked until a reviewed adapter and
fixtures are added.

