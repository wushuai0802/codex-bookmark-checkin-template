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
  const result=await adapter.methods.submit_once({identity:{userId:'245770'},context});
  assert.equal(result.state,'accepted');
  assert.ok(calls.some(value=>value.includes('/api/user/logout')));
  assert.equal(calls.some(value=>value.includes('/api/user/checkin')||value.includes('/api/user/sign_in')),false);
  assert.ok(clicks.length>=1);
});

test('OAuth reward status requires the current day, account, type, and amount',async()=>{
  const day='2026-09-15',calls=[];
  const page={
    url:()=> 'https://agentrouter.org/console',
    evaluate:async(_fn,args)=>{
      calls.push(args);
      if(args?.keys)return ['245770'];
      if(String(args?.path??'').startsWith('/api/user/self'))return {status:200,url:'https://agentrouter.org/api/user/self',body:{success:true,data:{id:245770}}};
      return {status:200,url:'https://agentrouter.org/api/log/self',body:{success:true,data:{items:[
        {type:4,user_id:245770,created_at:Date.parse('2026-09-14T02:00:00+08:00')/1000,content:'每日签到成功，增加额度 $25'},
        {type:4,user_id:999,created_at:Date.parse(day+'T02:00:00+08:00')/1000,content:'每日签到成功，增加额度 $25'}
      ]}}};
    }
  };
  const adapter=createOAuthRewardExecutionAdapter({origin:'https://agentrouter.org'});
  const identity=await adapter.methods.identity({expectedIdentity:'245770',context:{page}});
  const status=await adapter.methods.read_status({identity,businessDate:day,context:{page}});
  assert.equal(status.state,'not_signed');assert.equal(calls.filter(args=>String(args?.path??'').includes('/api/log/self')).length,1);
});
