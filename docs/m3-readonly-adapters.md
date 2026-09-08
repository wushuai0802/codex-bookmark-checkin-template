# M3a read-only adapters and live acceptance (2026-09-08)

Implemented: four capability-limited observer families: standard New API calendar,
reward usage log, LinuxDO wheel record, and current Vibe entitlement. Their API
surface exports capabilities, request validation and observation only. There is no
submit/relogin/register/captcha method and they are not connected to dry-worker
dispatch. Permanent M2 worker remains dry.noop.v1 with zero site actions.

The operator-side one-shot runner uses V1's effective config resolver and dedicated
profiles, checks the real V1 `tmp/run.lock` before opening each profile/task, and
closes contexts serially. Chromium's profile lock protects concurrently opened
profiles; this is not a shared distributed V1/V2 execution mutex. V1 owns execution.
The runner blocks all browser requests except same-origin GET robots.txt and the
family's exact read endpoints. Login, redirects and mutating requests are not
followed. Identity mismatch stops before business probing. No normal Chrome window
is moved, closed or reused and no interactive challenge is solved.

Evidence reducers return only allowlisted identity/day/cause fields. New API needs
a matching identity, today flag and dated/account-consistent calendar record. A
reward log needs expected event text/type/amount/day and identity. Wheel uses its
actual spin_date and account ID, not can_spin=false. Vibe is entitlement_active
when currently valid, not a claim that a daily check-in just occurred.

## Live outcome

23 planned account tasks accounted for, 16 actually probed, 30 adapter GET calls:
11 signed observations, 2 feature-disabled, 1 active entitlement, 2 blocked live
probes and 7 skipped. All 5 multi-account reward accounts and both two-account
calendar accounts passed the read-only identity/day check. The blocked live paths
were an access challenge and unavailable standard route; no login recovery ran.
Skipped: 5 PT native adapters not enabled for this phase and 2 missing expected
identities. These are M3 coverage gaps, not new V1 check-in failures.

Adapter durations exclude browser startup: 16 values, median about 609 ms and
nearest-rank P95 about 1849 ms in this one session. These are not a full execution
baseline, SLA or first-attempt success rate. No submission latency was measured.

Detailed private reports are external to the repository. A separate sanitized
adapter-observations.json can be displayed in dashboard settings; it never merges
into V1 results, execution leases, retry queues or success counters. The page shows
the observation timestamp; periodic shadow sync does not rerun these browser probes.

## Additional repair and hardening

Fixed a post-M1 regression where reconciled site-default keys prevented single
Harvest profile metadata from enriching the PT display identity. Regression tests
cover the explicit default key. Online self probes can refresh identity metadata,
including replacing a cached display ID with independently verified self data;
this does not change the execution identity or V1 config.
Added database-write-refusal injection: a read-only SQLite transaction returns
unavailable without recording a phantom lease, then recovers normally. This is a
write-failure simulation, not actual disk-full/power-loss validation.

## Gates not passed

M3a is not completion of all M3 families. PT native isolated read-only proof,
the special route adapter, challenge-gated account and migrated/maintenance sites
remain outstanding. Actual submit-once adapters and canary ownership transfer
must not be enabled by this read-only report. Seven-day shadow gate remains 3/7;
14-day execution trial has not started. Real reboot/power-loss tests require a
safe agreed maintenance window, not surprise reboot of the user's PC/NAS.

Next safe work: offline adapters/fixtures for remaining families, source discovery
when maintenance ends, bounded route diagnostics, and operator review of protected
login. Do not turn unknown into failed or automatically submit to 'prove' success.
