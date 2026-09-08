import test from 'node:test';
import assert from 'node:assert/strict';
import {buildV1AdapterCatalog} from '../src/v1-adapter-catalog.mjs';
test('V1 catalog extracts capabilities without importing executor code',()=>{
 const c=buildV1AdapterCatalog({config:{newApiSignInRules:{'https://api.example':{}},oauthReloginCheckinRules:{'https://agent.example':{}},nativeChallengePreflight:[{url:'https://pt.example/attendance.php'}]},plan:{targets:[{origin:'https://api.example'},{origin:'https://agent.example'},{origin:'https://pt.example'}]}});
 assert.equal(c.mode,'catalog_only');assert.equal(c.sites.length,3);assert.ok(c.sites.find(s=>s.origin==='https://api.example').familyId==='new-api-calendar.v1');assert.ok(c.sites.find(s=>s.origin==='https://agent.example').familyId==='oauth-reward-log.v1');assert.ok(c.sites.find(s=>s.origin==='https://pt.example').familyId==='native-pt.v1');assert.ok(c.sites.every(s=>s.observeOnly&&s.v2CanaryReady===false));assert.deepEqual(c.forbidden.sort(),['blind_post_retry','main_chrome_fallback','monitor_only_lease','relogin_without_identity','execute'].sort());
});
test('same origin stays one catalog site even when related URLs exist',()=>{const c=buildV1AdapterCatalog({config:{},plan:{targets:[{origin:'https://a.example/path'},{origin:'https://a.example/other'}]}});assert.equal(c.sites.length,1);assert.equal(c.sites[0].origin,'https://a.example');});
