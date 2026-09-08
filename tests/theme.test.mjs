import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../public/theme.js', import.meta.url), 'utf8');
function harness(saved, dark = false, blocked = false) {
  const events = {}, systemEvents = {}, docEvents = {}, selectEvents = {};
  const writes = [];
  const system = { matches: dark, addEventListener: (key, fn) => { systemEvents[key] = fn; } };
  const select = { value: '', addEventListener: (key, fn) => { selectEvents[key] = fn; } };
  const document = { documentElement: { dataset: {}, style: {} }, getElementById: () => select,
    addEventListener: (key, fn) => { docEvents[key] = fn; } };
  const window = { matchMedia: () => system, addEventListener: (key, fn) => { events[key] = fn; },
    get localStorage() {
      if (blocked) throw new Error('Storage disabled');
      return { getItem: () => saved, setItem: (key, value) => writes.push([key, value]) };
    } };
  vm.runInNewContext(source, { window, document });
  return { root: document.documentElement, select, writes,
    ready: () => docEvents.DOMContentLoaded(),
    choose: value => selectEvents.change({ target: { value } }),
    system: value => { system.matches = value; systemEvents.change(); },
    storage: value => events.storage({ key: 'fabricTheme', newValue: value }) };
}
test('theme defaults to system and updates live, before DOM ready', () => {
  const h = harness(null, true);
  assert.equal(h.root.dataset.theme, 'dark');
  h.ready(); assert.equal(h.select.value, 'system');
  h.system(false); assert.equal(h.root.dataset.theme, 'light');
});
test('manual theme overrides system and survives reload; system can be restored', () => {
  const h = harness('dark', false); h.ready();
  assert.equal(h.root.dataset.theme, 'dark');
  h.choose('light'); h.system(true);
  assert.equal(h.root.dataset.theme, 'light');
  assert.deepEqual(h.writes.at(-1), ['fabricTheme', 'light']);
  h.choose('system'); assert.equal(h.root.dataset.theme, 'dark');
  h.storage('light'); assert.equal(h.root.dataset.theme, 'light');
  assert.equal(h.select.value, 'light');
});
test('invalid or unavailable storage does not break theme switching', () => {
  for (const h of [harness('invalid', true), harness(null, true, true)]) {
    h.ready(); assert.equal(h.select.value, 'system');
    h.choose('light'); assert.equal(h.root.dataset.theme, 'light');
    assert.equal(h.root.style.colorScheme, 'light');
  }
});
