import test from 'node:test';
import assert from 'node:assert/strict';
import {createNewApiExecutionAdapter} from '../src/new-api-execution-adapter.mjs';
import {createNewApiCaptchaExecutionAdapter} from '../src/new-api-captcha-execution-adapter.mjs';
import {createOAuthApiExecutionAdapter} from '../src/oauth-api-execution-adapter.mjs';
import {createPtExecutionAdapter} from '../src/pt-execution-adapter.mjs';
import {createVibeEntitlementExecutionAdapter} from '../src/vibe-entitlement-execution-adapter.mjs';
import {createAnyRouterExecutionAdapter} from '../src/anyrouter-execution-adapter.mjs';

const day='2026-09-15';

function apiPage(handler){
  const calls=[];
  const page={
    current:'https://fixture.example/',
    calls,
    url(){return this.current;},
    async goto(url){this.current=String(url);},
    async evaluate(_fn,args){calls.push(args);return handler(args,calls);},
    async waitForTimeout(){}
  };
  return {page,calls};
}

test('New API refreshes one cached token and never exposes it in the result',async()=>{
  let refreshes=0,statusCalls=0;
  const fake=apiPage(args=>{
    if(args?.keys)return ['7'];
    if(args?.path==='/api/user/auth/refresh'){refreshes+=1;return {status:200,url:'https://fixture.example/api/user/auth/refresh',success:true,token:'private-token',expiresIn:600};}
    if(args?.path==='/api/user/self')return {status:200,url:'https://fixture.example/api/user/self',body:{success:true,data:{id:7,username:'reader'}}};
    if(String(args?.path).startsWith('/api/user/checkin?')){statusCalls+=1;return {status:200,url:'https://fixture.example/api/user/checkin?month=2026-09',body:{success:true,data:{stats:{checked_in_today:statusCalls>1,records:statusCalls>1?[{checkin_date:day,user_id:7,quota_awarded:25}]:[]}}}};}
    if(args?.path==='/api/user/checkin')return {status:200,url:'https://fixture.example/api/user/checkin',body:{success:true,message:'签到成功，获得 $25'}};
    return {status:500,url:'https://fixture.example/',body:{}};
  });
  const adapter=createNewApiExecutionAdapter({origin:'https://fixture.example',rule:{authRefreshPath:'/api/user/auth/refresh',rewardAmount:25}});
  const identity=await adapter.methods.identity({expectedIdentity:'7',context:fake});
  assert.equal(identity.userId,'7');
  assert.equal((await adapter.methods.read_status({identity,businessDate:day,context:fake})).state,'not_signed');
  assert.equal((await adapter.methods.submit_once({identity,context:fake})).state,'accepted');
  assert.equal((await adapter.methods.verify({identity,businessDate:day,context:fake})).state,'confirmed');
  assert.equal(refreshes,1);
  assert.equal(fake.calls.filter(args=>args?.path==='/api/user/auth/refresh').length,1);
});

test('captcha adapter requires an injected solver and accepts a bounded candidate',async()=>{
  const image='data:image/png;base64,'+Buffer.from('fixture-image').toString('base64');
  const fake=apiPage(args=>{
    if(args?.keys)return ['7'];
    if(args?.path==='/api/user/self')return {status:200,url:'https://fixture.example/api/user/self',body:{success:true,data:{id:7}}};
    if(args?.path==='/api/user/checkin/captcha')return {status:200,url:'https://fixture.example/api/user/checkin/captcha',body:{success:true,data:{captcha_id:'c1',captcha_image:image}}};
    if(args?.path==='/api/user/checkin')return {status:200,url:'https://fixture.example/api/user/checkin',body:{success:true}};
    return {status:500,url:'https://fixture.example/',body:{}};
  });
  const adapter=createNewApiCaptchaExecutionAdapter({origin:'https://fixture.example',rule:{selfPath:'/api/user/self',statusPath:'/api/user/checkin'}});
  const noSolver=await adapter.methods.submit_once({identity:{userId:'7'},context:fake});
  assert.equal(noSolver.reason,'captcha_solver_not_configured');
  const solved=await adapter.methods.submit_once({identity:{userId:'7'},context:{...fake,solveCaptcha:async()=>({code:'KPT2C'})}});
  assert.equal(solved.state,'accepted');
  assert.equal(fake.calls.filter(args=>args?.path==='/api/user/checkin').length,1);
});

