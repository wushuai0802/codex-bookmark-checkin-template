# Repository Ownership

This repository hosts the complete execution and observation source in sibling
packages. The private configured Windows execution runtime is not a Git checkout;
it must not be pushed wholesale, including ignored site/account configuration,
browser state and operational results.

Production architecture is observation layer -> execution layer -> redacted
snapshot/dashboard. The default `main` branch contains both reviewed packages.
Feature branches are temporary review artifacts; do not merge private runtime
files wholesale.

The original standalone controller history had no merge base with the public
`main` history. It was imported as reviewed source rather than force-merged or
rewritten. Its final branch head is preserved by the
`archive-v2-final-20260922` tag, so production needs only the default branch.

The public-template sync tool is report-only by default. Applying a reviewed
change requires `-Apply -IncludePaths` with exact managed file paths; it backs
up only those selections and refuses an active execution lock. This does not
resolve other private-runtime drift automatically. Review remaining differences
by file and never apply the full report as a batch.
