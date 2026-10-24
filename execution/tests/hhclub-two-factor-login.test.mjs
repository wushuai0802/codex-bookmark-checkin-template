import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {recoverHhclubTwoFactorLogin,readHhclubAuthenticated,inspectHhclubLogin,prepareHhclubLoginCaptcha,hhclubTwoFactorAdapter} from '../src/hhclub-two-factor-login.mjs';
import {validateSiteTwoFactorScope} from '../src/two-factor-scope.mjs';
import {acquireRunLock,releaseRunLock} from '../src/run-lock.mjs';

const ORIGIN='https://hhanclub.net',LOGIN=ORIGIN+'/login.php',CODE='789345',PRIVATE='MUST_NOT_ESCAPE';
function fixture(t,{signed=false,authenticated=false,matched=true,accept=true,rejected=false,submitError=false,providerError=false,origin=ORIGIN}={}){
  const adapter=origin===ORIGIN?hhclubTwoFactorAdapter:'hddolby-nexus-stepup-v1';
  const journalName=origin===ORIGIN?'hhclub-authentication':'hddolby-password-authentication';
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hhclub-login-')),profile=path.join(root,'data/profile'),controller=path.join(root,'controller');
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  for(const part of ['config','data/profile','tmp','controller/config','controller/data','controller/src'])fs.mkdirSync(path.join(root,part),{recursive:true});
  fs.writeFileSync(path.join(profile,'Local State'),'SYNTHETIC_PROFILE');
  const config={automationUserDataDir:profile,bookmarksPath:path.join(root,'bookmarks'),siteTwoFactorRecovery:{[origin]:
    {enabled:true,reviewed:true,provider:'bitwarden',adapterId:adapter,expectedAccountId:'123',usernameHash:'a'.repeat(64),...(origin!==ORIGIN?{allowPasswordLogin:true}:{})}}};
  const configFile=path.join(root,'config/config.json'),saveConfig=()=>fs.writeFileSync(configFile,JSON.stringify(config));saveConfig();
  const nonce=crypto.randomUUID();
  fs.writeFileSync(path.join(root,'data/v2-integration.json'),JSON.stringify({executionEngine:'v1',v2ProjectRoot:controller}));
  fs.writeFileSync(path.join(controller,'data/v2-run.lock'),JSON.stringify({pid:process.pid,nonce}));
  fs.writeFileSync(path.join(controller,'config/runtime.local.json'),JSON.stringify({executionEngine:'v1',legacyRoot:root}));
  fs.writeFileSync(path.join(controller,'src/legacy-engine.mjs'),`export {validateEngineLease} from ${JSON.stringify(new URL('../../observation/src/legacy-engine.mjs',import.meta.url).href)};`);
  const env=new Map(['CHECKIN_V2_ENGINE_ROOT','CHECKIN_V2_ENGINE_LEASE'].map(k=>[k,process.env[k]]));
  process.env.CHECKIN_V2_ENGINE_ROOT=controller;process.env.CHECKIN_V2_ENGINE_LEASE=nonce;
  t.after(()=>{for(const [k,v]of env)if(v===undefined)delete process.env[k];else process.env[k]=v;});
  let at=Date.parse('2026-10-14T01:00:00Z'),prepares=0,codes=0,submits=0,fills=[],scopeChecks=0;
  let recovered=false;
  const form={usernameHash:'a'.repeat(64),passwordFilled:true,captchaFilled:true,hiddenReady:true,otpReady:true,submitReady:true};
  const inspectOwner=async pid=>({alive:pid===process.pid,startedAt:null});
  const acquire=file=>acquireRunLock(file,{inspectProcess:inspectOwner});
  let authRoute;
  const page={url:()=>origin+'/login.php',route:async(_pattern,value)=>{authRoute=value;},locator:selector=>({fill:async value=>{fills.push(value);if(value)assert.ok(selector.includes(origin===ORIGIN?'two_step_code':'input[name="2fa"]'));},
    evaluate:async(fn,expected)=>fn({value:fills.at(-1)},expected)}),
    waitForLoadState:async()=>{},evaluate:async()=>rejected};
  const args={root,origin,config,page,profile,clock:()=>at,acquire,
    scope:options=>{scopeChecks++;return validateSiteTwoFactorScope({...options,acquire,inspectOwner,ancestors:async()=>new Set([process.pid]),
      readPlan:async()=>({exactScopeConfigured:true,targets:[{origin,candidates:[origin+'/attendance.php']}]})});},
    inspect:async()=>form,readAuthenticated:async()=>({authenticated:authenticated||recovered,accountMatched:matched,signed}),
    prepare:async()=>{prepares++;return {ready:true,reason:'prepared'};},
    withTotp:async options=>{codes++;if(providerError)throw Error(PRIVATE);await options.consume(CODE,{validUntilMs:at+20_000});return PRIVATE;},
    submit:async()=>{
      submits++;
      const state=JSON.parse(fs.readFileSync(path.join(root,'data/bitwarden/'+journalName+'.json')));
      assert.equal(state.attempts.at(-1).state,'pending');assert.ok(fs.existsSync(path.join(root,'tmp/run.lock')));
      assert.ok(fs.existsSync(path.join(root,'data/bitwarden/'+journalName+'.lock')));
      if(origin!==ORIGIN)await authRoute({request:()=>({url:()=>origin+'/takelogin.php',method:()=> 'POST'}),continue:async()=>{},abort:async()=>{throw Error('unexpected');}});
      if(submitError)throw Error(PRIVATE+CODE);if(accept)recovered=true;
    }};
  return {args,root,config,configFile,form,saveConfig,setTime:v=>{at=new Date(v).getTime();},loseSession:()=>{recovered=false;},
    get prepares(){return prepares;},get codes(){return codes;},get submits(){return submits;},get fills(){return fills;},get scopeChecks(){return scopeChecks;}};
}
function safe(value){
  assert.doesNotMatch(JSON.stringify(value),new RegExp(CODE+'|'+PRIVATE+'|usernameHash|expectedAccountId|bodyText|two_step_code|BW_SESSION'));
  if(value.siteTwoFactorRecovery)assert.deepEqual(Object.keys(value.siteTwoFactorRecovery).sort(),['accepted','attempted','reason']);
}

