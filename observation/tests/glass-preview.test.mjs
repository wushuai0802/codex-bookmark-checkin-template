import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('glass preview is opt-in, scoped, and has opaque accessibility fallbacks',()=>{
  const theme=fs.readFileSync(new URL('../public/theme.js',import.meta.url),'utf8');
  const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
  const css=fs.readFileSync(new URL('../public/glass-preview.css',import.meta.url),'utf8');
  const article=fs.readFileSync(new URL('../public/article-glass.css',import.meta.url),'utf8');
  assert.match(theme,/glass !== 'off'/);
  assert.match(html,/glass-preview\.css/);
  assert.match(html,/article-glass\.css/);
  assert.match(css,/html\[data-glass-preview\]/);
  assert.match(css,/#view-overview\.active-view \{ display: flex/);
  assert.doesNotMatch(css,/#view-overview \{ display: flex/);
  assert.match(css,/@supports not \(\(-webkit-backdrop-filter/);
  assert.match(css, /prefers-reduced-transparency: reduce/);
  assert.match(css, /prefers-contrast: more/);
  assert.doesNotMatch(css,/^body\s*\{/m);
  assert.match(article,/255, 210, 157, \.46/);
  assert.match(article,/160, 207, 255, \.50/);
  assert.match(article,/blur\(24px\) saturate\(130%\)/);
  assert.match(article,/blur\(18px\) saturate\(130%\)/);
  assert.match(article,/prefers-reduced-transparency: reduce/);
});
