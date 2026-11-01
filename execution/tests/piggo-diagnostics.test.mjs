import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {piggoOrigin,piggoCalendarUrl,installPiggoCalendarFirewall,readPiggoAccountIdInContext} from '../src/piggo-calendar.mjs';
import {readNativePtApiHeader,readNativePtApiHeaderInContext,runNativePtApiCheckin} from '../src/native-pt-api.mjs';
import {diagnosticOptions,runPiggoDiagnostic} from '../scripts/Diagnose-Piggo.mjs';
import {fixture,observedLoginRequests,response,now} from './helpers/piggo-spa-fixture.mjs';

test('firewall baseline covers every observed anonymous request with synthetic release-independent asset names',async t=>{
  const f=fixture(t),context=f.createContext();
  await installPiggoCalendarFirewall(context,{clock:f.clock});
  assert.equal(observedLoginRequests.length,26);
  for(const [method,route,allowed] of observedLoginRequests)
    assert.equal(await context.request(method,new URL(route,piggoOrigin).href),allowed,method+' '+route);
  assert.equal(f.calls.filter(call=>call.method!=='GET').length,0);
});

test('plugin comparison can deny only plugin assets while preserving the reviewed password-page resource rules',async t=>{
  const f=fixture(t),context=f.createContext();
  await installPiggoCalendarFirewall(context,{clock:f.clock,allowPluginAssets:false});
  for(const [method,route,allowed] of observedLoginRequests)
    assert.equal(await context.request(method,new URL(route,piggoOrigin).href),allowed&&!route.includes('/plugin-assets/'),method+' '+route);
});

test('asset shapes reject traversal before URL normalization, API lookalikes, unreviewed extensions and all optional auth APIs',async t=>{
  const f=fixture(t),context=f.createContext();await installPiggoCalendarFirewall(context,{clock:f.clock});
  for(const route of ['/assets/js/../main.js','/assets/%2e%2e/zhuzhu.png','/assets/%2E%2E/zhuzhu.png',
    '/assets/js\\main.js','/assets/js/name..js','/assets/js/a%2fb.js','/assets/js/a.js/extra','/assets/js/a.html',
    '/assets/js/a.php','/assets/js/a.js?token=fixture','/nested/zhuzhu.png','/root.js',
    '/cdn-cgi/scripts/not-a-hash/cloudflare-static/rocket-loader.min.js',
    `/cdn-cgi/scripts/${'a'.repeat(8)}/cloudflare-static/other.js`,
    '/v1/web/plugin-assets/plugin/nested/a.js','/v1/web/plugin-assets/plugin/a.html',
    '/v1/web/plugin-assets/plugin/a.js?x=1','/v1/web/passkeys/login/options?x=1',
    '/index.php','/login.php','/takelogin.php','/attendance.php'])
    assert.equal(await context.request('GET',piggoOrigin+route),false,route);
  for(const method of ['POST','PUT','PATCH','DELETE','HEAD','OPTIONS'])
    assert.equal(await context.request(method,piggoOrigin+'/assets/js/main.js'),false,method);
  const credentialAsset=new URL(piggoOrigin+'/assets/js/main.js');credentialAsset.username='fixture';
  for(const url of ['https://foreign.example/assets/js/main.js',credentialAsset.href])
    assert.equal(await context.request('GET',url),false,url);
});

function accountContext(record={}){
  const events=[],waits=[];let route,current='about:blank';
  const page={url:()=>current,route:async(pattern,handler)=>{assert.equal(pattern,'**/*');route=handler;events.push('firewall');},
    routeWebSocket:async(pattern,handler)=>{await handler({close:()=>events.push('socket_closed')});},
    waitForResponse:predicate=>new Promise(resolve=>waits.push({predicate,resolve})),
    goto:async url=>{
      assert.equal(url,piggoCalendarUrl);assert.deepEqual(events.slice(0,4),['new_page','bypass_worker','firewall','socket_closed']);
      for(const [method,target,expected] of [['GET',url,true],['GET',piggoOrigin+'/v1/web/me',true],
        ['POST',piggoOrigin+'/v1/web/calendar/attendance',false],['GET',piggoOrigin+'/attendance.php',false]]){
        let allowed=false;
        await route({request:()=>({method:()=>method,url:()=>target}),continue:async()=>{allowed=true;},abort:async()=>{}});
        assert.equal(allowed,expected,target);
      }
      current=record.redirect??url;
      const value=response(piggoOrigin+'/v1/web/me',record.data??{code:0,msg:'ok',data:{user:{id:42,token:'PRIVATE_MARKER'}}},record.options);
      for(const waiter of waits)waiter.resolve(waiter.predicate(value)?value:null);
      if(record.error)throw Error('PRIVATE_MARKER');
    },close:async()=>{events.push('close_page');}};
  return {events,context:{
    newPage:async()=>{events.push('new_page');return page;},
    newCDPSession:async target=>{assert.equal(target,page);return {
      send:async(method,args)=>{assert.equal(method,'Network.setBypassServiceWorker');assert.deepEqual(args,{bypass:true});events.push('bypass_worker');},
      detach:async()=>{events.push('detach');},
    };},
    get request(){throw Error('No direct API client or storage read is permitted');},
  }};
}

