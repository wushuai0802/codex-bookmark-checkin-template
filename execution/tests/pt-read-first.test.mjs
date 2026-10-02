import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {processTarget} from '../src/browser.mjs';

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
