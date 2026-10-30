# Gateway health records

The PowerShell gateway records unsuccessful controller exits and local
pre-dispatch/lease exceptions in `data/gateway-events.jsonl`. Each record has
only `schemaVersion`, UTC `time`, a fixed `stage`, a fixed `errorCode`, and
`exitCode`. Controller stderr is interpreted only through a small structured
error allowlist; raw messages, arguments, URLs, Profile paths and configuration
contents are not persisted in these records.

Each file holds at most 256 records; `.1`, `.2` and `.3` are the retained older
files. Rotation is serialized by a separate diagnostic mutex, which never
grants or replaces an execution lease. Diagnostics cannot authorize replay or
change the original gateway exit code.
