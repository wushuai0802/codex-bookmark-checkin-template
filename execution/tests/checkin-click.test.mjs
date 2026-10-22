import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {clickCheckinCandidate} from '../src/checkin-click.mjs';

const origin='https://click.example';
const candidate={index:0,tagName:'BUTTON',text:'签到',href:null,formAction:null};
function fixture({trialFails=false,realFails=false,changed={}}={}){
  const calls=[];
  const handle={click:async options=>{calls.push(options.trial?'trial':'click');if(options.trial?trialFails:realFails)throw Error('not ready');},
    evaluate:async()=>({...candidate,visible:true,disabled:false,...changed}),dispose:async()=>calls.push('dispose')};
  const page={url:()=>origin+'/',locator:()=>({nth:()=>({elementHandle:async()=>handle})})};
  return {page,calls,options:{allowedOrigins:[origin],beforeSubmit:()=>calls.push('intent')}};
}
test('a covered or changed control never records intent or clicks',async()=>{
  for(const change of [{trialFails:true},{changed:{disabled:true}},{changed:{text:'删除'}},{changed:{href:'https://other.example/'}}]){
    const f=fixture(change),result=await clickCheckinCandidate(f.page,candidate,f.options);
    assert.equal(result.submissionAttempted,false);assert.equal(result.failureCode,'checkin_control_unavailable');
    assert.equal(f.calls.includes('intent'),false);assert.equal(f.calls.includes('click'),false);assert.equal(f.calls.at(-1),'dispose');
  }
});
test('a ready control records intent immediately before its one real click',async()=>{
  const f=fixture();assert.equal(await clickCheckinCandidate(f.page,candidate,f.options),null);
  assert.deepEqual(f.calls,['trial','intent','click','dispose']);
});
test('a click timeout remains uncertain and cannot look like an unsubmitted retry',async()=>{
  const f=fixture({realFails:true}),result=await clickCheckinCandidate(f.page,candidate,f.options);
  assert.equal(result.submissionAttempted,true);assert.equal(result.failureCode,'submission_outcome_unknown');
  assert.equal(result.retryable,false);assert.equal(f.calls.filter(c=>c==='click').length,1);
});
test('dialog opening stays unsubmitted and a closed submission gate never clicks',async()=>{
  const f=fixture();await clickCheckinCandidate(f.page,candidate,{...f.options,opensDialog:true});
  assert.equal(f.calls.includes('intent'),false);
  const blocked=fixture(),error=Object.assign(Error('gate closed'),{ptGateDecision:{status:'already_signed'}});
  await assert.rejects(clickCheckinCandidate(blocked.page,candidate,{...blocked.options,beforeSubmit:()=>{throw error;}}),e=>e===error);
  assert.equal(blocked.calls.includes('click'),false);
});
test('binding the element survives a DOM insertion during actionability checks',async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try{
    const context=await browser.newContext();await context.route('**/*',r=>r.fulfill({contentType:'text/html',body:
      '<meta charset="utf-8"><button id="sign" onclick="window.signed=(window.signed||0)+1">签到</button>'}));
    const page=await context.newPage();await page.goto(origin+'/');
    await page.locator('#sign').evaluate(button=>button.addEventListener('pointerover',()=>{
      if(document.getElementById('other'))return;
      const other=document.createElement('button');other.id='other';other.textContent='删除';
      other.onclick=()=>{window.wrong=true;};other.style='position:absolute;left:500px;top:500px';button.before(other);
    }));
    let intents=0;
    assert.equal(await clickCheckinCandidate(page,candidate,{allowedOrigins:[origin],beforeSubmit:()=>{intents++;}}),null);
    assert.equal(intents,1);assert.deepEqual(await page.evaluate(()=>({signed:window.signed,wrong:Boolean(window.wrong)})),{signed:1,wrong:false});
  }finally{await browser.close();}
});
