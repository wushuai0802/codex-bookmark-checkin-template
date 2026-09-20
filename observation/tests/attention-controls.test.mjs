import test from 'node:test';
import assert from 'node:assert/strict';
import {activeSiteControls,pauseExpiresAt} from '../src/attention-controls.mjs';

test('site attention pause has a bounded expiry and does not change stored status',()=>{
  const now=Date.parse('2026-09-20T05:00:00Z');
  assert.equal(pauseExpiresAt('pause',null,now),'2026-09-21T05:00:00.000Z');
  assert.equal(pauseExpiresAt('pause',72,now),'2026-09-23T05:00:00.000Z');
  assert.equal(pauseExpiresAt('monitor',null,now),null);
  assert.throws(()=>pauseExpiresAt('pause',8,now),/pauseHours/);
  const stored={'https://example.com':{policy:'pause',note:'reviewing',expiresAt:'2026-09-21T05:00:00Z'}};
  assert.equal(activeSiteControls(stored,now)['https://example.com'].policy,'pause');
  assert.equal(activeSiteControls(stored,now+24*60*60*1000)['https://example.com'].policy,'monitor');
  assert.equal(stored['https://example.com'].policy,'pause');
  assert.equal(activeSiteControls({'https://legacy.example':{policy:'pause'}},now)['https://legacy.example'].policy,'monitor');
});
