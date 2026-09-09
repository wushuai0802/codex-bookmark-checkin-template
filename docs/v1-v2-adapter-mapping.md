# V1 capability to V2 adapter mapping

V2 now has one explicit translation boundary in `src/v1-v2-adapter-plan.mjs`.
It consumes the redacted `catalog_only` output from V1 and produces a V2
observe-only adapter plan. It does not import V1 browser code, credentials,
cookies, profiles, retry loops, or notification commands.

| V1 family | V2 adapter | Current boundary |
| --- | --- | --- |
| `new-api-calendar.v1` | `readonly.new-api.v1` | Identity and dated calendar GETs |
| `oauth-reward-log.v1` | `readonly.reward-log.v1` | Identity and dated reward log GETs |
| `oauth-status.v1` | `readonly.linuxdo-wheel.v1` | Identity and dated status GETs |
| `generic-discovery.v1` | `readonly.vibe-entitlement.v1` | Identity and entitlement GETs |
| `native-pt.v1` | `pt-native-readonly.v1` | Reviewed passive PT observations |

All mapped sites remain `canaryReady: false`. The first concrete factory is
`createNewApiReadonlyAdapter`; it only supports `identity`, `read_status`, and
`classify_error`. A status result is accepted only with the expected account
ID and current business date. It cannot submit a check-in, relogin, open a
browser, or retry a mutation. V1 remains the sole execution owner until the
separate shadow, adapter, and canary gates pass.
