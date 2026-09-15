# V1 capability to V2 adapter mapping

V2 consumes only the redacted catalog_only output from V1. It never imports
V1 browser code, credentials, cookies, profile state, retry loops, or
notification commands. The execution factory is selected again from the
normalized origin and reviewed family, so a stale or misclassified V1 family
cannot silently broaden the target.

| V1 family or origin rule | V2 adapter | Current boundary |
| --- | --- | --- |
| new-api-calendar.v1 | new-api.execute.v1 | dated calendar GET, one guarded POST, dated readback |
| jianzhile.vip image CAPTCHA | new-api-captcha.execute.v1 | one fresh challenge per answer, injected OCR only |
| oauth-reward-log.v1 | oauth-reward.execute.v1 | explicit OAuth relogin, typed reward log and account ID |
| oauth-status.v1 / x666.me | oauth-api.execute.v1 | allowlisted up.x666.me service, dated status/action |
| native-pt.v1 | pt-native.execute.v1 | reviewed same-origin attendance page and account/date evidence |
| anyrouter.top | anyrouter.execute.v1 | DNS/SNI/ESA route probe, account-bound status/log |
| new.sharedchat.cc | vibe-entitlement.execute.v1 | dated claim evidence; active entitlement is not a daily success |
| ai.venlacy.com, api.42w.shop, muyuan.do | new-api.execute.v1 | explicit site override for their known New API flow; a disabled feature remains not-available |
| known no-check-in generic sites | none | remain blocked/not-available until a reviewed capability exists |

All execution adapters are implemented in code but remain canaryReady=false
until their own identity fixtures, read-only probe, mutation proof, and
rollback test pass. A factory being constructible is not permission to migrate
an account. The coordinator still requires a fresh profile, an exact service
ID, a drained V1 owner, a durable intent, and an authoritative same-day
verification.

## CAPTCHA

Ordinary image CAPTCHA uses the explicit solver boundary in
src/captcha-solver.mjs. The default is fail-closed when no solver is
configured. hCaptcha, Turnstile, and 2FA are reported as human-required; V2
does not attempt stealth or challenge bypass.
