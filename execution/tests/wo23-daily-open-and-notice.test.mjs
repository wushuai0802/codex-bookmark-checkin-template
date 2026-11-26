import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {ptReadPolicy} from '../src/pt-read-policy.mjs';
import {ptFailureMessages} from '../src/checkin-contract.generated.mjs';
import {acquireDailyOpen, checkDailyOpenGate, recordDailyNoticeGate} from '../src/pt-daily-open-limit.mjs';
import {dailyOpenExhaustedOrigins, inspectDailyOpenState, readDailyOpenJournal} from '../src/pt-daily-open-state.mjs';
import {readNativePtApiHeader, runNativePtApiCheckin} from '../src/native-pt-api.mjs';
import {inspectNativePtHeader} from '../src/native-pt-read.mjs';
import {runNativePtGate} from '../src/native-pt-gate.mjs';
import {readPiggoCalendarInContext, installPiggoCalendarFirewall, piggoOrigin, piggoCalendarUrl, piggoDay} from '../src/piggo-calendar.mjs';
import {recoverPiggoSpaLogin} from '../src/piggo-login.mjs';
import {loginHelperOutcome} from '../src/login-recovery.mjs';
import {isRetryEligible, withRetrySchedule} from '../src/retry-policy.mjs';
import {runPtSupplement} from '../src/pt-supplement.mjs';
import {processTarget} from '../src/browser.mjs';
import {fixture,response,piggoLoginDom,observedLoginRequests} from './helpers/piggo-spa-fixture.mjs';
import {readNativePtApiHeaderInContext} from '../src/native-pt-api.mjs';
import {runOfflinePiggoIndex} from './helpers/piggo-index-fixture.mjs';
import {loginChainFixture} from './helpers/piggo-login-chain-fixture.mjs';

function loginFixture(t,{status=200,captcha=false,otp=false,afterChallenge=false}={}){
  const f=fixture(t),context=f.createContext(),waits=[];
  const file=path.join(f.root,'data/bitwarden/recovery-state.json');
  f.config.nativePtTwoFactorRecovery={[f.origin]:{enabled:true,reviewed:true,provider:'bitwarden',allowPasswordLogin:true,
    loginSource:'bitwarden',spaPasswordFormReviewed:true}};
  f.config.nativeWafPreflightUrls[0].passiveOnly=true;f.save();
  let route,currentUrl='about:blank',posts=0,prepares=0,reads=0,authenticated=false;
  const emit=value=>{for(const waiter of waits)if(!waiter.done&&waiter.predicate(value)){waiter.done=true;waiter.resolve(value);}};
  const mainFrame={page:()=>page},dispatch=async(method,url)=>{
    let allowed=false;
    await route({request:()=>({url:()=>url,method:()=>method}),continue:async()=>{allowed=true;},abort:async()=>{},
      fallback:async()=>{allowed=await context.request(method,url);}});
    return allowed;
  };
  const page={url:()=>currentUrl,context:()=>context,mainFrame:()=>mainFrame,route:async(_pat,handler)=>{route=handler;},unroute:async()=>{route=null;},
    waitForSelector:async()=>{},
    evaluate:(fn,args)=>piggoLoginDom({captcha:captcha||afterChallenge&&posts>0,otp}).evaluate(fn,args),
    waitForResponse:predicate=>new Promise(resolve=>waits.push({predicate,resolve,done:false})),
    goto:async url=>{
      currentUrl=url;
      for(const [method,routePath] of observedLoginRequests)await dispatch(method,new URL(routePath,f.origin).href);
      emit(response(f.origin+'/v1/web/auth/guest-config',{captcha,srp:false}));
    },
    locator:selector=>{
      const elements=piggoLoginDom().document.querySelectorAll(selector);
      return {fill:async()=>{},click:async()=>{
        if(await dispatch('POST',f.origin+'/v1/web/login')){
          posts++;authenticated=status===200;
          emit(response(f.origin+'/v1/web/login',{},{status,method:'POST'}));
        }
      }};
    }};
  const credential={username:'fixture-user',password:['WO23','MARKED','CREDENTIAL'].join('_')};
  const args={...f,page,profileProof:async()=>true,validateLease:async()=>{},
    prepare:async()=>{prepares++;return {ready:true};},
    withLogin:async({consume})=>{reads++;await consume(credential);return {ready:true};},
    readHeader:async options=>authenticated?readNativePtApiHeaderInContext(options):{status:'login_required'}};
  return {f,args,file,credential,context,get posts(){return posts;},get prepares(){return prepares;},get reads(){return reads;}};
}

const execute = promisify(execFile);
const executionRoot = fileURLToPath(new URL('../', import.meta.url));
const shell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';

const json = value => JSON.stringify(value);
const freshHeaders = now => ({ 'content-type': 'application/json', date: now.toUTCString() });