test('first-binding diagnostic captures a fresh /me numeric candidate only, with its own unarmed tab firewall',async()=>{
  const f=accountContext(),id=await readPiggoAccountIdInContext(f.context,{clock:()=>now});
  assert.equal(id,'42');assert.deepEqual(f.events.slice(-2),['close_page','detach']);
  assert.doesNotMatch(id,/PRIVATE|token|receipt|accountId/);
});

test('candidate diagnostic rejects stale/malformed/foreign/failed identity and login redirects without a receipt',async()=>{
  for(const record of [{data:{user:{id:'42'}}},{data:{user:{id:0}}},{data:{user:{id:1.5}}},
    {data:{user:{id:Number.MAX_SAFE_INTEGER+1}}},{data:{code:400,msg:'PRIVATE',data:{user:{id:42}}}},
    {options:{status:401}},{options:{date:'invalid'}},{options:{date:new Date(now.getTime()-300001).toUTCString()}},
    {options:{responseUrl:'https://foreign.example/v1/web/me'}},{redirect:piggoOrigin+'/login'},{error:true}]){
    const f=accountContext(record);
    assert.equal(await readPiggoAccountIdInContext(f.context,{clock:()=>now}),null);
    assert.deepEqual(f.events.slice(-2),['close_page','detach']);
  }
});

test('an unset expected ID stays account_mismatch in every normal reader/submitter and never writes a first binding',async t=>{
  const f=fixture(t);delete f.config.oauthExpectedAccountIds;f.save();
  const file=path.join(f.root,'config/config.json'),before=fs.readFileSync(file,'utf8');
  const context=f.createContext();
  for(const result of [await readNativePtApiHeader(f),await runNativePtApiCheckin(f),
    await readNativePtApiHeaderInContext({...f,context,expectedProfileBinding:f.profileBinding,profileProof:async()=>true})]){
    assert.equal(result.failureCode,'account_mismatch');assert.equal(result.status,'unconfirmed');
    assert.equal(result.submissionAttempted,false);assert.equal(result.evidence,undefined);
  }
  assert.equal(f.launches,0);assert.equal(f.posts.length,0);assert.equal(f.calls.length,0);
  assert.equal(fs.readFileSync(file,'utf8'),before);assert.equal(fs.existsSync(path.join(f.root,'data/native-pt-attempts.json')),false);
});

test('diagnostics default to help without loading a browser and require an explicit, loopback-only mode',async()=>{
  let output='',errors='';const unreachable=new Proxy({},{get(){throw Error('Browser must not be accessed');}});
  assert.equal(await runPiggoDiagnostic([],{chromium:unreachable,stdout:{write:value=>{output+=value;}},stderr:{write:value=>{errors+=value;}}}),0);
  assert.match(output,/Default: help only/);assert.equal(errors,'');
  assert.equal(diagnosticOptions(['--run-account-id','--cdp-url','http://127.0.0.1:9222']).mode,'account-id');
  assert.equal(diagnosticOptions(['--run-anonymous-login']).mode,'anonymous-login');
  for(const args of [['--cdp-url','http://127.0.0.1:9222'],['--run-account-id'],
    ['--run-anonymous-login','--run-account-id'],['--run-anonymous-login','--proxy','http://foreign.example:7890'],
    ['--run-account-id','--cdp-url','https://127.0.0.1:9222'],['--run-account-id','--cdp-url','http://user@127.0.0.1:9222'],
    ['--run-account-id','--cdp-url','http://127.0.0.1:9222/private'],['--run-account-id','--cdp-url','http://127.0.0.1:9222?secret=fixture']])
    assert.throws(()=>diagnosticOptions(args));
});
