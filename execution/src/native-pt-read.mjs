import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {nativePtHeaderOrigins} from './checkin-contract.generated.mjs';

const runFile=promisify(execFile);
export function nativePtReadRoute(config,origin){
  const canonical=value=>{try{return normalizeOrigin(value);}catch{return '';}};
  if(!nativePtHeaderOrigins.some(value=>canonical(value)===canonical(origin)))return null;
  const entries=[...(config.nativeWafPreflightUrls??[]).map(value=>typeof value==='string'?{url:value}:value),
    ...(config.nativeChallengePreflight??[])].filter(value=>canonical(value.url)===canonical(origin));
  const fallback=(config.mainChromeFallbackUrls??[]).find(value=>canonical(typeof value==='string'?value:value.sourceOrigin??value.url)===canonical(origin));
  if(!entries.length)return fallback?{mainProfile:true}:null;
  const action=entries.some(value=>value.action==='checkin')||(config.nativeAccessibilityCheckinOrigins??[]).some(value=>canonical(value)===canonical(origin));
  const useMain=!action&&fallback&&entries.every(value=>value.passiveOnly!==true);
  if(useMain)return {mainProfile:true};
  const profiles=[...new Set(entries.map(value=>value.automationUserDataDir??config.automationUserDataDir))];
  if(profiles.length!==1||!profiles[0])throw Error('Native PT execution profile is ambiguous');
  return {mainProfile:false,profile:profiles[0]};
}

export function nativePtReadBinding(config,target,{root,isolated=false}={}){
  if(target.accountKey!=='site-default')throw Error('Native PT read needs a unique site account');
  if(isolated){
    const route=nativePtReadRoute(config,target.origin);
    if(!root||!route||route.mainProfile!==false)throw Error('Native PT isolated read route is unavailable');
    const profile=path.resolve(root,route.profile),relative=path.relative(path.join(path.resolve(root),'data'),profile);
    if(!relative||relative.startsWith('..')||path.isAbsolute(relative)||!fs.existsSync(path.join(profile,'Local State')))
      throw Error('Configured native PT profile is unavailable');
    const key=process.platform==='win32'?profile.toLowerCase():profile;
    return {profile,accountKey:target.accountKey,profileBinding:crypto.createHash('sha256').update(key).digest('hex')};
  }
  const sourceRoot=path.resolve(config.sourceUserDataDir??''),profile=path.dirname(path.resolve(config.bookmarksPath??''));
  const relative=path.relative(sourceRoot,profile);
  if(!/^(Default|Profile [0-9]+)$/.test(relative)||!fs.existsSync(path.join(sourceRoot,'Local State')))
    throw Error('Configured main Chrome profile is unavailable');
  const key=process.platform==='win32'?profile.toLowerCase():profile;
  return {profile,accountKey:target.accountKey,profileBinding:crypto.createHash('sha256').update(key).digest('hex')};
}

const successful=new Set(['signed','already_signed','not_signed']);
const dayAt=value=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date(value));
const normalizeOrigin=value=>new URL(value).origin.replace(/^https:\/\/www\./,'https://');
const failureCodes=new Set(['accessibility_unavailable','window_not_created','window_merged','target_not_loaded','login_required','browser_route_conflict',
  'two_factor_required','authoritative_status_unavailable','network_error','tls_certificate_invalid','tls_handshake_failed',
  'native_readback_unavailable']);
const proxyPreflightCodes=new Set(['native_proxy_configuration_invalid','native_proxy_origin_not_registered','native_proxy_profile_conflict']);
const boundedBytes=value=>Math.min(200_000,Buffer.byteLength(String(value??''),'utf8'));
const diagnosticCodes=new Set(['request_rejected','profile_binding_unavailable','shell_rejected','scratch_unavailable',
  'process_deadline','output_limit','process_terminated','receipt_missing','invalid_json','invalid_receipt',
  'submission_reported','readonly_not_proven','receipt_accepted','waf_present','login_required','two_factor_required',
  'authoritative_evidence_rejected','readback_inconclusive','entrypoint_unavailable',...failureCodes]);