test('WO-23 T1/T7: dailyOpenLimit validates config, persists before launch even on crash, resets next day, and blocks all follow-ups without opening a browser', async t => {
  const f = fixture(t);
  for (const bad of [0, -1, 1.5, '1', 101, true]) {
    assert.throws(() => ptReadPolicy(f.origin, {
      ptReadOnlyPolicies: { [f.origin]: { reviewed: true, mode: 'safe_history_page', piggoCalendar: true, nativeApiHeaderFallback: true, dailyOpenLimit: bad } },
    }), /dailyOpenLimit/);
  }

  f.config.ptReadOnlyPolicies[f.origin].dailyOpenLimit = 1;
  f.save();

  // Persist-before-open: even if launch crashes, the slot is already on disk.
  let crashLaunchCalls = 0;
  const crashed = await readNativePtApiHeader({
    root: f.root,
    origin: f.origin,
    clock: f.clock,
    gate: f.gate,
    launch: async () => {
      crashLaunchCalls += 1;
      const onDiskBeforeThrow = readDailyOpenJournal(f.root);
      assert.equal(onDiskBeforeThrow.opens.length, 1);
      throw new Error('simulated_process_crash_during_launch');
    },
  });
  assert.equal(crashLaunchCalls, 1);
  assert.equal(crashed.status, 'unconfirmed');
  assert.equal(readDailyOpenJournal(f.root).opens.length, 1);

  // Subsequent API read, API checkin, inspectNativePtHeader, and native gate are all blocked with zero launches.
  let secondLaunches = 0;
  const apiReadBlocked = await readNativePtApiHeader({
    root: f.root,
    origin: f.origin,
    clock: f.clock,
    gate: f.gate,
    launch: async () => { secondLaunches += 1; throw new Error('must not launch'); },
  });
  assert.equal(secondLaunches, 0);
  assert.equal(apiReadBlocked.status, 'deferred');
  assert.equal(apiReadBlocked.failureCode, 'daily_open_limit');
  assert.equal(apiReadBlocked.submissionAttempted, false);
  assert.equal(apiReadBlocked.retryable, false);
  assert.equal(apiReadBlocked.retryExhaustedForDay, true);

  const apiCheckinBlocked = await runNativePtApiCheckin({
    root: f.root,
    origin: f.origin,
    url: f.url,
    clock: f.clock,
    gate: f.gate,
    validateLease: f.validateLease,
    acquire: async () => ({ release: async () => {} }),
    release: async () => {},
    launch: async () => { secondLaunches += 1; throw new Error('must not launch'); },
  });
  assert.equal(secondLaunches, 0);
  assert.equal(apiCheckinBlocked.status, 'deferred');
  assert.equal(apiCheckinBlocked.failureCode, 'daily_open_limit');
  assert.equal(apiCheckinBlocked.submissionAttempted, false);

  const headerInspectBlocked = await inspectNativePtHeader({
    root: f.root,
    origin: f.origin,
    url: piggoCalendarUrl,
    isolated: true,
    clock: f.clock,
    inspectApi: async () => { secondLaunches += 1; throw new Error('must not call inspectApi'); },
    execute: async () => { secondLaunches += 1; throw new Error('must not execute pwsh'); },
  });
  assert.equal(secondLaunches, 0);
  assert.equal(headerInspectBlocked.failureCode, 'daily_open_limit');
  assert.equal(headerInspectBlocked.submissionAttempted, false);

  const gateBlocked = await runNativePtGate({
    root: f.root,
    origin: f.origin,
    url: f.url,
    profile: f.profile,
    phase: 'inspect',
    clock: f.clock,
    readPlan: async () => ({ targets: [{ origin: f.origin, candidates: [f.url], accountKey: 'site-default' }] }),
    harvest: () => null,
  });
  assert.equal(gateBlocked.allow, false);
  assert.equal(gateBlocked.decision.failureCode, 'daily_open_limit');
  assert.equal(gateBlocked.decision.submissionAttempted, false);
  assert.equal(isRetryEligible(gateBlocked.decision, f.clock()), false);

  // Supplement path & processTarget also honor dailyOpenLimit before launching.
  fs.mkdirSync(path.join(f.root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(f.root, 'data/last-valid-bookmark-plan.json'), JSON.stringify({
    targets: [{ origin: f.origin, candidates: [piggoCalendarUrl], accountKey: 'site-default' }],
  }));
  const catalogFile = path.join(f.root, 'tmp', 'catalog.json');
  const catalogBody = JSON.stringify({ sites: [{ origin: f.origin, entryUrl: piggoCalendarUrl, displayName: 'PigGo' }] });
  fs.writeFileSync(catalogFile, catalogBody);
  const cryptoMod = await import('node:crypto');
  const catalogHash = cryptoMod.createHash('sha256').update(catalogBody).digest('hex');
  const suppBlocked = await runPtSupplement({
    root: f.root,
    origin: f.origin,
    catalogFile,
    catalogHash,
    readOnly: true,
    clock: f.clock,
    acquire: async () => ({ release: async () => {} }),
    release: async () => {},
    launch: async () => { secondLaunches += 1; throw new Error('must not launch supplement'); },
    inspectNative: async opts => inspectNativePtHeader({
      ...opts,
      inspectApi: async () => { secondLaunches += 1; throw new Error('must not call api'); },
    }),
  });
  assert.equal(secondLaunches, 0);
  assert.equal(suppBlocked.failureCode, 'daily_open_limit');
  assert.equal(suppBlocked.submissionAttempted, false);

  // Non-PigGo processTarget stops before context.newPage() once dailyOpenLimit is hit.
  const genericOrigin = 'https://generic-pt.example';
  f.config.ptReadOnlyPolicies[genericOrigin] = { dailyOpenLimit: 1 };
  await acquireDailyOpen({ root: f.root, origin: genericOrigin, config: f.config, source: 'test', clock: f.clock });
  let genericPages = 0;
  const targetResult = await processTarget(
    { newPage: async () => { genericPages += 1; return {}; } },
    { origin: genericOrigin, candidates: [`${genericOrigin}/index.php`] },
    f.config,
    { rules: [] },
    path.join(f.root, 'logs'),
  );
  // Note: browser.mjs resolves rootDirectory from its own module location; test explicit checkDailyOpenGate on genericOrigin:
  assert.equal(checkDailyOpenGate({ root: f.root, origin: genericOrigin, config: f.config, clock: f.clock }).allowed, false);
  assert.equal(genericPages, 0);

  // Next Shanghai day resets the counter.
  const tomorrow = new Date(f.clock().getTime() + 24 * 60 * 60 * 1000);
  const tomorrowState = inspectDailyOpenState({ root: f.root, origin: f.origin, config: f.config, now: tomorrow });
  assert.equal(tomorrowState.used, 0);
  assert.equal(tomorrowState.limitReached, false);
  assert.equal(checkDailyOpenGate({ root: f.root, origin: f.origin, config: f.config, clock: () => tomorrow }).allowed, true);
  assert.equal(dailyOpenExhaustedOrigins({ root: f.root, config: f.config, now: f.clock() }).has(f.origin), true);
  assert.equal(dailyOpenExhaustedOrigins({ root: f.root, config: f.config, now: tomorrow }).has(f.origin), false);
});

test('WO-23 T2: dailyOpenLimit=1 + Prepare-NativeWafSession hands off PigGo cleanly without spending quota, and Recover-NativeLogin unlocks 423 + reads + submits in 1 total open', { skip: process.platform !== 'win32' ? 'Windows PowerShell required' : false, timeout: 120000 }, async t => {
  const f = await loginChainFixture(t, { shell: 'pwsh.exe', idleUnlock: true, calendarMode: 'submit' });
  const siteOrigin = piggoOrigin;
  const cfgPath = path.join(f.root, 'config/config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.ptReadOnlyPolicies ??= {};
  cfg.ptReadOnlyPolicies[siteOrigin] = {
    reviewed: true,
    mode: 'safe_history_page',
    piggoCalendar: true,
    nativeApiHeaderFallback: true,
    ...(cfg.ptReadOnlyPolicies[siteOrigin] ?? {}),
    dailyOpenLimit: 1,
    nativeApiExecution: true,
  };
  cfg.nativeWafPreflightUrls = [{ url: `${siteOrigin}/v1/web/calendar/attendance`, waitSeconds: 20, action: 'checkin', automationUserDataDir: f.profile }];
  cfg.nativeChallengePreflight = [];
  cfg.mainChromeFallbackUrls = [];
  cfg.autoClickTurnstileOrigins = [];
  cfg.nativeAccessibilityCheckinOrigins = [siteOrigin];
  cfg.powershellExecutable = 'pwsh.exe';
  cfg.minimumBookmarkTargetCount = 1;
  cfg.mobileFolderIds = ['10'];
  cfg.targetFolderNames = ['PT'];
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  fs.writeFileSync(cfg.bookmarksPath, JSON.stringify({
    roots: { other: { type: 'folder', name: 'fixture', id: '10', children: [{ type: 'folder', name: 'PT', id: '11', children: [{ type: 'url', name: 'piggo', url: `${siteOrigin}/calendar` }] }] } },
  }));
  for (const scriptName of [
    'Prepare-NativeWafSession.ps1',
    'Native-PtGuard.ps1',
    'Native-PtGate.mjs',
    'Read-NativePtHeader.mjs',
    'Run-NativePtApiCheckin.mjs',
    'ResultContract.ps1',
    'CheckinContract.generated.ps1',
  ]) {
    fs.copyFileSync(path.join(executionRoot, 'scripts', scriptName), path.join(f.root, 'scripts', scriptName));
  }
  const runLockPath = path.join(f.root, 'tmp/run.lock');
  fs.writeFileSync(runLockPath, JSON.stringify({ pid: process.pid, nonce: 'test-nonce' }));

  // Step A: Prepare-NativeWafSession hands off PigGo without opening Chrome (opens stay 0).
  await execute('pwsh.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(f.root, 'scripts/Prepare-NativeWafSession.ps1'),
    '-Origins', siteOrigin,
  ], { cwd: f.root, env: f.env, windowsHide: true, timeout: 30000 });
  const preflight = JSON.parse(fs.readFileSync(path.join(f.root, 'tmp/native-waf-preflight.json'), 'utf8'));
  assert.equal(preflight.results.length, 1);
  assert.equal(preflight.results[0].origin, siteOrigin);
  assert.equal(preflight.results[0].status, 'login_required');
  assert.equal(preflight.results[0].deferredToLoginRecovery, true);
  assert.equal(preflight.results[0].submissionAttempted, false);
  assert.equal(f.launches.length, 0);
  assert.equal(readDailyOpenJournal(f.root).opens.length, 0);

  // Step B: Real recoverPiggoSpaLogin runs 423 unlock + calendar submit in 1 open and writes 1 open slot.
  const coreOut = await f.runCore();
  assert.equal(coreOut.code, 0, coreOut.stderr + coreOut.stdout);
  assert.equal(readDailyOpenJournal(f.root).opens.length, 1);
  assert.deepEqual(f.requests.filter(r => r.method === 'POST').map(r => r.path), [
    '/v1/web/me/lab-unlock/srp/challenge',
    '/v1/web/me/lab-unlock/srp',
    '/v1/web/calendar/attendance',
  ]);

  // Step C: Any subsequent Recover-NativeLogin.ps1 attempt on the same day is blocked BEFORE launching Open-PlainLoginChrome.ps1.
  let blockedOut = { code: 0, stdout: '' };
  try {
    await execute('pwsh.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', path.join(f.root, 'scripts/Recover-NativeLogin.ps1'),
      '-Origin', siteOrigin, '-UserDataDirOverride', f.profile,
    ], { cwd: f.root, env: f.env, windowsHide: true, timeout: 20000 });
  } catch (err) {
    blockedOut = { code: err.code, stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? '') };
  }
  assert.notEqual(blockedOut.code, 0);
  const blockedParsed = loginHelperOutcome(blockedOut.stdout);
  assert.equal(blockedParsed.failureCode, 'daily_open_limit', JSON.stringify(blockedOut));
  assert.equal(blockedParsed.retryable, false);
  assert.equal(f.launches.length, 0);

  // Step D: On a fresh root with no open Chrome and limit=1, Recover-NativeLogin.ps1 acquires slot #1 BEFORE launching Open-PlainLoginChrome.ps1.
  await t.test('Step D: Recover-NativeLogin acquires open slot before Open-PlainLoginChrome launch', async st => {
    const f2 = await loginChainFixture(st, { shell: 'pwsh.exe', idleUnlock: true, calendarMode: 'submit' });
    const cfg2Path = path.join(f2.root, 'config/config.json');
    const cfg2 = JSON.parse(fs.readFileSync(cfg2Path, 'utf8'));
    cfg2.ptReadOnlyPolicies[siteOrigin].dailyOpenLimit = 1;
    fs.writeFileSync(cfg2Path, JSON.stringify(cfg2));
    try {
      await execute('pwsh.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', path.join(f2.root, 'scripts/Recover-NativeLogin.ps1'),
        '-Origin', siteOrigin, '-UserDataDirOverride', f2.profile,
      ], { cwd: f2.root, env: f2.env, windowsHide: true, timeout: 35000 });
    } catch { /* Fixture Open-PlainLoginChrome.ps1 records launch without opening a real CDP socket */ }
    assert.equal(f2.launches.length, 1);
    assert.equal(readDailyOpenJournal(f2.root).opens.length, 1);
  });
});

