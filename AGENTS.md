# Check-in Fabric

This repository contains one check-in system with two packages:

- `execution/` holds site rules, browser profiles and authoritative check-in execution.
- `observation/` owns the lease, Harvest reconciliation, redacted reports and dashboard.

Keep credentials, Chrome profiles, runtime configuration and raw results out of Git.
Never infer a PT site's account binding from Harvest's database user ID. A
dashboard action must not directly submit a site check-in. Read the package's
own `AGENTS.md` before changing its source; run both packages' tests and the
root public-safety scan before publication.
