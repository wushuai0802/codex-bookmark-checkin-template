import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {compactAt,recentPages,recentLabels} from '../public/topbar.mjs';
const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const css=fs.readFileSync(new URL('../public/theme.css',import.meta.url),'utf8');
const app=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
test('sticky management bar is a compact recent-pages shortcut, not duplicate full navigation',()=>{
 assert.match(html,/aria-label="最近访问页面"/);
 assert.match(css,/\.topbar-shell\s*\{[^}]*position:sticky/);assert.match(css,/pointer-events:none/);assert.match(app,/topbar-context/);assert.match(app,/renderRecentPages/);
 assert.equal(Object.keys(recentLabels).length,7);
});
test('header hysteresis shrinks only after scrolling and expands near the top',()=>{
 assert.equal(compactAt(95,false),false);assert.equal(compactAt(96,false),true);
 assert.equal(compactAt(40,true),true);assert.equal(compactAt(12,true),false);
 assert.equal(compactAt(-50,true),false);assert.equal(compactAt(NaN,false),false);
});
test('recent pages pin home, deduplicate and bound history without storing private queries',()=>{
 assert.deepEqual(recentPages(null,'overview'),['overview']);
 assert.deepEqual(recentPages(['tasks','unknown','tasks','private-token'],'accounts'),['overview','tasks','accounts']);
 const result=recentPages(['tasks','pt-status','sites','accounts','ledger'],'settings');
 assert.equal(result.length,6);assert.equal(result[0],'overview');assert.equal(result.at(-1),'settings');assert.equal(result.includes('tasks'),false);
 assert.deepEqual(recentPages(['overview','tasks','accounts'],'tasks'),['overview','accounts','tasks']);
});
test('topbar remains responsive and does not replace full mobile navigation',()=>{
 assert.match(css,/@media\(max-width:700px\)/);assert.match(html,/id="menu-toggle"/);assert.match(html,/id="main-sidebar"/);
});

test('desktop workspace uses the full area beside the sidebar',()=>{
  const css=fs.readFileSync(new URL('../public/theme.css',import.meta.url),'utf8');
  assert.match(css,/\.main-content \{ min-width: 0; width: auto; max-width: none; flex: 1 1 auto; \}/);
});
