# M2a: authenticated dry-run transport foundation

Implemented and tested 2026-09-08. This is an isolated **dry-run protocol**, NOT
a production executor or production transport deployment. V1 remains sole signer;
no browser/site adapter exists in this worker, not even behind an execute flag.
The existing NAS dashboard/volume/reverse proxy/schedule were not changed.

## Implemented

- Independent pre-provisioned worker credential digests and server-side origin
  allowlists. Dashboard cookies/tokens are not accepted for worker enrollment.
  Rotation/revocation currently takes effect on registry reload/server restart.
- Only POST `/v2/dry/claim` and `/v2/dry/receipt`. Payload/mode/receipt shape,
  owner, epoch, date, snapshot health, plan hash and allowlist are validated.
  Execute, arbitrary command fields, successful check-in receipts and unknown
  routes are rejected. JSON/request/response size and time bounds are enforced.
- Windows initiates requests. HTTPS is required except on explicit loopback;
  redirects are rejected to avoid leaking worker credentials. This prototype
  service binds loopback only, not a public unauthenticated worker port.
- Separate NAS and Windows SQLite WAL stores, synchronous FULL and immediate
  transactions. State paths reject V1 roots and symlink traversal. This is a
  separate experimental schema, not the dashboard database or V1 state.
- One active dry lease per worker, unique instance key. A lost claim response
  returns the same active lease. Expired/fenced jobs quarantine rather than
  automatically reassign. Increasing the epoch fences old active jobs; rollback
  to an old epoch is denied. This is a transport epoch, not a V1 ownership change.
- Worker intent is committed before the no-op phase. Interrupted prepared work
  requires review; complete no-op receipts stay in a local outbox until accepted.
  Lost acknowledgements retry the same receipt, never a new execution. Duplicates
  of an already accepted exact receipt can be acknowledged after lease expiry.
- Old `dry-run-worker.mjs` is retained as an offline harness; transport worker
  reuses existing candidate/lease contracts but adds durable network ownership.

## Files

- `src/transport-store.mjs`: excluded-path validation, SQLite schema/transactions.
- `src/dry-transport-server.mjs`: worker auth, scope, durable claims, receipt ACK.
- `src/dry-transport-worker.mjs`: outbound requests, envelope verification, journal.
- `tests/dry-transport.test.mjs`: socket integration and failure injection.
- `scripts/m2-nas-fixture.mjs`: temporary loopback NAS synthetic server.
- `scripts/m2-nas-client-smoke.mjs`: isolated end-to-end NAS/Windows test.

No automatic worker start, schedule, new permanent container, remote execution
adapter or Telegram sender is installed. Secrets are never generated into the
repository. Smoke credentials are random, memory-only, and die with the test.
Test databases contain only synthetic task envelopes/receipts, not browser state.

## Verified tests

Local TCP tests: authorization failure; execute/command injection refusal;
exact-origin scope; lost claim response; lost receipt ACK after commit; worker
and server restarts; abrupt child exit leaving WAL intent without closing DB;
prepared interruption; outbox offline/reconnect; concurrent requests; clock skew;
expired lease; epoch fencing/rollback; key revocation; stale/missing/conflicting
snapshot; monitor-only exclusion; client redirect policy and V1-state rejection.

Real NAS test used a temporary `--read-only` container with loopback binding,
isolated tmpfs database, no dashboard/V1 data mounted, no browser, and only a
synthetic `https://m2-fixture.invalid` task. Sequence:

`claim -> outbox_pending -> injected offline -> same receipt reported -> idle`

The NAS rejects SSH TCP forwarding (`administratively prohibited`). Its security
configuration was not changed. Acceptance used an authenticated SSH **exec relay**
to the loopback HTTP fixture instead, with request/credential only in stdin and
memory. This is not direct HTTPS transport verification and is not the intended
production worker route. Temporary containers were removed after each test.

## Remaining M2 production gates

M2a core is implemented; M2 as a production delivery stage is NOT yet complete.
Before deploying a persistent worker transport:

1. Choose a dedicated reverse-proxied HTTPS worker route and verify certificates,
   proxy behavior, auth isolation, limits and revocation on the real route.
   Do not relax SSH forwarding or reuse the dashboard administration credential.
2. Add explicit credential bootstrap/rotation, private local secret storage and
   independently permissioned server registry. Operator authorization is required
   before enrolling a persistent worker or changing reverse proxy/security config.
3. Database schema versioning/restore, retention, bounded metrics, rate limits,
   health and observability. No production queue growth/HA guarantee is claimed.
4. Process kill/reboot and disk-full/clock/network partition testing on the actual
   persistent deployment; current crash tests do not prove power-loss durability.
5. A recurring worker lifecycle and safe orphan-review workflow, only after
   explicit installation approval. No live-site credentials should be provisioned
   during this dry protocol stage.

M3 adapters, site identity/evidence production and V1/V2 execution ownership
transfer remain separate. A dry protocol receipt is never a successful sign-in.
