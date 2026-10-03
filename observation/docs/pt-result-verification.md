# PT result verification

The unified executor keeps a submitted action distinct from a confirmed daily result. A successful read may reconcile an earlier unknown action; it never requires replaying that action. Site data, profiles and account identifiers remain private.

## BurnBao

Use the registered site's HTTPS `/index.php` in its existing main Chrome profile. Read only the web document, not the browser toolbar. If a minimized task window withholds its document, restore that task-created window without activating or modifying the user's other windows.

Completion requires a logged-in account header with one daily control showing `已签到` or `签到已得<amount>` (with the optional supplementary-card count). Do not accept a public forum message, a historical total, a login page, a challenge page, another origin, or simultaneous signed/unsigned controls.

Non-completion requires the same authenticated header to show exactly one reviewed `签到` or `签到得魔力` link and no successful daily signal. Its receipt must match the configured profile/account, current Shanghai business day and passive-read mode. A fresh unsigned read after the unknown action permits one guarded recovery; a new success read stops it. A missing control is unknown, not not-signed.

Mutation remains behind the live Harvest gate, controller lease and execution locks. Persist intent before navigation/click and never automatically replay an uncertain invocation. Recheck the resulting authoritative daily state. Maintenance announcements explain unavailability but cannot confirm account completion.

## HDDolby

Read the current authenticated account header on `/index.php`, then the same account's header on its linked `/log.php`. Only perform those exact same-origin GETs without following redirects. Parse inert HTML; do not execute page scripts or submit a form.

Both headers must resolve one identical current-user reference. Each HTTP response must be 200 with a current Shanghai-day Date within five minutes of the check. The header must contain one current `签到已得<amount>` reward field, without historical/cumulative wording or an unsigned control. Public log entries and rewards belonging to another user never prove this account's completion. The page may deny access to site logs while its authenticated header remains available; the header, not the access-error body, is the evidence.

The dated passive receipt retains its exact profile/account binding and `/log.php` provenance. Append reconciliation to an earlier unknown attempt; preserve the original audit. A `/take2fa.php` redirect is not success and is never revisited as a read. Use the passive header to resolve completion; otherwise retain the two-factor diagnosis and the no-replay protection.

## Success-rate attribution

Confirmed site maintenance, site TLS faults, explicit server faults, rate limiting and diagnosed upstream service faults are excluded from the project's executable-task denominator. They remain visible as waiting for site recovery, and no success is fabricated. Login loss, account mismatch, local transport failures, Harvest coordination waits and missing/ambiguous evidence remain in the denominator. Incomplete task inventories cannot authorize an exclusion. The headline distinguishes completed project work from remaining site recovery.

The project cannot guarantee site availability, persistent upstream login sessions or unannounced site changes. Changes to these rules require tests for current-day identity, conflicting controls, dated proof, passive network boundaries and unknown-action reconciliation.
