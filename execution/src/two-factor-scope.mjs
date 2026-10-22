import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
import {readBookmarkPlan} from './bookmarks.mjs';
import {ptExecutionBinding} from './pt-read-policy.mjs';
import {acquireRunLock,releaseRunLock,inspectProcessIdentity,classifyLockOwner} from './run-lock.mjs';

const execute=promisify(execFile);
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const canonical=value=>path.resolve(value).toLowerCase();
const digest=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const day=at=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date(at));
const now=clock=>{const value=new Date(clock());if(!Number.isFinite(value.getTime()))throw Error('clock');return value;};
const sameOrigin=(url,origin)=>{try{const u=new URL(url);return u.protocol==='https:'&&u.origin===origin&&!u.username&&!u.password;}catch{return false;}};
const criticalKeys=['bookmarksPath','bitwardenTotp','siteTwoFactorRecovery','savedLoginUrls','baiduOcr','excludedOrigins','disabledCheckinOrigins','disabledAccountKeys',
  'oauthAccountIdentities','supplementalOAuthAccounts','isolatedOAuthSiteProfiles','oauthSiteSessionBindings',
  'oauthExecutionAccountBindings','nativeWafPreflightUrls','nativeChallengePreflight'];
const criticalConfig=value=>JSON.stringify(Object.fromEntries(criticalKeys.map(key=>[key,value?.[key]])));
function plainPath(value){
  for(let part=path.resolve(value);part;part=path.dirname(part)){
    try{if(fs.lstatSync(part).isSymbolicLink())return false;}catch(error){if(error.code!=='ENOENT')return false;}
    if(path.dirname(part)===part)break;
  }
  return true;
}
function plainRuntime(root,profile){
  const auxiliary=path.join(root,'data/bitwarden');
  if(![root,profile,path.join(profile,'Local State'),path.join(root,'config/config.json'),
    path.join(root,'data/v2-integration.json'),path.join(root,'tmp/run.lock'),auxiliary].every(plainPath))return false;
  return !fs.existsSync(auxiliary)||fs.readdirSync(auxiliary).every(name=>plainPath(path.join(auxiliary,name)));
}

async function controllerLease(root,integration){
  const controller=integration?.v2ProjectRoot;
  if(integration?.executionEngine!=='v1'||!path.isAbsolute(controller??'')||
    !path.isAbsolute(process.env.CHECKIN_V2_ENGINE_ROOT??'')||canonical(controller)!==canonical(process.env.CHECKIN_V2_ENGINE_ROOT)||
    !process.env.CHECKIN_V2_ENGINE_LEASE)throw Error('lease');
  const {validateEngineLease}=await import(pathToFileURL(path.join(controller,'src/legacy-engine.mjs')).href);
  if(validateEngineLease({root:controller,legacyRoot:root})!==true)throw Error('lease');
}

async function ancestorPids(){
  if(process.platform!=='win32'){
    const chain=new Set([process.pid]);let pid=process.ppid;
    for(let i=0;pid>0&&i<24&&!chain.has(pid);i++){
      chain.add(pid);
      try{const stat=fs.readFileSync('/proc/'+pid+'/stat','utf8');pid=Number(stat.slice(stat.lastIndexOf(')')+2).split(' ')[1]);}
      catch{break;}
    }
    return chain;
  }
  const command="$ids=@();$p=[int]$env:CHECKIN_2FA_CALLER_PID;for($i=0;$p-gt 0-and $i-lt 24-and $ids-notcontains $p;$i++){$ids+=$p;$v=Get-CimInstance Win32_Process -Filter ('ProcessId='+$p) -ErrorAction SilentlyContinue;if(-not $v){break};$p=[int]$v.ParentProcessId};ConvertTo-Json -InputObject @($ids) -Compress";
  const {stdout}=await execute(path.join(process.env.SystemRoot??'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoProfile','-NonInteractive','-Command',command],{windowsHide:true,encoding:'utf8',timeout:8_000,maxBuffer:4096,
      env:{...process.env,CHECKIN_2FA_CALLER_PID:String(process.pid)}});
  const ids=JSON.parse(stdout.trim().replace(/^\uFEFF/,''));
  if(!Array.isArray(ids)||ids.some(pid=>!Number.isSafeInteger(pid)||pid<=0))throw Error('ancestors');
  return new Set(ids);
}

