import path from 'node:path';
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
  if (windowMode === 'offscreen') return ['--window-position=-32000,-32000', '--window-size=1365,900'];
  if (windowMode === 'minimized') return ['--start-minimized', '--window-size=1365,900'];
  throw Error('window mode must be offscreen or minimized');
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
  let context;
  try {
    context = await launchPersistentContext(profile, {headless:false, executablePath, args:browserArgs(windowMode)});
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
    return {...result, worker:{windowMode, profileBound:true, browserActions:result.mutationCount ?? 0, captchaSolverConfigured:typeof captchaSolver==='function', dismissedAnnouncements, completedAt:clock()}};
  } finally {
    if (context && typeof context.close === 'function') await context.close();
  }
}