test('authenticated or already-signed original account skips vault and login submission',async t=>{
  for(const signed of [false,true])await t.test(String(signed),async t=>{
    const f=fixture(t,{authenticated:true,signed}),r=await recoverHhclubTwoFactorLogin(f.args);
    assert.equal(r.status,'logged_in');assert.equal(r.siteTwoFactorRecovery.reason,signed?'already_signed':'already_authenticated');
    assert.equal(r.siteTwoFactorRecovery.attempted,false);assert.equal(f.prepares,0);assert.equal(f.codes,0);assert.equal(f.submits,0);safe(r);
  });
});

test('real normal login TOTP is delivered once to the original submit and own account is reverified',async t=>{
  const f=fixture(t),r=await recoverHhclubTwoFactorLogin(f.args);
  assert.equal(r.status,'logged_in');assert.equal(r.siteTwoFactorRecovery.reason,'authentication_accepted');
  assert.equal(f.prepares,1);assert.equal(f.codes,1);assert.equal(f.submits,1);assert.deepEqual(f.fills,[CODE,'']);safe(r);
  const journal=JSON.parse(fs.readFileSync(path.join(f.root,'data/bitwarden/hhclub-authentication.json')));
  assert.equal(journal.attempts.length,1);assert.equal(journal.attempts[0].state,'accepted');safe(journal);
  assert.equal(fs.existsSync(path.join(f.root,'tmp/run.lock')),false);
});

