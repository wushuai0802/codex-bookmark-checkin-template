const views = new Set(['overview', 'tasks', 'pt-status', 'sites', 'accounts', 'ledger', 'settings']);

export function normalizeRoute(value = {}) {
  return { fabricNav: 1, view: views.has(value.view) ? value.view : 'overview',
    query: typeof value.query === 'string' ? value.query.slice(0, 80) : '',
    status: typeof value.status === 'string' ? value.status.slice(0, 40) : '',
    account: typeof value.account === 'string' ? value.account.slice(0, 300) : '',
    ptScope: ['monitor','plan','fresh','review'].includes(value.ptScope) ? value.ptScope : '',
    scrollY: Math.max(0, Number(value.scrollY) || 0),
    overlay: value.overlay && ['menu','task','ledger'].includes(value.overlay.type)
      ? { type: value.overlay.type, id: String(value.overlay.id ?? '').slice(0, 120) } : null };
}

export function routeFromHash(hash) {
  const [view, query = ''] = hash.replace(/^#/, '').split('?');
  const params = new URLSearchParams(query);
  return normalizeRoute({ view, query: params.get('q'), status: params.get('status'), account: params.get('account'), ptScope: params.get('scope') });
}

export function routeHash(route) {
  const params = new URLSearchParams();
  if (route.view === 'tasks') for (const [key, value] of [['q',route.query],['status',route.status],['account',route.account]]) if (value) params.set(key,value);
  if (route.view === 'pt-status' && route.ptScope) params.set('scope',route.ptScope);
  return `#${route.view}${params.size ? '?' + params : ''}`;
}

export function createNavigation({ history, location, onChange, readScroll = () => 0 }) {
  let closing = false;
  let current = normalizeRoute(history.state?.fabricNav === 1 ? history.state : routeFromHash(location.hash));
  const write = (route, push) => { current = normalizeRoute(route); history[push ? 'pushState' : 'replaceState'](current, '', routeHash(current)); };
  write(current, false);
  function remember() { write({ ...current, scrollY: readScroll() }, false); }
  return {
    get current() { return current; },
    remember,
    navigate(next) {
      remember(); const route = normalizeRoute({ ...current, ...next, overlay: null, scrollY: 0 });
      const same = routeHash(route) === routeHash(current);
      if (current.overlay && same) { if (!closing) { closing = true; history.back(); } return; }
      write(route, !current.overlay && !same); onChange(current);
    },
    updateFilters(fields) { write({ ...current, ...fields, scrollY: readScroll() }, false); },
    openOverlay(type, id = '') { if (current.overlay) return; remember(); write({ ...current, overlay: {type,id} }, true); onChange(current); },
    closeOverlay() { if (current.overlay && !closing) { closing = true; history.back(); } },
    restore(state) { closing = false; current = normalizeRoute(state?.fabricNav === 1 ? state : routeFromHash(location.hash)); onChange(current); }
  };
}
