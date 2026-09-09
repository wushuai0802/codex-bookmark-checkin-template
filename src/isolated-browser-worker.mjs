import path from 'node:path';
import {runObservedTask} from './task-coordinator.mjs';
import {validateProfileHandoff} from './profile-handoff.mjs';

function safeProfilePath(profileDir, dedicatedRoot) {
  const profile = path.resolve(String(profileDir ?? ''));
  const root = path.resolve(String(dedicatedRoot ?? ''));
  if (!profile || !root || profile === root) throw Error('dedicated browser profile is required');
  const relative = path.relative(root, profile);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw Error('browser profile is outside dedicated root');
  if (/chrome[\\/](user data|default)|\\Google\\Chrome\\User Data[\\/]/i.test(profile)) throw Error('user Chrome profile is forbidden');
  return profile;
}

function browserArgs(windowMode) {
  if (windowMode === 'offscreen') return ['--window-position=-32000,-32000', '--window-size=1365,900'];
  if (windowMode === 'minimized') return ['--start-minimized', '--window-size=1365,900'];
  throw Error('window mode must be offscreen or minimized');
}

// Executes one V2 task inside a dedicated persistent browser context. The
// launcher is injected so tests and NAS workers can use their own Playwright
// runtime; this module never touches the user's normal Chrome profile.
export async function runIsolatedBrowserTask({task, adapterDefinition, profileDir, dedicatedRoot, profileMode = 'isolated', profileHandoff = null, executablePath, windowMode = 'offscreen', launchPersistentContext, clock = () => new Date().toISOString()} = {}) {
  if (!task || typeof task !== 'object') throw Error('task is required');
  const profile = profileMode === 'v1_handoff'
    ? (validateProfileHandoff(profileHandoff, {accountKey:task.accountKey, origin:task.origin, profileDir:profileDir ?? profileHandoff?.profileDir}), path.resolve(profileHandoff.profileDir))
    : safeProfilePath(profileDir, dedicatedRoot);
  if (typeof executablePath !== 'string' || !executablePath.trim()) throw Error('browser executable is required');
  if (typeof launchPersistentContext !== 'function') throw Error('browser launcher is required');
  let context;
  try {
    context = await launchPersistentContext(profile, {headless:false, executablePath, args:browserArgs(windowMode)});
    const pages = typeof context.pages === 'function' ? context.pages() : [];
    const page = pages[0] ?? await context.newPage();
    if (typeof page.goto !== 'function') throw Error('isolated page navigation is required');
    await page.goto(task.origin, {waitUntil:'domcontentloaded', timeout:20_000});
    const result = await runObservedTask({adapterDefinition, origin:task.origin, accountKey:task.accountKey,
      businessDate:task.businessDate, planHash:task.planHash, expectedIdentity:task.accountId, context:{page}});
    return {...result, worker:{windowMode, profileBound:true, browserActions:result.mutationCount ?? 0, completedAt:clock()}};
  } finally {
    if (context && typeof context.close === 'function') await context.close();
  }
}
