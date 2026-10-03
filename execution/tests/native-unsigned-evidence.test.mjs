import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execute = promisify(execFile);
const scripts = fileURLToPath(new URL("../scripts/", import.meta.url));
const quote = (value) => String(value).replaceAll("'", "''");
const shells = process.platform === "win32" ? ["powershell.exe", "pwsh.exe"] : ["pwsh"];
const preamble = `$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
. '${quote(scripts + "ResultContract.ps1")}'
`;

async function runFixture(shell, command) {
  try {
    const { stdout } = await execute(shell, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")], {
      encoding: "utf8", timeout: 60000,
    });
    return JSON.parse(stdout.trim());
  } catch (error) {
    throw new Error(`${shell}: ${error.stderr ?? error.message}`);
  }
}

test("native unsigned evidence requires the authenticated exact SaoBao daily control without conflicts", async () => {
  const base = {
    currentUrl: "https://ptsbao.club/index.php", sameOrigin: true, authenticated: true,
    siteBodyLoaded: true, waf: false, securityVerification: false, loginRoute: false,
    success: false, successText: "", successControl: "", signedControlCount: 0,
    unsignedControl: "签到", unsignedControlCount: 1,
  };
  const cases = [
    { snapshot: base, expected: true },
    { snapshot: { ...base, unsignedControl: '签到得魔力' }, expected: true },
    ...[
      { authenticated: false }, { sameOrigin: false }, { siteBodyLoaded: false },
      { waf: true }, { securityVerification: true }, { loginRoute: true },
      { success: true }, { success: undefined }, { successText: "今日已签到" },
      { successControl: "签到已得10, 补签卡: 0" }, { signedControlCount: 1 },
      { signedControlCount: 2 }, { signedControlCount: undefined },
      { unsignedControlCount: 0 }, { unsignedControlCount: 2 },
      { unsignedControl: "历史签到" }, { unsignedControl: "立即签到" },
      { currentUrl: "https://ptsbao.club/attendance.php" },
      { currentUrl: "https://ptsbao.club/index.php?day=2026-10-02" },
      { currentUrl: "https://ptsbao.club/index.php#history" },
      { currentUrl: "http://ptsbao.club/index.php" },
      { currentUrl: "https://www.ptsbao.club/index.php" },
      { currentUrl: "https://other.example/index.php" },
    ].map((overrides) => ({ snapshot: { ...base, ...overrides }, expected: false })),
    { snapshot: base, target: "https://ptsbao.club/attendance.php", expected: false },
    { snapshot: { ...base, currentUrl: "https://piggo.me/index.php" }, target: "https://piggo.me/index.php", expected: false },
  ];
  const command = preamble + `
$cases='${quote(JSON.stringify(cases))}' | ConvertFrom-Json
$rows=@(foreach($case in $cases){
  $target=if($case.target){$case.target}else{'https://ptsbao.club/index.php'}
  [pscustomobject]@{evidence=(Get-ConfirmedNativeUnsignedEvidence $case.snapshot $target ([datetimeoffset]'2026-10-02T16:00:01Z'))}
})
ConvertTo-Json -InputObject $rows -Depth 8 -Compress`;
  for (const shell of shells) {
    const results = await runFixture(shell, command);
    assert.equal(results.length, cases.length);
    results.forEach(({ evidence }, index) => {
      assert.equal(evidence?.authoritative === true, cases[index].expected, `${shell}/case ${index}`);
      if (!cases[index].expected) return;
      assert.equal(evidence.source, "page_text");
      assert.equal(evidence.statusSignal, "nexus_daily_header_unsigned");
      assert.equal(evidence.pagePath, "/index.php");
      assert.equal(evidence.businessDate, "2026-10-03");
      assert.equal(Date.parse(evidence.confirmedAt), Date.parse("2026-10-02T16:00:01Z"));
      assert.equal("bodyText" in evidence, false);
    });
  }
});

