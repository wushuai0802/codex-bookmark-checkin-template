import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {safeNativeReadback} from '../src/native-pt-read.mjs';
import {nativePtHeaderOrigins} from '../src/checkin-contract.generated.mjs';

const origin='https://tracker.example',audience='https://audience.example';
const now=new Date('2026-11-01T04:00:00Z');
const repository=fileURLToPath(new URL('../../',import.meta.url));
const additions=['inspectionPresent','securityVerification','signedControlCount','unsignedControlCount',
  'pathClass','dailyTextPresent','dailyControlCandidateCount','audiencesDailyHeaderVerified','apiStage','httpStatus'];
const dataModule=source=>'data:text/javascript;base64,'+Buffer.from(source).toString('base64');
const policyModule=dataModule(`
  export const ptReadPolicy=(origin,config)=>config.ptReadOnlyPolicies?.[origin];
  export const nativeApiHeaderAuthenticated=({headerText})=>headerText.includes('fixture-auth');
  export function classifyPtPassivePage({controls,authenticated}){
    const signed=controls.some(c=>c.path==='/attendance.php'&&c.text==='已签到');
    const unsigned=controls.some(c=>c.path==='/attendance.php'&&c.text==='签到');
    return {status:signed?'already_signed':unsigned?'not_signed':'unconfirmed',evidence:{authoritative:authenticated&&(signed||unsigned)}};
  }`);

