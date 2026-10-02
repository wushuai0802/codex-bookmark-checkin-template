import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {canonicalPtOrigin,harvestSiteAssignment,harvestTaskCompleted} from './pt-coordination.mjs';

const dayAt=value=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(value);
export function isPtExecutionTarget(target,{root}={}){
  if(target?.ptSupplement===true||(target?.folderNames??[]).some(folder=>/pt/i.test(folder))||
     ['https://open.cd','https://u2.dmhy.org'].includes(target?.origin))return true;
  try{const integration=JSON.parse(fs.readFileSync(path.join(root,'data/v2-integration.json'),'utf8'));
    if((integration.harvestPtGate?.expectedOrigins??[]).includes(target.origin))return true;
    const catalog=JSON.parse(fs.readFileSync(integration.harvestPtGate.catalogFile,'utf8'));
    return catalog.sites.some(site=>site.origin===target.origin);
  }catch{return false;}
}
const delay=(now,reason)=>({status:'deferred',retryCause:'harvest_waiting',
  nextEligibleAt:new Date(now.getTime()+30*60_000).toISOString(),
  submissionAttempted:false,reason});
const exactOrigin=value=>{try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&u.origin===value?value:null;}catch{return null;}};

export function harvestPtDecision({report,target,now=new Date()}={}){
  const wait=reason=>delay(now,reason);
  const businessDate=dayAt(now);
  if(report?.schemaVersion!==1||report.source!=='harvest'||report.businessDate!==businessDate||
    !Array.isArray(report.sites)||
    !Number.isFinite(Date.parse(report.generatedAt))||
    Date.parse(report.generatedAt)>now.getTime()+60_000||
    now.getTime()-Date.parse(report.generatedAt)>2*60_000)return wait('Harvest 当日状态未刷新，PT 提交已暂缓');
  const assignment=harvestSiteAssignment(report,target.origin),site=assignment.site;
  if(assignment.owner==='ambiguous')return wait('Harvest 同站身份不明确，PT 提交已暂缓');
  if(site&&['signed','already_signed'].includes(site.status)){
    const at=Date.parse(site.observedAt);
    if(site.evidence?.authoritative!==true||!Number.isFinite(at)||dayAt(new Date(at))!==businessDate||
      at>now.getTime()+60_000)return wait('Harvest 报告完成但缺少当日确认，PT 提交已暂缓');
    // Harvest's user ID must not be treated as this PT account's identity.
    // The separate PT status report holds the authoritative external receipt.
    return {status:'already_signed',reason:'Harvest 当日同站签到已完成，执行器只获取状态',
      submissionAttempted:false,evidence:{source:'harvest',authoritative:false,
        confirmedAt:new Date(at).toISOString(),businessDate}};
  }
  if(assignment.owner==='unknown')return wait('Harvest 签到分工尚未确认，先只读核验');
  if(assignment.owner==='execution')return null;
  if(!harvestTaskCompleted(report,businessDate,now))return wait('Harvest 当日任务未完成或正在重新执行，PT 提交已暂缓');
  return null;
}

export function checkHarvestPtBeforeWrite(target,{root,now=new Date(),probe}={}){
  const integrationFile=path.join(root,'data/v2-integration.json');
  if(!fs.existsSync(integrationFile))return null;
  const integration=JSON.parse(fs.readFileSync(integrationFile,'utf8'));
  const gate=integration.harvestPtGate;
  if(integration.executionEngine!=='v1'||gate?.enabled!==true)return null;
  if(!exactOrigin(target?.origin))return delay(now,'PT 目标来源不明确，已阻止提交');
  const suspectPt=(target.folderNames??[]).some(folder=>typeof folder==='string'&&/pt/i.test(folder))||
    (gate.expectedOrigins??[]).includes(target.origin);
  let catalog;
  try{catalog=JSON.parse(fs.readFileSync(gate.catalogFile,'utf8'));}
  catch{return suspectPt?delay(now,'PT 监测目录暂不可读，已阻止提交'):null;}
  if(!Array.isArray(catalog?.sites))return suspectPt?delay(now,'PT 监测目录无效，已阻止提交'):null;
  const monitored=catalog.sites.filter(site=>canonicalPtOrigin(site?.origin)===canonicalPtOrigin(target.origin));
  if(!monitored.length)return suspectPt?delay(now,'PT 书签尚未进入精确监测目录，已阻止提交'):null;
  if(monitored.length!==1)return delay(now,'PT 监测目录同站重复，已阻止提交');
  let plan;
  try{plan=JSON.parse(fs.readFileSync(path.join(root,'data/last-valid-bookmark-plan.json'),'utf8'));}
  catch{return delay(now,'PT 原计划暂不可读，已阻止提交');}
  if(!Array.isArray(plan.targets))return delay(now,'PT 原计划无效，已阻止提交');
  const owners=plan.targets.filter(site=>site.origin===target.origin);
  let supplemental=false;
  if(target.ptSupplement===true&&owners.length===0&&target.accountKey==='site-default'){
    try{const runtime=JSON.parse(fs.readFileSync(path.join(integration.v2ProjectRoot,'config/runtime.local.json'),'utf8'));
      supplemental=runtime.ptFallbackOnlyEnabled===true&&runtime.executionEngine==='v1'&&
        path.resolve(runtime.legacyRoot).toLowerCase()===path.resolve(root).toLowerCase();}catch{}
  }
  if(!supplemental&&(owners.length!==1||(owners[0].accountKey??'site-default')!==(target.accountKey??'site-default')))
    return delay(now,'PT 同站账号归属不唯一或补签未启用，已阻止提交');
  if(!/^[A-Za-z0-9._@-]{1,120}$/.test(gate.sshTarget??'')||
     !/^[/]volume3[/]docker[/][A-Za-z0-9._/-]{1,200}$/.test(gate.database??'')||
     gate.database.split('/').includes('..'))return delay(now,'Harvest 只读查询配置无效，已阻止 PT 提交');
  try{
    const report=probe?probe():(()=>{
      const source=fs.readFileSync(path.join(integration.v2ProjectRoot,'scripts/harvest-observe.py'),'utf8');
      const child=spawnSync('ssh',['-o','BatchMode=yes','-o','ConnectTimeout=5',gate.sshTarget,
        'sudo -n python3 - '+gate.database],{input:source,encoding:'utf8',timeout:8_000,maxBuffer:2_000_000,windowsHide:true});
      if(child.error||child.status!==0||!child.stdout)throw Error('Harvest read unavailable');
      return JSON.parse(child.stdout);
    })();
    return harvestPtDecision({report,target,now:probe?now:new Date()});
  }catch{return delay(now,'Harvest 实时只读查询失败，PT 提交已暂缓');}
}
