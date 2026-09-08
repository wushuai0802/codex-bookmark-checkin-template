import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const css=fs.readFileSync(new URL('../public/theme.css',import.meta.url),'utf8');
const app=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
test('sticky management bar exposes compact primary routes and contexts',()=>{
 for(const route of ['overview','tasks','pt-status','accounts'])assert.match(html,new RegExp(`data-top-view="${route}"`));
 assert.match(css,/\.topbar\s*\{[^}]*position:sticky/);assert.match(css,/backdrop-filter/);assert.match(app,/topbar-context/);assert.match(app,/data-top-view/);
});
test('topbar remains responsive and does not replace full mobile navigation',()=>{
 assert.match(css,/@media\(max-width:700px\)/);assert.match(html,/id="menu-toggle"/);assert.match(html,/id="main-sidebar"/);
});
