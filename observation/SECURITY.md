# Security model

V2 separates the NAS control plane from the Windows execution plane. Windows
polls the control plane in the planned design; the alpha bridge does not open a
listener and does not execute work.

## Data classification

The shared contract contains only origins, logical site keys, stable internal
account keys, statuses, timestamps, counts, and short evidence summaries.
Credentials and browser state never cross the bridge. `accountId` and account
labels are removed from receipts; the stable `accountKey` is retained so that
multi-account tasks cannot collide.

## Future worker requirements

Any worker implementation must use authenticated, mutually identified leases,
an explicit allowlist of origins, isolated browser profiles, bounded retries,
and a kill switch. It must not listen on `0.0.0.0`, accept wildcard CORS, run
arbitrary JavaScript, or accept arbitrary profile paths.

## Dashboard deployment

The dashboard binds to loopback in the supplied Compose file and is intended to
sit behind the NAS reverse proxy. Non-loopback binding requires
`FABRIC_ADMIN_TOKEN` or a Docker secret file. API access uses a constant-time
token comparison, a bounded request body, a per-client rate limit, and no
CORS. `GET /healthz` is intentionally minimal and suitable only for a
container health probe; it does not expose task data.