test('captcha adapter never reuses a single-use challenge for another answer',async()=>{
  let challengeCount=0,submitCount=0;
  const fake=apiPage(args=>{
    if(args?.path==='/api/user/checkin/captcha'){challengeCount+=1;return {status:200,url:'https://fixture.example/api/user/checkin/captcha',body:{success:true,data:{captcha_id:'c'+challengeCount,captcha_image:'data:image/png;base64,'+Buffer.from('x'+challengeCount).toString('base64')}}};}
    if(args?.path==='/api/user/checkin'){submitCount+=1;return {status:200,url:'https://fixture.example/api/user/checkin',body:{success:false,message:'验证码错误'}};}
    return {status:500,url:'https://fixture.example/',body:{}};
  });
  const adapter=createNewApiCaptchaExecutionAdapter({origin:'https://fixture.example',rule:{maxAttempts:2}});
  const result=await adapter.methods.submit_once({identity:{userId:'7'},context:{...fake,solveCaptcha:async()=>({candidates:['KPT2C','KP74C']})}});
  assert.equal(result.reason,'captcha_unresolved');assert.equal(submitCount,2);assert.equal(challengeCount,2);
});

test('OAuth API adapter keeps target and service origins separate and requires a dated record',async()=>{
  let statusMode='ready';
  const fake=apiPage(args=>{
    if(args?.path==='https://up.x666.me/api/user/self')return {status:200,url:'https://up.x666.me/api/user/self',body:{success:true,data:{id:7,username:'wheel'}}};
    if(args?.url?.endsWith('/api/user/self'))return {status:200,url:'https://up.x666.me/api/user/self',body:{success:true,data:{id:7}}};
    if(args?.url?.includes('/api/checkin/status'))return statusMode==='ready'
      ? {status:200,url:'https://up.x666.me/api/checkin/status',body:{success:true,data:{can_spin:true}}}
      : {status:200,url:'https://up.x666.me/api/checkin/status',body:{success:true,data:{can_spin:false,spin_date:day}}};
    if(args?.url?.includes('/api/checkin/spin'))return {status:200,url:'https://up.x666.me/api/checkin/spin',body:{success:true,message:'签到成功'}};
    return {status:200,url:'https://up.x666.me/',body:{success:true,data:{}}};
  });
  const adapter=createOAuthApiExecutionAdapter({origin:'https://x666.me',rule:{serviceOrigin:'https://up.x666.me',allowedServiceOrigins:['https://up.x666.me']}});
  const identity=await adapter.methods.identity({expectedIdentity:'7',context:fake});
  assert.equal(identity.origin,'https://x666.me');
  assert.equal((await adapter.methods.read_status({identity,businessDate:day,context:fake})).state,'not_signed');
  statusMode='done';
  assert.equal((await adapter.methods.submit_once({identity,context:fake})).state,'accepted');
  assert.equal((await adapter.methods.verify({identity,businessDate:day,context:fake})).state,'confirmed');
});

test('OAuth API cannot treat can_spin false without a date as completion',async()=>{
  const fake=apiPage(args=>{
    if(args?.url?.includes('/api/checkin/status'))return {status:200,url:'https://up.x666.me/api/checkin/status',body:{success:true,data:{can_spin:false}}};
    return {status:200,url:'https://up.x666.me/api/user/self',body:{success:true,data:{id:7}}};
  });
  const adapter=createOAuthApiExecutionAdapter({origin:'https://x666.me',rule:{serviceOrigin:'https://up.x666.me',allowedServiceOrigins:['https://up.x666.me']}});
  const status=await adapter.methods.read_status({identity:{userId:'7'},businessDate:day,context:fake});
  assert.equal(status.state,'unknown');assert.equal(status.reason,'status_date_contract_missing');
});

