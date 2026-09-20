import test from 'node:test';
import assert from 'node:assert/strict';
import {createOAuthRewardExecutionAdapter} from '../src/oauth-reward-execution-adapter.mjs';

function locator(clicks,name='provider'){
  return {count:async()=>1,isVisible:async()=>true,click:async()=>{clicks.push(name);}};
}

test('Agent adapter uses the OAuth relogin flow instead of a guessed check-in endpoint',async()=>{
  const calls=[],clicks=[],page={
    current:'https://agentrouter.org/console',
    url(){return this.current;},
    goto:async url=>{page.current=String(url);},
    evaluate:async(_fn,args)=>{
      if(args?.expected)return {status:200,storageIds:[String(args.expected)],body:{success:true,data:{id:Number(args.expected),username:'fixture-agent'}}};
      calls.push(String(args?.path??''));
      return {status:200,url:`https://agentrouter.org${args?.path??''}`,body:{success:true},text:''};
    },
    getByRole:(_role,options)=>locator(clicks,options?.name?.toString?.()||'provider'),
    getByText:(_text)=>locator(clicks,'text'),
    waitForEvent:async()=>null,
    waitForLoadState:async()=>{},
    waitForURL:async()=>{},
    waitForTimeout:async()=>{}
  };
  const context={page},adapter=createOAuthRewardExecutionAdapter({origin:'https://agentrouter.org',rule:{provider:'LinuxDO'}});
  const result=await adapter.methods.submit_once({identity:{userId:'700001'},context});
  assert.equal(result.state,'accepted');
  assert.ok(calls.some(value=>value.includes('/api/user/logout')));
  assert.equal(calls.some(value=>value.includes('/api/user/checkin')||value.includes('/api/user/sign_in')),false);
  assert.ok(clicks.length>=1);
});

test('Agent adapter waits for a provider button rendered after the login page load',async()=>{
  let rendered=false;const clicks=[];
  const delayed={count:async()=>rendered?1:0,isVisible:async()=>rendered,waitFor:async()=>{rendered=true;},click:async()=>{clicks.push('provider');}};
  const page={
    current:'https://agentrouter.org/console',url(){return this.current;},goto:async url=>{page.current=String(url);},
    evaluate:async(_fn,args)=>args?.expected?{status:200,storageIds:[String(args.expected)],body:{success:true,data:{id:Number(args.expected)}}}:{status:200,url:`https://agentrouter.org${args?.path??''}`,body:{success:true},text:''},
    getByRole:()=>delayed,getByText:()=>delayed,waitForEvent:async()=>null,waitForLoadState:async()=>{},waitForURL:async()=>{},waitForTimeout:async()=>{rendered=true;}
  };
  const adapter=createOAuthRewardExecutionAdapter({origin:'https://agentrouter.org',rule:{provider:'GitHub'}});
  const result=await adapter.methods.submit_once({identity:{userId:'336634'},context:{page}});
  assert.equal(result.state,'accepted');assert.equal(clicks[0],'provider');assert.ok(clicks.length>=1);
});

test('GitHub provider accepts only its reviewed OAuth host family',async()=>{
  const page={
    current:'https://agentrouter.org/login',url(){return this.current;},goto:async url=>{page.current=String(url);},
    evaluate:async(_fn,args)=>args?.expected?{status:200,storageIds:[String(args.expected)],body:{success:true,data:{id:Number(args.expected)}}}:{status:200,url:`https://agentrouter.org${args?.path??''}`,body:{success:true},text:''},
    getByRole:()=>locator([]),getByText:()=>locator([]),waitForEvent:async()=>({current:'https://github.com/login/oauth/authorize',url(){return this.current;},evaluate:async(_fn,args)=>({status:200,body:{data:{id:Number(args.expected)}}}),waitForTimeout:async function(){this.current='https://agentrouter.org/console';},getByRole:()=>({count:async()=>0,isVisible:async()=>false})}),waitForTimeout:async()=>{}
  };
  const adapter=createOAuthRewardExecutionAdapter({origin:'https://agentrouter.org',rule:{provider:'GitHub'}});
  const result=await adapter.methods.submit_once({identity:{userId:'336634'},context:{page}});
  assert.equal(result.state,'accepted');
});

test('OAuth reward status requires the current day, account, type, and amount',async()=>{
  const day='2026-09-15',calls=[];
  const page={
    url:()=> 'https://agentrouter.org/console',
    evaluate:async(_fn,args)=>{
      calls.push(args);
      if(args?.keys)return ['700001'];
      if(String(args?.path??'').startsWith('/api/user/self'))return {status:200,url:'https://agentrouter.org/api/user/self',body:{success:true,data:{id:700001}}};
      return {status:200,url:'https://agentrouter.org/api/log/self',body:{success:true,data:{items:[
        {type:4,user_id:700001,created_at:Date.parse('2026-09-14T02:00:00+08:00')/1000,content:'每日签到成功，增加额度 $25'},
        {type:4,user_id:999,created_at:Date.parse(day+'T02:00:00+08:00')/1000,content:'每日签到成功，增加额度 $25'}
      ]}}};
    }
  };
  const adapter=createOAuthRewardExecutionAdapter({origin:'https://agentrouter.org'});
  const identity=await adapter.methods.identity({expectedIdentity:'700001',context:{page}});
  const status=await adapter.methods.read_status({identity,businessDate:day,context:{page}});
  assert.equal(status.state,'not_signed');assert.equal(calls.filter(args=>String(args?.path??'').includes('page_size=100')).length,1);
});

