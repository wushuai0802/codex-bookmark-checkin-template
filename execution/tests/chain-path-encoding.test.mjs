import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {resultIdentity} from '../src/result-identity.mjs';
import {validateEngineLease} from '../../observation/src/legacy-engine.mjs';
import {runPowerShell} from './helpers/offline-chain-fixture.mjs';

const execution = fileURLToPath(new URL('../', import.meta.url));
function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-paths-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  return root;
}

test('real Node lease validation and the PowerShell root comparator agree on trailing separators, spaces and Chinese paths', {timeout: 30000}, async t => {
  const root = temporary(t), controller = path.join(root, 'example controller 中文'), legacy = path.join(root, 'example execution 中文');
  for (const name of ['config', 'data']) fs.mkdirSync(path.join(controller, name), {recursive: true});
  fs.mkdirSync(legacy);
  const nonce = crypto.randomUUID();
  fs.writeFileSync(path.join(controller, 'config/runtime.local.json'), JSON.stringify({executionEngine: 'v1', legacyRoot: legacy}));
  fs.writeFileSync(path.join(controller, 'data/v2-run.lock'), JSON.stringify({nonce, pid: process.pid}));
  const variants = [value => value, value => value + path.sep,
    value => value + path.sep + path.sep, value => path.join(value, 'example', '..')];
  if (process.platform === 'win32') variants.push(value => value[0].toLowerCase() + value.slice(1),
    value => (value[0].toUpperCase() + value.slice(1)).replaceAll('\\', '/') + '/');
  const cases = variants.map(variant => ({left: controller, right: variant(controller), legacy: variant(legacy)}));
  const file = path.join(root, 'inputs.json'); fs.writeFileSync(file, JSON.stringify(cases));
  // Extract only the existing pure comparator assignment. Never invoke the
  // provider entrypoint, load its configuration or execute a vault command.
  const command = String.raw`
$ErrorActionPreference='Stop'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($env:CHAIN_PROVIDER_SOURCE,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Provider parse failed'}
$assignments=@($ast.FindAll({param($n) $n -is [Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -eq '$sameRoot'},$true))
if($assignments.Count -ne 1){throw 'Root comparator changed'}
. ([scriptblock]::Create($assignments[0].Extent.Text))
$cases=Get-Content -Raw -LiteralPath $env:CHAIN_INPUTS | ConvertFrom-Json
@($cases | ForEach-Object { & $sameRoot $_.left $_.right }) | ConvertTo-Json -Compress
`;
  const out = await runPowerShell(t, command, {env: {...process.env, CHAIN_PROVIDER_SOURCE: path.join(execution, 'scripts/Get-BitwardenTotp.ps1'), CHAIN_INPUTS: file}});
  if (!out) return;
  const fromPowerShell = JSON.parse(out.stdout);
  const fromNode = cases.map(value => validateEngineLease({root: controller, legacyRoot: value.legacy,
    env: {CHECKIN_V2_ENGINE_ROOT: value.right, CHECKIN_V2_ENGINE_LEASE: nonce}}));
  assert.deepEqual(fromPowerShell, cases.map(() => true));
  assert.deepEqual(fromNode, fromPowerShell);
  assert.throws(() => validateEngineLease({root: controller, legacyRoot: legacy,
    env: {CHECKIN_V2_ENGINE_ROOT: path.join(controller, 'other'), CHECKIN_V2_ENGINE_LEASE: nonce}}), /binding mismatch/);
});

test('Node and PowerShell canonical origins and encoded account identities agree through UTF-8 JSON', {timeout: 30000}, async t => {
  const root = temporary(t), cases = ['https://TRACKER.EXAMPLE/', 'https://TRACKER.EXAMPLE:443/',
    'https://tracker.example/目录?example=1', 'https://OTHER.EXAMPLE/'].flatMap(origin => [
    {origin}, {origin, accountKey: "example 中文 /#!'()*"},
  ]);
  const file = path.join(root, 'inputs.json'); fs.writeFileSync(file, JSON.stringify(cases));
  const out = await runPowerShell(t, String.raw`
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
. $env:CHAIN_IDENTITY_SOURCE
$cases=Get-Content -Raw -Encoding UTF8 -LiteralPath $env:CHAIN_INPUTS | ConvertFrom-Json
@($cases | ForEach-Object { Get-CanonicalResultIdentity $_ }) | ConvertTo-Json -Compress
`, {env: {...process.env, CHAIN_IDENTITY_SOURCE: path.join(execution, 'scripts/ResultIdentity.ps1'), CHAIN_INPUTS: file}});
  if (!out) return;
  assert.deepEqual(JSON.parse(out.stdout), cases.map(resultIdentity));
  assert.ok(JSON.parse(out.stdout).every(value => value.startsWith('https://tracker.example') || value.startsWith('https://other.example')));
});
