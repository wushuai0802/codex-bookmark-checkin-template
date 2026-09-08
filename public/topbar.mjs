// A wide hysteresis band prevents direction changes/scroll anchoring from
// repeatedly expanding the header near its collapse threshold.
export function compactAt(scrollY, wasCompact) {
  const y = Math.max(0, Number(scrollY) || 0);
  return wasCompact ? y > 12 : y >= 96;
}

export const recentLabels = {overview:'总览',tasks:'任务', 'pt-status':'PT 监测',sites:'站点',accounts:'账号',ledger:'运行记录',settings:'设置'};
export function recentPages(previous, current) {
  const known = Array.isArray(previous) ? previous.filter(view => Object.hasOwn(recentLabels, view)) : [];
  const ordered = [...new Set(known)].filter(view => view !== 'overview' && view !== current);
  if (current !== 'overview' && Object.hasOwn(recentLabels, current)) ordered.push(current);
  return ['overview', ...ordered.slice(-5)];
}

export function installCompactTopbar({ topbar, win = window }) {
  if (!topbar) return () => {};
  const nav = topbar.querySelector('.top-nav');
  const narrow = win.matchMedia('(max-width:1000px)');
  let frame = null;
  let readyFrame = null;
  let compact = false;
  const update = () => {
    frame = null;
    compact = compactAt(win.scrollY, compact);
    // Don't hide an actively keyboard-operated navigation item.
    const retainNav = nav?.contains(topbar.ownerDocument.activeElement) && topbar.ownerDocument.activeElement.matches(':focus-visible');
    const hideNav = narrow.matches && compact && !retainNav;
    topbar.classList.toggle('compact', compact);
    topbar.classList.toggle('nav-focus', Boolean(retainNav));
    topbar.classList.toggle('scrolled', win.scrollY > 8);
    if (nav) { nav.inert = hideNav; nav.setAttribute('aria-hidden', String(hideNav)); }
  };
  const schedule = () => { if (frame === null) frame = win.requestAnimationFrame(update); };
  win.addEventListener('scroll', schedule, { passive: true });
  win.addEventListener('pageshow', schedule);
  narrow.addEventListener('change', schedule);
  topbar.addEventListener('focusin', schedule);
  topbar.addEventListener('focusout', schedule);
  update();
  readyFrame = win.requestAnimationFrame(() => { readyFrame = win.requestAnimationFrame(() => topbar.classList.add('motion-ready')); });
  return () => {
    if (frame !== null) win.cancelAnimationFrame(frame);
    if (readyFrame !== null) win.cancelAnimationFrame(readyFrame);
    win.removeEventListener('scroll', schedule); win.removeEventListener('pageshow', schedule);
    narrow.removeEventListener('change', schedule);
    topbar.removeEventListener('focusin', schedule); topbar.removeEventListener('focusout', schedule);
  };
}
