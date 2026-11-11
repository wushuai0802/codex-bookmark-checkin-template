import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath,pathToFileURL} from 'node:url';
import sharp from 'sharp';
import {publicSupplementResult} from '../src/pt-supplement.mjs';
import {projectPtSiteResult} from '../../observation/src/pt-site-execution.mjs';
import {projectU2Diagnostics,solveU2VisualChallenge} from '../src/u2-vision.mjs';

const execute=promisify(execFile),execution=fileURLToPath(new URL('../',import.meta.url));
const origin='https://u2.dmhy.org', marker='WO25_PRIVATE_OPTION';

async function pictures(){
  const cover=background=>sharp({create:{width:200,height:240,channels:3,background}}).png().toBuffer();
  const covers=await Promise.all(['red','blue','green'].map(cover));
  const reliable=await sharp({create:{width:400,height:273,channels:3,background:'white'}}).composite([
    {input:covers[0],left:0,top:0},{input:covers[1],left:200,top:0},
    {input:Buffer.from('<svg width="400" height="240"><circle cx="100" cy="120" r="28" fill="white" stroke="black" stroke-width="3"/></svg>'),left:0,top:0},
  ]).png().toBuffer();
  const ambiguous=await Promise.all([220,200,180,160,140].map(v=>sharp({create:{width:400,height:273,channels:3,
    background:{r:v,g:v,b:v}}}).png().toBuffer()));
  return {covers,reliable,ambiguous};
}

