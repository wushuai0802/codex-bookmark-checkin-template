import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {chromium} from 'playwright-core';
import {processTarget} from '../src/browser.mjs';
import {installPtReadFirewall,ptReadPolicy,readPtPassivePage,ptReadProxy} from '../src/pt-read-policy.mjs';
import {initialPtObservation} from '../src/pt-initial-observation.mjs';

test('a private local proxy applies only to reviewed passive reads and cannot carry credentials',()=>{
  const configured={ptPassiveReadOnly:true,ptReadProxyServer:'http://127.0.0.1:7890'};
  assert.deepEqual(ptReadProxy(configured),{server:'http://127.0.0.1:7890'});
  assert.equal(ptReadProxy({...configured,ptPassiveReadOnly:false}),undefined);
  assert.equal(ptReadProxy({}),undefined);
  for(const value of ['http://external.example:7890','http://u:p@127.0.0.1:7890','http://127.0.0.1:7890/path',
    'http://127.0.0.1:7890?token=x','socks5://127.0.0.1:7890','http://127.0.0.1']){
    assert.throws(()=>ptReadProxy({...configured,ptReadProxyServer:value}));
  }
  const origin='https://u2.dmhy.org',base=ptReadPolicy(origin);
  assert.equal(ptReadPolicy(origin,{ptReadOnlyPolicies:{[origin]:{...base,proxyServer:configured.ptReadProxyServer}}}).proxyServer,configured.ptReadProxyServer);
  assert.throws(()=>ptReadPolicy(origin,{ptReadOnlyPolicies:{[origin]:{...base,proxyServer:'http://remote.example:7890'}}}));
});

test('authenticated daily completion stops the real browser flow before any attendance request',async()=>{
  const browser=await chromium.launch({headless:true,channel:'chrome'});
  try{
    for(const [origin,control] of [['https://dstudio.me','今日已完成已签到'],['https://p.t-baozi.cc','[签到已得3000, 补签卡: 0]'],['https://ptsbao.club','[签到已得3000, 补签卡: 0]']]){
    const context=await browser.newContext({javaScriptEnabled:false,serviceWorkers:'block'}),visited=[];
    await context.route('**/*',async route=>{
      visited.push({url:route.request().url(),method:route.request().method()});
      if(route.request().url()!==origin+'/index.php'){await route.abort();return;}
      await route.fulfill({status:200,contentType:'text/html; charset=utf-8',body:'<a href="/logout.php">退出</a><a href="/usercp.php">设置</a><a href="/userdetails.php?id=7">本人</a><div id="info_block"><a href="/attendance.php">'+control+'</a></div>'});
    });
    const result=await processTarget(context,{origin,allowedOrigins:[origin],folderNames:['PT白名单'],candidates:[origin+'/attendance.php']},
      {retryCount:0,navigationTimeoutMs:5000,failureScreenshots:false},{},'unused');
    assert.equal(result.status,'already_signed',JSON.stringify({result,visited}));assert.equal(result.submissionAttempted,false);
    assert.equal(result.evidence.authoritative,true);assert.equal(result.evidence.statusSignal,'nexus_daily_header_signed');
    assert.deepEqual(visited,[{url:origin+'/index.php',method:'GET'}]);
    await context.close();
    }
  }finally{await browser.close();}
});

test('Depth Studio button pending control is an account-bound passive not-signed signal',async()=>{
  const origin='https://dstudio.me',browser=await chromium.launch({headless:true,channel:'chrome'});
  try{
    const context=await browser.newContext({javaScriptEnabled:false,serviceWorkers:'block'});
    await context.route('**/*',async route=>{
      assert.equal(route.request().url(),origin+'/index.php');
      await route.fulfill({status:200,contentType:'text/html; charset=utf-8',body:
        '<a href="/logout.php">退出</a><a href="/usercp.php">设置</a><a href="/userdetails.php?id=7">本人</a>'+
        '<div id="info_block"><strong>欢迎回来，wushuai0802</strong><button>待签到</button></div>'});
    });
    const policy=ptReadPolicy(origin),page=await context.newPage();
    const response=await page.goto(policy.url,{waitUntil:'domcontentloaded'});
    const result=await readPtPassivePage(page,policy,{origin,httpStatus:response.status(),now:new Date('2026-10-06T04:00:00Z')});
    assert.equal(result.status,'not_signed',JSON.stringify(result));
    assert.equal(result.evidence.authoritative,true);
    assert.equal(result.evidence.statusSignal,'nexus_daily_header_unsigned');
    await context.close();
  }finally{await browser.close();}
});

