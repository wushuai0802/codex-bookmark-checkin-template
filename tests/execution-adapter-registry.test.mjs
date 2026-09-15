import test from 'node:test';
import assert from 'node:assert/strict';
import {executionBindingForOrigin,adapterBindingForSite,createExecutionAdapter,executionAdapterDefinitions} from '../src/execution-adapter-registry.mjs';

test('execution registry exposes implemented and planned families explicitly',()=>{
  const defs=executionAdapterDefinitions(); assert.equal(defs.find(x=>x.id==='new-api.execute.v1').status,'implemented');
  assert.equal(defs.find(x=>x.id==='oauth-reward.execute.v1').status,'implemented');
  assert.equal(adapterBindingForSite({origin:'https://fixture.example',familyId:'new-api-calendar.v1'}).adapterId,'new-api.execute.v1');
});

test('only implemented execution adapters can be constructed',()=>{
  assert.equal(createExecutionAdapter({adapterId:'new-api.execute.v1',origin:'https://fixture.example'}).mutating,true);
  assert.equal(createExecutionAdapter({adapterId:'oauth-reward.execute.v1',origin:'https://fixture.example'}).mutating,true);
  assert.equal(createExecutionAdapter({adapterId:'pt-native.execute.v1',origin:'https://fixture.example'}).mutating,true);
  assert.equal(createExecutionAdapter({adapterId:'anyrouter.execute.v1',origin:'https://fixture.example'}).mutating,true);
});

test('execution binding selects the concrete adapter and only non-secret rules',()=>{
  const agent=executionBindingForOrigin({origin:'https://agentrouter.org',config:{oauthReloginCheckinRules:{'https://agentrouter.org':{logType:4,rewardAmount:25}},oauthLoginUrls:{'https://agentrouter.org':'https://agentrouter.org/login'}}});
  assert.equal(agent.adapterId,'oauth-reward.execute.v1');
  assert.equal(agent.adapterRule.logPath,'/api/log/self');
  assert.equal(Object.keys(agent.adapterRule).some(key=>/password|cookie|token|profile/i.test(key)),false);
  assert.equal(executionBindingForOrigin({origin:'https://anyrouter.top'}).adapterId,'anyrouter.execute.v1');
  assert.equal(executionBindingForOrigin({origin:'https://piggo.me'}).adapterId,'pt-native.execute.v1');
  assert.equal(adapterBindingForSite({origin:'https://ai.venlacy.com',familyId:'generic-discovery.v1'}).adapterId,'new-api.execute.v1');
  assert.equal(adapterBindingForSite({origin:'https://api.42w.shop',familyId:'generic-discovery.v1'}).adapterId,'new-api.execute.v1');
  assert.equal(executionBindingForOrigin({origin:'https://ai.venlacy.com'}).adapterRule.authRefreshPath,'/api/user/auth/refresh');
  assert.equal(executionBindingForOrigin({origin:'https://api.42w.shop'}).adapterRule.authRefreshPath,null);
  assert.equal(executionBindingForOrigin({origin:'https://jianzhile.vip'}).adapterRule.authRefreshPath,'/api/user/auth/refresh');
  assert.equal(adapterBindingForSite({origin:'https://muyuan.do',familyId:'new-api-calendar.v1'}).adapterId,'new-api.execute.v1');
  assert.equal(executionBindingForOrigin({origin:'https://x666.me'}).adapterRule.allowUndatedCanSpinFalse,true);
  const bearer=executionBindingForOrigin({origin:'https://bearer.example',config:{protectedCredentialApiLoginRules:{'https://bearer.example':{selfPath:'/api/user/self',authRefreshPath:'/api/user/auth/refresh'}}}});
  assert.equal(bearer.adapterRule.authRefreshPath,'/api/user/auth/refresh');
});
