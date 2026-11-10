import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {buildSnapshot} from '../../observation/src/bridge.mjs';
import {dayVerdict} from '../../observation/public/day-verdict.mjs';

const execute=promisify(execFile),execution=fileURLToPath(new URL('../',import.meta.url));
const origin='https://tracker.example',at='2026-11-11T04:00:00.000Z';
const maintenance='<h1>维护通知</h1><p>数据恢复与测试阶段，暂时无法访问</p><a href="/attendance.php">签到</a>';

function fixture(t,{mode='maintenance',reviewed=true}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'wo22-maintenance-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  for(const folder of ['src','config','tmp','data/profile'])fs.mkdirSync(path.join(root,folder),{recursive:true});
  fs.cpSync(path.join(execution,'src'),path.join(root,'src'),{recursive:true});
  fs.symlinkSync(path.join(execution,'node_modules'),path.join(root,'node_modules'),'junction');
  const bookmarks=path.join(root,'tmp/Bookmarks'),profile=path.join(root,'data/profile');
  fs.writeFileSync(path.join(profile,'Local State'),'{}');
  fs.writeFileSync(bookmarks,JSON.stringify({roots:{other:{type:'folder',name:'fixture',id:'10',children:[
    {type:'folder',name:'PT',id:'11',children:[
      {type:'url',name:'synthetic',url:origin+(['click','plain'].includes(mode)?'/index.php':'/attendance.php')},
      ...(['click','plain'].includes(mode)?[]:[{type:'url',name:'synthetic alternate',url:origin+'/checkin.php'}]),
    ]}]}}}));
  const config={...JSON.parse(fs.readFileSync(path.join(execution,'config/defaults.json'),'utf8')),
    bookmarksPath:bookmarks,automationUserDataDir:profile,minimumBookmarkTargetCount:1,
    mobileFolderIds:['10'],targetFolderNames:['PT'],sessionPreflightEnabled:false,
    retryCount:1,retryDelayMs:0,recoveryRounds:2,recoveryDelaysMs:[0,0],actionWaitMs:0,
    navigationTimeoutMs:5000,cloudflareWaitMs:1000,logRetentionDays:7,failureScreenshots:false,
    ...(reviewed?{ptReadOnlyPolicies:{[origin]:{reviewed:true,mode:'safe_history_page',url:origin+'/index.php',
      selector:'#info_block',dailyHeader:true,actionPath:'/attendance.php',unsignedText:'签到'}}}:{})};
  fs.writeFileSync(path.join(root,'config/config.json'),JSON.stringify(config));
  fs.writeFileSync(path.join(root,'config/qa-rules.json'),JSON.stringify({rules:[]}));
  const hooks=path.join(root,'tmp/hooks.mjs');
  // Execute the real index, candidate loop, page detector and submission guard.
  // Replace only the browser launcher: empty ephemeral context, all network
  // requests fulfilled locally, no persistent browser data or helper execution.
  fs.writeFileSync(hooks,`import fs from 'node:fs';
import path from 'node:path';
import childProcess from 'node:child_process';
import {registerHooks,syncBuiltinESMExports} from 'node:module';
const root=${JSON.stringify(root)},origin=${JSON.stringify(origin)},mode=${JSON.stringify(mode)};
const NativeDate=Date,at=Date.parse(process.env.WO22_TEST_AT);
globalThis.Date=class extends NativeDate{constructor(...args){super(...(args.length?args:[at]));}static now(){return at;}};
const deny=()=>{throw Error('Unexpected helper process');};
childProcess.execFile=deny;childProcess.spawnSync=deny;syncBuiltinESMExports();
globalThis.fetch=()=>{throw Error('Unexpected direct network request');};
globalThis.wo22Browser=async chromium=>{
 const browser=await chromium.launch({headless:true,channel:'chrome'});
 const context=await browser.newContext({javaScriptEnabled:false,serviceWorkers:'block'});
 await context.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());
  fs.appendFileSync(path.join(root,'tmp/requests.jsonl'),JSON.stringify({url:request.url(),method:request.method()})+'\\n');
  if(url.origin!==origin)throw Error('Unexpected origin');
  const header='<a href="/logout.php">退出</a><a href="/usercp.php">设置</a><a href="/userdetails.php?id=7">example-user</a>'+
   '<div id="info_block"><a href="/attendance.php">签到</a></div>';
  const body=(mode==='late'||mode==='click')&&url.pathname==='/index.php'?header:${JSON.stringify(maintenance)};
  await route.fulfill({status:200,contentType:'text/html; charset=utf-8',body});
 });
 context.close=()=>browser.close();return context;
};
registerHooks({load(url,context,next){
 if(url===new URL('../src/browser.mjs',import.meta.url).href){
  const source=fs.readFileSync(new URL(url),'utf8');
  const start=source.indexOf('export async function launchAutomationContext('),end=source.indexOf('export async function processTarget(',start);
  if(start<0||end<0)throw Error('Browser launcher seam changed');
  return {format:'module',shortCircuit:true,source:source.slice(0,start)+
   'export async function launchAutomationContext(){return globalThis.wo22Browser(chromium); }\\n'+source.slice(end)};
 }
 return next(url,context);
}});`);
  return {root,async run({now=at,resume=false}={}){
    let out;
    try{out={code:0,...await execute(process.execPath,['--import',pathToFileURL(hooks).href,path.join(root,'src/index.mjs'),
      ...(resume?['--resume-report',path.join(root,'logs/latest.json')]:[])],
      {cwd:root,env:{...process.env,WO22_TEST_AT:now,CHECKIN_PT_FALLBACK_RECHECK:'0'},windowsHide:true,timeout:60000,maxBuffer:65536})};}
    catch(error){if(typeof error.code!=='number')throw error;out={code:error.code,stderr:error.stderr,stdout:error.stdout};}
    assert.ok(fs.existsSync(path.join(root,'logs/latest.json')),out.stderr+out.stdout);
    const report=JSON.parse(fs.readFileSync(path.join(root,'logs/latest.json'),'utf8'));
    const requests=fs.existsSync(path.join(root,'tmp/requests.jsonl'))
      ?fs.readFileSync(path.join(root,'tmp/requests.jsonl'),'utf8').trim().split('\n').map(JSON.parse):[];
    return {...out,report,requests};
  }};
}

