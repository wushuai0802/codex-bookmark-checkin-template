# NAS dashboard deployment

This is a deployment guide, not an automatic deployment. The dashboard is
read-only with respect to check-in execution; it serves snapshots and a
small, audited V2 control state. The Windows runner remains the only executor.

## Prepare data and secret

First create a clean deployment bundle locally:

```powershell
npm run export:nas -- --out outputs\\nas-bundle
```

On the NAS, create a dedicated application directory and copy only the
contents of `outputs/nas-bundle/`:

- `Dockerfile`
- `compose.nas.yaml`
- `compose.worker.yaml` (optional transport overlay; execution remains disabled
  unless separately configured and authorized)
- `package.json`
- `package-lock.json`
- `src/`
- `public/`

Create `nas-data/` with the latest redacted `shadow-beta-snapshot.json` and
`shadow-ledger.jsonl`. The snapshot may include the optional `ptStatus` catalog
from a Harvest or other read-only observer. Do not copy the old project's `data/credentials`, Chrome
profiles, cookies, tokens, screenshots, or full logs. Create
`secrets/fabric_admin_token.txt` with a random 32+ character value and protect
it with NAS filesystem permissions. The container runs as the unprivileged
`node` user (UID 1000 in the image), so ensure the mounted `nas-data/` is
writable by that user; the application needs write access only for
`control-state.json`.

The browser submits the administrator token once to create a signed HttpOnly,
SameSite=Strict session cookie. With `FABRIC_TRUST_PROXY_TLS=1`, the cookie is
also Secure. The administrator token is not persisted in browser storage or
copied into the cookie. A normal browser session is internally bounded to 12
hours; remember-me is bounded to 7 days.

For the configured NAS host, use `scripts/deploy-nas-code.ps1` after reviewing
the generated bundle. It uploads a tar stream over SSH because the NAS SCP
subsystem is unavailable, creates a dated code backup, rebuilds the dashboard,
and waits for a healthy container. It never replaces `nas-data/`, `secrets/`,
or transport state.

The script keeps the existing dry transport overlay enabled by default and
preflights `transport-config/worker-registry.json` plus `transport-data/`.
For a dashboard-only deployment, pass `-UseWorkerTransport:$false`; this does
not delete an existing overlay or transport data.

## Start

```sh
docker compose -f compose.nas.yaml up -d --build
docker compose -f compose.nas.yaml ps
docker inspect --format '{{json .State.Health}}' checkin-fabric-dashboard
```

The container binds only to NAS loopback (`127.0.0.1:8787`). Your reverse
proxy should be the only externally reachable entry point, terminate HTTPS,
forward `Host` and `X-Forwarded-Proto`, and require your normal access control
in addition to the dashboard token. Do not expose port 8787 directly or remove
the token secret.

## Reverse proxy contract

- Recommended public hostname for this deployment: `wsfabric.ugnas.cc`.
- Upstream: `http://127.0.0.1:8787`
- WebSocket upgrade is not needed for this beta.
- Preserve `X-Fabric-Token` or `Authorization: Bearer …` if your proxy does
  not already authenticate the user.
- Use HTTPS and a restricted hostname; do not enable wildcard CORS.
- Restrict request methods to GET/HEAD/POST and rate-limit the proxy.

## Refreshing snapshots

The Windows operations wrapper should first run V1's read-only health command,
pass its JSON through `--health-file`, and then copy only the generated
redacted snapshot and ledger into NAS `nas-data/`. Trigger a refresh when the
final V1 report changes and keep a fixed daily refresh as a fallback. The
dashboard does not poll Windows, launch Chrome, or send Telegram notifications.
A stale snapshot is shown as stale in the UI.

## Rollback

`docker compose -f compose.nas.yaml down` stops only this dashboard. Removing
the V2 container or `nas-data/control-state.json` does not alter the legacy
runner or its browser profiles.
