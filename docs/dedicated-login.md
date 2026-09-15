# Dedicated V2 login

The manual login entry point opens native Chrome with the account's registered
V2 directory, positive window coordinates and no debugging flags. It does not
copy V1 state, use ordinary Chrome, automate authentication or perform check-in.

```powershell
node scripts/open-v2-login.mjs ACCOUNT_KEY --check
node scripts/open-v2-login.mjs ACCOUNT_KEY --visible
```

`--check` validates configuration and paths without opening a browser. Opening
requires explicit `--visible`. The registry must contain exactly one account;
unknown accounts, a different profile path, missing files or redirected profile
paths are refused. The executable comes from existing runtime configuration.

The launcher holds the existing V2 execution lock while its Chrome process runs.
An active worker prevents opening; an open login window prevents automatic V2
execution. Use outside the daily execution window and close promptly after login.
It does not stop or change V1 tasks. Do not interrupt the launcher while the
browser is open. A process-start message is not proof of a visible window or a
successful login. If Chrome hands off to an already-open instance and exits,
close that dedicated instance before retrying. Never close all ordinary Chrome.

After manually logging in and closing the dedicated browser, use the existing
profile verification command to verify the expected site ID. Only authoritative
execution evidence permits later ownership transfer. This launcher does not
promote an account to ready or migrated.

Host tool permissions are separate from project functionality. A host-denied
launch must be reported, not retried through a disguised command or alternate
helper. Unit tests use injected fake processes; `--check` alone is not a live
window acceptance test.
