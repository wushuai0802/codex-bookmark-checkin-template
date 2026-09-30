# PT recovery and evidence

Run these commands from the configured observation runtime. Its private
runtime configuration must bind the existing execution installation. Profiles,
credentials, bookmark catalogs and generated receipts remain outside Git.

## Read-only verification

```powershell
node scripts/verify-open-cd.mjs <catalog-file> <catalog-sha256>
```

The catalog must match the current bookmark scope. A read-only request uses
the existing account/profile and a reviewed passive page. Unsupported pages
remain unverified; the request never turns into a check-in. OpenCD's CAPTCHA
flow remains in the formal executor. Opening its CAPTCHA dialog is distinct
from submitting the answer.

A dated passive receipt can close the executor's OpenCD quarantine and be
reused by subsequent runs without another site submission.

## Inspect and reconcile an attempt

```powershell
node scripts/reconcile-pt-fallback.mjs --business-date YYYY-MM-DD --resolution list
node scripts/reconcile-pt-fallback.mjs --business-date YYYY-MM-DD --attempt-id <id> --receipt-file <passive-receipt.json>
```

The default resolution, confirmed_external, requires a matching origin,
account, profile hash and business date. Reconciliation appends an audit entry
and preserves the original attempt. Older entries receive deterministic
legacy IDs for review; their history is not rewritten.

confirmed_not_submitted is available only when the executor recorded explicit
non-submission. It does not infer failure from an absent success receipt:

```powershell
node scripts/reconcile-pt-fallback.mjs --business-date YYYY-MM-DD --attempt-id <id> --resolution confirmed_not_submitted
```

An operator may close an individually reviewed historical uncertainty:

```powershell
node scripts/reconcile-pt-fallback.mjs --business-date YYYY-MM-DD --attempt-id <id> --resolution closed_manual --acknowledgement reviewed-this-attempt-no-same-day-replay --note "<reason for this specific review>"
```

Manual closure keeps the outcome unknown and keeps same-day replay blocked.
It never fabricates a successful check-in. Automated recovery must not emit
this operator acknowledgement.

## Retry and publication

Harvest waiting and proven preflight refusals do not consume submission
attempts. Due per-account wakeups have a separate bounded scheduler budget,
including reserved late upstream probes. A login-recovered timestamp is a
wake-up hint; account/session validation still belongs to the executor.

The final publication marker is dashboard-generation.json. It embeds the
redacted snapshot and identifies an exact ledger prefix by size and SHA-256.
Publish the ledger and compatibility snapshot first, then replace the marker
atomically. Retain dashboard-generation.previous.json for restart recovery.
An interrupted publication can therefore serve the previous complete
generation with generationStale=true.

Code rollback must keep live attempts, receipts and profiles. Roll back the
publisher and dashboard reader together, then validate a read-only snapshot
before considering new submissions.
