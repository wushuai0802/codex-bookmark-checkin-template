import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {initialPtObservation} from '../src/pt-initial-observation.mjs';

test('reviewed initial read confirms only authenticated current-day controls and never navigates actions or resources',async()=>{
  const browser=await chromium.launch({headless:true,channel:'chrome'});
  try{
    const context=await browser.newContext(),page=await context.newPage(),requests=[];
    page.on('request',request=>requests.push(request.url()));
    const origin='https://dstudio.me',now=new Date('2026-10-02T01:00:00Z');
    const authentication='<a href="/logout.php">退出</a><a href="/usercp.php">设置</a><a href="/userdetails.php?id=7">本人</a>';
    const html=control=>authentication+'<div id="info_block">'+control+'</div>'+
      '<img src="https://dstudio.me/attendance.php"><iframe src="https://dstudio.me/attendance.php"></iframe><script>fetch("/attendance.php")</script>';
    let getCalls=0;
    const inspect=async(body,{status=200,url=origin+'/index.php',date='Fri, 02 Oct 2026 01:00:00 GMT'}={})=>
      initialPtObservation(page,{origin},{},{now,get:async(target,options)=>{
        getCalls++;assert.equal(target,origin+'/index.php');assert.equal(options.maxRedirects,0);
        return {status:()=>status,url:()=>url,text:async()=>body,headers:()=>({date})};
      }});
    const result=await inspect(html('<a href="/attendance.php">今日已完成已签到</a>'));
    assert.equal(result.status,'already_signed');assert.equal(result.submissionAttempted,false);
    assert.equal(result.evidence.authoritative,true);assert.equal(result.evidence.businessDate,'2026-10-02');
    for(const body of [html('<a href="/attendance.php">签到</a>'),html('<span>今日已完成已签到</span>'),
      html('<a data-href="/attendance.php">今日已完成已签到</a>'),html('<a href="https://other.example/attendance.php">今日已完成已签到</a>'),
      '<div id="info_block"><a href="/attendance.php">今日已完成已签到</a></div>'])assert.equal(await inspect(body),null);
    assert.equal(await inspect(html('<a href="/attendance.php">今日已完成已签到</a>'),{status:302}),null);
    assert.equal(await inspect(html('<a href="/attendance.php">今日已完成已签到</a>'),{date:'Thu, 01 Oct 2026 01:00:00 GMT'}),null);
    assert.equal(await inspect(html('<a href="/attendance.php">今日已完成已签到</a>'),{url:'https://other.example/index.php'}),null);
    assert.equal(getCalls,9);assert.deepEqual(requests,[]);assert.equal(page.url(),'about:blank');
    await context.close();
  }finally{await browser.close();}
});
