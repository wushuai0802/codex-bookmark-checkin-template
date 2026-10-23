import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {tryU2Captcha} from '../src/browser.mjs';
import {publicSupplementResult} from '../src/pt-supplement.mjs';
import {ptFailureMessages} from '../src/checkin-contract.generated.mjs';

test('U2 public success feed cannot confirm this account; its own daily header must change after one answer POST',async()=>{
  const browser=await chromium.launch({headless:true,channel:'chrome'});
  const pixel='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jM1kAAAAASUVORK5CYII=';
  const auth='<a href="/logout.php">退出</a><a href="/usercp.php">设置</a><a href="/userdetails.php?id=7">本人</a>';
  try{
    for(const completed of [false,true]){
      const context=await browser.newContext(),page=await context.newPage();let posts=0,checks=0;
      await context.route('https://u2.dmhy.org/**',async route=>{
        const request=route.request();
        if(request.method()==='POST')posts++;
        const index=new URL(request.url()).pathname==='/index.php';
        const body=index?auth+'<div id="info_block"><a href="/showup.php">'+(completed?'已簽到':'立即簽到')+'</a></div>':
          auth+'<form method="post" action="/showup.php"><img alt="captcha" src="'+pixel+'"><textarea name="message"></textarea><input type="submit" name="captcha_a" value="A"><input type="submit" name="captcha_b" value="B"></form><p>其他用户回答正確！獎勵UCoin：59</p>';
        await route.fulfill({status:200,contentType:'text/html; charset=utf-8',body});
      });
      await page.goto('https://u2.dmhy.org/showup.php');
      const result=await tryU2Captcha(page,'https://u2.dmhy.org',{beforePtSubmit:()=>{checks++;}},
        {solve:async()=>({answer:{name:'captcha_a',text:'A'}})});
      assert.equal(posts,1);assert.equal(checks,1);assert.equal(result.submissionAttempted,true);
      assert.equal(result.status,completed?'signed':'needs_attention');
      if(completed){assert.equal(result.evidence.authoritative,true);assert.equal(result.evidence.statusSignal,'nexus_daily_header_signed');}
      else assert.equal(result.failureCode,'submission_outcome_unknown');
      await context.close();
    }
  }finally{await browser.close();}
});

test('U2 solver diagnostics survive PT projection without a POST or a false login prompt',async()=>{
  const browser=await chromium.launch({headless:true,channel:'chrome'});
  const pixel='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jM1kAAAAASUVORK5CYII=';
  try{
    for(const code of ['u2_reference_unavailable','u2_reference_timeout','u2_visual_ambiguous','u2_solver_failed','untrusted_code','missing_message']){
      const context=await browser.newContext(),page=await context.newPage();let posts=0,intents=0;
      await context.route('https://u2.dmhy.org/**',async route=>{
        if(route.request().method()==='POST')posts++;
        await route.fulfill({status:200,contentType:'text/html; charset=utf-8',body:
          '<form method="post" action="/showup.php"><img alt="captcha" src="'+pixel+'">'+
          (code==='missing_message'?'':'<textarea name="message"></textarea>')+
          '<input type="submit" name="captcha_a" value="A"><input type="submit" name="captcha_b" value="B"></form>'});
      });
      await page.goto('https://u2.dmhy.org/showup.php');
      const expected=code==='missing_message'?'u2_challenge_changed':code==='untrusted_code'?'u2_visual_ambiguous':code;
      const result=await tryU2Captcha(page,'https://u2.dmhy.org',{beforePtSubmit:()=>{intents++;}},
        {solve:async()=>{
          if(code==='u2_solver_failed')throw Error('PRIVATE_PROVIDER_ERROR');
          if(code==='missing_message')return {answer:{name:'captcha_a',text:'A'}};
          return {answer:null,failureCode:code,reason:'PRIVATE_PROVIDER_ERROR'};
        }});
      assert.equal(result.failureCode,expected);assert.equal(result.submissionAttempted,false);
      assert.equal(intents,0);assert.equal(posts,0);
      const projected=publicSupplementResult('https://u2.dmhy.org',result);
      assert.equal(projected.failureCode,expected);assert.equal(projected.evidence.summary,ptFailureMessages[expected]);
      assert.equal(projected.evidence.authoritative,false);assert.equal(projected.submissionAttempted,false);
      assert.doesNotMatch(JSON.stringify(projected),/PRIVATE_PROVIDER_ERROR|untrusted_code/);
      await context.close();
    }
  }finally{await browser.close();}
});