test('V1 fallback marker carries a fresh passive not-signed proof into the action path',async t=>{
  const origin='https://dstudio.me',policy=ptReadPolicy(origin),old=process.env.CHECKIN_PT_FALLBACK_RECHECK;
  t.after(()=>{if(old===undefined)delete process.env.CHECKIN_PT_FALLBACK_RECHECK;else process.env.CHECKIN_PT_FALLBACK_RECHECK=old;});
  const page={url:()=>policy.url,locator:selector=>({
    innerText:async()=> '欢迎回来，wushuai0802',
    evaluateAll:async()=>selector==='a'?true:[{path:'/attendance.php',text:'待签到'}],
  })};
  delete process.env.CHECKIN_PT_FALLBACK_RECHECK;
  assert.equal((await initialPtObservation(page,policy,origin,{status:()=>200})),null);
  process.env.CHECKIN_PT_FALLBACK_RECHECK='1';
  const proof=await initialPtObservation(page,policy,origin,{status:()=>200});
  assert.equal(proof.status,'not_signed');assert.equal(proof.evidence.authoritative,true);assert.equal(proof.submissionAttempted,false);
});

test('reviewed passive daily page reports a non-empty login view as login_required',async()=>{
  const origin='https://dstudio.me',browser=await chromium.launch({headless:true,channel:'chrome'});
  try{
    const context=await browser.newContext({javaScriptEnabled:false,serviceWorkers:'block'});
    await context.route('**/*',async route=>{
      assert.equal(route.request().url(),origin+'/index.php');
      await route.fulfill({status:200,contentType:'text/html; charset=utf-8',body:
        '<div id="info_block">请先登录后查看签到状态<form><input name="username" /></form></div>'});
    });
    const policy=ptReadPolicy(origin),page=await context.newPage();
    const response=await page.goto(policy.url,{waitUntil:'domcontentloaded'});
    const result=await readPtPassivePage(page,policy,{origin,httpStatus:response.status(),now:new Date('2026-10-06T04:00:00Z')});
    assert.equal(result.status,'login_required');
    assert.equal(result.submissionAttempted,false);
    await context.close();
  }finally{await browser.close();}
});

test('homepage status legends cannot confirm check-in when the authenticated daily control is unsigned',async()=>{
  const origin='https://p.t-baozi.cc',browser=await chromium.launch({headless:true,channel:'chrome'});
  try{
    const context=await browser.newContext({javaScriptEnabled:false,serviceWorkers:'block'}),visited=[];
    await context.route('**/*',async route=>{
      visited.push(route.request().url());
      assert.equal(route.request().url(),origin+'/index.php');
      await route.fulfill({status:200,contentType:'text/html; charset=utf-8',body:
        '<a href="/logout.php">退出</a><a href="/usercp.php">设置</a><a href="/userdetails.php?id=7">本人</a>'+
        '<div id="info_block"><a href="/attendance.php">[签到得魔力]</a></div><footer>状态说明：已签到 / 待签到</footer>'});
    });
    const result=await processTarget(context,{origin,allowedOrigins:[origin],folderNames:['PT白名单'],candidates:[origin+'/index.php']},
      {retryCount:0,navigationTimeoutMs:5000,failureScreenshots:false},{},'unused');
    assert.equal(result.status,'visited');assert.equal(result.submissionAttempted,false);
    assert.notEqual(result.evidence?.authoritative,true);assert.deepEqual(visited,[origin+'/index.php']);
    await context.close();
  }finally{await browser.close();}
});

test('real server redirects cannot bypass the passive firewall to attendance; login is read without following another redirect',async()=>{
  const visited=[];let redirect='/attendance.php',loginRedirect=false,browser;
  const server=http.createServer((request,response)=>{
    visited.push(request.url);
    if(request.url==='/index.php'||request.url==='/login.php'&&loginRedirect){
      response.writeHead(302,{location:request.url==='/index.php'?redirect:'/attendance.php'});response.end();
    }else{
      response.writeHead(200,{'content-type':'text/html; charset=utf-8'});
      response.end(request.url==='/login.php'?'<div id="info_block"></div>请先登录':'fixture attendance action');
    }
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  try{
    browser=await chromium.launch({headless:true,channel:'chrome'});
    for(const fixture of [
      {redirect:'/attendance.php',expected:['/index.php']},
      {redirect:'/login.php',expected:['/index.php','/login.php'],login:true},
      {redirect:'/login.php',loginRedirect:true,expected:['/index.php','/login.php']},
      {redirect:'/login.php?returnto=attendance.php',expected:['/index.php']}
    ]){
      redirect=fixture.redirect;loginRedirect=Boolean(fixture.loginRedirect);visited.length=0;
      const context=await browser.newContext({javaScriptEnabled:false,serviceWorkers:'block'});
      const policy={...ptReadPolicy('https://ptsbao.club'),url:origin+'/index.php'};
      await installPtReadFirewall(context,policy);
      const page=await context.newPage();let response,error;
      try{response=await page.goto(policy.url,{waitUntil:'domcontentloaded',timeout:5000});}catch(value){error=value;}
      if(fixture.login){
        assert.equal(error,undefined);
        const result=await readPtPassivePage(page,policy,{origin,httpStatus:response.status()});
        assert.equal(result.status,'login_required');assert.equal(result.submissionAttempted,false);
      }else assert.ok(error,'An unreviewed redirect must fail before its target receives a request');
      assert.deepEqual(visited,fixture.expected);assert.ok(!visited.includes('/attendance.php'));
      await context.close();
    }
  }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
});
