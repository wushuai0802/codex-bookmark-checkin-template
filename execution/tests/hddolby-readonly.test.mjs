import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {hddolbyHeaderSigned,readHddolbyHeader,hddolbyDailyProof} from '../src/hddolby-readonly.mjs';
import {tryHddolbyPostRedirectVerification} from '../src/browser.mjs';
import {ptReadPolicy} from '../src/pt-read-policy.mjs';
import {publicSupplementResult} from '../src/pt-supplement.mjs';
const origin='https://www.hddolby.com',now=new Date('2026-10-03T04:00:00Z');
const header={authenticated:true,userIds:['7'],logLinked:true,text:'鲸币 [使用] (签到已得10)',unsigned:false};
function fixture({change={},status=200,date=now.toUTCString()}={}){
  const calls=[];
  const context={request:{get:async(url,options)=>{
    calls.push({url,options});
    return {status:()=>status,url:()=>url,headers:()=>({date}),text:async()=>url.endsWith('/index.php')?'index':'log'};
  }}};
  const extractHeader=async html=>({...header,...(html==='log'?change:{text:'本站账户栏'})});
  return {context,calls,extractHeader};
}
test('HDDolby completion requires the unique current account header rather than public log rows',()=>{
  assert.equal(hddolbyHeaderSigned(header),true);
  for(const value of [undefined,{...header,authenticated:false},{...header,unsigned:true},{...header,userIds:['7','8']},
    {...header,text:'历史签到已得10'},{...header,text:'累计 签到已得10'},
    {...header,text:'(签到已得10) (签到已得20)'},{...header,text:'普通日志：别的用户签到成功'}])
    assert.equal(hddolbyHeaderSigned(value),false);
});
test('HDDolby reads only linked passive pages and retains exact account/day evidence',async()=>{
  const f=fixture(),result=await readHddolbyHeader(f.context,{origin,now,extractHeader:f.extractHeader});
  assert.equal(hddolbyDailyProof(result,now),true);
  assert.equal(hddolbyDailyProof(result,new Date(now.getTime()+5*60_000+1)),false);
  assert.equal(result.status,'already_signed');assert.equal(result.submissionAttempted,false);
  assert.equal(result.evidence.businessDate,'2026-10-03');assert.equal(result.evidence.pagePath,'/log.php');
  assert.equal(result.evidence.statusSignal,'hddolby_account_header_signed');
  assert.deepEqual(f.calls.map(call=>call.url),[origin+'/index.php',origin+'/log.php']);
  assert.ok(f.calls.every(call=>call.options.maxRedirects===0));
  assert.equal('userIds' in result.evidence,false);
  const projected=publicSupplementResult(origin,{...result,operationMode:'safe_history_page',readSafety:'reviewed_passive'},now);
  assert.equal(projected.evidence.pagePath,'/log.php');assert.equal(projected.evidence.authoritative,true);
});
test('different accounts, stale server clocks, unreadable pages and unlinked logs cannot certify completion',async()=>{
  for(const options of [{change:{userIds:['8']}},{change:{authenticated:false}},{status:302},
    {date:'invalid'},{date:'Fri, 02 Oct 2026 04:00:00 GMT'},{date:'Sat, 03 Oct 2026 04:10:00 GMT'}]){
    const f=fixture(options),value=await readHddolbyHeader(f.context,{origin,now,extractHeader:f.extractHeader});
    assert.equal(value.status,'unknown');assert.equal(value.submissionAttempted,false);
  }
  const f=fixture();
  assert.equal((await readHddolbyHeader(f.context,{origin,now,extractHeader:async()=>({...header,logLinked:false})})).status,'unknown');
  assert.equal(f.calls.length,1);
  await assert.rejects(()=>readHddolbyHeader(f.context,{origin:'https://foreign.example'}),/not reviewed/);
});
test('a take2fa redirect needs real readback and never accepts generic homepage text or re-navigates attendance',async()=>{
  const page={url:()=>origin+'/take2fa.php',context:()=>({}),goto:()=>{throw Error('Navigation must not be repeated');}};
  const missing=await tryHddolbyPostRedirectVerification(page,origin,{},async()=>({status:'already_signed',reason:'普通首页显示已签到'}));
  assert.equal(missing.status,'needs_attention');assert.equal(missing.failureCode,'two_factor_required');
  const at=new Date();
  const proven={status:'already_signed',submissionAttempted:false,evidence:{source:'pt_page',authoritative:true,
    businessDate:new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(at),confirmedAt:at.toISOString(),
    pagePath:'/log.php',statusSignal:'hddolby_account_header_signed'}};
  assert.equal((await tryHddolbyPostRedirectVerification(page,origin,{},async()=>proven)).evidence,proven.evidence);
  assert.equal((await tryHddolbyPostRedirectVerification(page,origin,{},async()=>({...proven,
    evidence:{...proven.evidence,statusSignal:'generic_page_text'}}))).status,'needs_attention');
});
test('HDDolby capability cannot be transplanted to another site or an action page',()=>{
  const standard=ptReadPolicy(origin);
  assert.equal(standard.url,origin+'/log.php');
  assert.equal(standard.hddolbyHeader,true);
  assert.equal(standard.reviewed,true);
  const base={reviewed:true,mode:'safe_history_page',url:origin+'/log.php',selector:'#info_block',hddolbyHeader:true};
  assert.equal(ptReadPolicy(origin,{ptReadOnlyPolicies:{[origin]:base}}).hddolbyHeader,true);
  for(const rule of [{...base,url:origin+'/attendance.php'},{...base,nativeMainChrome:true},{...base,selector:'body'}])
    assert.throws(()=>ptReadPolicy(origin,{ptReadOnlyPolicies:{[origin]:rule}}));
  assert.throws(()=>ptReadPolicy('https://other.example',{ptReadOnlyPolicies:{'https://other.example':{...base,url:'https://other.example/log.php'}}}));
});
test('inert parsing blocks inline scripts and requests even in an execution context with JavaScript enabled',async()=>{
  const browser=await chromium.launch({headless:true,channel:'chrome'});
  const original=await browser.newContext(),requests=[];let scriptRan=false;
  original.on('request',request=>requests.push(request.url()));
  const wrap={request:{get:async url=>({status:()=>200,url:()=>url,headers:()=>({date:now.toUTCString()}),text:async()=>
    '<script>window.scriptRan=true;fetch("https://external.example/leak")</script>'+ 
    '<h2>对不起，没有权限访问站点日志</h2><a href="/usercp.php">控制面板</a><div id="info_block"><a href="/logout.php">退出</a>'+
    '<a href="/userdetails.php?id=7">本人</a>'+ 
    (url.endsWith('/index.php')?'<a href="/log.php">日志</a>':'<span>(签到已得10)</span>')+'</div>'})},
    newPage:async()=>{const page=await original.newPage(),close=page.close.bind(page);
      page.close=async()=>{scriptRan=await page.evaluate(()=>window.scriptRan===true);return close();};return page;}};
  try{
    const result=await readHddolbyHeader(wrap,{origin,now});
    assert.equal(result.evidence.authoritative,true);assert.equal(scriptRan,false);assert.deepEqual(requests,[]);
  }finally{await original.close();await browser.close();}
});