test('the new HDDolby domain reuses the same bounded Nexus algorithm with its reviewed 2fa field and pinned account',async t=>{
  const f=fixture(t,{origin:'https://www.uhddolby.com'}),value=await recoverHhclubTwoFactorLogin(f.args);
  assert.equal(value.status,'logged_in');assert.equal(f.codes,1);assert.equal(f.submits,1);assert.deepEqual(f.fills,[CODE,'']);safe(value);
  const journal=JSON.parse(fs.readFileSync(path.join(f.root,'data/bitwarden/hddolby-password-authentication.json')));
  assert.equal(journal.attempts[0].origin,'https://www.uhddolby.com');assert.equal(journal.attempts[0].adapterId,'hddolby-nexus-stepup-v1');
  assert.equal(journal.attempts[0].state,'accepted');
});

test('wrong username/profile, missing CAPTCHA/password/hidden state, disabled and paused targets never read TOTP',async t=>{
  for(const issue of ['username','profile','captcha','password','hidden','otp','submit','disabled','paused','account','nativeproof','lease'])await t.test(issue,async t=>{
    const f=fixture(t,{authenticated:issue==='account',matched:issue!=='account'});
    if(issue==='username')f.form.usernameHash='b'.repeat(64);
    if(issue==='profile')f.args.profile=path.join(f.root,'data/other');
    if(issue==='captcha')f.form.captchaFilled=false;
    if(issue==='password')f.form.passwordFilled=false;
    if(issue==='hidden')f.form.hiddenReady=false;
    if(issue==='otp')f.form.otpReady=false;
    if(issue==='submit')f.form.submitReady=false;
    if(issue==='disabled'){f.config.siteTwoFactorRecovery[ORIGIN].enabled=false;f.saveConfig();}
    if(issue==='paused'){f.config.disabledCheckinOrigins=[ORIGIN];f.saveConfig();}
    if(issue==='nativeproof')f.args.profileProof=async()=>false;
    if(issue==='lease')delete process.env.CHECKIN_V2_ENGINE_LEASE;
    const r=await recoverHhclubTwoFactorLogin(f.args);
    assert.equal(f.prepares,0);assert.equal(f.codes,0);assert.equal(f.submits,0);safe(r);
  });
});

test('unknown or rejected login never claims success or repeats authentication on the same day',async t=>{
  for(const issue of ['unknown','rejected','throw','wrongaccount'])await t.test(issue,async t=>{
    const f=fixture(t,{accept:issue==='wrongaccount',matched:issue!=='wrongaccount',rejected:issue==='rejected',submitError:issue==='throw'});
    const first=await recoverHhclubTwoFactorLogin(f.args);assert.equal(first.status,'needs_attention');
    assert.equal(first.siteTwoFactorRecovery.attempted,true);assert.equal(first.siteTwoFactorRecovery.accepted,false);safe(first);
    f.loseSession();const second=await recoverHhclubTwoFactorLogin(f.args);
    assert.equal(second.siteTwoFactorRecovery.reason,'daily_recovery_limit');assert.equal(f.submits,1);assert.equal(f.codes,1);safe(second);
    assert.equal(f.fills.at(-1),'');
  });
});

test('provider refusal and exceptions are sanitized and cannot submit credentials',async t=>{
  for(const stage of ['prepare','read'])await t.test(stage,async t=>{
    const f=fixture(t,{providerError:stage==='read'});
    if(stage==='prepare')f.args.prepare=async()=>({ready:false,reason:'vault_locked',raw:PRIVATE});
    const r=await recoverHhclubTwoFactorLogin(f.args);
    assert.equal(r.status,'needs_attention');assert.equal(r.siteTwoFactorRecovery.attempted,false);assert.equal(f.submits,0);safe(r);
  });
});

test('only one callback is accepted and code cannot outlive scope/config/day guards',async t=>{
  for(const issue of ['double','config','day','expired'])await t.test(issue,async t=>{
    const f=fixture(t);
    f.args.withTotp=async options=>{
      if(issue==='config'){f.config.disabledCheckinOrigins=[ORIGIN];f.saveConfig();}
      if(issue==='day')f.setTime('2026-10-15T01:00:00Z');
      const until=f.args.clock()+(issue==='expired'?2000:20_000);
      await options.consume(CODE,{validUntilMs:until});
      if(issue==='double')await options.consume(CODE,{validUntilMs:until});
      return {ready:true,reason:'totp_consumed',raw:PRIVATE};
    };
    const r=await recoverHhclubTwoFactorLogin(f.args);assert.equal(f.submits,issue==='double'?1:0);safe(r);
  });
});