const cleanupCodes=new Set(['closed','already_closed','window_unavailable','window_not_owned','window_close_timeout','helper_only','cleanup_unavailable']);
const diagnosticFacts=['sameOrigin','authenticated','waf','loginRoute','siteBodyLoaded','pageContentAvailable','hasDailySignal','hasSignedControl'];

export const asciiNativePtReadReceipt=value=>JSON.stringify(value).replace(/[\u007f-\uffff]/g,
  character=>'\\u'+character.charCodeAt(0).toString(16).padStart(4,'0'));
export function safeNativeReadback(value={}){
  return {stage:['preflight','transport','timeout','decode','guard','readback','completed'].includes(value.stage)?value.stage:'preflight',
    code:diagnosticCodes.has(value.code)?value.code:'request_rejected',
    exitCode:Number.isInteger(value.exitCode)?value.exitCode:null,
    durationMs:Math.min(600_000,Math.max(0,Number(value.durationMs)||0)),stderrPresent:value.stderrPresent===true,
    stderrBytes:Math.min(200_000,Math.max(0,Number(value.stderrBytes)||0)),
    ...(cleanupCodes.has(value.cleanupCode)?{cleanupCode:value.cleanupCode}:{}),
    ...Object.fromEntries(diagnosticFacts.filter(key=>typeof value[key]==='boolean').map(key=>[key,value[key]]))};
}

export class NativePtReadError extends Error{
  constructor(code,diagnostic,possibleSubmission=false){
    super('Native PT read failed: '+code);this.code=code;this.nativeReadback=diagnostic;
    this.possibleSubmission=possibleSubmission;
  }
}

// Kill only the helper and its non-browser descendants. Chrome uses a shared
// main-profile process, so taskkill /T (or a process-name kill) is never safe.
async function cleanupReadHelper({root,shell,pid,startedAt,lifecyclePath}){
  if(process.platform!=='win32')return {code:'helper_only'};
  try{
    const {stdout}=await runFile(shell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',
      path.join(root,'scripts/Cleanup-NativePtRead.ps1'),'-HelperProcessId',String(pid),
      '-StartedAt',startedAt,'-LifecyclePath',lifecyclePath],
    {encoding:'utf8',windowsHide:true,timeout:8_000,maxBuffer:10_000});
    const value=JSON.parse(stdout.trim().replace(/^\uFEFF/,''));
    return {code:['closed','already_closed','window_unavailable','window_not_owned','window_close_timeout'].includes(value.code)
      ?value.code:'cleanup_unavailable'};
  }catch{return {code:'cleanup_unavailable'};}
}

export function runNativeReadProcess(file,args,options={}){
  const {root,shell=file,lifecyclePath='',cleanup=cleanupReadHelper,timeout=75_000,...processOptions}=options;
  return new Promise((resolve,reject)=>{
    let timedOut=false,settled=false,output='',errors='',timer;
    const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(value);};
    const startedAt=new Date().toISOString();
    const child=execFile(file,args,{...processOptions,timeout:0},(error,stdout,stderr)=>{
      output=stdout??'';errors=stderr??'';
      if(timedOut)return;
      if(error){error.stdout=output;error.stderr=errors;finish(error);}
      else finish(null,{stdout:output,stderr:errors,exitCode:0});
    });
    child.stdout?.on('data',chunk=>{output+=chunk;});
    child.stderr?.on('data',chunk=>{errors+=chunk;});
    timer=setTimeout(async()=>{
      timedOut=true;
      let cleanupResult,cleanupTimer;try{cleanupResult=await Promise.race([
        cleanup({root,shell,pid:child.pid,startedAt,lifecyclePath}),
        new Promise(resolve=>{cleanupTimer=setTimeout(()=>resolve({code:'cleanup_unavailable'}),8_000);}),
      ]);}
      catch{cleanupResult={code:'cleanup_unavailable'};}
      finally{clearTimeout(cleanupTimer);}
      // This is the owned child handle, never a browser PID from a name lookup.
      try{child.kill('SIGKILL');}catch{}
      const error=Object.assign(Error('Native read process deadline reached'),{
        killed:true,code:'ETIMEDOUT',stdout:output,stderr:errors,cleanupCode:cleanupResult?.code??'cleanup_unavailable'});
      finish(error);
    },timeout);
  });
}

