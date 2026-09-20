# Repository instructions for Codex

Use the bundled `skills/deploy-bookmark-checkin/SKILL.md` for setup, repair, migration, or acceptance work.

Always run `scripts/Test-Environment.ps1` before modifying the machine. Treat it as read-only evidence. If a blocking or optional capability is missing, explain the impact and offer explicit choices; do not install software, change Chrome settings, create scheduled tasks, or enable a notifier until the user chooses.

The first setup question after environment blockers is bookmark scope: which Chrome profile, which parent/container bookmark folder names, and which child folders contain the daily targets. Never assume names from examples or from another user. Re-run `Test-Environment.ps1` with the confirmed scope before generating configuration.

Never request or persist plaintext passwords, cookies, session tokens, passkeys, PINs, recovery codes, Telegram tokens, or OAuth tokens. Reuse Chrome's encrypted saved-login state, interactive login, environment variables, or an OS-backed secret manager. Do not include private values in logs, screenshots, results, issues, commits, or chat summaries.

Keep user-specific origins and rules in ignored files (`config/config.local.json` and `config/qa-rules.local.json`). Add a rule to `config/site-rules.public.json` only after removing personal data and receiving the user's explicit intent to contribute it publicly.

Do not declare success from a click, navigation, window title, or lack of an error. Require page text, an authoritative endpoint, or another stable site signal that confirms `signed` or `already_signed`. Run a full acceptance pass before installing the daily schedule.
