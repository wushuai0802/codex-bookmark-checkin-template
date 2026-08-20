import json
import sqlite3
import sys


def host_matches(value: str, allowed_hosts: set[str]) -> bool:
    host = str(value or "").lstrip(".").lower()
    return any(host == allowed or host.endswith("." + allowed) for allowed in allowed_hosts)


if len(sys.argv) != 4:
    raise SystemExit("usage: Sync-ChromeSiteCookies.py <source> <target> <allowed-hosts-json>")

source_path, target_path, allowed_json = sys.argv[1:]
allowed_hosts = {str(value).lstrip(".").lower() for value in json.loads(allowed_json) if value}
if not allowed_hosts:
    print(json.dumps({"copied": 0, "origins": 0}))
    raise SystemExit(0)

source = sqlite3.connect(f"file:{source_path.replace(chr(92), '/')}?mode=ro", uri=True)
target = sqlite3.connect(target_path, timeout=30)
try:
    source_columns = [row[1] for row in source.execute("pragma table_info(cookies)")]
    target_columns = [row[1] for row in target.execute("pragma table_info(cookies)")]
    columns = [column for column in source_columns if column in target_columns]
    if "host_key" not in columns:
        raise RuntimeError("Chrome Cookies schema is incompatible")

    quoted = ",".join(f'"{column}"' for column in columns)
    source_rows = source.execute(f"select {quoted} from cookies").fetchall()
    host_index = columns.index("host_key")
    selected_rows = [row for row in source_rows if host_matches(row[host_index], allowed_hosts)]

    target.execute("begin immediate")
    existing = target.execute("select rowid, host_key from cookies").fetchall()
    delete_ids = [row[0] for row in existing if host_matches(row[1], allowed_hosts)]
    if delete_ids:
        target.executemany("delete from cookies where rowid = ?", [(value,) for value in delete_ids])

    placeholders = ",".join("?" for _ in columns)
    target.executemany(
        f"insert or replace into cookies ({quoted}) values ({placeholders})",
        selected_rows,
    )
    target.commit()
    print(json.dumps({"copied": len(selected_rows), "origins": len(allowed_hosts)}))
except Exception:
    target.rollback()
    raise
finally:
    target.close()
    source.close()
