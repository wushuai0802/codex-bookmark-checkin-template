import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {promisify} from 'node:util';

const execute = promisify(execFile);
const execution = fileURLToPath(new URL('../../', import.meta.url));
const shell = process.platform === 'win32' ? 'pwsh.exe' : 'pwsh';
export const exampleOrigin = name => `https://${name}.example`;

export async function runPowerShell(t, command, options = {}) {
  try {
    return await execute(shell, ['-NoProfile', '-NonInteractive', '-Command', command],
      {encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 256 * 1024, ...options});
  } catch (error) {
    if (error.code === 'ENOENT') { t.skip('PowerShell unavailable; offline chain requires pwsh'); return null; }
    throw error;
  }
}

// Same source-copy/browser-launch seam as the existing offline index fixtures.
// Config, bookmarks, profiles, journals and reports are all synthetic and live
// exclusively in this test's temporary root. No process-global lease is changed.
export function chainFixture(t, names, {paused = [], now = new Date()} = {}) {
  // Resolve 8.3 short names (CI runners expose a short TEMP): PowerShell expands
  // them, and the profile-containment check compares the two spellings.
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'checkin-chain-')));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  for (const dir of ['config', 'data/profile', 'logs', 'tmp', 'scripts']) fs.mkdirSync(path.join(root, dir), {recursive: true});
  const profile = path.join(root, 'data/profile');
  fs.writeFileSync(path.join(profile, 'Local State'), 'offline example profile');
  fs.cpSync(path.join(execution, 'src'), path.join(root, 'src'), {recursive: true});
  fs.symlinkSync(path.join(execution, 'node_modules'), path.join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  for (const name of ['Run-Checkin.ps1', 'Start-UserScheduler.ps1', 'Resolve-Runtime.ps1', 'RunLock.ps1',
    'ResultIdentity.ps1', 'ResultContract.ps1', 'CheckinContract.generated.ps1', 'V2-EngineGateway.ps1', 'Gateway-Audit.ps1']) {
    fs.copyFileSync(path.join(execution, 'scripts', name), path.join(root, 'scripts', name));
  }
  fs.copyFileSync(fileURLToPath(new URL('./chain-preflight.ps1', import.meta.url)), path.join(root, 'scripts/Prepare-NativeWafSession.ps1'));
  fs.copyFileSync(fileURLToPath(new URL('./chain-runner.ps1', import.meta.url)), path.join(root, 'tmp/chain-runner.ps1'));
  fs.writeFileSync(path.join(root, 'scripts/Clear-StalePrivateTemp.ps1'), '# No machine cleanup in the offline fixture.\n');
  fs.writeFileSync(path.join(root, 'scripts/Submit-UnifiedCheckinReport.ps1'), '# No notification enqueue in the offline fixture.\n');
  fs.writeFileSync(path.join(root, 'scripts/Invoke-CheckinNotificationOutbox.ps1'), "'{\"processed\":0,\"invalid\":0}'\n");
  const config = {
    automationUserDataDir: profile, bookmarksPath: path.join(root, 'tmp/Bookmarks'),
    minimumBookmarkTargetCount: 1, mobileFolderIds: ['10'], targetFolderNames: ['example-folder'],
    nativeWafPreflightUrls: names.map(name => ({url: exampleOrigin(name) + '/attendance.php',
      automationUserDataDir: profile, trustAsSigned: false, action: 'checkin'})),
    disabledCheckinOrigins: paused.map(exampleOrigin), sessionPreflightEnabled: false,
    recoveryRounds: 1, recoveryDelaysMs: [0], logRetentionDays: 2, retryCount: 0,
    taskRunAttempts: 1, taskRetryDelayMinutes: 0, taskTimeoutMinutes: 5, schedule: '00:00',
    runMutexName: 'checkin-chain-run-' + crypto.randomUUID(), schedulerMutexName: 'checkin-chain-scheduler-' + crypto.randomUUID(),
  };
  fs.writeFileSync(config.bookmarksPath, JSON.stringify({roots: {other: {type: 'folder', id: '10', name: 'example-container', children: [
    {type: 'folder', id: '11', name: 'example-folder', children: names.map(name => ({type: 'url', name: 'example', url: exampleOrigin(name) + '/attendance.php'}))},
  ]}}}));
  fs.writeFileSync(path.join(root, 'config/qa-rules.json'), '{"rules":[]}');
  const save = () => fs.writeFileSync(path.join(root, 'config/config.json'), JSON.stringify(config));
  save();
  const hooks = path.join(root, 'tmp/offline-hooks.mjs');
  fs.writeFileSync(hooks, `import fs from 'node:fs';
import path from 'node:path';
import childProcess from 'node:child_process';
import net from 'node:net';import tls from 'node:tls';import http from 'node:http';import https from 'node:https';
import {registerHooks,syncBuiltinESMExports} from 'node:module';
import {promisify} from 'node:util';
const root=${JSON.stringify(root)},at=Date.parse(process.env.CHECKIN_CHAIN_NOW),NativeDate=Date;
const processStartedAt=new NativeDate(NativeDate.now()-process.uptime()*1000).toISOString();
setTimeout(()=>process.exit(124),25000).unref();
globalThis.Date=class extends NativeDate{constructor(...args){super(...(args.length?args:[at]));}static now(){return at;}};
const trace=value=>fs.appendFileSync(root+'/tmp/browser-calls.jsonl',JSON.stringify(value)+'\\n');
const forbidden=()=>{trace({event:'forbidden'});throw Error('Offline chain forbids network and helper processes');};
globalThis.fetch=forbidden;globalThis.WebSocket=class{constructor(){forbidden();}};
net.connect=net.createConnection=tls.connect=http.request=http.get=https.request=https.get=forbidden;
net.Socket.prototype.connect=forbidden;
for(const key of ['exec','execFile','execSync','execFileSync','spawn','spawnSync','fork'])childProcess[key]=forbidden;
// The lock asks for this child process's start time on Windows. Supply only
// that OS observation; every login/credential/browser helper remains forbidden.
const lockIdentity=(file,args,options)=>{
 if(file.endsWith('powershell.exe')&&args.some(arg=>arg.includes('CHECKIN_LOCK_PID'))&&options.env.CHECKIN_LOCK_PID===String(process.pid))
  return Promise.resolve({stdout:processStartedAt,stderr:''});
 if(args.includes(path.join(root,'scripts','Invoke-PlainSavedPasswordAccessibility.ps1'))){
  const origin=args[args.indexOf('-Origin')+1];
  trace({event:'login_helper',origin});
  return Promise.resolve({stdout:JSON.stringify({status:'login_required',failureCode:'session_unavailable'}),stderr:''});
 }
 return forbidden();
};
childProcess.execFile[promisify.custom]=lockIdentity;
syncBuiltinESMExports();
registerHooks({load(url,context,next){
 if(url===new URL('../src/browser.mjs',import.meta.url).href){
  const source=fs.readFileSync(new URL(url),'utf8');
  const start=source.indexOf('export async function launchAutomationContext('),end=source.indexOf('export async function processTarget(',start);
  if(start<0||end<0)throw Error('Offline browser launch seam changed');
  const fake='export async function launchAutomationContext(){trace({event:"launch"});return {close:async()=>trace({event:"close"}),newPage:async()=>{trace({event:"page"});throw Error("No browser pages in the offline chain");}};}\\n';
  return {format:'module',shortCircuit:true,source:'const trace=value=>globalThis.__chainTrace(value);\\n'+source.slice(0,start)+fake+source.slice(end)};
 }
 return next(url,context);
}});
globalThis.__chainTrace=trace;
`);
  const envFor = at => {
    const env = {...process.env, TZ: 'Asia/Shanghai', CHECKIN_CHAIN_ROOT: root, CHECKIN_CHAIN_NODE: process.execPath,
      CHECKIN_CHAIN_NOW: new Date(at).toISOString(), CHECKIN_CHAIN_PREFLIGHT_SOURCE: path.join(execution, 'scripts/Prepare-NativeWafSession.ps1'),
      NODE_OPTIONS: '--import=' + pathToFileURL(hooks).href};
    for (const name of ['CHECKIN_V2_ENGINE_ROOT', 'CHECKIN_V2_ENGINE_LEASE', 'CHECKIN_PT_FALLBACK_RECHECK']) delete env[name];
    return env;
  };
  const json = relative => JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
  const lines = relative => fs.existsSync(path.join(root, relative))
    ? fs.readFileSync(path.join(root, relative), 'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse) : [];
  const run = async (file, args, at) => {
    try { return {code: 0, ...await execute(file, args, {cwd: root, env: envFor(at), encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 256 * 1024})}; }
    catch (error) {
      if (typeof error.code !== 'number') throw error;
      return {code: error.code, stdout: error.stdout, stderr: error.stderr};
    }
  };
  const report = out => {
    assert.ok(fs.existsSync(path.join(root, 'logs/latest.json')), out.stdout + out.stderr);
    const latest = json('logs/latest.json');
    assert.deepEqual(json('logs/' + latest.runId + '/result.json'), latest);
    assert.equal(latest.runState, 'final'); assert.equal(latest.isComplete, true);
    assert.equal(fs.existsSync(path.join(root, 'tmp/run.lock')), false);
    return {...out, report: latest};
  };
  const powerShell = async (mode, origins, at = now) => {
    try { return await run(shell, ['-NoProfile', '-NonInteractive', '-File', path.join(root, 'tmp/chain-runner.ps1'),
      '-Mode', mode, ...(origins?.length ? ['-Origins', origins.join(',')] : [])], at); }
    catch (error) { if (error.code === 'ENOENT') { t.skip('PowerShell unavailable; offline chain requires pwsh'); return null; } throw error; }
  };
  const writePreflight = async (inspections, {at = now, origins = names.map(exampleOrigin)} = {}) => {
    fs.writeFileSync(path.join(root, 'tmp/chain-inspections.json'), JSON.stringify(inspections));
    const out = await powerShell('preflight', origins, at);
    if (!out) return null;
    assert.equal(out.code, 0, out.stdout + out.stderr);
    const bytes = fs.readFileSync(path.join(root, 'tmp/native-waf-preflight.json'));
    assert.notEqual(bytes.subarray(0, 3).toString('hex'), 'efbbbf');
    return json('tmp/native-waf-preflight.json');
  };
  const runIndex = async ({resume = false, at = now} = {}) => report(await run(process.execPath,
    [path.join(root, 'src/index.mjs'), ...(resume ? ['--resume-report', path.join(root, 'logs/latest.json')] : [])], at));
  const runEntry = async (mode, origins) => {
    const out = await powerShell(mode, origins);
    return out ? report(out) : null;
  };
  return {root, profile, config, now, save, json, lines, writePreflight, runIndex, runEntry};
}

export function inspection(status, now, extra = {}) {
  const at = new Date(now).toISOString();
  const businessDate = new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Shanghai'}).format(new Date(at));
  return {status, submissionAttempted: false, reason: 'example inspection',
    ...(['signed', 'already_signed'].includes(status) ? {evidence: {source: 'page_text', authoritative: true, confirmedAt: at, businessDate}} : {}), ...extra};
}