async function fixture(t,{mode='recover',config={},entry='index'}={}){
  // Node resolves imported modules to long paths; hooks must use the same
  // canonical root even when TEMP is the Windows 8.3 spelling.
  const root=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'wo25-u2-')));
  t.after(()=>{
    const target=path.resolve(root),parent=fs.realpathSync.native(os.tmpdir());
    assert.equal(path.dirname(target),parent);assert.ok(path.basename(target).startsWith('wo25-u2-'));
    fs.rmSync(target,{recursive:true,force:true});
  });
  for(const folder of ['src','config','tmp','data/profile'])fs.mkdirSync(path.join(root,folder),{recursive:true});
  fs.cpSync(path.join(execution,'src'),path.join(root,'src'),{recursive:true});
  fs.symlinkSync(path.join(execution,'node_modules'),path.join(root,'node_modules'),'junction');
  const images=await pictures();
  for(const [i,cover] of images.covers.entries())fs.writeFileSync(path.join(root,`tmp/cover-${i}.png`),cover);
  for(const [i,image] of images.ambiguous.entries())fs.writeFileSync(path.join(root,`tmp/ambiguous-${i}.png`),image);
  fs.writeFileSync(path.join(root,'tmp/reliable.png'),images.reliable);
  fs.writeFileSync(path.join(root,'tmp/reliable-next.png'),await sharp(images.reliable).composite([
    {input:Buffer.from('<svg width="400" height="10"><rect width="400" height="10" fill="gray"/></svg>'),left:0,top:260},
  ]).png().toBuffer());
  const bookmarks=path.join(root,'tmp/Bookmarks'),profile=path.join(root,'data/profile');
  fs.writeFileSync(path.join(profile,'Local State'),'{}');
  fs.writeFileSync(bookmarks,JSON.stringify({roots:{other:{type:'folder',name:'fixture',id:'10',children:[
    {type:'folder',name:'PT',id:'11',children:[{type:'url',name:'synthetic',url:origin+(mode==='prior_submit'?'/checkin.php':'/showup.php')}]},
  ]}}}));
  const settings={...JSON.parse(fs.readFileSync(path.join(execution,'config/defaults.json'),'utf8')),
    bookmarksPath:bookmarks,automationUserDataDir:profile,minimumBookmarkTargetCount:1,
    mobileFolderIds:['10'],targetFolderNames:['PT'],sessionPreflightEnabled:false,
    retryCount:1,retryDelayMs:0,recoveryRounds:2,recoveryDelaysMs:[0,0],actionWaitMs:0,
    navigationTimeoutMs:5000,cloudflareWaitMs:1000,logRetentionDays:7,failureScreenshots:false,
    u2ReferenceRequestTimeoutMs:60,...config};
  fs.writeFileSync(path.join(root,'config/config.json'),JSON.stringify(settings));
  fs.writeFileSync(path.join(root,'config/qa-rules.json'),JSON.stringify({rules:[]}));
  const hooks=path.join(root,'tmp/hooks.mjs');
  fs.writeFileSync(hooks,`import fs from 'node:fs';
import path from 'node:path';
import childProcess from 'node:child_process';
import {registerHooks,syncBuiltinESMExports} from 'node:module';
const root=${JSON.stringify(root)},origin=${JSON.stringify(origin)},mode=${JSON.stringify(mode)},marker=${JSON.stringify(marker)};
const realNow=Date.now;let clockOffset=0;Date.now=()=>realNow()+clockOffset;
globalThis.wo25Expire=()=>{clockOffset+=100001;};
const record=value=>fs.appendFileSync(path.join(root,'tmp/events.jsonl'),JSON.stringify({...value,at:Date.now()})+'\\n');
const deny=()=>{throw Error('Unexpected helper process');};
childProcess.execFile=deny;childProcess.spawnSync=deny;syncBuiltinESMExports();
globalThis.fetch=()=>{throw Error('Unexpected direct network request');};
let questions=0,posts=0,contexts=0;
globalThis.wo25NewContext=async()=>{
 const id=++contexts;record({kind:'reference_open',id});
 return {async fetch(raw,init){
  const url=new URL(raw);record({kind:'reference',path:url.pathname,source:url.hostname,
   option:init.data?Number(JSON.parse(init.data).variables.search.slice(-1)):null});
  let body;
  if(mode==='deadline')return new Promise(()=>{});
  if(url.hostname==='graphql.anilist.co'){
   const index=Number(JSON.parse(init.data).variables.search.slice(-1));
   if(mode==='reference_timeout'&&index===1)return new Promise(()=>{});
   body=JSON.stringify({data:{Page:{media:[{id:index+1,coverImage:{large:'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/'+index+'.png'}}]}}});
  }else if(url.hostname==='s4.anilist.co')body=fs.readFileSync(path.join(root,'tmp/cover-'+path.basename(url.pathname)));
  else if(url.hostname==='myanimelist.net')body='';
  else throw Error('Unexpected reference origin');
  return {status:()=>200,headers:()=>({}),body:async()=>Buffer.from(body)};
 },async dispose(){record({kind:'reference_close',id});}};
};
globalThis.wo25Browser=async chromium=>{
 const browser=await chromium.launch({headless:true,channel:'chrome'});
 const context=await browser.newContext({javaScriptEnabled:false,serviceWorkers:'block'});
 context.on('page',page=>page.on('close',()=>record({kind:'page_close'})));
 await context.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());
  if(url.origin!==origin)throw Error('Unexpected site origin');
  record({kind:'site',path:url.pathname,method:request.method()});
  if(request.method()==='POST'){posts++;if(mode==='post_error')return route.abort();}
  if(url.pathname==='/showup.php'&&request.method()==='GET')questions++;
  const auth='<a href="/logout.php">退出</a><a href="/usercp.php">设置</a><a href="/userdetails.php?id=7">fixture-account</a>';
  let body;
  if(url.pathname==='/index.php'){
   if(posts&&mode==='unknown')return route.abort();
   body=auth+'<div id="info_block"><a href="/showup.php">'+(posts&&mode!=='post_error'?'已簽到':'立即簽到')+'</a></div>';
  }else if(['/showup.php','/checkin.php'].includes(url.pathname)){
   const reliable=['unknown','post_error','changed','reference_timeout','expired'].includes(mode)||mode==='recover'&&questions>1;
   const image=fs.readFileSync(path.join(root,'tmp/'+(reliable?(mode==='expired'&&questions>1?'reliable-next.png':'reliable.png'):'ambiguous-'+(mode==='same'?0:Math.max(0,Math.min(questions-1,4)))+'.png'))).toString('base64');
   const second=mode==='reference_timeout'&&questions>1?2:1;
   body=auth+'<form method="post" action="/showup.php">'+
    (mode==='missing_image'?'':'<img alt="captcha" src="data:image/png;base64,'+image+'">')+
    (mode==='changed'?'':'<textarea name="message"></textarea>')+
    '<input type="submit" name="captcha_a" value="'+marker+' 0"><input type="submit" name="captcha_b" value="'+marker+' '+second+'"></form>';
  }else throw Error('Unexpected site path');
  await route.fulfill({status:200,contentType:'text/html; charset=utf-8',body});
 });
 const close=context.close.bind(context);context.close=async()=>{record({kind:'context_close',pages:context.pages().length});await close();await browser.close();};
 return context;
};
registerHooks({load(url,context,next){
 if(url===new URL('../src/browser.mjs',import.meta.url).href){
  const source=fs.readFileSync(new URL(url),'utf8');
  const start=source.indexOf('export async function launchAutomationContext('),end=source.indexOf('export async function processTarget(',start);
  if(start<0||end<0)throw Error('Browser launcher seam changed');
  return {format:'module',shortCircuit:true,source:source.slice(0,start)+
   'export async function launchAutomationContext(){return globalThis.wo25Browser(chromium); }\\n'+source.slice(end)};
 }
 if(url===new URL('../src/u2-reference-fetch.mjs',import.meta.url).href){
  const source=fs.readFileSync(new URL(url),'utf8'),seam='newContext = (options) => request.newContext(options),';
  if(!source.includes(seam))throw Error('Reference context seam changed');
  return {format:'module',shortCircuit:true,source:source.replace(seam,'newContext = globalThis.wo25NewContext,')};
 }
 if(['unknown_code','unsafe_code','expired'].includes(mode)&&url===new URL('../src/u2-vision.mjs',import.meta.url).href){
  const source=fs.readFileSync(new URL(url),'utf8').replace('export async function solveU2VisualChallenge(','async function fixtureRealSolver(');
  const extra=mode==='expired'
   ?'let calls=0;export async function solveU2VisualChallenge(...args){const result=await fixtureRealSolver(...args);if(++calls===1)globalThis.wo25Expire();return result;}'
   :'export async function solveU2VisualChallenge(){return {answer:null,failureCode:'+JSON.stringify(mode==='unknown_code'?'unexpected_solver_code':'https://private.invalid/WO25_PRIVATE_OPTION')+',diagnostics:{optionText:"WO25_PRIVATE_OPTION",url:"https://private.invalid"}};}';
  return {format:'module',shortCircuit:true,source:source+'\\n'+extra};
 }
 return next(url,context);
}});`);
  let script=path.join(root,'src/index.mjs');
  if(entry==='target'){
    script=path.join(root,'tmp/target.mjs');
    fs.writeFileSync(script,`import fs from 'node:fs';import {launchAutomationContext,processTarget} from '../src/browser.mjs';
const config=${JSON.stringify(settings)},context=await launchAutomationContext(config);
try{const row=await processTarget(context,{origin:${JSON.stringify(origin)},candidates:[${JSON.stringify(origin+'/showup.php')}],folderNames:['PT']},config,[],'');
fs.mkdirSync(${JSON.stringify(path.join(root,'logs'))},{recursive:true});fs.writeFileSync(${JSON.stringify(path.join(root,'logs/latest.json'))},JSON.stringify({results:[row]}));}
finally{await context.close();}`);
  }
  let out;
  try{out={code:0,...await execute(process.execPath,['--import',pathToFileURL(hooks).href,script],
    {cwd:root,env:{...process.env,CHECKIN_PT_FALLBACK_RECHECK:'0'},windowsHide:true,timeout:60000,maxBuffer:65536})};}
  catch(error){if(typeof error.code!=='number')throw error;out={code:error.code,stderr:error.stderr,stdout:error.stdout};}
  assert.ok(fs.existsSync(path.join(root,'logs/latest.json')),out.stderr+out.stdout);
  const report=JSON.parse(fs.readFileSync(path.join(root,'logs/latest.json'),'utf8'));
  const events=fs.readFileSync(path.join(root,'tmp/events.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  const row=report.results[0],sites=events.filter(e=>e.kind==='site');
  const gets=sites.filter(e=>e.path==='/showup.php'&&e.method==='GET'),posts=sites.filter(e=>e.method==='POST');
  const opens=events.filter(e=>e.kind==='reference_open'),closes=events.filter(e=>e.kind==='reference_close');
  assert.deepEqual(opens.map(e=>e.id).sort(),closes.map(e=>e.id).sort(),'every isolated reference context closed once');
  assert.ok(events.some(e=>e.kind==='context_close'&&e.pages===0),'processTarget closes its page before context shutdown');
  const projected=publicSupplementResult(origin,row);
  assert.deepEqual(projected.u2Diagnostics,row.u2Diagnostics);
  assert.equal(projectPtSiteResult(projected,origin).u2Diagnostics,undefined,'observation currently drops new diagnostics');
  for(const file of fs.readdirSync(path.join(root,'logs'),{recursive:true})){
    const full=path.join(root,'logs',file);if(fs.statSync(full).isFile())assert.doesNotMatch(fs.readFileSync(full,'utf8'),new RegExp(marker));
  }
  assert.doesNotMatch(out.stdout+out.stderr,new RegExp(marker));
  assert.doesNotMatch(JSON.stringify(row.u2Diagnostics),/https?:|optionText|PRIVATE_OPTION|base64/);
  return {...out,row,events,gets,posts};
}

test('real index: ambiguous first question then reliable answer, exactly one POST and own daily receipt',async t=>{
  const out=await fixture(t);assert.equal(out.code,0,out.stderr);assert.equal(out.row.status,'signed');
  assert.equal(out.row.evidence.authoritative,true);assert.equal(out.row.evidence.statusSignal,'nexus_daily_header_signed');
  assert.equal(out.row.submissionAttempted,true);assert.equal(out.row.u2Diagnostics.questionCount,2);
  assert.deepEqual(out.row.u2Diagnostics.subreasons,['u2_match_gap_insufficient','u2_answer_reliable']);
  assert.equal(out.gets.length,2);assert.equal(out.posts.length,1);
  assert.ok(out.gets[1].at-out.gets[0].at>=1500);
  assert.equal(out.events.filter(e=>e.kind==='reference'&&e.source==='graphql.anilist.co').length,2,'cached works are not searched again');
  assert.deepEqual(out.row.u2Diagnostics.questions.map(q=>q.optionReferenceCounts),[[1,1],[1,1]]);
  assert.equal(out.row.u2Diagnostics.questions[1].requests,0);
});

test('real index: three ambiguous questions, only question GETs, no submission intent or outer recovery',async t=>{
  const out=await fixture(t,{mode:'ambiguous'});assert.equal(out.row.status,'needs_attention');
  assert.equal(out.row.failureCode,'u2_visual_ambiguous');assert.equal(out.row.submissionAttempted,false);
  assert.equal(out.row.u2Diagnostics.questionCount,3);assert.equal(out.gets.length,3);assert.equal(out.posts.length,0);
  assert.deepEqual(out.row.u2Diagnostics.subreasons,Array(3).fill('u2_match_gap_insufficient'));
  assert.equal(out.row.u2Diagnostics.stopCode,'u2_retry_limit');
  assert.ok(out.events.filter(e=>e.kind==='site').every(e=>e.method==='GET'));
});

test('real index: identical pixels and options stop immediately after the first reload',async t=>{
  const out=await fixture(t,{mode:'same'});assert.equal(out.gets.length,2);assert.equal(out.posts.length,0);
  assert.equal(out.row.submissionAttempted,false);assert.equal(out.row.u2Diagnostics.stopCode,'u2_question_unchanged');
  assert.deepEqual(out.row.u2Diagnostics.subreasons,['u2_match_gap_insufficient','u2_question_unchanged']);
});

for(const mode of ['unknown','post_error'])test(`real index: ${mode} after POST never reloads a question or replays`,async t=>{
  const out=await fixture(t,{mode});assert.equal(out.row.failureCode,'submission_outcome_unknown');
  assert.equal(out.row.submissionAttempted,true);assert.equal(out.row.retryable,false);
  assert.equal(out.gets.length,1);assert.equal(out.posts.length,1);
});

test('real index: an earlier guarded navigation forbids U2 solving, reloading or answer submission',async t=>{
  const out=await fixture(t,{mode:'prior_submit'});assert.equal(out.row.failureCode,'submission_outcome_unknown');
  assert.equal(out.row.submissionAttempted,true);assert.equal(out.row.retryable,false);
  assert.equal(out.gets.length,0);assert.equal(out.posts.length,0);assert.equal(out.row.u2Diagnostics.questionCount,0);
  assert.equal(out.events.filter(e=>e.kind==='reference').length,0);
});

test('real index: changed form does not reload or submit',async t=>{
  const out=await fixture(t,{mode:'changed'});assert.equal(out.row.failureCode,'u2_challenge_changed');
  assert.equal(out.row.submissionAttempted,false);assert.equal(out.gets.length,1);assert.equal(out.posts.length,0);
});

test('real index: reference timeout permits another question and reuses the cover already obtained',async t=>{
  const out=await fixture(t,{mode:'reference_timeout'});
  assert.equal(out.row.u2Diagnostics.questions[0].subreason,'u2_reference_timeout');
  assert.equal(out.row.u2Diagnostics.questions[0].timedOut,true);assert.ok(out.gets.length>=2);
  const searches=out.events.filter(e=>e.kind==='reference'&&e.source==='graphql.anilist.co');
  assert.equal(searches.filter(e=>e.option===0).length,1);
  assert.equal(out.events.filter(e=>e.kind==='reference'&&e.path.endsWith('/0.png')).length,1);
});

test('real index: overall deadline stops active reference transport and leaves no page',async t=>{
  const out=await fixture(t,{mode:'deadline',config:{u2StepTimeoutMs:1000,u2ReferenceRequestTimeoutMs:10000,failureScreenshots:true}});
  assert.equal(out.row.u2Diagnostics.stepTimedOut,true);assert.equal(out.row.u2Diagnostics.stopCode,'u2_step_timeout');
  assert.equal(out.row.submissionAttempted,false);assert.equal(out.gets.length,1);assert.equal(out.posts.length,0);
});

test('real index: overall deadline during retry delay retains the last question result',async t=>{
  const out=await fixture(t,{mode:'ambiguous',config:{u2StepTimeoutMs:1000}});
  assert.equal(out.row.u2Diagnostics.stepTimedOut,true);assert.equal(out.row.failureCode,'u2_visual_ambiguous');
  assert.equal(out.gets.length,1);assert.equal(out.row.submissionAttempted,false);
});

test('real index: the 100-second per-question limit rejects an expired reliable answer then allows a fresh question',async t=>{
  const out=await fixture(t,{mode:'expired'});assert.equal(out.row.status,'signed');
  assert.equal(out.posts.length,1);assert.equal(out.gets.length,2);
  assert.deepEqual(out.row.u2Diagnostics.subreasons,['u2_question_expired','u2_answer_reliable']);
});

for(const mode of ['unknown_code','unsafe_code'])test(`real index: ${mode} is solver_failed, never visual_ambiguous or retried`,async t=>{
  const out=await fixture(t,{mode});assert.equal(out.row.failureCode,'u2_solver_failed');
  assert.equal(out.gets.length,1);assert.equal(out.posts.length,0);assert.equal(out.row.submissionAttempted,false);
  assert.equal(out.row.u2Diagnostics.questions[0].originalFailureCode,mode==='unknown_code'?'unexpected_solver_code':undefined);
});

test('real processTarget: zero question retries keeps the single-question challenge behavior',async t=>{
  const out=await fixture(t,{mode:'ambiguous',config:{u2QuestionRetryCount:0},entry:'target'});
  assert.equal(out.row.status,'interactive_challenge');assert.equal(out.row.submissionAttempted,false);
  assert.equal(out.row.u2Diagnostics.questionCount,1);assert.equal(out.gets.length,1);assert.equal(out.posts.length,0);
});

test('real index: oversized retry setting is capped at four additional questions',async t=>{
  const out=await fixture(t,{mode:'ambiguous',config:{u2QuestionRetryCount:99}});
  assert.equal(out.gets.length,5);assert.equal(out.row.u2Diagnostics.questionCount,5);assert.equal(out.posts.length,0);
});

test('real index: missing image retries without ever entering the submit guard',async t=>{
  const out=await fixture(t,{mode:'missing_image'});assert.equal(out.row.failureCode,'u2_image_unavailable');
  assert.equal(out.row.submissionAttempted,false);assert.equal(out.gets.length,3);assert.equal(out.posts.length,0);
});

test('diagnostic projection permits only bounded numeric/boolean fields and fixed codes',()=>{
  const unsafe={referenceCount:2,optionReferenceCounts:[1,1,marker],bestTotal:0.2,alternativeTotal:0.3,matchGap:0.1,
    distanceRatio:Infinity,circleRatio:NaN,timedOut:false,subreason:'u2_dot_side_unclear',optionText:marker,
    originalFailureCode:'https://private.invalid',questions:[{optionText:marker,subreason:marker,originalFailureCode:'unexpected_solver_code'}]};
  const safe=projectU2Diagnostics(unsafe);assert.doesNotMatch(JSON.stringify(safe),/PRIVATE|https|optionText|Infinity|NaN/);
  assert.equal(safe.questions[0].originalFailureCode,'unexpected_solver_code');assert.equal(safe.subreason,'u2_dot_side_unclear');
});

test('real solver distinguishes dot-side uncertainty without changing confidence thresholds',async()=>{
  const {covers}=await pictures();
  const image=await sharp({create:{width:400,height:273,channels:3,background:'white'}})
    .composite([{input:covers[0],left:0,top:0},{input:covers[1],left:200,top:0}]).png().toBuffer();
  const options=[0,1].map(i=>({name:'captcha_'+i,text:marker+' '+i}));
  const result=await solveU2VisualChallenge(image,options,{fetchImpl:async(url,init)=>{
    if(String(url).includes('graphql')){const i=Number(JSON.parse(init.body).variables.search.slice(-1));
      return new Response(JSON.stringify({data:{Page:{media:[{id:i,coverImage:{large:'https://fixture.invalid/'+i}}]}}}));}
    return new Response(covers[Number(new URL(url).pathname.slice(1))]);
  }});
  assert.equal(result.failureCode,'u2_visual_ambiguous');assert.equal(result.diagnostics.subreason,'u2_dot_side_unclear');
  assert.ok(result.diagnostics.distanceRatio<1.22);assert.ok(result.diagnostics.circleRatio<1.3);
});

test('reference cache reuses backup-only covers and rebinds reordered option names without another request',async()=>{
  const {reliable,covers}=await pictures(),referenceCache=new Map();let requests=0;
  const options=[0,1].map(i=>({name:'captcha_'+i,text:marker+' '+i}));
  const fetchImpl=async(url,init)=>{
    requests++;const parsed=new URL(url);
    if(parsed.hostname==='graphql.anilist.co')return new Response('',{status:503});
    if(parsed.hostname==='myanimelist.net'){
      const i=Number(parsed.searchParams.get('q').slice(-1));
      return new Response('<img alt="'+options[i].text+'" data-src="https://cdn.myanimelist.net/images/anime/'+i+'.png">');
    }
    return new Response(covers[Number(path.basename(parsed.pathname,'.png'))]);
  };
  assert.equal((await solveU2VisualChallenge(reliable,options,{fetchImpl,referenceCache})).answer,options[0]);
  const before=requests,reordered=[{...options[1],name:'captcha_new_b'},{...options[0],name:'captcha_new_a'}];
  const second=await solveU2VisualChallenge(reliable,reordered,{fetchImpl,referenceCache});
  assert.equal(second.answer,reordered[1]);assert.equal(requests,before);assert.equal(second.diagnostics.requests,0);
});
