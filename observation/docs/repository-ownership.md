# Repository Ownership

This repository hosts the complete execution and observation source in sibling
packages. The private configured Windows execution runtime is not a Git checkout;
it must not be pushed wholesale, including ignored site/account configuration,
browser state and operational results.

Production architecture is observation layer -> execution layer -> redacted
snapshot/dashboard. The unified integration branch is based on the public
`main` history and imports the reviewed observation source as a package. Old
branch names remain for audit; do not merge private runtime files wholesale.

The original standalone `v2` history has no merge base with the public `main`
history. This integration is a reviewed source import, not a force merge or a
history rewrite. Keep the old branch as a rollback/audit reference until the
unified release and runtime cutover have been independently verified.

The public-template sync tool is report-only by default. Applying a reviewed
change requires `-Apply -IncludePaths` with exact managed file paths; it backs
up only those selections and refuses an active execution lock. This does not
resolve other private-runtime drift automatically. Review remaining differences
by file and never apply the full report as a batch.
