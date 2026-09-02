# NAS secret setup

Create `fabric_admin_token.txt` on the NAS deployment host, containing a
random token of at least 32 characters. Do not commit it or paste it into
chat. The Compose file mounts this file as a Docker secret and the dashboard
accepts it through `X-Fabric-Token` or `Authorization: Bearer ...`.