test('reward log lag is polled for the configured V1 verification interval',async()=>{
  let reads=0;const day='2026-09-17';
  const page={url:()=> 'https://agentrouter.org/console',waitForTimeout:async()=>{},evaluate:async(_fn,args)=>{
    if(args.expected)return {status:200,body:{data:{id:7}}};
    reads++;return {status:200,body:{success:true,data:{items:reads<6?[]:[{type:4,user_id:7,created_at:Date.parse(day+'T01:00:00+08:00')/1000,content:'每日签到成功，增加额度 $25'}]}}};
  }};
  const adapter=createOAuthRewardExecutionAdapter({origin:'https://agentrouter.org',rule:{verificationWaitMs:12000}});
  assert.equal((await adapter.methods.verify({identity:{userId:'7'},businessDate:day,context:{page}})).state,'confirmed');assert.equal(reads,6);
});

test('full log pages and rejected API bodies cannot prove not signed',async()=>{
  for(const body of [{success:false,data:{items:[]}},{success:true,data:{items:Array.from({length:100},()=>({type:1}))}}]){
    const page={url:()=> 'https://agentrouter.org/console',evaluate:async()=>({status:200,body})};
    const adapter=createOAuthRewardExecutionAdapter({origin:'https://agentrouter.org',rule:{maxLogPages:1}});
    assert.equal((await adapter.methods.read_status({identity:{userId:'7'},businessDate:'2026-09-17',context:{page}})).state,'unknown');
  }
});

test('known WAF confirmation is bounded once and requires fresh self identity',async()=>{
  let clicks=0,requests=0;const site='https://agentrouter.org';
  const page={url:()=>site,goto:async()=>{},waitForTimeout:async()=>{},
    locator:selector=>selector==='button#sl-check'?{count:async()=>clicks?0:1,isVisible:async()=>true,click:async()=>{clicks++;}}:{count:async()=>1,innerText:async()=> '客户端异常，请确认您是合法用户'},
    evaluate:async(_fn,args)=>{if(args.keys)return ['7'];if(args.path.includes('/api/log/self'))return {status:403};requests++;return requests===1?{status:403,text:'sl-check 雷池 客户端异常'}:{status:200,body:{success:true,data:{id:7}}};}};
  const adapter=createOAuthRewardExecutionAdapter({origin:site}),context={page};
  assert.equal((await adapter.methods.identity({expectedIdentity:'7',context})).userId,'7');assert.equal(clicks,1);assert.equal(requests,2);
});

test('login navigation transport retry occurs before the only OAuth click',async()=>{
  let navigations=0,clicks=0;const site='https://agentrouter.org';
  const page={url:()=>site+'/login',goto:async()=>{if(++navigations===1)throw Error('net::ERR_CONNECTION_RESET');},waitForTimeout:async()=>{},waitForEvent:async()=>null,
    getByRole:()=>({count:async()=>1,isVisible:async()=>true,click:async()=>{clicks++;}}),evaluate:async()=>({status:200,body:{data:{id:7}}})};
  const adapter=createOAuthRewardExecutionAdapter({origin:site,rule:{forceLogout:false}});
  assert.equal((await adapter.methods.submit_once({identity:{userId:'7'},context:{page}})).state,'accepted');assert.equal(navigations,2);assert.equal(clicks,1);
});

test('Alibaba slider page is reported as CAPTCHA and is never auto-submitted',async()=>{
  const page={url:()=> 'https://agentrouter.org',evaluate:async()=>({status:200,text:'CF_APP_WAF nc-container captcha-element 滑动验证',body:null})};
  const adapter=createOAuthRewardExecutionAdapter({origin:'https://agentrouter.org'});
  const result=await adapter.methods.identity({expectedIdentity:'7',context:{page}});
  assert.equal(result.blockedReason,'captcha_required');
});

test('identity scan follows V1 across renamed SPA storage keys without returning values',async()=>{
  const page={url:()=> 'https://agentrouter.org/console',evaluate:async(_fn,args)=>args?.keys?['424894']:({status:200,body:{success:true,data:{id:424894}}})};
  const adapter=createOAuthRewardExecutionAdapter({origin:'https://agentrouter.org',rule:{userStorageKeys:['legacy_missing_key']}});
  const result=await adapter.methods.identity({expectedIdentity:'424894',context:{page}});
  assert.equal(result.userId,'424894');
});

test('authenticated log proves the stored account even when self is WAF blocked',async()=>{
  let selfCalls=0;
  const page={url:()=> 'https://agentrouter.org/console/log',evaluate:async(_fn,args)=>{
    if(args.keys)return ['7'];
    if(args.path.startsWith('/api/user/self')){selfCalls++;return {status:403};}
    return {status:200,body:{success:true,data:{items:[{user_id:7,type:4}]}}};
  }};
  const adapter=createOAuthRewardExecutionAdapter({origin:'https://agentrouter.org'});
  assert.equal((await adapter.methods.identity({expectedIdentity:'7',context:{page}})).userId,'7');assert.equal(selfCalls,0);
});

test('a cached user ID and a different or missing log user ID never prove identity',async()=>{
  for(const user_id of [8,undefined]){
    const page={url:()=> 'https://agentrouter.org',evaluate:async(_fn,args)=>args.keys?['7']:args.path.startsWith('/api/log/self')?{status:200,body:{success:true,data:{items:[{user_id}]}}}:{status:401}};
    const adapter=createOAuthRewardExecutionAdapter({origin:'https://agentrouter.org'});
    assert.equal((await adapter.methods.identity({expectedIdentity:'7',context:{page}}))?.userId,undefined);
  }
});
