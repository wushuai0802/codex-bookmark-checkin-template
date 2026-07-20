# Setup questionnaire

Ask at most three questions per turn and skip answers already available from preflight.

1. Environment decision: approve installing each missing required component; approve or reject the user-scheduler fallback.
2. Bookmark scope, before every other preference: profile name or Auto; parent/container folder name or names; target child-folder name or names. Offer candidates found by preflight, but do not preselect or infer names.
3. Runtime: daily time; missed-run behavior; built-in public rules; saved-login sync; Linux DO OAuth discovery.
4. Challenges: allow image OCR; allow managed challenge wait/click; allow limited public search for fixed-choice questions; safe message text.
5. Notification: none or a local executable with argument placeholders. Secrets must come from environment variables or an OS-backed secret store.

Do not ask for passwords, cookies, tokens, PINs, passkeys, or recovery codes in chat. If login is needed, open the isolated Chrome profile visibly and let the user complete it, or reuse Chrome's encrypted saved-login database with their approval.
