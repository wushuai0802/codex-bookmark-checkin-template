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
- `package.json`
- `package-lock.json`
- `src/`
- `public/`

Create `nas-data/` with the latest redacted `shadow-beta-snapshot.json` and
`shadow-ledger.jsonl`. Do not copy the old project's `data/credentials`, Chrome
profiles, cookies, tokens, screenshots, or full logs. Create
`secrets/fabric_admin_token.txt` with a random 32+ character value and protect
it with NAS filesystem permissions. The container runs as the unprivileged
`node` user (UID 1000 in the image), so ensure the mounted `nas-data/` is
writable by that user; the application needs write access only for
`control-state.json`.

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

- Upstream: `http://127.0.0.1:8787`
- WebSocket upgrade is not needed for this beta.
- Preserve `X-Fabric-Token` or `Authorization: Bearer …` if your proxy does
  not already authenticate the user.
- Use HTTPS and a restricted hostname; do not enable wildcard CORS.
- Restrict request methods to GET/HEAD/POST and rate-limit the proxy.

## Refreshing snapshots

Run the existing Windows shadow command, then copy the generated redacted
snapshot and ledger into NAS `nas-data/` using your approved file-sync path.
This dashboard does not poll Windows, launch Chrome, or send Telegram
notifications. A stale snapshot is shown as stale in the UI.

## Rollback

`docker compose -f compose.nas.yaml down` stops only this dashboard. Removing
the V2 container or `nas-data/control-state.json` does not alter the legacy
runner or its browser profiles.
