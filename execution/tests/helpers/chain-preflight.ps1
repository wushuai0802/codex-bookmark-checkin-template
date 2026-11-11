param([string[]]$Origins)

$ErrorActionPreference = 'Stop'
$root = $env:CHECKIN_CHAIN_ROOT
$tokens = $null; $parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($env:CHECKIN_CHAIN_PREFLIGHT_SOURCE, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw 'Preflight syntax changed' }
foreach ($name in @('Select-ScopedPreflightItems', 'Test-TwoFactorResult', 'Copy-NativeReceiptBindingFields')) {
    $definitions = @($ast.FindAll({param($node)
        $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name
    }, $true))
    if ($definitions.Count -ne 1) { throw "Preflight function missing: $name" }
    . ([scriptblock]::Create($definitions[0].Extent.Text))
}
. (Join-Path $root 'scripts/ResultContract.ps1')

$config = Get-Content -Raw -LiteralPath (Join-Path $root 'config/config.json') | ConvertFrom-Json
$inspections = Get-Content -Raw -LiteralPath (Join-Path $root 'tmp/chain-inspections.json') | ConvertFrom-Json
$items = @(Select-ScopedPreflightItems $config.nativeWafPreflightUrls $Origins $config.disabledCheckinOrigins)
$trace = [pscustomobject]@{requested = @($Origins); selected = @($items | ForEach-Object { ([uri]$_.url).GetLeftPart([UriPartial]::Authority) })}
[IO.File]::AppendAllText((Join-Path $root 'tmp/preflight-calls.jsonl'), ($trace | ConvertTo-Json -Compress) + "`n", [Text.UTF8Encoding]::new($false))

# Execute the real final inspection-to-row projection, including its helper
# calls. Only the browser's inspection is supplied by the offline fixture.
$loops = @($ast.EndBlock.Statements | Where-Object {
    $_ -is [Management.Automation.Language.ForEachStatementAst] -and $_.Variable.Extent.Text -eq '$item'
})
if ($loops.Count -ne 1) { throw 'Preflight item loop changed' }
$statements = @($loops[0].Body.Statements)
$start = @($statements | Where-Object {
    $_ -is [Management.Automation.Language.AssignmentStatementAst] -and $_.Left.Extent.Text -eq '$explicitlyConfirmed'
})
if ($start.Count -ne 1) { throw 'Preflight result projection changed' }
$projection = [scriptblock]::Create(($statements | Where-Object {
    $_.Extent.StartOffset -ge $start[0].Extent.StartOffset
} | ForEach-Object { $_.Extent.Text }) -join "`n")
$candidateLoop = @($ast.EndBlock.Statements | Where-Object {
    $_ -is [Management.Automation.Language.ForEachStatementAst] -and $_.Variable.Extent.Text -eq '$candidate'
})
if ($candidateLoop.Count -ne 1) { throw 'Preflight gate loop changed' }
$decisionBranch = @($candidateLoop[0].Body.Statements | Where-Object {
    $_ -is [Management.Automation.Language.IfStatementAst]
})
if ($decisionBranch.Count -ne 1) { throw 'Preflight gate branch changed' }
$gateStatements = @($decisionBranch[0].Clauses[0].Item2.Statements | Select-Object -Last 4)
if ($gateStatements[-1].Extent.Text -ne '$preflightResults += $decision') { throw 'Preflight gate projection changed' }
$gateProjection = [scriptblock]::Create(($gateStatements | ForEach-Object { $_.Extent.Text }) -join "`n")
$preflightResults = @()
foreach ($item in $items) {
    $origin = ([uri]$item.url).GetLeftPart([UriPartial]::Authority)
    $entry = $inspections.PSObject.Properties[$origin]
    if ($null -eq $entry) { continue }
    $url = $item.url; $hostName = ([uri]$url).Host; $inspection = $entry.Value
    if ($inspection.gateDecision) {
        $candidateOrigin = $origin; $candidateUrl = $url; $decision = $inspection.gateDecision
        . $gateProjection
    } else { . $projection }
}

# Take the actual top-level writer statements, rather than reproducing its
# JSON envelope, depth, timestamp format or UTF-8 encoding in the test.
$writerStart = @($ast.EndBlock.Statements | Where-Object {
    $_ -is [Management.Automation.Language.AssignmentStatementAst] -and $_.Left.Extent.Text -eq '$preflightPath'
})
if ($writerStart.Count -ne 1) { throw 'Preflight writer changed' }
$writer = [scriptblock]::Create(($ast.EndBlock.Statements | Where-Object {
    $_.Extent.StartOffset -ge $writerStart[0].Extent.StartOffset
} | ForEach-Object { $_.Extent.Text }) -join "`n")
. $writer
