import json
import sqlite3
import sys
from urllib.parse import urlparse


def host_matches(value: str, allowed_hosts: set[str]) -> bool:
    try:
        host = (urlparse(value).hostname or "").lower()
    except Exception:
        return False
    return any(host == allowed or host.endswith("." + allowed) for allowed in allowed_hosts)


if len(sys.argv) != 4:
    raise SystemExit("usage: Sync-ChromeSavedLogins.py <source> <target> <allowed-hosts-json>")

source_path, target_path, allowed_json = sys.argv[1:]
allowed_hosts = {str(value).lower() for value in json.loads(allowed_json) if value}
if not allowed_hosts:
    print(json.dumps({"copied": 0, "origins": 0}))
    raise SystemExit(0)

source = sqlite3.connect(
    "file:" + source_path.replace("\\", "/") + "?mode=ro&immutable=1",
    uri=True,
)
target = sqlite3.connect(target_path, timeout=10)
try:
    source_columns = [row[1] for row in source.execute("pragma table_info(logins)")]
    target_columns = [row[1] for row in target.execute("pragma table_info(logins)")]
    columns = [column for column in source_columns if column in target_columns and column != "id"]
    if not columns:
        raise RuntimeError("Chrome Login Data schema is incompatible")

    source_rows = source.execute(
        "select " + ",".join(f'\"{column}\"' for column in columns) + " from logins"
    ).fetchall()
    origin_index = columns.index("origin_url")
    realm_index = columns.index("signon_realm")
    selected_rows = [
        row for row in source_rows
        if host_matches(str(row[origin_index]), allowed_hosts)
        or host_matches(str(row[realm_index]), allowed_hosts)
    ]
    populated_hosts = {
        allowed
        for row in selected_rows
        for allowed in allowed_hosts
        if host_matches(str(row[origin_index]), {allowed})
        or host_matches(str(row[realm_index]), {allowed})
    }

    target.execute("begin immediate")
    existing = target.execute("select id, origin_url, signon_realm from logins").fetchall()
    delete_ids = [
        row[0] for row in existing
        if host_matches(str(row[1]), populated_hosts) or host_matches(str(row[2]), populated_hosts)
    ]
    if delete_ids:
        target.executemany("delete from logins where id = ?", [(value,) for value in delete_ids])

    placeholders = ",".join("?" for _ in columns)
    insert_sql = (
        "insert into logins ("
        + ",".join(f'\"{column}\"' for column in columns)
        + ") values ("
        + placeholders
        + ")"
    )
    target.executemany(insert_sql, selected_rows)
    target.commit()
    print(json.dumps({"copied": len(selected_rows), "origins": len(allowed_hosts), "populated_origins": len(populated_hosts)}))
except Exception:
    target.rollback()
    raise
finally:
    target.close()
    source.close()