test('real index stops on the reviewed maintenance homepage before any attendance request',async t=>{
  const f=fixture(t),out=await f.run(),row=out.report.results[0];
  assert.equal(row.status,'deferred',JSON.stringify({row,requests:out.requests}));
  assert.equal(row.failureCode,'site_maintenance');assert.equal(row.submissionAttempted,false);
  assert.equal(row.underlyingFailureCode,undefined);assert.equal(row.retryExhaustedForDay,true);
  assert.deepEqual(out.requests,[{url:origin+'/index.php',method:'GET'}]);
  assert.equal(row.candidateHistory.length,1);
  assert.equal(fs.existsSync(path.join(f.root,'data/native-pt-attempts.json')),false);
  // The existing exit contract treats deferred rows as non-terminal. Do not
  // loosen it or turn an external outage into completion in this repair.
  assert.equal(out.code,2,out.stderr);
  fs.writeFileSync(path.join(f.root,'data/scheduler-state.json'),JSON.stringify({lastRunDate:'20261111'}));
  const snapshot=buildSnapshot({legacyRoot:f.root,generatedAt:at});
  const verdict=dayVerdict(snapshot,{now:new Date(at)});
  assert.equal(verdict.counts.external,1);assert.equal(verdict.counts.done,0);assert.equal(verdict.counts.verifying,0);
  const resumed=await f.run({now:'2026-11-11T07:00:00.000Z',resume:true});
  assert.deepEqual(resumed.requests,out.requests,'same-day resume must not visit maintenance again');
  const tomorrow=await f.run({now:'2026-11-12T04:00:00.000Z'});
  assert.equal(tomorrow.requests.length,2,'the following main run must check the homepage again');
  assert.equal(tomorrow.report.results[0].failureCode,'site_maintenance');
});

for(const mode of ['late','click'])test(`real index keeps unknown submission when maintenance appears after ${mode==='late'?'attendance navigation':'a check-in click'}`,async t=>{
  const f=fixture(t,{mode,reviewed:mode!=='click'}),out=await f.run(),row=out.report.results[0];
  assert.equal(row.status,'needs_attention',JSON.stringify(row));
  assert.equal(row.failureCode,'submission_outcome_unknown');assert.equal(row.submissionAttempted,true);
  assert.equal(row.underlyingFailureCode,'site_maintenance');assert.equal(row.retryable,false);
  assert.deepEqual(out.requests.map(item=>item.url),[origin+'/index.php',origin+'/attendance.php']);
  assert.equal(out.code,2,out.stderr);
});

test('real index labels an ordinary maintenance page as explicitly unsubmitted',async t=>{
  const f=fixture(t,{mode:'plain',reviewed:false}),out=await f.run(),row=out.report.results[0];
  assert.equal(row.status,'deferred');assert.equal(row.failureCode,'site_maintenance');
  assert.equal(row.submissionAttempted,false);
  assert.deepEqual(out.requests,[{url:origin+'/index.php',method:'GET'}]);
});
