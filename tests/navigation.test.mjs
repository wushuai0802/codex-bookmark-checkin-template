import test from 'node:test';
import assert from 'node:assert/strict';
import { createNavigation, routeFromHash, routeHash } from '../public/navigation.mjs';

function harness(hash = '') {
  const stack = [{ state: null, url: hash }]; let index = 0, scroll = 0, changes = [];
  const location = { hash };
  const history = {
    get state() { return stack[index].state; },
    replaceState(value, _, url) { stack[index] = { state: structuredClone(value), url }; location.hash = url; },
    pushState(value, _, url) { stack.splice(++index); stack.push({ state: structuredClone(value), url }); location.hash = url; },
    back() { if (index > 0) { index--; location.hash = stack[index].url; } },
  };
  const nav = createNavigation({ history, location, onChange: r => changes.push(r), readScroll: () => scroll });
  return { nav, stack, history, scroll: n => { scroll = n; }, back: () => { history.back(); nav.restore(history.state); }, pop: () => nav.restore(history.state), changes };
}

test('view history restores task filters and list scroll without extra landing entries', () => {
  const h = harness(); assert.equal(h.stack.length, 1);
  h.nav.navigate({view:'tasks',status:'pending',query:'reader'});
  h.scroll(480); h.nav.navigate({view:'accounts'}); h.back();
  assert.equal(h.nav.current.view,'tasks'); assert.equal(h.nav.current.status,'pending');
  assert.equal(h.nav.current.query,'reader'); assert.equal(h.nav.current.scrollY,480);
});

test('menu navigation replaces only the overlay entry, back returns to source page', () => {
  const h = harness(); h.nav.openOverlay('menu'); h.nav.navigate({view:'ledger'});
  assert.equal(h.stack.length,2); h.back(); assert.equal(h.nav.current.view,'overview');
  assert.equal(h.nav.current.overlay,null);
});

test('back dismisses overlays and rapid close cannot consume two entries', () => {
  const h = harness(); h.nav.navigate({view:'tasks'}); h.nav.openOverlay('task','task-example');
  h.nav.closeOverlay(); h.nav.closeOverlay(); h.pop();
  assert.equal(h.nav.current.view,'tasks'); assert.equal(h.nav.current.overlay,null);
  h.nav.openOverlay('menu'); h.back(); assert.equal(h.nav.current.overlay,null);
});

test('initial deep link and route filters survive reload', () => {
  const route = routeFromHash('#tasks?status=success&q=example%20reader');
  assert.equal(route.view,'tasks'); assert.equal(route.query,'example reader');
  assert.equal(routeHash(route),'#tasks?q=example+reader&status=success');
  assert.equal(routeFromHash('#invalid').view,'overview');
});

test('selecting current page from menu consumes menu instead of duplicating the page', () => {
  const h=harness(); h.nav.navigate({view:'ledger'}); h.nav.openOverlay('menu');
  h.nav.navigate({view:'ledger'}); h.pop(); h.back();
  assert.equal(h.nav.current.view,'overview');
});
