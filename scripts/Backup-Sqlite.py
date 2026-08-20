import sqlite3
import sys
from pathlib import Path


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: Backup-Sqlite.py SOURCE DESTINATION", file=sys.stderr)
        return 2

    source = Path(sys.argv[1]).resolve(strict=True)
    destination = Path(sys.argv[2]).resolve(strict=False)
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        destination.unlink()

    source_uri = f"{source.as_uri()}?mode=ro"
    with sqlite3.connect(source_uri, uri=True, timeout=30) as source_db:
        with sqlite3.connect(destination, timeout=30) as destination_db:
            source_db.backup(destination_db)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
