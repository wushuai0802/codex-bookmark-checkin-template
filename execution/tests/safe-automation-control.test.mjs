import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const helperPath = path.join(root, "scripts", "Safe-UIAutomation.ps1").replaceAll("'", "''");
const powershell = process.platform === "win32" ? "pwsh.exe" : "pwsh";

test("安全 UIAutomation 调用器只使用明确允许的模式", async () => {
  const command = `
. '${helperPath}'
function New-MockElement([bool]$FailInvoke) {
    $state = [pscustomobject]@{ invoke = 0; toggle = 0; selection = 0 }
    $invoke = [pscustomobject]@{ State = $state; Fail = $FailInvoke }
    $invoke | Add-Member ScriptMethod Invoke { if ($this.Fail) { throw 'invoke unavailable' }; $this.State.invoke++ }
    $toggle = [pscustomobject]@{ State = $state; Current = [pscustomobject]@{ ToggleState = [System.Windows.Automation.ToggleState]::Off } }
    $toggle | Add-Member ScriptMethod Toggle { $this.State.toggle++ }
    $selection = [pscustomobject]@{ State = $state; Current = [pscustomobject]@{ IsSelected = $false } }
    $selection | Add-Member ScriptMethod Select { $this.State.selection++ }
    $element = [pscustomobject]@{ InvokeAction = $invoke; ToggleAction = $toggle; SelectionAction = $selection }
    $element | Add-Member ScriptMethod GetCurrentPattern {
        param($requested)
        if ($requested.Id -eq [System.Windows.Automation.InvokePattern]::Pattern.Id) { return $this.InvokeAction }
        if ($requested.Id -eq [System.Windows.Automation.TogglePattern]::Pattern.Id) { return $this.ToggleAction }
        if ($requested.Id -eq [System.Windows.Automation.SelectionItemPattern]::Pattern.Id) { return $this.SelectionAction }
        throw 'pattern unavailable'
    }
    return [pscustomobject]@{ Element = $element; State = $state }
}
$first = New-MockElement $false
$firstResult = Invoke-SafeAutomationControl -Element $first.Element -AllowedPatterns @('Invoke', 'Toggle')
$second = New-MockElement $true
$secondResult = Invoke-SafeAutomationControl -Element $second.Element -AllowedPatterns @('Invoke', 'SelectionItem')
$third = New-MockElement $true
$thirdResult = Invoke-SafeAutomationControl -Element $third.Element -AllowedPatterns @('Invoke')
[pscustomobject]@{
    firstResult = $firstResult
    first = $first.State
    secondResult = $secondResult
    second = $second.State
    thirdResult = $thirdResult
    third = $third.State
} | ConvertTo-Json -Compress -Depth 4
`;
  const { stdout } = await execFileAsync(powershell, ["-NoProfile", "-NonInteractive", "-Command", command], {
    encoding: "utf8",
  });
  const result = JSON.parse(stdout.trim());
  assert.equal(result.firstResult, true);
  assert.deepEqual(result.first, { invoke: 1, toggle: 0, selection: 0 });
  assert.equal(result.secondResult, true);
  assert.deepEqual(result.second, { invoke: 0, toggle: 0, selection: 1 });
  assert.equal(result.thirdResult, false);
  assert.deepEqual(result.third, { invoke: 0, toggle: 0, selection: 0 });
});
