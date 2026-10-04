import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const scripts = fileURLToPath(new URL("../scripts/", import.meta.url));
const quoted = (value) => String(value).replaceAll("'", "''");
const shells = process.platform === "win32" ? ["powershell.exe", "pwsh.exe"] : ["pwsh"];
async function runFixture(shell, command) {
  try {
    const { stdout } = await run(shell, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")], {
      encoding: "utf8", timeout: 60000,
    });
    return JSON.parse(stdout.trim());
  } catch (error) {
    throw new Error(`${shell} native fixture failed: ${error.stderr ?? error.message}`);
  }
}

// Dummy automation types and controls exercise the actual action functions
// without loading Windows UI libraries or interacting with a browser.
const harness = `
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
Add-Type @'
namespace CheckinFixture.Automation {
  public class AutomationElement { }
  public static class ControlType {
    public static string Button="Button", Hyperlink="Hyperlink", CheckBox="CheckBox";
  }
  public static class InvokePattern { public static string Pattern="Invoke"; }
  public static class TogglePattern { public static string Pattern="Toggle"; }
  public enum ToggleState { Off, On }
}
'@
. '${quoted(scripts + "Native-PtGuard.ps1")}'
. '${quoted(scripts + "CheckinContract.generated.ps1")}'
$originValue='https://ptsbao.club'
function Import-ActionFunction([string]$File,[string]$Name) {
  $tokens=$null;$errors=$null
  $ast=[Management.Automation.Language.Parser]::ParseFile($File,[ref]$tokens,[ref]$errors)
  if($errors.Count){throw 'Native reader syntax error'}
  $definition=$ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $Name},$true) | Select-Object -First 1
  if(-not $definition){throw 'Missing action function'}
  return $definition.Extent.Text.Replace('[System.Windows.Automation.', '[CheckinFixture.Automation.')
}
. ([scriptblock]::Create((Import-ActionFunction '${quoted(scripts + "Invoke-MainChromeCheckinAccessibility.ps1")}' 'Invoke-UniqueCheckinButton')))
. ([scriptblock]::Create((Import-ActionFunction '${quoted(scripts + "Invoke-PlainWafAccessibility.ps1")}' 'Invoke-NativeCheckinAction')))
function Get-WindowElements { if(-not $script:noControl){$script:control} }
function Get-WindowPageElements { Get-WindowElements $null }
function Get-AllAutomationElements { if(-not $script:noControl){$script:control} }
function Start-NativePtWrite([string]$Action) {
  $script:events.Add('guard:'+ $Action)
  if($script:gateClosed){
    $exception=[InvalidOperationException]::new('mock gate closed')
    $exception.Data['NativePtDecision']=[pscustomobject]@{status='deferred';retryCause='harvest_waiting';submissionAttempted=$false}
    throw $exception
  }
  $script:NativePtGuard.attempted=$true
}
$script:pattern=[pscustomobject]@{Current=[pscustomobject]@{ToggleState=[CheckinFixture.Automation.ToggleState]::Off}}
$script:pattern|Add-Member ScriptMethod Invoke {
  $script:events.Add('invoke')
  if($script:actionThrows){throw 'Mock action failed after dispatch'}
  return (-not $script:actionReturnsFalse)
}
$script:pattern|Add-Member ScriptMethod Toggle {$script:events.Add('toggle')}
$script:control=[pscustomobject]@{Current=[pscustomobject]@{Name='签到';IsEnabled=$true;ControlType=[CheckinFixture.Automation.ControlType]::Button}}
$script:control|Add-Member ScriptMethod GetCurrentPattern {
  param($kind)
  if($kind -eq 'Invoke' -and -not $script:supportsInvoke){throw 'Pattern unsupported'}
  return $script:pattern
}
function Invoke-FixtureAction([string]$Reader) {
  if($Reader -eq 'main'){Invoke-UniqueCheckinButton $null}else{Invoke-NativeCheckinAction}
}
`;

