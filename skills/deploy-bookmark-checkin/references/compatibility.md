# Compatibility

Supported baseline:

- Windows 10 or 11, x64.
- Desktop Google Chrome for the isolated automation profile, with at least one readable `Bookmarks` or `AccountBookmarks` source.
- Desktop Microsoft Edge is optional; when selected, its `Bookmarks` or `AccountBookmarks` file is merged as an additional read-only target source.
- PowerShell 5.1 or newer; PowerShell 7 is preferred.
- Node.js 20 or newer and npm.
- A writable local project directory.
- The user remains signed in for the user-level scheduler fallback. Missed runs execute after the next same-day sign-in.

Treat missing Chrome, unreadable primary Chrome bookmarks, unsupported OS, or unavailable Node.js as blocking. Treat missing Edge, unavailable Windows Task Scheduler registration, and absent notification integration as optional: omit Edge bookmarks, offer the hidden user-scheduler fallback, or use no notification.

Do not silently install packages or change execution policy. Prefer a project-local npm install. Do not upload bookmark/profile data for diagnosis.
