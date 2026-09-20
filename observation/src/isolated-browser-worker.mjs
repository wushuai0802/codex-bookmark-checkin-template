import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {setTimeout as sleep} from 'node:timers/promises';
import {createRequire} from 'node:module';
import {runObservedTask} from './task-coordinator.mjs';
import {validateProfileHandoff} from './profile-handoff.mjs';

function safeProfilePath(profileDir, dedicatedRoot, accountKey) {
  const profile = path.resolve(String(profileDir ?? ''));
  const root = path.resolve(String(dedicatedRoot ?? ''));
  if (!profile || !root || profile === root) throw Error('dedicated browser profile is required');
  const relative = path.relative(root, profile);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw Error('browser profile is outside dedicated root');
  if (/chrome[\\/](user data|default)|\\Google\\Chrome\\User Data[\\/]/i.test(profile)) throw Error('user Chrome profile is forbidden');
  const accountRoot=path.resolve(root,'data','v2-profiles',String(accountKey??''));
  const accountRelative=path.relative(accountRoot,profile);
  if(!accountKey||!accountRelative||accountRelative.startsWith('..')||path.isAbsolute(accountRelative))throw Error('browser profile is not bound to its V2 account');
  return profile;
}

function browserArgs(windowMode) {
  const common=['--profile-directory=Default','--no-first-run','--no-default-browser-check','--disable-component-update','--disable-features=OptimizationGuideOnDeviceModel','--force-renderer-accessibility','--disable-background-timer-throttling','--disable-backgrounding-occluded-windows','--disable-renderer-backgrounding'];
  if (windowMode === 'offscreen') return [...common,'--window-position=-32000,-32000', '--window-size=1400,900'];
  if (windowMode === 'minimized') return [...common,'--start-minimized', '--window-size=1400,900'];
  throw Error('window mode must be offscreen or minimized');
}

export async function launchNativeBrowser(profile, executablePath, windowMode, url) {
  const server=net.createServer();await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const port=server.address().port;await new Promise(resolve=>server.close(resolve));
  const child=spawn(executablePath,[`--user-data-dir=${profile}`,`--remote-debugging-port=${port}`,'--remote-debugging-address=127.0.0.1',`--remote-allow-origins=http://127.0.0.1:${port}`,...browserArgs(windowMode),url],{windowsHide:true,stdio:'ignore'});
  let spawnError=null;child.on('error',error=>{spawnError=error;});
  const require=createRequire(import.meta.url),{chromium}=require('playwright-core');let browser=null,lastError;
  try { for(let attempt=0;attempt<50;attempt++){if(child.exitCode!==null)throw Error('native Chrome exited before CDP attach');try{browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`,{timeout:1000});break;}catch(error){lastError=error;await sleep(300);}} if(!browser)throw Error(`native Chrome CDP unavailable: ${lastError?.message??'timeout'}`);return {browser,context:browser.contexts()[0],child}; }
  catch(error){if(child.pid&&child.exitCode===null)child.kill();throw spawnError??error;}
}

export async function closeNativeBrowser(native) {
  // CDP browser.close disconnects; Browser.close asks Chrome to flush its state.
  try{const session=await native.browser.newBrowserCDPSession();await session.send('Browser.close');}catch{}
  for(let tick=0;tick<80&&native.child.exitCode===null&&native.child.signalCode===null;tick++)await sleep(100);
  await native.browser.close().catch(()=>{});
  if(native.child.exitCode===null&&native.child.signalCode===null)throw Error('dedicated Chrome did not exit after graceful close');
}

export async function dismissKnownAnnouncements(page) {
  if (!page || typeof page.getByRole !== 'function') return [];
  const labels = ['今日关闭', '今天关闭', '关闭公告'];
  const dismissed = [];
  for (let pass = 0; pass < 3; pass += 1) {
    let found = false;
    for (const label of labels) {
      const button = page.getByRole('button', {name:label, exact:true});
      if (await button.count().catch(() => 0) !== 1 || !await button.isVisible().catch(() => false)) continue;
      await button.click({timeout:5000});
      dismissed.push(label);
      found = true;
      await page.waitForTimeout?.(300);
      break;
    }
    if (!found) break;
  }
  return dismissed;
}

// Executes one V2 task inside a dedicated persistent browser context. The
// launcher is injected so tests and NAS workers can use their own Playwright
// runtime; this module never touches the user's normal Chrome profile.
export async function runIsolatedBrowserTask({task, adapterDefinition, profileDir, dedicatedRoot, profileMode = 'isolated', profileHandoff = null, executablePath, windowMode = 'offscreen', launchPersistentContext, allowMutation = false, persistIntent = null, recoveryProof = null, captchaSolver = null, clock = () => new Date().toISOString()} = {}) {
  if (!task || typeof task !== 'object') throw Error('task is required');
  const profile = profileMode === 'v1_handoff'
    ? (validateProfileHandoff(profileHandoff, {accountKey:task.accountKey, origin:task.origin, profileDir:profileDir ?? profileHandoff?.profileDir}), path.resolve(profileHandoff.profileDir))
    : safeProfilePath(profileDir, dedicatedRoot, task.accountKey);
  if (typeof executablePath !== 'string' || !executablePath.trim()) throw Error('browser executable is required');
  if (typeof launchPersistentContext !== 'function') throw Error('browser launcher is required');
  let context, nativeBrowser;
  try {
    if(task.adapterRule?.nativeBrowser===true)nativeBrowser=await launchNativeBrowser(profile,executablePath,windowMode,task.origin);
    context = nativeBrowser?.context ?? await launchPersistentContext(profile, {headless:false, executablePath, args:browserArgs(windowMode)});
    const pages = typeof context.pages === 'function' ? context.pages() : [];
    const page = pages.find(candidate => {
      try { return new URL(candidate.url()).origin === new URL(task.origin).origin; } catch { return false; }
    }) ?? pages[0] ?? await context.newPage();
    if (typeof page.goto !== 'function') throw Error('isolated page navigation is required');
    await page.goto(task.origin, {waitUntil:'domcontentloaded', timeout:20_000});
    const dismissedAnnouncements=await dismissKnownAnnouncements(page);
    const adapterContext={page,dismissedAnnouncements};
    if(typeof captchaSolver==='function')adapterContext.solveCaptcha=captchaSolver;
    const result = await runObservedTask({adapterDefinition, origin:task.origin, accountKey:task.accountKey,
      businessDate:task.businessDate, planHash:task.planHash, expectedIdentity:task.accountId, context:adapterContext,allowMutation,persistIntent,recoveryProof});
    return {...result, worker:{windowMode, profileBound:true,browserLaunches:1,oauthDiagnostic:adapterContext.oauthDiagnostic??null, browserActions:result.mutationCount ?? 0, captchaSolverConfigured:typeof captchaSolver==='function', dismissedAnnouncements, completedAt:clock()}};
  } finally {
    if(nativeBrowser)await closeNativeBrowser(nativeBrowser);
    else if (context && typeof context.close === 'function') await context.close();
  }
}