test('old authentication guard is retained while the next business day can attempt normally',async t=>{
  const f=fixture(t,{accept:false}),first=await recoverHhclubTwoFactorLogin(f.args);safe(first);
  f.setTime('2026-10-15T01:00:00Z');const next=await recoverHhclubTwoFactorLogin(f.args);
  assert.equal(f.submits,2);assert.equal(next.siteTwoFactorRecovery.attempted,true);safe(next);
  const state=JSON.parse(fs.readFileSync(path.join(f.root,'data/bitwarden/hhclub-authentication.json')));
  assert.deepEqual(state.attempts.map(e=>e.businessDate),['2026-10-14','2026-10-15']);
});

test('a slow final profile check cannot submit an expired code after its earlier validity check',async t=>{
  const f=fixture(t),started=f.args.clock();
  f.args.profileProof=async()=>{if(f.fills.includes(CODE))f.setTime(started+18_000);return true;};
  const r=await recoverHhclubTwoFactorLogin(f.args);
  assert.equal(r.siteTwoFactorRecovery.reason,'totp_expired');assert.equal(f.submits,0);assert.equal(f.fills.at(-1),'');safe(r);
});

test('HHCLUB current hidden user-info-panel supplies identity through the existing Chrome network',async t=>{
  const saved=new Map(['fetch','DOMParser','location'].map(k=>[k,globalThis[k]]));
  t.after(()=>{for(const [k,v]of saved)if(v===undefined)delete globalThis[k];else globalThis[k]=v;});
  let ownId='123',otp=false,headingCount=1,attendanceLabel='[签到得憨豆]';
  const node=(text,href)=>({textContent:text,getAttribute:name=>name==='href'?href:null});
  const own=()=>node('SYNTHETIC_USER','/userdetails.php?id='+ownId);
  const links=()=>[own(),node('退出','/logout.php'),node('控制面板','/usercp.php'),node(attendanceLabel,'/attendance.php')];
  const actualStructure='<div id="user-info-panel" hidden><a href="userdetails.php?id=123">SYNTHETIC_USER</a></div><a href="attendance.php">[签到得憨豆]</a>';
  globalThis.location={origin:ORIGIN};
  globalThis.fetch=async(url,options)=>{
    assert.equal(url,ORIGIN+'/index.php');assert.equal(options.method,'GET');assert.equal(options.credentials,'same-origin');
    assert.equal(options.redirect,'manual');assert.equal(options.cache,'no-store');
    return {url,status:200,headers:new Map([['date','Wed, 14 Oct 2026 01:00:00 GMT']]),text:async()=>actualStructure};
  };
  globalThis.DOMParser=class{parseFromString(html,type){
    assert.equal(html,actualStructure);assert.equal(type,'text/html');
    return {querySelector:()=>null,body:{textContent:'欢迎回来'},querySelectorAll:selector=>
      selector==='#user-info-panel'?Array.from({length:headingCount},()=>({querySelectorAll:()=>[own()]})):
      selector==='a[href]'?links():selector==='input'&&otp?[{name:'two_step_code',type:'text',getAttribute:()=>'',parentElement:null}]:[]};
  }};
  const page={url:()=>LOGIN,context:()=>{throw Error('API client must not be used');},evaluate:(fn,args)=>fn(args)};
  assert.deepEqual(await readHhclubAuthenticated(page,{expectedAccountId:'123',now:new Date('2026-10-14T01:00:00Z')}),
    {authenticated:true,accountMatched:true,signed:false});
  for(const label of ['[签到得憨豆]','[已签到]','[签到已得840]']){
    attendanceLabel=label;
    assert.equal((await readHhclubAuthenticated(page,{expectedAccountId:'123',now:new Date('2026-10-14T01:00:00Z')})).signed,false);
  }
  ownId='999';assert.equal((await readHhclubAuthenticated(page,{expectedAccountId:'123',now:new Date('2026-10-14T01:00:00Z')})).accountMatched,false);
  otp=true;assert.equal((await readHhclubAuthenticated(page,{expectedAccountId:'999',now:new Date('2026-10-14T01:00:00Z')})).authenticated,false);
  otp=false;headingCount=0;assert.equal(await readHhclubAuthenticated(page,{expectedAccountId:'123',now:new Date('2026-10-14T01:00:00Z')}),null);
});

