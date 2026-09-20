# V2 controller with V1 execution engine

The selected production boundary is now `executionEngine: v1`.

V2 owns the entry point, one run lease, redacted status publication and
dashboard projection. V1 remains the only browser/check-in implementation. It
continues to read its compiled `config/config.json`, encrypted saved-login
state, dedicated site/account profiles, site adapters, retry policy and
authoritative result contracts. V2 no longer starts its independent canary
adapters in this mode.

The gateway is `scripts/run-v1-engine.mjs`. Scheduled V2 calls it with
`--scheduled`; targeted calls use `--execute`, `--account-key` or `--origin`.
The child receives a random V2 lease nonce and the V1 wrapper validates the
same root, nonce and live owner before continuing. V1's own mutex and
`tmp/run.lock` still guard the actual browser run. A child cannot invoke the
gateway recursively because it inherits the lease and is allowed through only
after validation.

After V1 writes its current final report, V2 imports it through the read-only
bridge, writes `outputs/engine-daily-YYYY-MM-DD.json`, and clears stale V2
canary overlay data from the dashboard runtime. V1 browser state, credentials,
site configuration and scheduler cadence remain in place.

Before changing a live integration, back up its gateway binding and runtime
configuration outside the repository.

Validation completed: V2 316 tests, V1 414 tests, JavaScript syntax, module
structure, PowerShell parsing and scheduled-task inspection. The gateway also
completed a real 22-task acceptance run (14 complete, two unavailable, six
unresolved); five AgentRouter accounts were verified by V1 reward logs.

Maintenance update: explicit `disabledCheckinOrigins` and
`disabledAccountKeys` remain in force. Only retired V2 handoff markers are
ignored. Old V2 ownership/profile/notification write commands reject unified
mode; the former V2 Canary scheduler hook lives in V1
`scripts/compat/StandaloneV2Canary.ps1` and is loaded only during rollback.
A scheduled probe with no new V1 final result leaves the previous V2 snapshot
and report untouched. Neither manual nor scheduled runs claim business
completion merely because the process returned zero.

Harvest integration (2026-09-20): a current, explicit failure for a unique
registered PT site can queue one targeted V1 recovery pass through the same
V2 controller. Successful Harvest entries remain read-only status, and
an unknown entry may queue one V1 recheck only after Harvest finishes its
daily task and the PT site is already uniquely registered. Harvest-only entries
remain unregistered observations. Harvest's
database user ID cannot be used as a PT site account ID; the V1 browser
checks its own identity and status before any submission. No new scheduled
task or duplicate V2 site adapter was installed. See [pt-status.md](pt-status.md).
Each actual V1 final-report import now runs the existing read-only V1 health
check and uses that structured output for the V2 snapshot. If the check
cannot return a valid result, the bridge keeps the cached source marked stale
instead of manufacturing a healthy timestamp.

2026-09-20 consolidation acceptance: explicit disabled-site/account settings
were regression-tested in unified mode. An alternate `ConfigPath` can no
longer execute outside the gateway; only a quiet isolated dry run is exempt.
A scheduled trigger colliding with an active V2 run now exits as a documented
skip, while manual execution remains exclusive. Historical V2 migration,
handoff, profile and notification write entrypoints reject unified mode;
the compatibility Canary hook is loaded only when the standalone engine is
explicitly selected. Old profile directories, migration records, journals and
receipts were preserved for audit and rollback, not erased.

The official manual acceptance generated a fresh V1 22/22 final report that
V2 imported under the same run ID: 14 complete, two unavailable and six
unresolved. Bounded follow-up probes identified four accounts needing login
recovery (one also has a CAPTCHA), one inaccessible upstream and one
submission with unknown outcome; none were relabelled as success. V1 health
and public-safety checks passed, both locks released, and the existing
Windows scheduled task was manually triggered without changing its schedule
and returned code zero. The next scheduled run is still needed to establish
multi-day reliability.
