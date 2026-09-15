import test from 'node:test';
import assert from 'node:assert/strict';
import {clearAnyRouterRouteCache,createCookieJar,normalizeAnyRouterRoutePolicy,parseRouteJson,resolveAnyRouterRoute,solveEsaChallenge,requestAnyRouterRoute} from '../src/anyrouter-route.mjs';

test('AnyRouter route policy is bounded and normalized',()=>{
  const policy=normalizeAnyRouterRoutePolicy('https://anyrouter.top',{dnsNames:['ANYROUTER.TOP','bad..name'],dnsServers:['1.1.1.1','not-an-ip'],maxCandidates:99,timeoutMs:1});
  assert.deepEqual(policy.dnsNames,['anyrouter.top']);
  assert.deepEqual(policy.dnsServers,['1.1.1.1']);
  assert.equal(policy.maxCandidates,16);
  assert.equal(policy.timeoutMs,1000);
  assert.throws(()=>normalizeAnyRouterRoutePolicy('http://anyrouter.top'),/HTTPS/);
});

test('route resolver probes DNS candidates and caches the exact policy',async()=>{
  clearAnyRouterRouteCache();
  let resolves=0,probes=0;
  const deps={
    resolve4:async()=>{resolves+=1;return ['203.0.113.10','203.0.113.11'];},
    probe:async({address})=>{probes+=1;return {ok:address.endsWith('10'),statusCode:200};}
  };
  const rule={dnsNames:['anyrouter.top'],dnsServers:['1.1.1.1'],ttlMs:30000};
  const first=await resolveAnyRouterRoute(rule,deps),second=await resolveAnyRouterRoute(rule,deps);
  assert.equal(first.address,'203.0.113.10');assert.equal(second.address,first.address);
  assert.equal(resolves,1);assert.equal(probes,2);
  const changed=await resolveAnyRouterRoute({...rule,probePath:'/api/status'},deps);
  assert.equal(changed.address,'203.0.113.10');assert.equal(resolves,2);
});

test('concurrent route probes share one in-flight resolution',async()=>{
  clearAnyRouterRouteCache();let resolves=0;
  const deps={resolve4:async()=>{resolves+=1;await new Promise(resolve=>setTimeout(resolve,5));return ['203.0.113.20'];},probe:async()=>({ok:true,statusCode:200})};
  const [left,right]=await Promise.all([
    resolveAnyRouterRoute({dnsNames:['anyrouter.top'],dnsServers:['1.1.1.1'],ttlMs:30000},deps),
    resolveAnyRouterRoute({dnsNames:['anyrouter.top'],dnsServers:['1.1.1.1'],ttlMs:30000},deps)
  ]);
  assert.equal(left.address,right.address);assert.equal(resolves,1);
});

test('ESA challenge solver is bounded and only returns a cookie',()=>{
  const body='<html><script>var arg1=\"ok\";document.cookie=\"cf_clearance=abc; path=/\";</script></html>';
  assert.equal(solveEsaChallenge(body),'cf_clearance=abc');
  assert.equal(solveEsaChallenge('<script>var arg1=\"x\";this.constructor.constructor(\"return process\")()</script>'),null);
  assert.equal(solveEsaChallenge('x'.repeat(200001)),null);
  assert.equal(parseRouteJson({body:String.fromCharCode(0xfeff)+'{\"success\":true}'}).success,true);
});

test('cookie jar handles updates and deletion',()=>{
  const jar=createCookieJar([{name:'sid',value:'one'}]);
  jar.update(['foo=bar; Path=/']);assert.match(jar.header(),/sid=one/);assert.match(jar.header(),/foo=bar/);
  jar.update(['sid=gone; Max-Age=0; Path=/']);assert.doesNotMatch(jar.header(),/sid=/);
});

test('route request rejects unsafe paths and invalid routes before network',async()=>{
  const invalid=await requestAnyRouterRoute({address:'not-ip',host:'anyrouter.top'},'/api/status');
  assert.equal(invalid.error,'route_invalid');
  const unsafe=await requestAnyRouterRoute({address:'203.0.113.1',host:'anyrouter.top'},'https://other.example/');
  assert.equal(unsafe.error,'AnyRouter request path is invalid');
});
