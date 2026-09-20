# Site adapters

Keep public rules in `config/site-rules.public.json` and private rules in ignored `config/config.local.json`.

A rule may define related candidate URLs, logical duplicate groups, visit-after-time behavior, native WAF preflight URLs, OAuth redirects, and confirmed no-feature origins. Navigation must remain within the bookmark origin or explicitly allowed related origins.

Use `newApiSignInRules` for New API variants that expose a real `POST /api/user/sign_in` endpoint. Keep every configured endpoint on the same HTTPS origin, obtain `New-Api-User` only from named browser-storage keys, and confirm completion from an explicit reward response, the normalized quota change, or an exact same-day reward log. `emptySuccessMeansAlreadySigned` must remain off unless that exact site's authenticated endpoint contract has been verified; when enabled, it additionally requires HTTP 200, `success=true`, an empty message, and a measured zero quota change.

Before adding a public rule:

1. Remove usernames, email addresses, balances, account IDs, invite codes, tokens, query secrets, screenshots, and history excerpts.
2. Prove the rule from stable public structure or a successful local page signal.
3. Add a detector or routing test.
4. Do not cache an answer until the site confirms it was correct.
5. Do not mark a feature unavailable solely because no button was found; prefer an authoritative API or settings flag.