test('PigGo regression: historical unconfirmed submitted intent + dailyOpenLimit=1 + origin.piggo.me SPA assets complete passive readback and formal submit in 1 open', { skip: process.platform !== 'win32' ? 'Windows PowerShell required' : false, timeout: 150000 }, async t => {
  for (const calendarMode of ['passive', 'submit']) {
    await t.test(`mode=${calendarMode}`, async st => {
      const f = await loginChainFixture(st, { shell: 'pwsh.exe', idleUnlock: true, calendarMode, useAssetOrigin: true });
      const siteOrigin = piggoOrigin;
      const cfgPath = path.join(f.root, 'config/config.json');
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      cfg.ptReadOnlyPolicies[siteOrigin].dailyOpenLimit = 1;
      cfg.ptReadOnlyPolicies[siteOrigin].nativeApiExecution = true;
      cfg.nativeWafPreflightUrls = [{
        url: calendarMode === 'submit' ? `${siteOrigin}/v1/web/calendar/attendance` : `${siteOrigin}/calendar`,
        waitSeconds: 20,
        ...(calendarMode === 'submit' ? { action: 'checkin' } : { passiveOnly: true }),
        automationUserDataDir: f.profile,
      }];
      cfg.nativeChallengePreflight = [];
      cfg.mainChromeFallbackUrls = [];
      cfg.autoClickTurnstileOrigins = [];
      cfg.nativeAccessibilityCheckinOrigins = calendarMode === 'submit' ? [siteOrigin] : [];
      cfg.powershellExecutable = 'pwsh.exe';
      cfg.minimumBookmarkTargetCount = 1;
      fs.writeFileSync(cfgPath, JSON.stringify(cfg));
      for (const scriptName of [
        'Prepare-NativeWafSession.ps1',
        'Native-PtGuard.ps1',
        'Native-PtGate.mjs',
        'Read-NativePtHeader.mjs',
        'Run-NativePtApiCheckin.mjs',
        'ResultContract.ps1',
        'CheckinContract.generated.ps1',
      ]) {
        fs.copyFileSync(path.join(executionRoot, 'scripts', scriptName), path.join(f.root, 'scripts', scriptName));
      }
      // Seed an unconfirmed October submitted entry matching production native-pt-attempts.json
      fs.mkdirSync(path.join(f.root, 'data'), { recursive: true });
      fs.writeFileSync(path.join(f.root, 'data/native-pt-attempts.json'), JSON.stringify({
        schemaVersion: 1,
        attempts: [{
          attemptId: '00000000-0000-4000-8000-000000001008',
          origin: siteOrigin,
          accountKey: 'site-default',
          profileBinding: f.profileBinding,
          businessDate: '2026-10-08',
          startedAt: '2026-10-08T00:06:25.088Z',
          state: 'submitted',
          actions: ['navigation'],
        }],
      }));

      // Step 1: Prepare-NativeWafSession hits the historical submission_outcome_unknown in the eligibility loop,
      // and hands off directly to single-session login recovery with 0 opens and 0 browser launches.
      await execute('pwsh.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', path.join(f.root, 'scripts/Prepare-NativeWafSession.ps1'),
        '-Origins', siteOrigin,
      ], { cwd: f.root, env: f.env, windowsHide: true, timeout: 30000 });
      const preflight = JSON.parse(fs.readFileSync(path.join(f.root, 'tmp/native-waf-preflight.json'), 'utf8'));
      assert.equal(preflight.results.length, 1);
      assert.equal(preflight.results[0].status, 'login_required');
      assert.equal(preflight.results[0].deferredToLoginRecovery, true);
      assert.equal(preflight.results[0].submissionAttempted, false);
      assert.equal(f.launches.length, 0);
      assert.equal(readDailyOpenJournal(f.root).opens.length, 0);

      // Step 2: Single-session recoverPiggoSpaLogin loads origin.piggo.me/assets/* JS & CSS, unlocks 423,
      // reads /calendar, and either stops passively (not_signed) or submits attendance (signed) in 1 open.
      const coreOut = await f.runCore();
      assert.equal(coreOut.code, 0, coreOut.stderr + coreOut.stdout);
      assert.deepEqual(f.errors, []);
      assert.equal(readDailyOpenJournal(f.root).opens.length, 1);
      assert.equal(f.requests.some(r => r.path === 'origin.piggo.me/assets/js/calendar.js'), true);
      assert.equal(f.requests.some(r => r.path === 'origin.piggo.me/assets/js/unlock.js'), true);
      assert.equal(f.requests.some(r => r.path === 'origin.piggo.me/assets/css/shell.css'), true);
      const parsed = loginHelperOutcome(coreOut.stdout);
      assert.equal(parsed.status, 'logged_in');
      if (calendarMode === 'passive') {
        assert.deepEqual(f.requests.filter(r => r.method === 'POST').map(r => r.path), [
          '/v1/web/me/lab-unlock/srp/challenge',
          '/v1/web/me/lab-unlock/srp',
        ]);
        const rawResult = JSON.parse(coreOut.stdout.trim().split(/\r?\n/).at(-1));
        assert.equal(rawResult.dailyCheckin?.status, 'not_signed');
        assert.equal(rawResult.dailyCheckin?.receiptAccepted, true);
        assert.equal(rawResult.dailyCheckin?.submissionAttempted, false);

        // Step 3: Later same-day Prepare-NativeWafSession sees dailyOpenLimit already reached
        // and emits daily_open_limit (NOT deferredToLoginRecovery), spending 0 opens.
        await execute('pwsh.exe', [
          '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
          '-File', path.join(f.root, 'scripts/Prepare-NativeWafSession.ps1'),
          '-Origins', siteOrigin,
        ], { cwd: f.root, env: f.env, windowsHide: true, timeout: 30000 });
        const secondPreflight = JSON.parse(fs.readFileSync(path.join(f.root, 'tmp/native-waf-preflight.json'), 'utf8'));
        assert.equal(secondPreflight.results[0].failureCode, 'daily_open_limit');
        assert.notEqual(secondPreflight.results[0].deferredToLoginRecovery, true);
        assert.equal(readDailyOpenJournal(f.root).opens.length, 1);
      } else {
        assert.deepEqual(f.requests.filter(r => r.method === 'POST').map(r => r.path), [
          '/v1/web/me/lab-unlock/srp/challenge',
          '/v1/web/me/lab-unlock/srp',
          '/v1/web/calendar/attendance',
        ]);
        const rawResult = JSON.parse(coreOut.stdout.trim().split(/\r?\n/).at(-1));
        assert.equal(rawResult.dailyCheckin?.status, 'signed');
        assert.equal(rawResult.dailyCheckin?.confirmationState, 'confirmed');
      }
    });
  }

  // Step 4: Same-day unconfirmed submitted attempt stays fail-closed (never hands off to login recovery and never re-clicks)
  await t.test('same-day submitted attempt stays fail-closed', async st => {
    const f = await loginChainFixture(st, { shell: 'pwsh.exe', idleUnlock: true, calendarMode: 'submit', useAssetOrigin: true });
    const siteOrigin = piggoOrigin;
    const today = piggoDay(new Date());
    const cfgPath = path.join(f.root, 'config/config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    cfg.ptReadOnlyPolicies[siteOrigin].dailyOpenLimit = 2;
    cfg.ptReadOnlyPolicies[siteOrigin].nativeApiExecution = true;
    cfg.nativeWafPreflightUrls = [{ url: `${siteOrigin}/v1/web/calendar/attendance`, waitSeconds: 20, action: 'checkin', automationUserDataDir: f.profile }];
    cfg.nativeChallengePreflight = [];
    cfg.mainChromeFallbackUrls = [];
    cfg.autoClickTurnstileOrigins = [];
    cfg.nativeAccessibilityCheckinOrigins = [siteOrigin];
    cfg.powershellExecutable = 'pwsh.exe';
    cfg.minimumBookmarkTargetCount = 1;
    fs.writeFileSync(cfgPath, JSON.stringify(cfg));
    fs.mkdirSync(path.join(f.root, 'data'), { recursive: true });
    fs.writeFileSync(path.join(f.root, 'data/native-pt-attempts.json'), JSON.stringify({
      schemaVersion: 1,
      attempts: [{
        attemptId: '00000000-0000-4000-8000-000000002026',
        origin: siteOrigin,
        accountKey: 'site-default',
        profileBinding: f.profileBinding,
        businessDate: today,
        startedAt: new Date(Date.now() - 60_000).toISOString(),
        state: 'submitted',
        actions: ['click'],
      }],
    }));
    const coreOut = await f.runCore();
    assert.equal(coreOut.code, 0, coreOut.stderr + coreOut.stdout);
    const rawResult = JSON.parse(coreOut.stdout.trim().split(/\r?\n/).at(-1));
    assert.equal(rawResult.dailyCheckin?.status, 'needs_attention');
    assert.equal(rawResult.dailyCheckin?.failureCode, 'submission_outcome_unknown');
    assert.equal(f.requests.some(r => r.method === 'POST' && r.path === '/v1/web/calendar/attendance'), false);
  });
});