// Optional acceptance comparison against the untouched work-order base. The
// regular suite has no Git-history dependency. All browser/HTTP edges are fake.
async function modules(revision){
  const load=(file,overrides={})=>{
    let source=revision?execFileSync('git',['show',revision+':execution/src/'+file],{cwd:repository,encoding:'utf8'}):
      fs.readFileSync(new URL('../src/'+file,import.meta.url),'utf8');
    source=source.replaceAll(nativePtHeaderOrigins[0],audience);
    source=source.replace(/(['"])(\.\.?\/[^'"\n]+)\1/g,(match,quote,specifier)=>
      JSON.stringify(overrides[specifier]??new URL(specifier,new URL('../src/'+file,import.meta.url)).href));
    return dataModule(source);
  };
  const readerUrl=load('native-pt-read.mjs',{
    './checkin-contract.generated.mjs':dataModule(`export const nativePtHeaderOrigins=${JSON.stringify([origin,audience])};`),
    './pt-read-policy.mjs':policyModule});
  const reader=await import(readerUrl);
  const api=await import(load('native-pt-api.mjs',{'./native-pt-read.mjs':readerUrl,'./pt-read-policy.mjs':policyModule}));
  return {reader,api};
}
const current=await modules();
const baseline=process.env.WO08_BASELINE_REVISION?await modules(process.env.WO08_BASELINE_REVISION):null;
function oldFields(value){
  if(Array.isArray(value))return value.map(oldFields);
  if(!value||typeof value!=='object')return value;
  return Object.fromEntries(Object.entries(value).map(([key,entry])=>[key,key==='nativeReadback'?
    Object.fromEntries(Object.entries(entry).filter(([name])=>!additions.includes(name))):oldFields(entry)]));
}
function fixture(t,site=origin){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'read-diagnostic-fixture-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  for(const dir of ['config','main/Default','data/profile','logs'])fs.mkdirSync(path.join(root,dir),{recursive:true});
  for(const dir of ['main','data/profile'])fs.writeFileSync(path.join(root,dir,'Local State'),'synthetic fixture');
  const config={sourceUserDataDir:path.join(root,'main'),bookmarksPath:path.join(root,'main/Default/Bookmarks'),
    automationUserDataDir:'data/profile',nativeWafPreflightUrls:[{url:site+'/index.php',passiveOnly:true}],
    ptReadOnlyPolicies:{[site]:{reviewed:true,nativeApiHeaderFallback:true,nativeIsolatedChrome:true,
      dailyHeader:true,mode:'safe_history_page',url:site+'/index.php',selector:'#info_block',actionPath:'/attendance.php',unsignedText:'签到'}}};
  fs.writeFileSync(path.join(root,'config/config.json'),JSON.stringify(config));
  const args={root,origin:site,url:site+'/index.php',clock:()=>now};
  const binding=current.reader.nativePtReadBinding(config,{origin:site,accountKey:'site-default'});
  const receipt={status:'already_signed',submissionAttempted:false,accountKey:'site-default',profileBinding:binding.profileBinding,
    evidence:{source:'page_text',authoritative:true,confirmedAt:now.toISOString(),businessDate:'2026-11-01',
      pagePath:'/index.php',statusSignal:'nexus_daily_header_signed'},
    inspection:{currentUrl:args.url,sameOrigin:true,authenticated:true,waf:false,loginRoute:false,securityVerification:false,
      siteBodyLoaded:true,pageContentAvailable:true,successText:'PRIVATE_PAGE_MARKER',successControl:'已签到',
      signedControlCount:1,unsignedControlCount:0,unsignedControl:'',success:true,
      bodyText:'PRIVATE_PAGE_MARKER',dailyTextPresent:true,dailyControlCandidateCount:1}};
  return {args,receipt,config};
}

test('new private read facts strictly discard unknown, coerced and out-of-range values',()=>{
  const safe=safeNativeReadback({inspectionPresent:true,securityVerification:false,signedControlCount:0,unsignedControlCount:1000,
    dailyControlCandidateCount:2,dailyTextPresent:true,pathClass:'index',apiStage:'request',httpStatus:404,bodyText:'PRIVATE_PAGE_MARKER'});
  assert.equal(safe.inspectionPresent,true);assert.equal(safe.unsignedControlCount,1000);assert.equal(safe.httpStatus,404);
  for(const key of additions){
    for(const value of ['PRIVATE_PAGE_MARKER',null,{},[],NaN,Infinity,-1,1001,1.5]){
      if(!Object.hasOwn(safeNativeReadback({[key]:value}),key))continue;
      assert.fail(key+' accepted '+String(value));
    }
  }
  for(const value of [0,99,600,'200',200.5])assert.equal(safeNativeReadback({httpStatus:value}).httpStatus,undefined);
  for(const value of ['root','index','login','other','none'])assert.equal(safeNativeReadback({pathClass:value}).pathClass,value);
  assert.doesNotMatch(JSON.stringify(safe),/PRIVATE_PAGE_MARKER|bodyText/);
});

test('read envelopes retain every old field for receipts, WAF, login, absent inspection, guards and API failures',async t=>{
  const {args,receipt,config}=fixture(t);
  const unsigned={...receipt,status:'not_signed',evidence:{...receipt.evidence,statusSignal:'nexus_daily_header_unsigned'},
    inspection:{...receipt.inspection,success:false,successText:'',successControl:'',signedControlCount:0,unsignedControlCount:1,unsignedControl:'签到'}};
  const cases=[receipt,unsigned,{...receipt,profileBinding:'b'.repeat(64)},
    {...receipt,status:'managed_challenge',inspection:{...receipt.inspection,waf:true}},
    {...receipt,status:'login_required',inspection:{...receipt.inspection,loginRoute:true,currentUrl:origin+'/login.php'}},
    {status:'unconfirmed',failureCode:'authoritative_status_unavailable',submissionAttempted:false},
    {...receipt,status:'unconfirmed',inspection:{...receipt.inspection,securityVerification:true}},
    {...receipt,submissionAttempted:true},{...receipt,submissionAttempted:undefined},
    {status:'unconfirmed',failureCode:'native_readback_unavailable',submissionAttempted:false,
      nativeReadback:{apiStage:'request',httpStatus:404,bodyText:'PRIVATE_PAGE_MARKER'}}];
  const previousNow=Date.now;Date.now=()=>now.getTime();
  try{
    for(const [index,value] of cases.entries()){
      const execute=async()=>({stdout:JSON.stringify(value),exitCode:0,stderr:''});
      const run=async reader=>{
        try{return await reader.inspectNativePtHeader({...args,execute});}
        catch(error){return reader.nativePtReadFailure(error);}
      };
      const actual=await run(current.reader);
      if(baseline)assert.deepEqual(oldFields(actual),oldFields(await run(baseline.reader)),'legacy case '+index);
      assert.equal(actual.submissionAttempted,index===7);
      assert.equal(actual.nativeReadback.inspectionPresent,index===5||index===9?false:index===7||index===8?undefined:true);
      assert.doesNotMatch(JSON.stringify(actual),/PRIVATE_PAGE_MARKER|bodyText/);
    }
    for(const [url,expected] of [[origin+'/','root'],[args.url,'index'],[origin+'/login.php?private=1','login'],
      [origin+'/other?private=1','other'],['PRIVATE_PAGE_MARKER','none']]){
      const value={...receipt,inspection:{...receipt.inspection,currentUrl:url}};
      const result=await current.reader.inspectNativePtHeader({...args,execute:async()=>({stdout:JSON.stringify(value),exitCode:0})});
      assert.equal(result.nativeReadback.pathClass,expected);
    }
    const isolated=current.reader.nativePtReadBinding(config,{origin,accountKey:'site-default'},{root:args.root,isolated:true});
    const apiValue={...receipt,profileBinding:isolated.profileBinding,nativeReadback:{apiStage:'daily_fields',httpStatus:200,
      dailyTextPresent:true,dailyControlCandidateCount:2}};
    const apiResult=await current.reader.inspectNativePtHeader({...args,isolated:true,inspectApi:async()=>apiValue,
      execute:async()=>assert.fail('API fallback must not invoke a UI helper')});
    assert.equal(apiResult.nativeReadback.apiStage,'daily_fields');assert.equal(apiResult.nativeReadback.httpStatus,200);
    if(baseline)assert.deepEqual(oldFields(apiResult),oldFields(await baseline.reader.inspectNativePtHeader({
      ...args,isolated:true,inspectApi:async()=>apiValue})));
    const log=fs.readFileSync(path.join(args.root,'logs/native-pt-readback.jsonl'),'utf8');
    assert.doesNotMatch(log,/PRIVATE_PAGE_MARKER|private=1|bodyText/);
    fs.rmSync(path.join(args.root,'logs/native-pt-readback.jsonl'));
    fs.mkdirSync(path.join(args.root,'logs/native-pt-readback.jsonl'));
    const result=await current.reader.inspectNativePtHeader({...args,execute:async()=>({stdout:JSON.stringify(unsigned),exitCode:0})});
    assert.equal(result.status,'not_signed','a failed diagnostic append cannot change a receipt');
  }finally{Date.now=previousNow;}
});

function apiHarness({status=200,error=false,parseError=false,headerCount=1,baseValid=true,authenticated=true,signed=false,missingDaily=false,stale=false}={}){
  const calls=[];
  const context={route:async()=>{},close:async()=>{},request:{get:async(url,options)=>{
    calls.push({url,options});if(error)throw Error('PRIVATE_PAGE_MARKER');
    return {url:()=>url,status:()=>status,headers:()=>({date:stale?'invalid':now.toUTCString(),location:'/login.php'}),text:async()=>'<html>PRIVATE_PAGE_MARKER</html>'};
  }},newPage:async()=>({route:async()=>{},setContent:async()=>{},close:async()=>{},evaluate:async()=>{
    if(parseError)throw Error('PRIVATE_PAGE_MARKER');
    return {headerCount,baseValid,headerText:(authenticated?'fixture-auth ':'')+'PRIVATE_PAGE_MARKER',bodyText:'PRIVATE_PAGE_MARKER',
      controls:[{path:'/userdetails.php',accountId:'123',tag:'a'},{path:'/usercp.php'},
        ...(missingDaily?[]:[{path:'/attendance.php',text:signed?'已签到':'签到',tag:'a'}])]};
  }})};
  return {context,calls};
}

test('API stages separate request, freshness, status, parsing, authentication and absent daily fields without changing legacy results',async t=>{
  const {args,config}=fixture(t);
  const binding=current.reader.nativePtReadBinding(config,{origin,accountKey:'site-default'},{root:args.root,isolated:true});
  const gate=async()=>({allow:true,...binding});
  const scenarios=[{stage:'request',options:{error:true},failure:'native_readback_unavailable'},
    {stage:'response_freshness',options:{stale:true},http:200},
    {stage:'http_status',options:{status:404},http:404},
    {stage:'redirect',options:{status:302},http:302,status:'login_required',failure:'login_required'},
    {stage:'response_structure',options:{parseError:true},http:200,failure:'native_readback_unavailable'},
    {stage:'response_structure',options:{headerCount:0},http:200},
    {stage:'response_structure',options:{baseValid:false},http:200},
    {stage:'authentication',options:{authenticated:false},http:200},
    {stage:'daily_fields',options:{missingDaily:true},http:200},
    {stage:'completed',options:{},http:200,status:'not_signed'},
    {stage:'completed',options:{signed:true},http:200,status:'already_signed'}];
  for(const scenario of scenarios){
    const run=async api=>{
      const harness=apiHarness(scenario.options);
      const result=await api.readNativePtApiHeader({...args,gate,launch:async()=>harness.context});
      return {result,calls:harness.calls};
    };
    const {result,calls}=await run(current.api);
    assert.equal(result.status,scenario.status??'unconfirmed');assert.equal(result.submissionAttempted,false);
    if(result.status==='unconfirmed'||result.status==='login_required')assert.equal(result.failureCode,scenario.failure??'authoritative_status_unavailable');
    assert.equal(result.nativeReadback.apiStage,scenario.stage);assert.equal(result.nativeReadback.httpStatus,scenario.http);
    assert.equal(calls.length,1);assert.equal(calls[0].url,args.url);
    assert.equal(calls[0].options.maxRedirects,0);assert.equal(calls[0].options.maxRetries,0);
    assert.doesNotMatch(JSON.stringify(result),/PRIVATE_PAGE_MARKER|bodyText|headerText/);
    if(baseline){const before=await run(baseline.api);assert.deepEqual(oldFields(result),oldFields(before.result));assert.deepEqual(calls,before.calls);}
  }
});

test('API preflight, context proof and second-page failures retain their old result and request sequence',async t=>{
  const {args,config}=fixture(t,audience);
  const binding=current.reader.nativePtReadBinding(config,{origin:audience,accountKey:'site-default'},{root:args.root,isolated:true});
  for(const scenario of ['configuration','binding','launch','profile_status','profile_request','completed','context_unproved','context_changed']){
    const run=async api=>{
      const harness=apiHarness(),get=harness.context.request.get;let checks=0;
      harness.context.request.get=async(...options)=>{
        const response=await get(...options);
        if(harness.calls.length===2&&scenario==='profile_request')throw Error('PRIVATE_PAGE_MARKER');
        return harness.calls.length===2&&scenario==='profile_status'?{...response,status:()=>404}:response;
      };
      const options={...args,gate:async()=>({allow:scenario!=='binding',...binding}),
        launch:async()=>{if(scenario==='launch')throw Error('PRIVATE_PAGE_MARKER');return harness.context;}};
      const result=scenario.startsWith('context_')?await api.readNativePtApiHeaderInContext({...options,context:harness.context,
        expectedProfileBinding:binding.profileBinding,profileProof:async()=>{checks++;return scenario==='context_changed'&&checks===1;}}):
        await api.readNativePtApiHeader({...options,...(scenario==='configuration'?{root:path.join(args.root,'missing')}:{})});
      return {result,calls:harness.calls,checks};
    };
    const {result,calls,checks}=await run(current.api);
    assert.equal(result.nativeReadback.apiStage,{profile_status:'http_status',profile_request:'request',
      context_unproved:'binding',context_changed:'profile_verification'}[scenario]??scenario);
    assert.equal(result.status,scenario==='completed'?'not_signed':'unconfirmed');
    assert.equal(calls.length,['configuration','binding','launch','context_unproved'].includes(scenario)?0:2);
    assert.equal(result.nativeReadback.httpStatus,scenario==='profile_status'?404:scenario==='profile_request'?undefined:calls.length?200:undefined);
    assert.doesNotMatch(JSON.stringify(result),/PRIVATE_PAGE_MARKER|bodyText|headerText/);
    if(baseline){const before=await run(baseline.api);assert.deepEqual(oldFields(result),oldFields(before.result));assert.deepEqual(calls,before.calls);assert.equal(checks,before.checks);}
  }
});

const shells=process.platform==='win32'?['powershell.exe','pwsh.exe']:['pwsh'];
for(const shell of shells)test(`page diagnostic expressions parse and return only booleans/counts (${shell})`,()=>{
  const scripts=fileURLToPath(new URL('../scripts/',import.meta.url));
  const quote=value=>value.replaceAll("'","''");
  const command=`$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
  $rows=@(foreach($file in @('Invoke-PlainWafAccessibility.ps1','Invoke-MainChromeCheckinAccessibility.ps1')){
    $tokens=$null;$errors=$null
    $ast=[Management.Automation.Language.Parser]::ParseFile(('${quote(scripts)}'+$file),[ref]$tokens,[ref]$errors)
    if($errors.Count){throw 'Reader syntax failure'}
    $tables=@($ast.FindAll({param($n) $n -is [Management.Automation.Language.HashtableAst]},$true))
    $pairs=@($tables | ForEach-Object {$_.KeyValuePairs} | Where-Object {$_.Item1.Value -in @('dailyTextPresent','dailyControlCandidateCount')})
    if($pairs.Count -ne 2){throw 'Diagnostic fields missing or duplicated'}
    $expression='@{'+(($pairs | ForEach-Object {$_.Item1.Value+'='+$_.Item2.Extent.Text}) -join ';')+'}'
    foreach($variant in @('none','text','control','duplicate')){
      $bodyText=if($variant -eq 'none'){'PRIVATE_PAGE_MARKER'}else{'PRIVATE_PAGE_MARKER 签到入口'}
      $controlNames=@('PRIVATE_PAGE_MARKER')
      if($variant -in @('control','duplicate')){$controlNames+=@('新签到入口')}
      if($variant -eq 'duplicate'){$controlNames+=@('Check in')}
      $facts=& ([scriptblock]::Create($expression))
      [pscustomobject]@{file=$file;variant=$variant;facts=$facts}
    }
  })
  ConvertTo-Json -InputObject $rows -Depth 6 -Compress`;
  const output=execFileSync(shell,['-NoProfile','-NonInteractive','-OutputFormat','Text','-EncodedCommand',Buffer.from(command,'utf16le').toString('base64')],
    {encoding:'utf8',windowsHide:true,timeout:30000,stdio:['ignore','pipe','pipe']});
  const rows=JSON.parse(output.trim().replace(/^\uFEFF/,''));
  assert.equal(rows.length,8);
  for(const row of rows){
    assert.equal(row.facts.dailyTextPresent,row.variant!=='none');
    assert.equal(row.facts.dailyControlCandidateCount,{none:0,text:0,control:1,duplicate:2}[row.variant]);
  }
  assert.doesNotMatch(output,/PRIVATE_PAGE_MARKER|新签到入口/);
});