test("native actions persist write intent before dispatch and never repeat an ambiguous Invoke", async () => {
  const command = harness + `
$rows=@(foreach($reader in @('main','plain')){
  foreach($scenario in @('success','throws','returns_false','gate_closed','read_only','no_control','toggle_only')){
    $script:events=[Collections.Generic.List[string]]::new()
    $script:NativePtGuard=@{managed=$false;attempted=$false;readOnly=($scenario -eq 'read_only')}
    $script:checkinClickAttempted=$false;$script:nativeLocalSubmissionAttempted=$false
    $script:ReadOnly=$scenario -eq 'read_only'
    $script:gateClosed=$scenario -eq 'gate_closed';$script:noControl=$scenario -eq 'no_control'
    $script:supportsInvoke=$scenario -ne 'toggle_only'
    $script:actionThrows=$scenario -eq 'throws';$script:actionReturnsFalse=$scenario -eq 'returns_false'
    $errorRecord=$null;$first=$null;$second=$null
    try{$first=Invoke-FixtureAction $reader}catch{$errorRecord=$_}
    if(-not $script:gateClosed){$second=Invoke-FixtureAction $reader}
    $failure=if($errorRecord){Get-NativePtFailure -ErrorRecord $errorRecord}else{$null}
    [pscustomobject]@{reader=$reader;scenario=$scenario;events=@($script:events.ToArray());
      first=$first;second=$second;threw=($null -ne $errorRecord);attempted=$script:nativeLocalSubmissionAttempted;
      clickAttempted=$script:checkinClickAttempted;failure=$failure}
  }
})
ConvertTo-Json -InputObject $rows -Depth 8 -Compress`;
  for (const shell of shells) {
    for (const result of await runFixture(shell, command)) {
      const label = `${shell}/${result.reader}/${result.scenario}`;
      if (["success", "throws", "returns_false"].includes(result.scenario)) {
        assert.deepEqual(result.events, ["guard:click", "invoke"], label);
        assert.equal(result.attempted, true, label);
        assert.equal(result.clickAttempted, true, label);
        assert.equal(result.second, false, label);
        assert.equal(result.threw, result.scenario === "throws", label);
        if (result.threw) assert.equal(result.failure.failureCode, "submission_outcome_unknown", label);
      } else if (result.scenario === "gate_closed") {
        assert.deepEqual(result.events, ["guard:click"], label);
        assert.equal(result.attempted, false, label);
        assert.equal(result.failure.retryCause, "harvest_waiting", label);
        assert.equal(result.failure.submissionAttempted, false, label);
      } else if (result.scenario === "toggle_only" && result.reader === "plain") {
        assert.deepEqual(result.events, ["guard:click", "toggle"], label);
        assert.equal(result.attempted, true, label);
        assert.equal(result.second, false, label);
      } else {
        assert.deepEqual(result.events, [], label);
        assert.equal(result.attempted, false, label);
      }
    }
  }
});

test("both native readers initialize before UI setup and guard navigation before browser startup", async () => {
  for (const file of ["Invoke-MainChromeCheckinAccessibility.ps1", "Invoke-PlainWafAccessibility.ps1"]) {
    const source = await fs.readFile(scripts + file, "utf8");
    const initialize = source.indexOf("$nativeDecision = Initialize-NativePtGuard");
    const setup = file.includes("MainChrome") ? source.indexOf("Add-Type -AssemblyName UIAutomationClient") : source.indexOf("Join-Path $PSScriptRoot 'Safe-UIAutomation.ps1'");
    const navigation = source.indexOf("Start-NativePtWrite -Action navigation");
    const startup = file.includes("MainChrome") ? source.indexOf("Start-Process -FilePath") : source.indexOf("& (Join-Path $PSScriptRoot 'Open-PlainLoginChrome.ps1')");
    assert.ok(initialize > 0 && initialize < setup, file);
    assert.ok(navigation > setup && navigation < startup, file);
    assert.match(source.slice(initialize, setup), /\$nativeDecision \| Complete-NativePtResult \| ConvertTo-Json/);
    assert.match(source, /Get-NativePtFailure -ErrorRecord \$_/);
    assert.match(source, /checkinClickAttempted/);
  }
});

test("a gated native unknown first gets a read-only main-profile recovery when the site has a fallback", async () => {
  const source = await fs.readFile(scripts + "Prepare-NativeWafSession.ps1", "utf8");
  assert.match(source, /function Invoke-MainChromeReadOnlyFallbackResult/);
  assert.match(source, /failureCode -eq 'submission_outcome_unknown'[\s\S]{0,420}Invoke-MainChromeReadOnlyFallbackResult/);
  assert.match(source, /-ReadOnly/);
  assert.match(source, /submissionAttempted -eq \$true/);
});

test("native completion preserves local submission facts even when no PT journal owns the site", async () => {
  const command = harness + `
$script:NativePtGuard=@{managed=$false;attempted=$false;readOnly=$false}
$rows=@(foreach($value in @(
  [pscustomobject]@{status='unconfirmed';submissionAttempted=$true;clicked=$false;checkinClickAttempted=$true},
  [pscustomobject]@{status='login_required';submissionAttempted=$true;checkinClicked=$false;checkinClickAttempted=$true}
)){$value|Complete-NativePtResult})
ConvertTo-Json -InputObject $rows -Depth 8 -Compress`;
  for (const shell of shells) {
    for (const result of await runFixture(shell, command)) {
      assert.equal(result.status, "needs_attention");
      assert.equal(result.failureCode, "submission_outcome_unknown");
      assert.equal(result.submissionAttempted, true);
      assert.equal(result.checkinClickAttempted, true);
      assert.equal(result.retryable, false);
    }
  }
});