function receiptEvidence(value,origin,url,inspected,now){
  let actual;try{actual=new URL(inspected.currentUrl);}catch{return null;}
  const evidence=value.evidence,confirmed=Date.parse(evidence?.confirmedAt??'');
  const day=dayAt(now);
  if(inspected.sameOrigin!==true||normalizeOrigin(actual.origin)!==normalizeOrigin(origin)||
    actual.protocol!=='https:'||actual.username||actual.password||actual.search||actual.hash||
    !['/','/index.php'].includes(actual.pathname)||value.status==='not_signed'&&actual.pathname!=='/index.php'||
    inspected.waf===true||inspected.loginRoute===true||
    inspected.securityVerification===true||evidence?.authoritative!==true||evidence.source!=='page_text'||
    !Number.isFinite(confirmed)||confirmed>now.getTime()+60_000||dayAt(confirmed)!==day||
    evidence.businessDate!==day||evidence.pagePath!==actual.pathname||
    !['nexus_daily_header_signed','nexus_daily_header_unsigned'].includes(evidence.statusSignal)||
    (value.status==='not_signed')!==(evidence.statusSignal==='nexus_daily_header_unsigned'))return null;
  if(origin==='https://ourbits.club'&&value.status!=='not_signed'&&inspected.signedControlCount===0&&(
    inspected.authenticated!==true||inspected.siteBodyLoaded!==true||inspected.ourbitsDailyHeaderVerified!==true||
    inspected.ourbitsHeaderContextClear!==true||inspected.ourbitsHeaderLogoutCount!==1||
    inspected.ourbitsHeaderStatsCount!==4||inspected.ourbitsHeaderRewardCount!==1||
    inspected.ourbitsHeaderUnsignedControlCount!==0||inspected.unsignedControlCount!==0||inspected.successControl||inspected.unsignedControl))return null;
  return {source:'page_text',authoritative:true,confirmedAt:new Date(confirmed).toISOString(),businessDate:day,
    pagePath:actual.pathname,statusSignal:evidence.statusSignal};
}

export function nativePtReadFailure(error){
  const possible=error?.possibleSubmission===true;
  return {status:possible?'needs_attention':'unconfirmed',failureCode:possible?'submission_outcome_unknown':'native_readback_unavailable',
    reason:possible?'只读回执违反禁止提交护栏，先核验，禁止重放':'主 Chrome 只读回读未取得有效回执，已保留诊断',
    submissionAttempted:possible,...(possible?{retryable:false}:{}),
    nativeReadback:safeNativeReadback(error?.nativeReadback)};
}

