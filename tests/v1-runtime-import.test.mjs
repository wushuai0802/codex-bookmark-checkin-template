import test from 'node:test';
import assert from 'node:assert/strict';
import {importV1Runtime} from '../src/v1-runtime-import.mjs';

test('V1 runtime import carries metadata into fresh V2 refs without secrets or V1 profile reuse',()=>{
  const result=importV1Runtime({config:{oauthAccountIdentities:{'https://fixture.example':{accountKey:'acct7',accountId:'7',accountLabel:'Reader',provider:'LinuxDO',upstreamProvider:'Google',upstreamAccount:'google-user',loginUrl:'https://fixture.example/login',automationUserDataDir:'data/accounts/acct7/chrome-user-data'}},oauthSessionProfiles:{shared:'data/sessions/shared/chrome-user-data'}},v1Catalog:{mode:'catalog_only',sites:[]}});
  assert.equal(result.executionEnabled,false); assert.equal(result.v1RemainsOwner,true);
  assert.equal(result.accounts[0].v2ProfileRef,'data/v2-profiles/acct7'); assert.equal(result.accounts[0].v1ProfileAvailable,true);
  assert.equal(result.sharedSessions[0].v2SessionRef,'data/v2-sessions/shared');
  assert.deepEqual(result.forbidden,['v1_profile_reuse','cookie_copy','secret_import','parallel_owner','blind_retry']);
  assert.doesNotMatch(JSON.stringify(result),/password|cookie_value|access_token/i);
});