test("native snapshot counts actual links and rejects duplicate or contradictory daily controls", async () => {
  const command = preamble + `
Add-Type @'
namespace System.Windows.Automation {
  public class AutomationElement { }
  public class ControlType {
    public string ProgrammaticName;
    public ControlType(string name) { ProgrammaticName="ControlType."+name; }
    public static ControlType Edit=new ControlType("Edit");
  }
  public enum TreeScope { Descendants }
  public class Condition { public static Condition TrueCondition=new Condition(); }
}
'@
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile('${quote(scripts + "Invoke-MainChromeCheckinAccessibility.ps1")}',[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Native reader syntax error'}
foreach($functionName in @('Get-WindowPageElements','Read-PageSnapshot','Test-EquivalentOrigin')){
  $definition=$ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $functionName},$true)|Select-Object -First 1
  . ([scriptblock]::Create($definition.Extent.Text))
}
function Get-WindowElements {$script:elements}
function Get-CurrentUri {[uri]'https://ptsbao.club/index.php'}
function New-FixtureControl([string]$Name,[string]$Type){
  [pscustomobject]@{Current=[pscustomobject]@{Name=$Name;ControlType=[System.Windows.Automation.ControlType]::new($Type)}}
}
$originValue='https://ptsbao.club';$targetUri=[uri]'https://ptsbao.club/index.php'
$rows=@(foreach($scenario in @('unique','toolbar_only','duplicate','signed_conflict','multiple_signed','browser_chrome_only')){
  $script:elements=@(
    (New-FixtureControl '退出' 'Hyperlink'),(New-FixtureControl '控制面板' 'Hyperlink'),
    (New-FixtureControl ('site fixture content ' * 10) 'Text'),(New-FixtureControl '签到' 'Button')
  )
  if($scenario -ne 'toolbar_only'){$script:elements+=(New-FixtureControl '[签到]' 'Hyperlink')}
  if($scenario -eq 'duplicate'){$script:elements+=(New-FixtureControl '签到' 'Hyperlink')}
  if($scenario -in @('signed_conflict','multiple_signed')){$script:elements+=(New-FixtureControl '签到已得10, 补签卡: 0' 'Hyperlink')}
  if($scenario -eq 'multiple_signed'){$script:elements+=(New-FixtureControl '签到已得20, 补签卡: 0' 'Hyperlink')}
  $script:pageElements=@($script:elements)
  if($scenario -ne 'browser_chrome_only'){
    $document=New-FixtureControl '网页内容' 'Document'
    $document | Add-Member ScriptMethod FindAll {param($scope,$condition) $script:pageElements}
    $script:elements=@((New-FixtureControl '签到已得999, 补签卡: 0' 'Hyperlink'),$document)+$script:pageElements
  }
  $snapshot=Read-PageSnapshot $null
  $evidence=Get-ConfirmedNativeUnsignedEvidence $snapshot $targetUri.AbsoluteUri
  [pscustomobject]@{scenario=$scenario;unsignedCount=$snapshot.unsignedControlCount;signedCount=$snapshot.signedControlCount;authoritative=($null -ne $evidence);loaded=$snapshot.siteBodyLoaded;authenticated=$snapshot.authenticated;pageContentAvailable=$snapshot.pageContentAvailable}
})
ConvertTo-Json -InputObject $rows -Depth 6 -Compress`;
  for (const shell of shells) {
    const results = await runFixture(shell, command);
    assert.deepEqual(results.map((result) => [result.scenario, result.authoritative]), [
      ["unique", true], ["toolbar_only", false], ["duplicate", false],
      ["signed_conflict", false], ["multiple_signed", false], ["browser_chrome_only", false],
    ], shell);
    assert.equal(results.find((row) => row.scenario === "duplicate").unsignedCount, 2);
    assert.equal(results.find((row) => row.scenario === "multiple_signed").signedCount, 2);
    const unavailable=results.find(row=>row.scenario==='browser_chrome_only');
    assert.equal(unavailable.loaded,false);
    assert.equal(unavailable.authenticated,false);
    assert.equal(unavailable.pageContentAvailable,false);
  }
});

test("unsigned readback is reachable only in the explicit read-only branch", async () => {
  const source = await fs.readFile(scripts + "Invoke-MainChromeCheckinAccessibility.ps1", "utf8");
  assert.match(source, /if \(\$ReadOnly\) \{\s+\$unsignedEvidence = Get-ConfirmedNativeUnsignedEvidence \$last \$Url/);
  assert.match(source, /status = 'not_signed'[\s\S]{0,180}submissionAttempted = \$false/);
  assert.match(source, /\$ReadOnly -and \$result.status -eq 'not_signed'/);
});
