# Historical material

This directory preserves superseded workflow definitions. Only
`.github/workflows/unified.yml` at the repository root runs CI.

The production command names remain compatible with existing installations.
Canary/migration readers in `observation/src` remain where referenced by
historical receipt readers and regression tests; their standalone execution
entry points are fenced off in unified mode. They are not a second scheduler.
