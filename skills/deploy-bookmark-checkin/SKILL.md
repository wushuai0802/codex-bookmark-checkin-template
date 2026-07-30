---
name: deploy-bookmark-checkin
description: Deploy, repair, migrate, or validate a private Windows Chrome bookmark daily check-in automation. Use when Codex must inspect compatibility, collect a structured setup questionnaire, configure bookmark folders and login recovery, adapt public or unknown check-in sites, install hidden scheduling, and verify end-to-end results without exposing credentials.
---

# Deploy bookmark check-in

Use the repository root that contains this skill. Keep every user-specific value in ignored local files.

## Workflow

1. Run `scripts/Test-Environment.ps1` without changing the machine.
2. Classify findings as blocking, optional, or ready. Explain each missing capability and its effect. Ask the user to choose whether to install, skip, or use the documented fallback before changing the environment.
3. Read [questionnaire.md](references/questionnaire.md). Before any other setup preference, ask which Chrome profile, which parent/container bookmark folders, and which child folders contain the targets. Use folder candidates from preflight; never assume names from defaults, examples, or another user. Ask only unanswered questions, at most three at a time.
4. Re-run `scripts/Test-Environment.ps1` with `-ContainerFolderNames` and `-TargetFolderNames`. Resolve an empty or ambiguous match before continuing.
5. Copy `setup/answers.example.json` to ignored `setup/answers.json` and record the confirmed non-secret answers. Run `scripts/Initialize-Checkin.ps1`.
6. Run the bookmark dry run. Show every matched source, deduplicated site count, and any ambiguous profile selection before browsing sites.
7. Initialize the isolated Chrome profile. Keep the browser visible only for the initial user-approved login pass; scheduled runs must use the configured off-screen mode.
8. Run one complete check-in without notification. For every unresolved site, first retry and inspect stable page evidence. Use built-in public rules, then generic discovery, then a local adapter. Write local rules only to ignored config files.
9. Require authoritative success evidence. A click, redirect, empty error, or window title is insufficient.
10. Read [acceptance.md](references/acceptance.md), run all acceptance checks, then install scheduling. Use the Windows task when permitted; otherwise use the user-level hidden scheduler only if the user accepted the fallback.
11. After scheduling is live, run `npm run --silent health`. Require exit code `0`, `healthy=true`, and an empty `failedChecks` array. Treat the JSON as local diagnostic data; never publish it without removing paths and user-specific site information.
12. Run `scripts/Scan-PublicSafety.ps1`. Report installed mode, schedule, site totals, unresolved sites, notification behavior, health-check result, and recovery instructions.

Read [compatibility.md](references/compatibility.md) when preflight is not fully ready. Read [site-adapters.md](references/site-adapters.md) when adding or reviewing site rules.