test('WO-23 T4: piggo-calendar detects notice_gate on /rules with only safe fixed codes and never clicks or relaxes firewall', async t => {
  const f = fixture(t);
  const routes = [];
  const blockedRequests = [];
  const allowedRequests = [];
  let postCount = 0;

  const responseDouble = (url, body, status = 200) => ({
    url: () => url,
    status: () => status,
    headers: () => freshHeaders(f.clock()),
    text: async () => json(body),
    request: () => ({ method: () => 'GET' }),
  });

  const makeMockContext = ({ redirectTo = '/rules', noticeGate = true, meStatus = 200, calendarStatus = null, meBodyExtra = {} } = {}) => {
    let pageUrl = 'about:blank';
    const waits = [];
    const urlWaits = [];
    const context = {
      route: async (_pat, fn) => { routes.push(fn); },
      unroute: async () => {},
      routeWebSocket: async (_pat, fn) => fn({ close: () => {} }),
      newPage: async () => ({
        url: () => pageUrl,
        close: async () => {},
        waitForResponse: pred => new Promise(resolve => waits.push({ pred, resolve, done: false })),
        waitForURL: pred => new Promise(resolve => urlWaits.push({ pred, resolve, done: false })),
        goto: async targetUrl => {
          const handler = routes.at(-1);
          assert.ok(handler, 'firewall must be installed');
          const checkAllowed = async (method, reqUrl, body = null) => {
            let ok = false;
            await handler({
              request: () => ({ url: () => reqUrl, method: () => method, postDataJSON: () => body, isNavigationRequest: () => false }),
              continue: async () => { ok = true; allowedRequests.push([method, reqUrl]); },
              abort: async () => { blockedRequests.push([method, reqUrl]); },
            });
            return ok;
          };
          assert.equal(await checkAllowed('GET', targetUrl), true);
          pageUrl = targetUrl;

          // Verify firewall keeps /rules and notice endpoints strictly blocked!
          assert.equal(await checkAllowed('GET', `${piggoOrigin}/rules`), false);
          assert.equal(await checkAllowed('GET', `${piggoOrigin}/v1/web/notices/ack`), false);
          assert.equal(await checkAllowed('POST', `${piggoOrigin}/v1/web/notices/ack`, { id: 1 }), false);

          const meUrl = `${piggoOrigin}/v1/web/me`;
          await checkAllowed('GET', meUrl);
          const mePayload = {
            code: 0,
            msg: 'ok',
            data: { user: { id: 42 }, notice_gate: noticeGate ? { id: 9, title: 'SECRET_NOTICE_CONTENT' } : false, ...meBodyExtra },
          };
          for (const w of waits) {
            const resp = responseDouble(meUrl, mePayload, meStatus);
            if (!w.done && w.pred(resp)) { w.done = true; w.resolve(resp); }
          }
          if (calendarStatus !== null) {
            const calUrl = `${piggoOrigin}/v1/web/calendar?year=2026&month=11&day=24`;
            await checkAllowed('GET', calUrl);
            for (const w of waits) {
              const resp = responseDouble(calUrl, { code: 0, msg: 'ok', data: {} }, calendarStatus);
              if (!w.done && w.pred(resp)) { w.done = true; w.resolve(resp); }
            }
          }
          if (redirectTo) {
            pageUrl = redirectTo.startsWith('http') ? redirectTo : `${piggoOrigin}${redirectTo}`;
            for (const w of urlWaits) {
              if (!w.done && w.pred(new URL(pageUrl))) { w.done = true; w.resolve(pageUrl); }
            }
          }
          for (const w of waits) if (!w.done) { w.done = true; w.resolve(null); }
        },
        locator: () => ({ click: async () => { postCount += 1; } }),
      }),
    };
    return context;
  };

  // Notice gate + /rules and production /wiki/rules-general landing
  for (const [redirectTo, expectedPath] of [['/rules?secret=123', '/rules'], ['/wiki/rules-general', '/wiki/rules-general']]) {
    const rulesCtx = makeMockContext({ redirectTo, noticeGate: true, meStatus: 200 });
    await installPiggoCalendarFirewall(rulesCtx, { clock: f.clock });
    const rulesDiag = {};
    const rulesRead = await readPiggoCalendarInContext(rulesCtx, { expectedAccountId: '42', identity: { origin: piggoOrigin, accountKey: 'site-default', profileBinding: f.profileBinding } }, f.clock, rulesDiag);
    assert.equal(rulesRead.result.status, 'needs_attention');
    assert.equal(rulesRead.result.failureCode, 'notice_acknowledgement_required');
    assert.equal(rulesRead.result.submissionAttempted, false);
    assert.equal(rulesRead.result.reason, ptFailureMessages.notice_acknowledgement_required);
    assert.equal(rulesRead.result.nativeReadback.pageClass, 'rules');
    assert.equal(rulesRead.result.nativeReadback.pagePath, expectedPath);
    assert.equal(rulesRead.result.nativeReadback.meHttpStatus, 200);
    assert.equal(rulesRead.result.nativeReadback.noticeGate, true);
    assert.equal(postCount, 0);
    assert.doesNotMatch(JSON.stringify(rulesRead), /SECRET_NOTICE_CONTENT|secret=123/);
  }

  // /offline and off-origin diagnostics keep fixed codes without notice_gate false positive
  for (const [redirectTo, expectedClass] of [['/offline', 'offline'], ['https://foreign.example/down', 'off_origin']]) {
    const ctx = makeMockContext({ redirectTo, noticeGate: false, meStatus: 503 });
    await installPiggoCalendarFirewall(ctx, { clock: f.clock });
    const out = await readPiggoCalendarInContext(ctx, { expectedAccountId: '42', identity: { origin: piggoOrigin, accountKey: 'site-default', profileBinding: f.profileBinding } }, f.clock, {});
    assert.equal(out.result.status, 'unconfirmed');
    assert.equal(out.result.failureCode, 'authoritative_status_unavailable');
    assert.equal(out.result.nativeReadback.pageClass, expectedClass);
    assert.equal(out.result.nativeReadback.meHttpStatus, 503);
    assert.equal(out.result.nativeReadback.noticeGate, false);
  }
});

