# Security policy

Do not submit issues, logs, screenshots, bookmark exports, Chrome profile files, cookies, passwords, PINs, tokens, balances, usernames, email addresses, or private site URLs to this repository.

Security reports should describe the code path and impact with synthetic examples. Before publishing a branch, run:

```powershell
pwsh -NoProfile -File .\scripts\Scan-PublicSafety.ps1
npm audit --omit=dev
```

The automation profile and generated configuration are local credentials. Back them up only to encrypted storage and never commit them.