test('a same-origin login form must have the reviewed POST fields and ready CAPTCHA, without returning secrets',async t=>{
  const saved=new Map(['document','location','getComputedStyle'].map(k=>[k,globalThis[k]]));
  t.after(()=>{for(const [k,v]of saved)if(v===undefined)delete globalThis[k];else globalThis[k]=v;});
  let fields=[['username','text',' USER '],['password','password',PRIVATE],['two_step_code','text',''],['imagestring','text','ABCD'],
    ['secret','hidden',PRIVATE],['imagehash','hidden',PRIVATE]].map(([name,type,value])=>({name,type,value,disabled:false,readOnly:false,
      getBoundingClientRect:()=>({width:10,height:10})}));
  const image={src:ORIGIN+'/image.php?action=regimage&imagehash='+PRIVATE+'&secret='+PRIVATE,
    getBoundingClientRect:()=>({width:240,height:60})};
  const form={method:'post',action:ORIGIN+'/takelogin.php',target:'',querySelectorAll:selector=>
    selector==='input'?fields:selector==='img'?[image]:[{disabled:false}]};
  globalThis.document={forms:[form],querySelector:()=>null};globalThis.location={href:LOGIN};
  globalThis.getComputedStyle=()=>({display:'block',visibility:'visible'});
  const page={url:()=>LOGIN,evaluate:(fn,args)=>fn(args)};
  const snapshot=await inspectHhclubLogin(page);
  assert.equal(snapshot.usernameHash,crypto.createHash('sha256').update('user').digest('hex'));
  assert.equal(snapshot.passwordFilled,true);assert.equal(snapshot.captchaFilled,true);
  assert.equal(snapshot.captchaLength,-1);assert.equal(snapshot.captchaImageReady,true);assert.match(snapshot.captchaBinding,/^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(snapshot),new RegExp(PRIVATE+'|'+CODE));
  fields.find(f=>f.name==='imagestring').value='';assert.equal((await inspectHhclubLogin(page)).captchaFilled,false);
  image.src='https://another.example/image.php?action=regimage&imagehash='+PRIVATE+'&secret='+PRIVATE;
  assert.equal((await inspectHhclubLogin(page)).captchaImageReady,false);
  image.src=ORIGIN+'/image.php?action=regimage&imagehash=DIFFERENT&secret='+PRIVATE;
  assert.equal((await inspectHhclubLogin(page)).captchaImageReady,false);
  form.action='https://another.example/takelogin.php';assert.equal(await inspectHhclubLogin(page),null);
});

function captchaFixture(){
  const facts={usernameHash:'a'.repeat(64),passwordFilled:true,captchaFilled:false,hiddenReady:true,otpReady:true,
    submitReady:true,captchaImageReady:true,captchaBinding:'c'.repeat(64),captchaLength:-1};
  let screenshots=0,recognitions=0,secondOpinions=0,value='',current=true;
  const box={x:5,y:5,width:240,height:60};
  const page={url:()=>LOGIN,locator:selector=>({count:async()=>1,boundingBox:async()=>box,
    screenshot:async()=>{assert.ok(selector.includes('img['));screenshots++;return Buffer.from('SYNTHETIC_CAPTCHA_ONLY');},
    fill:async text=>{assert.ok(selector.includes('imagestring'));value=text;facts.captchaFilled=Boolean(text);},
    evaluate:async(fn,expected)=>fn({value},expected)})};
  const args={usernameHash:'a'.repeat(64),config:{},assertCurrent:async()=>current,inspect:async()=>({...facts}),
    recognize:async image=>{assert.ok(Buffer.isBuffer(image));recognitions++;return {code:'ABC123',confidence:85};},
    secondOpinion:async()=>{secondOpinions++;return {code:null,confidence:10};}};
  return {page,args,facts,box,setCurrent:v=>{current=v;},get screenshots(){return screenshots;},get recognitions(){return recognitions;},
    get secondOpinions(){return secondOpinions;},get value(){return value;}};
}