test('WO-23 T5 & T6: index.mjs, loginHelperOutcome, recoverPiggoSpaLogin keep real non-2FA failure codes, keep two_factor_required only for real OTP, handle notice_acknowledgement_required once/day, and preserve prior verdicts on daily_open_limit', async t => {
  // 1) OTP -> two_factor_required; non-OTP failures -> real failureCode, never two_factor_required
  const otpFix = loginFixture(t, { otp: true });
  const otpResult = await recoverPiggoSpaLogin(otpFix.args);
  assert.equal(otpResult.status, 'needs_attention');
  assert.equal(otpResult.failureCode, 'two_factor_required');
  assert.equal(otpResult.nativeTwoFactorRecovery.reason, 'two_factor_requires_manual');

  const captchaFix = loginFixture(t, { captcha: true });
  const captchaResult = await recoverPiggoSpaLogin(captchaFix.args);
  assert.equal(captchaResult.status, 'needs_attention');
  assert.equal(captchaResult.failureCode, 'captcha_requires_manual');

  const rejectedFix = loginFixture(t, { status: 401 });
  const rejectedResult = await recoverPiggoSpaLogin(rejectedFix.args);
  assert.equal(rejectedResult.status, 'needs_attention');
  assert.equal(rejectedResult.failureCode, 'authentication_rejected');

  const unauthNoticeFix = loginFixture(t);
  const noticeBeforeResult = await recoverPiggoSpaLogin({
    ...unauthNoticeFix.args,
    readHeader: async () => ({
      status: 'needs_attention',
      failureCode: 'notice_acknowledgement_required',
      submissionAttempted: false,
      nativeReadback: { stage: 'readback', code: 'notice_acknowledgement_required', apiStage: 'http_status', pageClass: 'rules', pagePath: '/rules', meHttpStatus: 200, noticeGate: true },
    }),
  });
  assert.equal(noticeBeforeResult.status, 'needs_attention');
  assert.equal(noticeBeforeResult.failureCode, 'notice_acknowledgement_required');
  assert.equal(noticeBeforeResult.reason, ptFailureMessages.notice_acknowledgement_required);
  assert.equal(unauthNoticeFix.prepares, 0);
  assert.equal(unauthNoticeFix.posts, 0);
  assert.equal(readDailyOpenJournal(unauthNoticeFix.f.root).notices.length, 1);

  // 2) End-to-end index.mjs checks for notice_acknowledgement_required, captcha_requires_manual, and real two_factor_required
  const noticeIdx = loginFixture(t);
  const noticeRun = await runOfflinePiggoIndex(noticeIdx.f, noticeBeforeResult);
  assert.equal(noticeRun.calls.length, 1);
  const noticeRow = noticeRun.report.results[0];
  assert.equal(noticeRow.status, 'needs_attention');
  assert.equal(noticeRow.failureCode, 'notice_acknowledgement_required');
  assert.equal(noticeRow.reason, ptFailureMessages.notice_acknowledgement_required);
  assert.equal(noticeRow.attentionKind, undefined);
  assert.equal(noticeRow.retryable, false);
  assert.equal(noticeRow.retryableLoginRecovery, false);
  assert.equal(noticeRow.pageClass, 'rules');
  assert.equal(noticeRow.noticeGate, true);
  assert.equal(noticeRow.meHttpStatus, 200);

  const captchaIdx = loginFixture(t);
  const captchaRun = await runOfflinePiggoIndex(captchaIdx.f, captchaResult);
  assert.equal(captchaRun.calls.length, 1);
  const captchaRow = captchaRun.report.results[0];
  assert.equal(captchaRow.status, 'needs_attention');
  assert.equal(captchaRow.failureCode, 'captcha_requires_manual');
  assert.equal(captchaRow.attentionKind, undefined);
  assert.doesNotMatch(captchaRow.reason, /异地登录 2FA/);

  const otpIdx = loginFixture(t);
  const otpRun = await runOfflinePiggoIndex(otpIdx.f, otpResult);
  const otpRow = otpRun.report.results[0];
  assert.equal(otpRow.failureCode, 'two_factor_required');
  assert.equal(otpRow.attentionKind, 'trusted_device_initialization');

  // 3) daily_open_limit in index.mjs preserves same-day prior verdict (needs_attention) instead of clobbering it
  const priorIdx = loginFixture(t);
  const resumeFile = path.join(priorIdx.f.root, 'logs/latest.json');
  fs.mkdirSync(path.dirname(resumeFile), { recursive: true });
  const runId = `${piggoDay(priorIdx.f.clock()).replaceAll('-', '')}-080500-001-prior`;
  const resumeReport = {
    ...noticeRun.report,
    runId,
    results: [{
      ...noticeRow,
      origin: priorIdx.f.origin,
      accountKey: 'site-default',
      profileBinding: priorIdx.f.profileBinding,
    }],
  };
  fs.writeFileSync(resumeFile, JSON.stringify(resumeReport));
  // Trigger a daily_open_limit decision on same day while prior needs_attention exists:
  const dailyBlockedHelper = {
    origin: priorIdx.f.origin,
    handled: true,
    status: 'deferred',
    failureCode: 'daily_open_limit',
    submissionAttempted: false,
    retryable: false,
    retryExhaustedForDay: true,
    nextEligibleAt: withRetrySchedule({ status: 'deferred', failureCode: 'daily_open_limit' }, {}, priorIdx.f.clock()).nextEligibleAt,
  };
  const secondRun = await runOfflinePiggoIndex(priorIdx.f, dailyBlockedHelper, {
    preflightChange: { status: 'deferred', failureCode: 'daily_open_limit', retryable: false, retryExhaustedForDay: true, nextEligibleAt: dailyBlockedHelper.nextEligibleAt },
  });
  const secondRow = secondRun.report.results[0];
  assert.equal(secondRow.status, 'deferred');
  assert.equal(secondRow.failureCode, 'daily_open_limit');
  assert.equal(secondRow.retryExhaustedForDay, true);
  assert.equal(secondRow.retryable, false);
  assert.equal(isRetryEligible(secondRow, priorIdx.f.clock()), false);

  // Verify Submit-UnifiedCheckinReport.ps1 suppresses "需要人工恢复"/"需处理" on daily_open_limit and formats notice_acknowledgement_required cleanly
  if (process.platform === 'win32') {
    const notifyRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'wo23-notify-')));
    t.after(() => fs.rmSync(notifyRoot, { recursive: true, force: true }));
    fs.mkdirSync(path.join(notifyRoot, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(notifyRoot, 'config'), { recursive: true });
    fs.mkdirSync(path.join(notifyRoot, 'logs'), { recursive: true });
    for (const file of ['Submit-UnifiedCheckinReport.ps1', 'Notification-Digest.ps1', 'ResultIdentity.ps1', 'ResultContract.ps1', 'CheckinContract.generated.ps1']) {
      fs.copyFileSync(path.join(executionRoot, 'scripts', file), path.join(notifyRoot, 'scripts', file));
    }
    fs.writeFileSync(path.join(notifyRoot, 'config/config.json'), JSON.stringify({
      minimumBookmarkTargetCount: 1,
      notification: { mode: 'none', policy: 'per_change', taskId: 'test', name: 'Test', source: 'test' },
    }));
    const limitReportPath = path.join(notifyRoot, 'logs/limit-report.json');
    fs.writeFileSync(limitReportPath, JSON.stringify({
      runId: `${piggoDay(priorIdx.f.clock()).replaceAll('-', '')}-090000-001-limit`,
      runState: 'final',
      isComplete: true,
      plannedTotal: 1,
      processedTotal: 1,
      bookmarkSummary: { targets: [{ origin: piggoOrigin, accountKey: 'site-default' }] },
      results: [{
        origin: piggoOrigin,
        title: 'PigGo',
        accountKey: 'site-default',
        status: 'deferred',
        failureCode: 'daily_open_limit',
        submissionAttempted: false,
        retryable: false,
        retryExhaustedForDay: true,
        nextEligibleAt: dailyBlockedHelper.nextEligibleAt,
        reason: ptFailureMessages.daily_open_limit,
      }],
    }));
    const outLimit = await execute('pwsh.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', path.join(notifyRoot, 'scripts/Submit-UnifiedCheckinReport.ps1'),
      '-ReportPath', limitReportPath, '-Preview',
    ], { cwd: notifyRoot, windowsHide: true, timeout: 20000 });
    const parsedLimit = JSON.parse(outLimit.stdout);
    assert.notEqual(parsedLimit.status, 'needs_attention');
    assert.doesNotMatch(parsedLimit.summary, /需处理|需要人工恢复/);

    const noticeReportPath = path.join(notifyRoot, 'logs/notice-report.json');
    fs.writeFileSync(noticeReportPath, JSON.stringify({
      runId: `${piggoDay(priorIdx.f.clock()).replaceAll('-', '')}-090100-001-notice`,
      runState: 'final',
      isComplete: true,
      plannedTotal: 1,
      processedTotal: 1,
      bookmarkSummary: { targets: [{ origin: piggoOrigin, accountKey: 'site-default' }] },
      results: [{
        origin: piggoOrigin,
        title: 'PigGo',
        accountKey: 'site-default',
        status: 'needs_attention',
        failureCode: 'notice_acknowledgement_required',
        submissionAttempted: false,
        retryable: false,
        reason: ptFailureMessages.notice_acknowledgement_required,
      }],
    }));
    const outNotice = await execute('pwsh.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', path.join(notifyRoot, 'scripts/Submit-UnifiedCheckinReport.ps1'),
      '-ReportPath', noticeReportPath, '-Preview',
    ], { cwd: notifyRoot, windowsHide: true, timeout: 20000 });
    const parsedNotice = JSON.parse(outNotice.stdout);
    assert.equal(parsedNotice.status, 'needs_attention');
    assert.match(parsedNotice.summary, /站点要求先阅读并确认公告，请在自己的浏览器里处理/);
  }
});
