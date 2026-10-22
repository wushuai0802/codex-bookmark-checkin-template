import test from 'node:test';
import assert from 'node:assert/strict';
import {readHhclubProfileState} from '../src/hhclub-two-factor-login.mjs';

const ORIGIN='https://hhanclub.net',now=new Date('2026-10-14T01:00:00Z'),PRIVATE='DO_NOT_READ_OR_RETURN';
function fixture(t,options={}){
  const old=globalThis.DOMParser;t.after(()=>{if(old===undefined)delete globalThis.DOMParser;else globalThis.DOMParser=old;});
  let reads=0,pages=0,closes=0;
  const input=(name,type='text')=>({name,type,hidden:false,disabled:false,parentElement:null,getAttribute:()=>'',
    get value(){throw Error('Reading a login credential or OTP is forbidden');}});
  const link=href=>({getAttribute:key=>key==='href'?href:null,get textContent(){throw Error('Reading account text is unnecessary');}});
  const user=link('/userdetails.php?id='+(options.ownId??'123'));
  const ownLinks=options.badIdentityQuery?[link('/userdetails.php?id=123&action=security')]:[user];
  const links=options.foreignAuth?[user,link('https://other.example/logout.php'),link('https://other.example/usercp.php')]:
    [user,link('/logout.php'),link('/usercp.php'),link('/attendance.php')];
  const loginInputs=[input('username'),input('password','password'),input('two_step_code')];
  const loginForm={getAttribute:name=>name==='method'?'POST':name==='action'?options.loginAction??'/takelogin.php':null,
    querySelectorAll:()=>loginInputs};
  const verification={getAttribute:name=>name==='method'?'POST':name==='action'?'/take2fa.php':null,querySelectorAll:()=>[input('totp')]};
  const inputs=options.loginForm?loginInputs:options.activeOtp?[input('two_step_code')]:options.password?[input('password','password')]:[];
  const doc={body:{textContent:options.waf?'Just a moment':'普通主页二级验证设置说明 '+PRIVATE},
    querySelector:selector=>selector==='base[href]'&&options.base?{}:null,
    querySelectorAll:selector=>selector==='script,style,template,noscript'?[]:
      selector==='#user-info-panel'?Array.from({length:options.panels??1},()=>({querySelectorAll:()=>ownLinks})):
      selector==='a[href]'?links:
      selector==='input'?inputs:
      selector==='input[type="password"]'?inputs.filter(e=>e.type==='password'):
      selector==='form[action]'?options.loginForm?[loginForm]:options.verification?[verification]:[]:[]};
  globalThis.DOMParser=class{parseFromString(html,type){assert.equal(html,'SYNTHETIC_INERT_PAGE');assert.equal(type,'text/html');return doc;}};
  const context={request:{get:async(url,args)=>{
    reads++;assert.equal(url,ORIGIN+'/index.php');assert.equal(args.maxRedirects,0);assert.equal(args.maxRetries,0);
    assert.equal(args.ignoreHTTPSErrors,false);assert.equal(args.headers['Cache-Control'],'no-cache');
    if(options.requestError)throw Error(PRIVATE);
    return {url:()=>options.responseUrl??url,status:()=>options.status??200,
      headers:()=>({date:options.date??'Wed, 14 Oct 2026 01:00:00 GMT',location:options.location}),text:async()=>options.html??'SYNTHETIC_INERT_PAGE'};
  }},newPage:async()=>{
    pages++;return {route:async(pattern)=>assert.equal(pattern,'**/*'),evaluate:(fn,args)=>fn(args),close:async()=>{closes++;}};
  }};
  return {context,get reads(){return reads;},get pages(){return pages;},get closes(){return closes;}};
}
const read=f=>readHhclubProfileState(f.context,{expectedAccountId:'123',now});
const safe=value=>assert.doesNotMatch(JSON.stringify(value),/DO_NOT_READ_OR_RETURN|123|signed|attendance|two_factor|totp|username|password|cookie|token|evidence/);

test('a fresh authenticated own profile is unknown attendance and never supplies not-signed or success evidence',async t=>{
  const f=fixture(t),r=await read(f);
  assert.deepEqual(r,{status:'unknown',authenticated:true,accountMatched:true,submissionAttempted:false});
  assert.equal(f.reads,1);assert.equal(f.pages,1);assert.equal(f.closes,1);safe(r);
});

test('only an exact same-origin ordinary login redirect asks the mother for login recovery',async t=>{
  for(const location of ['/login.php',ORIGIN+'/login.php'])await t.test(location,async t=>{
    const f=fixture(t,{status:302,location}),r=await read(f);
    assert.deepEqual(r,{status:'login_required',submissionAttempted:false});assert.equal(f.pages,0);safe(r);
  });
});

test('foreign, signup, second-factor and query-bearing redirects stay unknown without navigation',async t=>{
  for(const location of ['https://other.example/login.php','/signup.php','/take2fa.php','/login.php?returnto=attendance.php','/login.php#next'])
    await t.test(location,async t=>{
      const f=fixture(t,{status:302,location}),r=await read(f);
      assert.equal(r.status,'unknown');assert.equal(r.authenticated,false);assert.equal(f.reads,1);assert.equal(f.pages,0);safe(r);
    });
});

test('ordinary POST login with optional TOTP is login-required, not a second-factor terminal state',async t=>{
  const f=fixture(t,{panels:0,loginForm:true}),r=await read(f);
  assert.deepEqual(r,{status:'login_required',submissionAttempted:false});assert.equal(f.closes,1);safe(r);
});

test('mismatched/ambiguous identity, active security controls and WAF never prove the expected profile',async t=>{
  for(const issue of ['identity','panels','identityquery','foreignauth','otp','password','verification','waf','base','foreignlogin'])
    await t.test(issue,async t=>{
      const options={ownId:issue==='identity'?'999':'123',panels:issue==='panels'?2:1,badIdentityQuery:issue==='identityquery',
        foreignAuth:issue==='foreignauth',activeOtp:issue==='otp',password:issue==='password',verification:issue==='verification',
        waf:issue==='waf',base:issue==='base',loginForm:issue==='foreignlogin',loginAction:'https://other.example/takelogin.php'};
      const f=fixture(t,options),r=await read(f);
      assert.equal(r.status,'unknown');assert.equal(r.accountMatched,false);assert.equal(f.reads,1);safe(r);
    });
});

test('failed, stale, future and altered-origin responses do not advance the mother flow',async t=>{
  for(const options of [{requestError:true},{status:503},{date:'invalid'},{date:'Tue, 13 Oct 2026 01:00:00 GMT'},
    {date:'Wed, 14 Oct 2026 01:10:00 GMT'},{responseUrl:'https://other.example/index.php'},{html:''}])await t.test(JSON.stringify(options),async t=>{
      const f=fixture(t,options),r=await read(f);
      assert.equal(r.status,'unknown');assert.equal(r.authenticated,false);assert.equal(f.pages,0);safe(r);
    });
});