function domElement({text='',bodyText='',click=null,screenshot=Buffer.from('image')}={}){
  const element={innerText:text,value:text,disabled:false,href:'',form:null};
  return {
    count:async()=>1,nth(){return this;},first(){return this;},isVisible:async()=>true,isEnabled:async()=>true,
    innerText:async()=>typeof bodyText==='function'?bodyText():bodyText||text,getAttribute:async name=>name==='src'?'https://fixture.example/image.php':'',
    evaluate:async callback=>callback(element),screenshot:async()=>screenshot,
    fill:async value=>{element.value=value;},click:async()=>{if(click)click();}
  };
}

test('PT adapter accepts an input submit control and binds account/date evidence',async()=>{
  let signed=false;
  const body=domElement({bodyText:()=>''});
  body.innerText=async()=>'PT account ID: 7 '+day+' '+(signed?'今日已签到':'今日未签到');
  const action=domElement({text:'立即签到',click:()=>{signed=true;}});
  const page={
    current:'https://pt.example/',
    url(){return this.current;},goto:async url=>{page.current=String(url);},
    locator:selector=>selector==='body'?body:(selector.includes('showupbutton')?action:{count:async()=>0,nth(){return this;},isVisible:async()=>false}),
    waitForTimeout:async()=>{}
  };
  const adapter=createPtExecutionAdapter({origin:'https://pt.example',rule:{allowUndatedStatus:false}});
  const identity=await adapter.methods.identity({expectedIdentity:'7',context:{page}});
  assert.equal(identity.userId,'7');
  const before=await adapter.methods.read_status({identity,businessDate:day,context:{page}});
  assert.equal(before.state,'not_signed');
  assert.equal((await adapter.methods.submit_once({identity,context:{page}})).state,'accepted');
  assert.equal((await adapter.methods.verify({identity,businessDate:day,context:{page}})).state,'confirmed');
});

test('PT image CAPTCHA uses one solver answer per refreshed challenge',async()=>{
  let signed=false,refreshes=0,submitted=0;
  const body=domElement({bodyText:()=> 'PT account ID: 7 '+day+' '+(signed?'今日已签到':'请输入验证码')});
  const input=domElement({text:''});
  const image=domElement({screenshot:Buffer.from('captcha-'+refreshes)});
  image.screenshot=async()=>Buffer.from('captcha-'+refreshes);
  const submit=domElement({text:'立即签到',click:()=>{submitted+=1;signed=true;}});
  const page={
    current:'https://pt.example/attendance.php',
    url(){return this.current;},goto:async url=>{page.current=String(url);},reload:async()=>{refreshes+=1;},
    locator:selector=>{
      if(selector==='body')return body;
      if(selector.includes('imagestring'))return input;
      if(selector.includes('showupimg'))return image;
      if(selector.includes('showupbutton'))return submit;
      return {count:async()=>0,nth(){return this;},isVisible:async()=>false};
    },
    waitForTimeout:async()=>{}
  };
  const adapter=createPtExecutionAdapter({origin:'https://pt.example',rule:{allowUndatedStatus:true}});
  const noSolver=await adapter.methods.submit_once({identity:{userId:'7'},context:{page}});
  assert.equal(noSolver.reason,'challenge_required');
  const solved=await adapter.methods.submit_once({identity:{userId:'7'},context:{page,solveCaptcha:async()=>['ABC123','XYZ789']}});
  assert.equal(solved.state,'accepted');assert.equal(submitted,1);
});

test('Vibe entitlement does not turn an active subscription into a fake daily sign-in',async()=>{
  const fake=apiPage(args=>{
    if(args?.path==='/frontend-api/getme')return {status:200,url:'https://new.sharedchat.cc/frontend-api/getme',body:{code:1,data:{id:7,name:'vibe'}}};
    return {status:200,url:'https://new.sharedchat.cc/frontend-api/vibe-code/quota',body:{code:1,data:{codex:{isAuth:true,subscriptions:[{isActive:true,expireTime:'2099-01-01T00:00:00Z'}]}}}};
  });
  const adapter=createVibeEntitlementExecutionAdapter({origin:'https://new.sharedchat.cc',rule:{claimEnabled:false}});
  const identity=await adapter.methods.identity({expectedIdentity:'7',context:fake});
  const status=await adapter.methods.read_status({identity,businessDate:day,context:fake});
  assert.equal(status.state,'not_available');
  assert.equal(status.evidence.outcome,'entitlement_active');
});

