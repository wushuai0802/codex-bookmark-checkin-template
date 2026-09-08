import test from 'node:test';
import assert from 'node:assert/strict';
import { identityBinding, observedIdentity } from '../src/identity-observations.mjs';
import { identityCaption } from '../public/dashboard-model.mjs';

const args = {config:{automationUserDataDir:'data/default'},root:'/fixture',origin:'https://example.com',accountKey:'site-default',now:'2026-09-08T01:00:00Z'};
const row = () => ({origin:args.origin,accountKey:args.accountKey,userId:'12345',username:'reader',source:'user-self',observedAt:args.now,bindingKey:identityBinding(args.config,args.root,args.origin,args.accountKey),password:'must-not-copy'});
test('only allowlisted display metadata crosses the observation boundary',()=>{
  const identity = observedIdentity({observations:[row()]},args);
  assert.equal(identity.userId,'12345'); assert.equal(identity.source,'user-self'); assert.equal('password' in identity,false);
});
test('a switched profile, account or ambiguous ID invalidates stored metadata',()=>{
  const report={observations:[row()]};
  assert.equal(observedIdentity(report,{...args,config:{automationUserDataDir:'data/other'}}),null);
  assert.equal(observedIdentity(report,{...args,accountKey:'other'}),null);
  assert.equal(observedIdentity({observations:[row(),{...row(),userId:'999'}]},args),null);
});
test('stale or future observations cannot be presented as current identity',()=>{
  assert.equal(observedIdentity({observations:[{...row(),observedAt:'2026-07-01T00:00:00Z'}]},args),null);
  assert.equal(observedIdentity({observations:[{...row(),observedAt:'2026-09-09T00:00:00Z'}]},args),null);
});
test('cache identity and upstream identifiers remain explicitly distinguished',()=>{
  const identity=observedIdentity({observations:[{...row(),source:'browser-cache'}]},args);
  assert.match(identityCaption({identity}),/缓存/);
  assert.match(identityCaption({identity:{...identity,idKind:'linuxdo'}}),/^LinuxDO ID/);
});
