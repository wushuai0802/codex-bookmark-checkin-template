import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {runOAuthBrowserFlow} from '../src/oauth-browser-flow.mjs';
import {executionRuleForProfile} from '../src/execution-adapter-registry.mjs';

const site='https://fixture.example';
function fixture({destination=site+'/console',delay=0,callback=null,identity=true,clickError=false}={}){
  const emitter=new EventEmitter();let waits=0,clicks=0;
  const page={current:site+'/login',url(){return this.current;},context:()=>emitter,
    waitForTimeout:async()=>{waits++;},waitForEvent:async()=>null,
    getByRole:(_,{name}={})=>({count:async()=>name==='使用 GitHub 继续'&&waits>=delay?1:0,isVisible:async()=>true,
      click:async()=>{clicks++;page.current=destination;if(callback)emitter.emit('response',{url:()=>site+'/api/oauth/github',json:async()=>callback,status:()=>403});if(clickError)throw Error('timeout');}}),
    getByText:()=>({count:async()=>0,isVisible:async()=>false})};
  const options={context:{page},site,provider:'GitHub',expectedIdentity:'7',waitMs:3000,readIdentity:async()=>identity?{userId:'7',origin:site}:null};
  return {options,page,emitter,counts:()=>({waits,clicks})};
}
test('delayed provider waits once per poll rather than once per label',async()=>{
  const f=fixture({delay:3});assert.equal((await runOAuthBrowserFlow(f.options)).state,'triggered');assert.deepEqual(f.counts(),{waits:3,clicks:1});
});
test('callback rejection overrides even a readable cached identity and cleans observers',async()=>{
  const f=fixture({callback:{success:false,message:'state rejected'}});const r=await runOAuthBrowserFlow(f.options);
  assert.equal(r.reason,'oauth_callback_rejected');assert.equal(r.actionMayHaveHappened,true);assert.equal(f.emitter.listenerCount('response'),0);
});
test('click timeout is uncertain and never safe for blind relogin',async()=>{
  const f=fixture({clickError:true});const r=await runOAuthBrowserFlow(f.options);assert.equal(r.actionMayHaveHappened,true);assert.equal(f.counts().clicks,1);
});
test('callback page alone cannot prove login and timeout is bounded',async()=>{
  const f=fixture({destination:site+'/oauth/github',identity:false});const r=await runOAuthBrowserFlow(f.options);
  assert.equal(r.reason,'oauth_callback_timeout');assert.equal(r.actionMayHaveHappened,true);assert.equal(f.counts().waits,2);
});
test('unreviewed OAuth host fails before any provider-host action',async()=>{
  const f=fixture({destination:'https://github.com.evil.example/login'});assert.equal((await runOAuthBrowserFlow(f.options)).reason,'oauth_untrusted_origin');
});
test('GitHub authorize route can redirect before credentials are requested',async()=>{
  const f=fixture({destination:'https://github.com/login/oauth/authorize'});
  f.page.waitForTimeout=async()=>{f.page.current=site+'/console';};assert.equal((await runOAuthBrowserFlow(f.options)).state,'triggered');
});
test('stuck authorization button is clicked only once',async()=>{
  const f=fixture({destination:'https://connect.linux.do/oauth2/authorize',identity:false});let approved=0;
  f.options.provider='LinuxDO';const original=f.page.getByRole;
  f.page.getByRole=(role,opts={})=>opts.name==='授权'&&role==='link'?{count:async()=>1,isVisible:async()=>true,click:async()=>{approved++;}}:original(role,{name:typeof opts.name==='string'?opts.name.replace('LinuxDO','GitHub'):opts.name});
  assert.equal((await runOAuthBrowserFlow(f.options)).reason,'oauth_callback_timeout');assert.equal(approved,1);
});

test('account-level upstream import preserves ID binding and excludes credentials',()=>{
  const origin='https://agentrouter.org',profile={origin,accountKey:'primary',expectedIdentity:'7',provider:'LinuxDO'};
  const account={accountKey:'primary',accountId:'7',provider:'LinuxDO',upstreamProvider:'Google',upstreamAccount:'secret',automationUserDataDir:'private'};
  const config={oauthAccountIdentities:{[origin]:account}};
  const rule=executionRuleForProfile({profile,config});assert.equal(rule.upstreamProvider,'Google');assert.equal(JSON.stringify(rule).includes('secret'),false);assert.equal(JSON.stringify(rule).includes('private'),false);
  assert.throws(()=>executionRuleForProfile({profile:{...profile,expectedIdentity:'8'},config}),/identity mismatch/);
});