test('Vibe requires an account-bound daily claim before reporting completion',async()=>{
  let mismatch=false;
  const fake=apiPage(args=>{
    if(args?.path==='/frontend-api/getme')return {status:200,url:'https://new.sharedchat.cc/frontend-api/getme',body:{code:'1',data:{id:7,name:'vibe'}}};
    return {status:200,url:'https://new.sharedchat.cc/frontend-api/vibe-code/quota',body:{code:1,data:{id:mismatch?8:7,daily_claimed:true,claim_date:day}}};
  });
  const adapter=createVibeEntitlementExecutionAdapter({origin:'https://new.sharedchat.cc'});
  const identity=await adapter.methods.identity({expectedIdentity:'7',context:fake});
  assert.equal((await adapter.methods.read_status({identity,businessDate:day,context:fake})).state,'already_done');
  mismatch=true;
  assert.equal((await adapter.methods.read_status({identity,businessDate:day,context:fake})).reason,'identity_mismatch');
});

test('AnyRouter browser adapter uses account-bound status and log evidence',async()=>{
  let done=false;
  const fake=apiPage(args=>{
    if(args?.keys)return ['7'];
    if(args?.path==='/api/user/self')return {status:200,url:'https://anyrouter.top/api/user/self',body:{success:true,data:{id:7}}};
    if(args?.path==='/api/status?month=2026-09')return {status:200,url:'https://anyrouter.top/api/status?month=2026-09',body:{success:true,data:{checked_in_today:done,records:done?[{checkin_date:day,user_id:7}]:[]}}};
    if(args?.path==='/api/user/sign_in')return {status:200,url:'https://anyrouter.top/api/user/sign_in',body:{success:true,message:'签到成功'}};
    if(args?.path?.startsWith('/api/log/self'))return {status:200,url:'https://anyrouter.top/api/log/self',body:{success:true,data:{items:done?[{type:4,user_id:7,created_at:Date.parse(day+'T02:00:00+08:00')/1000,content:'每日签到成功，增加额度 $25'}]:[]}}};
    return {status:500,url:'https://anyrouter.top/',body:{}};
  });
  const adapter=createAnyRouterExecutionAdapter({origin:'https://anyrouter.top'});
  const identity=await adapter.methods.identity({expectedIdentity:'7',context:fake});
  assert.equal((await adapter.methods.read_status({identity,businessDate:day,context:fake})).state,'not_signed');
  done=true;
  assert.equal((await adapter.methods.submit_once({identity,context:fake})).state,'accepted');
  assert.equal((await adapter.methods.verify({identity,businessDate:day,context:fake})).state,'confirmed');
});

test('AnyRouter falls back to the filtered reward log when status has no daily flag',async()=>{
  let logReads=0;
  const fake=apiPage(args=>{
    if(args?.keys)return ['7'];
    if(args?.path==='/api/user/self')return {status:200,url:'https://anyrouter.top/api/user/self',body:{success:true,data:{id:7}}};
    if(args?.path?.startsWith('/api/status'))return {status:200,url:'https://anyrouter.top/api/status',body:{success:true,data:{quota_per_unit:1}}};
    if(args?.path?.startsWith('/api/log/self')){logReads+=1;return {status:200,url:'https://anyrouter.top/api/log/self',body:{success:true,data:{items:[]}}};}
    return {status:200,url:'https://anyrouter.top/',body:{success:true}};
  });
  const adapter=createAnyRouterExecutionAdapter({origin:'https://anyrouter.top'});
  const result=await adapter.methods.read_status({identity:{userId:'7'},businessDate:day,context:fake});
  assert.equal(result.state,'not_signed');assert.equal(result.evidence.source,'anyrouter_log');assert.equal(logReads,1);
});