export async function inspectNativePtHeader({root,origin,url,isolated=false,execute=runNativeReadProcess,inspectApi,clock=()=>new Date()}={}){
  const started=Date.now();let transport={};
  const diagnostic=(stage,code,extra={})=>({stage,code,exitCode:Number.isInteger(transport.exitCode)?transport.exitCode:null,
    durationMs:Math.min(600_000,Math.max(0,Date.now()-started)),stderrPresent:Boolean(transport.stderr),
    stderrBytes:boundedBytes(transport.stderr),...extra});
  const fail=(stage,code,possible=false,extra={})=>{throw new NativePtReadError(code,diagnostic(stage,code,extra),possible);};
  let target;try{target=new URL(url);if(target.origin!==origin||target.protocol!=='https:'||target.username||target.password||
    target.pathname!=='/index.php'||target.search||target.hash||!nativePtHeaderOrigins.some(value=>normalizeOrigin(value)===normalizeOrigin(origin)))
      fail('preflight','request_rejected');}catch(error){if(error instanceof NativePtReadError)throw error;fail('preflight','request_rejected');}
  root=path.resolve(root??'');let config,binding;
  try{config=JSON.parse(fs.readFileSync(path.join(root,'config/config.json'),'utf8'));binding=nativePtReadBinding(config,{origin,accountKey:'site-default'},{root,isolated});}
  catch{fail('preflight','profile_binding_unavailable');}
  const shell=config.powershellExecutable||'pwsh.exe';
  if(!/^(?:pwsh|powershell)(?:\.exe)?$/i.test(path.basename(shell)))fail('preflight','shell_rejected');
  const script=path.join(root,'scripts',isolated?'Invoke-PlainWafAccessibility.ps1':'Invoke-MainChromeCheckinAccessibility.ps1');
  let scratch;try{fs.mkdirSync(path.join(root,'tmp'),{recursive:true});scratch=fs.mkdtempSync(path.join(root,'tmp/native-pt-read-'));}
  catch{fail('preflight','scratch_unavailable');}
  const lifecyclePath=path.join(scratch,'window.json'),ownerToken=crypto.randomUUID();
  try{
    let apiPolicy;
    if(isolated){try{const {ptReadPolicy}=await import('./pt-read-policy.mjs');apiPolicy=ptReadPolicy(origin,config);}catch{}}
    if(apiPolicy?.nativeApiHeaderFallback===true){
      const read=inspectApi??(await import('./native-pt-api.mjs')).readNativePtApiHeader;
      const value=await read({root,origin,clock});
      transport={stdout:JSON.stringify({...value,inspection:value.inspection??value.readbackReceipt?.inspection}),stderr:'',exitCode:0};
    }else try{transport=await execute(shell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script,
      '-Origin',origin,'-Url',url,'-ReadOnly','-TimeoutSeconds','35',
      ...(isolated?['-UserDataDirOverride',binding.profile,'-WindowMode','offscreen']:['-LifecyclePath',lifecyclePath,'-LifecycleToken',ownerToken])],
    {encoding:'utf8',windowsHide:true,timeout:75_000,maxBuffer:200_000,root,shell,lifecyclePath});}
    catch(error){
      transport={stdout:error.stdout,stderr:error.stderr,exitCode:Number.isInteger(error.code)?error.code:
        (Number.isInteger(error.status)?error.status:null)};
      if(error.code==='ETIMEDOUT')fail('timeout','process_deadline',false,{cleanupCode:cleanupCodes.has(error.cleanupCode)?error.cleanupCode:'cleanup_unavailable'});
      if(error.code==='ERR_CHILD_PROCESS_STDIO_MAXBUFFER')fail('transport','output_limit');
      if(error.killed)fail('transport','process_terminated');
      if(!transport.stdout)fail('transport','receipt_missing');
    }
    let value;try{value=JSON.parse(String(transport.stdout??'').trim().replace(/^\uFEFF/,''));}
    catch{fail('decode','invalid_json');}
    if(!value||typeof value!=='object'||Array.isArray(value))fail('decode','invalid_receipt');
    if(['clicked','submissionAttempted','checkinClickAttempted','checkinClicked'].some(key=>value[key]===true))
      fail('guard','submission_reported',true);
    if(value.submissionAttempted!==false)fail('guard','readonly_not_proven');
    const proxyPreflight=value.status==='unconfirmed'&&value.failureCode==='native_readback_unavailable'&&
      proxyPreflightCodes.has(value.nativeProxyFailureCode)&&value.nativeReadback?.stage==='preflight'&&
      value.nativeReadback?.code==='profile_binding_unavailable';
    const routeConflict=proxyPreflight&&value.nativeProxyFailureCode==='native_proxy_profile_conflict';
    const inspected=value.inspection??{};
    const facts={sameOrigin:inspected.sameOrigin===true,authenticated:inspected.authenticated===true,waf:inspected.waf===true,
      loginRoute:inspected.loginRoute===true,siteBodyLoaded:inspected.siteBodyLoaded===true,
      pageContentAvailable:inspected.pageContentAvailable===true,hasDailySignal:Boolean(inspected.successText),hasSignedControl:Boolean(inspected.successControl)};
    let status=['signed','already_signed','not_signed','managed_challenge','login_required','unconfirmed','needs_attention'].includes(value.status)?value.status:'unconfirmed';
    const identityMatches=value.accountKey===binding.accountKey&&value.profileBinding===binding.profileBinding;
    const evidence=successful.has(status)&&identityMatches?receiptEvidence(value,origin,url,inspected,clock()):null;
    const accepted=evidence!==null;
    const code=proxyPreflight?'profile_binding_unavailable':accepted?'receipt_accepted':facts.waf||status==='managed_challenge'?'waf_present':facts.loginRoute||status==='login_required'?'login_required':
      value.failureCode==='two_factor_required'?'two_factor_required':successful.has(status)?'authoritative_evidence_rejected':
      failureCodes.has(value.failureCode)?value.failureCode:'readback_inconclusive';
    if(successful.has(status)&&!accepted)status='unconfirmed';
    const nativeReadback=diagnostic(proxyPreflight?'preflight':accepted?'completed':'readback',code,facts);
    const label=isolated?'执行 Profile':'主 Chrome';
    const result={origin,url,accountKey:binding.accountKey,profileBinding:binding.profileBinding,status,
      reason:proxyPreflight?(value.nativeProxyFailureCode==='native_proxy_profile_conflict'
        ?'常用 Chrome 的现有代理与站点专用线路不一致，需要正常关闭后按站点线路重开'
        :'站点专用代理配置未通过验证，尚未启动浏览器或签到'):
        accepted?(status==='not_signed'?`${label} 只读首页确认今日尚未签到`:`${label} 只读首页确认今日已签到`):
        code==='waf_present'?`${label} 只读回读仍停留在安全验证页`:code==='login_required'?`${label} 只读回读需要登录`:
        code==='two_factor_required'?`${label} 只读回读需要二次验证`:code==='network_error'?'站点连接未能建立，尚未读取签到页面':
        code==='tls_certificate_invalid'?'站点证书验证未通过，尚未读取签到页面':
        code==='tls_handshake_failed'?'站点 TLS 连接未能建立，尚未读取签到页面':`${label} 只读回读未取得当日权威证据`,
      ...(accepted?{evidence}:{failureCode:routeConflict?'browser_route_conflict':code==='login_required'?'login_required':
        failureCodes.has(value.failureCode)?value.failureCode:'authoritative_status_unavailable'}),
      submissionAttempted:false,nativeReadback};
    // Recovery consumes the verified child receipt from the same actual
    // profile. Keep this bounded projection separate from page diagnostics.
    if(accepted)
      result.readbackReceipt={origin,url,status,accountKey:value.accountKey,profileBinding:value.profileBinding,
        observedAt:evidence.confirmedAt,businessDate:evidence.businessDate,submissionAttempted:false,
        operationMode:'safe_history_page',readSafety:'reviewed_passive',
        evidence:{...evidence,evidenceScope:'site_account_day'},inspection:{
          currentUrl:inspected.currentUrl,...facts,securityVerification:inspected.securityVerification===true,
          signedControlCount:inspected.signedControlCount,unsignedControlCount:inspected.unsignedControlCount,
          successControl:inspected.successControl??'',unsignedControl:inspected.unsignedControl??'',
          success:inspected.success===true,successText:Boolean(inspected.successText),
          audiencesDailyHeaderVerified:inspected.audiencesDailyHeaderVerified===true,
          ...(origin==='https://ourbits.club'?{
            ourbitsDailyHeaderVerified:inspected.ourbitsDailyHeaderVerified===true,
            ourbitsHeaderContextClear:inspected.ourbitsHeaderContextClear===true,
            ...Object.fromEntries(['ourbitsHeaderLogoutCount','ourbitsHeaderStatsCount','ourbitsHeaderRewardCount','ourbitsHeaderUnsignedControlCount']
              .filter(key=>Number.isInteger(inspected[key])).map(key=>[key,inspected[key]]))}: {})}};
    try{fs.mkdirSync(path.join(root,'logs'),{recursive:true});fs.appendFileSync(path.join(root,'logs/native-pt-readback.jsonl'),
      JSON.stringify({origin,observedAt:clock().toISOString(),status,failureCode:result.failureCode??null,...facts,nativeReadback})+'\n',{mode:0o600});}
    catch{/* Diagnostic writes cannot discard a valid receipt. */}
    return result;
  }catch(error){
    if(error instanceof NativePtReadError){try{fs.mkdirSync(path.join(root,'logs'),{recursive:true});fs.appendFileSync(path.join(root,'logs/native-pt-readback.jsonl'),
      JSON.stringify({origin,observedAt:clock().toISOString(),...nativePtReadFailure(error)})+'\n',{mode:0o600});}catch{}}
    throw error;
  }finally{fs.rmSync(scratch,{recursive:true,force:true});}
}