async function exactScope(root,origin,config,integration,readPlan){
  try{
    const plan=await readPlan(config.bookmarksPath,config);
    const matches=(plan.targets??[]).filter(target=>target.origin===origin);
    if(matches.length>1)return false;
    if(matches.length===1)return plan.exactScopeConfigured===true&&
      (!matches[0].accountKey||matches[0].accountKey==='site-default')&&
      (matches[0].candidates??[]).some(url=>sameOrigin(url,origin));
  }catch{/* A PT monitor has a separate explicitly registered bookmark scope. */}
  const runtime=read(path.join(integration.v2ProjectRoot,'config/runtime.local.json'));
  if(runtime.ptFallbackOnlyEnabled!==true||runtime.executionEngine!=='v1'||canonical(runtime.legacyRoot)!==canonical(root))return false;
  const file=integration.harvestPtGate?.catalogFile;
  if(!path.isAbsolute(file??''))return false;
  const catalog=read(file),sites=(catalog.sites??[]).filter(site=>site.origin===origin);
  if(catalog.schemaVersion!==1||sites.length!==1||!sameOrigin(sites[0].entryUrl,origin)||
    !/^\d{1,20}$/.test(catalog.scope?.folderId??'')||!/^\d{1,20}$/.test(catalog.scope?.parentId??''))return false;
  const bookmarks=read(config.bookmarksPath),folders=[];
  const visit=(node,parents=[])=>{
    if(String(node.id)===String(catalog.scope.folderId)&&parents.includes(String(catalog.scope.parentId)))folders.push(node);
    for(const child of node.children??[])visit(child,[...parents,String(node.id)]);
  };
  for(const node of Object.values(bookmarks.roots??{}))visit(node);
  if(folders.length!==1)return false;
  let matched=false;
  const collect=node=>{
    if(node.type==='url'&&sameOrigin(node.url,origin)){
      const url=new URL(node.url);
      if(!url.search&&!url.hash&&url.origin+url.pathname===sites[0].entryUrl)matched=true;
    }
    for(const child of node.children??[])collect(child);
  };
  collect(folders[0]);return matched;
}

/** Validate the existing owner and exact account scope without opening a browser. */
export async function validateSiteTwoFactorScope({root,origin,config,profile,clock=Date.now,adapterId,
  readPlan=readBookmarkPlan,validateLease=controllerLease,ancestors=ancestorPids,
  inspectOwner=inspectProcessIdentity,acquire=acquireRunLock,release=releaseRunLock}={}){
  let ownLock,lockFile,lockHash,configHash,binding,integration,startedDay;
  try{
    if(!path.isAbsolute(root??'')||!path.isAbsolute(profile??'')||!sameOrigin(origin,origin)||
      new URL(origin).origin!==origin||!/^[a-z0-9-]{1,80}$/.test(adapterId??''))return null;
    root=path.resolve(root);profile=path.resolve(profile);
    const configFile=path.join(root,'config/config.json'),current=read(configFile);
    if(config!==undefined&&criticalConfig(current)!==criticalConfig(config))return null;
    config=current;configHash=digest(configFile);
    const opt=config.siteTwoFactorRecovery?.[origin];
    if(opt?.enabled!==true||opt.reviewed!==true||opt.provider!=='bitwarden'||opt.adapterId!==adapterId)return null;
    const paused=()=>[...(config.excludedOrigins??[]),...(config.disabledCheckinOrigins??[])].includes(origin)||
      (config.disabledAccountKeys??[]).includes('site-default');
    if(paused())return null;
    const selected=ptExecutionBinding(config,root,{origin,accountKey:'site-default'});
    if(canonical(selected.profile)!==canonical(profile)||!fs.existsSync(path.join(profile,'Local State'))||!plainRuntime(root,profile))return null;
    binding={accountKey:'site-default',profileBinding:selected.profileBinding,adapterId};
    integration=read(path.join(root,'data/v2-integration.json'));startedDay=day(now(clock));
    await validateLease(root,integration);
    if(!await exactScope(root,origin,config,integration,readPlan))return null;
    lockFile=path.join(root,'tmp/run.lock');
    if(fs.existsSync(lockFile)){
      const owner=read(lockFile),chain=await ancestors();
      if(owner.version!==1||!Number.isSafeInteger(owner.pid)||!chain.has(owner.pid)||
        !/^[0-9a-f-]{36}$/.test(owner.nonce??'')||!Number.isFinite(Date.parse(owner.processStartedAt??''))||
        classifyLockOwner(owner,await inspectOwner(owner.pid))!=='active')return null;
    }else ownLock=await acquire(lockFile);
    lockHash=digest(lockFile);
    let released=false;
    const releaseScope=async()=>{if(!released){released=true;if(ownLock)await release(ownLock);}};
    const assertCurrent=async()=>{
      try{
        if(released||!plainRuntime(root,profile)||day(now(clock))!==startedDay||digest(configFile)!==configHash||digest(lockFile)!==lockHash||
          JSON.stringify(read(path.join(root,'data/v2-integration.json')))!==JSON.stringify(integration))return false;
        const owner=read(lockFile);
        if(classifyLockOwner(owner,await inspectOwner(owner.pid))!=='active')return false;
        await validateLease(root,integration);
        return await exactScope(root,origin,config,integration,readPlan);
      }catch{return false;}
    };
    if(!await assertCurrent()){await releaseScope();return null;}
    return {binding,configHash,assertCurrent,release:releaseScope};
  }catch{if(ownLock)try{await release(ownLock);}catch{};return null;}
}