test('HHCLUB ordinary CAPTCHA preparation captures only the scoped image and does not fetch OTP or submit login',async()=>{
  const f=captchaFixture(),r=await prepareHhclubLoginCaptcha(f.page,f.args);
  assert.deepEqual(r,{prepared:true,reason:'captcha_prepared'});assert.equal(f.screenshots,1);assert.equal(f.recognitions,1);
  assert.equal(f.secondOpinions,0);assert.equal(f.value,'ABC123');assert.doesNotMatch(JSON.stringify(r),/ABC123|imagehash|secret/);
});

test('unbound username/password, missing image protocol, wrong glyph length and oversized image never reach OCR',async()=>{
  for(const issue of ['username','password','hidden','protocol','glyphs','bounds','scope']){
    const f=captchaFixture();
    if(issue==='username')f.facts.usernameHash='b'.repeat(64);
    if(issue==='password')f.facts.passwordFilled=false;
    if(issue==='hidden')f.facts.hiddenReady=false;
    if(issue==='protocol')f.facts.captchaImageReady=false;
    if(issue==='glyphs')f.facts.captchaLength=4;
    if(issue==='bounds')f.box.width=2000;
    if(issue==='scope')f.setCurrent(false);
    assert.equal((await prepareHhclubLoginCaptcha(f.page,f.args)).prepared,false);
    assert.equal(f.screenshots,0);assert.equal(f.recognitions,0);assert.equal(f.value,'');
  }
});

test('low OCR confidence uses at most one configured second opinion; invalid consensus never fills a guess',async()=>{
  const f=captchaFixture();f.args.recognize=async()=>({code:'ABC123',confidence:20});
  assert.equal((await prepareHhclubLoginCaptcha(f.page,f.args)).prepared,false);assert.equal(f.secondOpinions,1);assert.equal(f.value,'');
  f.args.secondOpinion=async(image,local,options)=>{
    assert.equal(options.origin,ORIGIN);assert.equal(options.length,6);assert.equal(options.alphabet,'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789');
    return {code:'ABC123',confidence:70,externalConsensus:true,externalProvider:'baidu'};
  };
  assert.equal((await prepareHhclubLoginCaptcha(f.page,f.args)).prepared,true);assert.equal(f.value,'ABC123');
});

test('the original challenge hash and live credential/scope proof must still match after OCR',async()=>{
  for(const issue of ['hash','scope','credentials','code','confidence']){
    const f=captchaFixture();f.args.recognize=async()=>{
      if(issue==='hash')f.facts.captchaBinding='d'.repeat(64);
      if(issue==='scope')f.setCurrent(false);
      if(issue==='credentials')f.facts.usernameHash='b'.repeat(64);
      return {code:issue==='code'?'BAD':'ABC123',confidence:issue==='confidence'?NaN:85};
    };
    assert.equal((await prepareHhclubLoginCaptcha(f.page,f.args)).prepared,false);assert.equal(f.value,'');
  }
});

test('an already-filled CAPTCHA is left untouched without re-recognition',async()=>{
  const f=captchaFixture();f.facts.captchaFilled=true;
  assert.deepEqual(await prepareHhclubLoginCaptcha(f.page,f.args),{prepared:true,reason:'captcha_already_filled'});
  assert.equal(f.screenshots,0);assert.equal(f.recognitions,0);
});
