#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync,spawnSync} from 'node:child_process';
import {managed,auditRelease} from './release-lib.mjs';
import {probeRelease,verifyRelease,checkReleaseHealth} from './release-runtime.mjs';
import {evaluateReleaseGate,releaseTasks,shanghaiDay} from './release-gate.mjs';
import {parseReleaseOptions} from './release.mjs';
import {collectNasRuntime,nasRuntimeFile,nasPackageEqual} from './nas-runtime.mjs';
import {ptStatuses} from '../observation/src/checkin-contract.generated.mjs';

const source=fileURLToPath(new URL('../',import.meta.url));
const roles=['execution','observation','operations'];
const revisionPattern=/^[a-f0-9]{7,64}$/;
const versionPattern=/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/;
const count=value=>Number.isSafeInteger(value)&&value>=0;
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const requireValue=condition=>{if(!condition)throw Error('invalid evidence');};
const json=file=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
const timestamp=value=>{
  requireValue(typeof value==='string'&&Number.isFinite(Date.parse(value)));
  return new Date(value).toISOString();
};
const gateNames={
  tasks_ready:'调度空闲窗口',no_active_process:'项目进程',no_pt_lifecycle:'PT 生命周期',
  no_manual_session:'人工会话',final_report_today:'今日最终报告',no_retry_pending:'今日重试',
  harvest_settled:'Harvest 结束',evidence_settled:'证据复核结束',notifications_flushed:'汇总通知投递'
};
const phases={settled:'当日步骤已结束',before_run:'主运行前',settling:'当日步骤尚未结束',unsafe:'运行安全条件未满足',override:'紧急覆盖'};
const failureCauses=new Set(['connection_timeout','connection_interrupted','authentication_failed',
  'host_key_verification_failed','name_resolution_failed','remote_storage_full','ssh_transport_failed',
  'remote_command_failed','transport_helper_missing','input_missing','sync_command_failed']);
const dailyCountNames=['completed','unavailable','cancelled','unresolved'];
const ptCountNames=['sites','inLegacyPlan','externalOnly','fallbackOnly','fresh','discrepancies',
  'supplementCandidates','monitorOnlyUnconfirmed','guardedReadNeeded','verificationPending','externalBlocked','notSignedConfirmed'];

// Source inputs copied by observation/scripts/export-nas-bundle.mjs. Generated
// release/transfer metadata and empty data/secret directories have no Git diff.
const nasFiles=new Set(['Dockerfile','compose.nas.yaml','compose.worker.yaml','.dockerignore',
  'package.json','package-lock.json','secrets/README.md'].map(file=>'observation/'+file));
export const isNasSource=file=>nasFiles.has(file)||/^observation\/(?:src\/|public\/|compose\.[^/]+\.yaml$)/.test(file);
// sync-v2-status.ps1 derives the project from its default NasDataDir. Keep the
// remote command constant: configuration supplies only the validated SSH alias.
const nasReadCommand='cat -- /volume3/docker/checkin-fabric-v2/release.json';

export function parseDoctorOptions(argv){
  const values={},flags=new Set(),releaseArgs=[];
  for(let i=0;i<argv.length;i++){
    const arg=argv[i];
    if(['--json','--no-nas'].includes(arg)){
      requireValue(!flags.has(arg));flags.add(arg);continue;
    }
    requireValue(['--config','--manifest'].includes(arg)&&!Object.hasOwn(values,arg)&&
      typeof argv[i+1]==='string'&&argv[i+1].length>0&&!argv[i+1].startsWith('--'));
    values[arg]=argv[++i];
    releaseArgs.push(arg,values[arg]);
  }
  requireValue(Boolean(values['--config']));
  return {...parseReleaseOptions(releaseArgs),noNas:flags.has('--no-nas'),json:flags.has('--json')};
}

function validateOptions(options){
  requireValue(object(options));
  for(const field of ['executionRoot','observationRoot','opsRoot','backupRoot'])
    requireValue(typeof options[field]==='string'&&options[field].trim().length>0);
  const names=options.taskNames;
  requireValue(object(names)&&typeof names.main==='string'&&names.main.trim().length>0&&
    typeof names.sync==='string'&&names.sync.trim().length>0&&
    Object.entries(names).every(([role,name])=>/^[a-z][a-z0-9_]{0,30}$/.test(role)&&typeof name==='string'&&name.trim().length>0)&&
    new Set(Object.values(names)).size===Object.keys(names).length);
  const roots={execution:path.resolve(options.executionRoot),observation:path.resolve(options.observationRoot),operations:path.resolve(options.opsRoot)};
  const canonical=value=>process.platform==='win32'?value.toLowerCase():value;
  requireValue(new Set(Object.values(roots).map(canonical)).size===3);
  return roots;
}

function marker(value){
  requireValue(object(value)&&typeof value.version==='string'&&versionPattern.test(value.version)&&
    typeof value.revision==='string'&&revisionPattern.test(value.revision));
  return {version:value.version,revision:value.revision};
}

function matchingManifest(options,revision){
  if(options.manifest)return json(options.manifest);
  let entries;
  try{entries=fs.readdirSync(options.backupRoot,{withFileTypes:true});}
  catch(error){if(error.code==='ENOENT')return null;throw error;}
  const candidates=[];
  for(const entry of entries){
    if(!entry.isDirectory()||entry.isSymbolicLink())continue;
    const file=path.join(options.backupRoot,entry.name,'manifest.json');
    try{candidates.push({file,mtime:fs.statSync(file).mtimeMs});}
    catch(error){if(error.code!=='ENOENT')throw error;}
  }
  for(const candidate of candidates.sort((a,b)=>b.mtime-a.mtime)){
    const plan=json(candidate.file);
    if(plan?.revision===revision)return plan;
  }
  return null;
}

function counts(value,names){
  requireValue(object(value));
  const result={};
  for(const name of names)if(Object.hasOwn(value,name)){
    requireValue(count(value[name]));result[name]=value[name];
  }
  requireValue(Object.keys(result).length>0);
  return result;
}

function publicHealthCodes(){
  const script=fs.readFileSync(path.join(source,'execution/scripts/Test-CheckinHealth.ps1'),'utf8');
  const block=script.match(/^\$checks = \[ordered\]@\{\r?\n([\s\S]*?)^\}/m)?.[1];
  requireValue(Boolean(block));
  return new Set([...block.matchAll(/^    ([A-Za-z][A-Za-z0-9_]*) = /gm)].map(match=>match[1]));
}

// All reads are independent; only a configuration/tool failure makes the
// command itself fail. Never return raw records, exceptions or subprocess I/O.
export async function runDoctor(options,{projectSource=source,clock=()=>new Date(),probe,health,
  ssh=execFileSync,gitExec=execFileSync,delay=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}){
  const roots=validateOptions(options),now=new Date(clock());
  requireValue(Number.isFinite(now.getTime()));
  const result={schemaVersion:1,checkedAt:now.toISOString(),exitCode:0,status:'normal',sections:{},attention:[],errors:[]};
  let toolUnavailable=false,nasStage='parse';
  const localExec=(execute,file,args,settings)=>{
    try{return execute(file,args,settings);}
    catch(error){if(error.code==='ENOENT'&&String(error.syscall).startsWith('spawn'))toolUnavailable=true;throw error;}
  };
  const git=args=>localExec(gitExec,'git',args,{cwd:projectSource,encoding:'utf8',windowsHide:true,timeout:8_000,
    maxBuffer:4_000_000,stdio:['ignore','pipe','ignore'],env:{...process.env,GIT_OPTIONAL_LOCKS:'0'}}).trim();
  const diff=(from,to,filter)=>{
    requireValue(revisionPattern.test(from??'')&&revisionPattern.test(to??''));
    return git(['diff','--name-only','-z','--no-renames','--no-ext-diff','--no-textconv',from,to,'--'])
      .split('\0').filter(file=>file&&filter(file));
  };
  const warn=(section,code,message)=>result.attention.push({section,code,message});
  const recordError=(section,error)=>{
    if(error?.code==='TOOL_UNAVAILABLE')toolUnavailable=true;
    const code=error?.code==='ENOENT'?'missing':error instanceof SyntaxError?'invalid_json':'read_failed';
    result.errors.push({section,code,...(section==='nas'?{stage:nasStage}:{})});
  };
  const section=async(name,label,read)=>{
    const before=result.attention.length;
    try{
      const value=await read((code,message)=>warn(name,code,message));
      result.sections[name]={status:result.attention.length>before?'attention':'ok',...value};
    }catch(error){
      recordError(name,error);warn(name,'unavailable',label+'无法校验，请检查读取条件');
      result.sections[name]={status:'unavailable',summary:'无法校验（读取失败）'};
    }
  };
  const markers={};
  await section('versions','版本',warn=>{
    for(const role of roles){
      try{markers[role]=marker(json(path.join(roots[role],'release.json')));}
      catch(error){recordError('versions.'+role,error);warn('marker_unavailable',({execution:'执行根',observation:'观测根',operations:'运维根'})[role]+'版本无法读取');}
    }
    const complete=Object.keys(markers).length===3;
    const consistent=complete&&new Set(Object.values(markers).map(value=>value.version+'@'+value.revision)).size===1;
    if(complete&&!consistent)warn('version_mismatch','三个运行根的版本或提交不一致');
    const details=roles.filter(role=>markers[role]).map(role=>({execution:'执行',observation:'观测',operations:'运维'})[role]+
      ' '+markers[role].version+' / '+markers[role].revision.slice(0,12)).join('；');
    return {summary:(consistent?'三个运行根一致':complete?'三个运行根不一致':'部分版本无法读取')+'（'+details+'）',consistent,roots:markers};
  });
  const plan={roots,revision:markers.execution?.revision};
  let snapshot;
  await section('probe','运行探针',async()=>{
    const inspect=probe??(current=>probeRelease(current,{taskNames:options.taskNames,
      exec:(...args)=>localExec(execFileSync,...args)}));
    snapshot=await inspect(plan);requireValue(snapshot?.schemaVersion===1);
    return {summary:'只读探针可用'};
  });
  await section('audit','文件与依赖漂移',warn=>{
    requireValue(Boolean(plan.revision));
    const manifest=matchingManifest(options,plan.revision);
    if(!manifest)return {status:'info',summary:'无法校验（没有匹配的清单）'};
    requireValue(manifest.revision===plan.revision&&object(manifest.roots)&&Array.isArray(manifest.files));
    for(const role of roles)requireValue(typeof manifest.roots[role]==='string'&&path.resolve(manifest.roots[role])===roots[role]);
    for(const entry of manifest.files)requireValue(object(entry)&&typeof entry.file==='string'&&managed.test(entry.file)&&
      /^[a-f0-9]{64}$/.test(entry.afterHash??''));
    const audit=auditRelease({...manifest,roots});
    if(audit.drift.length)warn('file_drift','受管文件存在漂移，需要审阅');
    if(audit.dependencyDrift.length)warn('dependency_drift','已安装依赖存在漂移，需要核对依赖');
    return {summary:'文件漂移 '+audit.drift.length+'，依赖漂移 '+audit.dependencyDrift.length,
      files:audit.files,fileDrift:audit.drift.length,dependencyDrift:audit.dependencyDrift.length};
  });
  await section('pending','待发布源码',()=>{
    const head=git(['rev-parse','HEAD']);requireValue(revisionPattern.test(head));
    const files=diff(plan.revision,head,file=>managed.test(file)).length;
    return {status:'info',summary:'受管文件差异 '+files+' 个',revision:head,files};
  });
  await section('nas','NAS',async warn=>{
    if(options.noNas)return {status:'info',summary:'已跳过 NAS 检查'};
    const config=json(path.join(roots.operations,'config/config.json'));
    requireValue(typeof config?.sshTarget==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.-]{0,252}$/.test(config.sshTarget));
    nasStage='ssh';
    let body;
    for(let attempt=0;attempt<2;attempt++){
      try{
        body=ssh('ssh',['-T','-o','BatchMode=yes','-o','ConnectTimeout=8',
          '-o','StrictHostKeyChecking=yes','-o','UpdateHostKeys=no','-o','ControlMaster=no',
          '-o','ControlPath=none','-o','ClearAllForwardings=yes','-o','PermitLocalCommand=no',config.sshTarget,nasReadCommand],
          {encoding:'utf8',windowsHide:true,timeout:20_000,maxBuffer:64_000,stdio:['ignore','pipe','ignore']});
        break;
      }catch(error){if(attempt===1)throw error;await delay(3_000);}
    }
    nasStage='parse';
    const deployed=marker(JSON.parse(String(body).replace(/^\uFEFF/,'')));
    nasStage='diff';
    const changed=diff(deployed.revision,plan.revision,isNasSource);
    const readFile=file=>git(['show',plan.revision+':'+file]);
    const runtime=collectNasRuntime(readFile);
    let files=0,bundledOnlyFiles=0,versionOnlyFiles=0;
    for(const file of changed){
      if(/^observation\/package(?:-lock)?\.json$/.test(file)&&
        nasPackageEqual(file,git(['show',deployed.revision+':'+file]),readFile(file)))versionOnlyFiles++;
      else if(nasRuntimeFile(file,runtime))files++;
      else bundledOnlyFiles++;
    }
    if(files)warn('nas_behind','NAS 面板相关文件与 Windows 部署不同，需要部署');
    const summary=[files?'面板相关文件差异 '+files+' 个':'面板相关文件一致'];
    if(bundledOnlyFiles)summary.push(bundledOnlyFiles+' 个打包文件不同，NAS 不运行，无需部署');
    if(versionOnlyFiles)summary.push(versionOnlyFiles+' 个包文件仅版本不同，无需部署');
    if(runtime.unresolvedImports.length)summary.push(runtime.unresolvedImports.length+' 处动态 import 无法解析，已按所在目录保守计入');
    return {status:files?'attention':bundledOnlyFiles||versionOnlyFiles||runtime.unresolvedImports.length?'info':'ok',
      summary:summary.join('；'),...deployed,files,bundledOnlyFiles,versionOnlyFiles,
      reachableModules:runtime.modules.size,unresolvedImports:runtime.unresolvedImports.length};
  });
  await section('tasks','调度',warn=>{
    const tasks=releaseTasks(snapshot).filter(task=>['main','sync'].includes(task.role)).map(task=>{
      const state=['Ready','Running','Disabled','Queued','Unknown'].includes(task.state)?task.state:'Unknown';
      if(!['Ready','Running'].includes(state))warn('task_state',({main:'主任务',sync:'同步任务'})[task.role]+'状态异常');
      if(![0,267009,...(task.role==='main'?[2]:[])].includes(task.lastResult))
        warn('task_result',({main:'主任务',sync:'同步任务'})[task.role]+'上次结果码异常');
      return {role:task.role,state,lastResult:task.lastResult,lastRun:timestamp(task.lastRun),nextRunAt:new Date(task.nextRunMs).toISOString()};
    });
    return {summary:tasks.map(task=>({main:'主任务',sync:'同步任务'})[task.role]+' '+task.state+' / '+task.lastResult+' / 下次 '+task.nextRunAt).join('；'),tasks};
  });
  await section('sync','同步',warn=>{
    const state=json(path.join(roots.operations,'outputs/scheduler-state.json'));
    requireValue(count(state?.failureCount)&&Object.hasOwn(state,'lastFailureCause'));
    const lastSuccessAt=timestamp(state.lastSuccessAt),ageMinutes=(now-Date.parse(lastSuccessAt))/60_000;
    requireValue(ageMinutes>=-1);
    if(state.failureCount>=3)warn('sync_failures','同步已连续失败至少三次，需要检查同步链路');
    if(ageMinutes>120)warn('sync_stale','同步最后成功已超过两小时，需要检查同步链路');
    const cause=state.lastFailureCause;
    const known=typeof cause==='string'?(failureCauses.has(cause)?cause:cause.match(/\bcause=([a-z_]+)\)/)?.[1]):null;
    const lastFailureCause=cause==null||cause===''?null:failureCauses.has(known)?known:'other';
    return {summary:'最后成功 '+lastSuccessAt+'，连续失败 '+state.failureCount+' 次'+
      (lastFailureCause?'，原因 '+lastFailureCause:''),lastSuccessAt,failureCount:state.failureCount,lastFailureCause};
  });
  await section('health','健康',async warn=>{
    const inspect=health??(current=>checkReleaseHealth(current,{spawn:(...args)=>{
      const value=spawnSync(...args);if(value.error?.code==='ENOENT')toolUnavailable=true;return value;
    }}));
    const value=await inspect(plan);
    requireValue(typeof value?.healthy==='boolean'&&Array.isArray(value.failedChecks)&&value.healthy===(value.failedChecks.length===0));
    const known=publicHealthCodes(),failedChecks=value.failedChecks.map(code=>known.has(code)?code:'unrecognizedCheck');
    if(failedChecks.length)warn('health_failures','健康检查失败：'+failedChecks.join('、'));
    return {summary:failedChecks.length?'失败项：'+failedChecks.join('、'):'全部通过',healthy:value.healthy,failedChecks};
  });
  await section('gate','发布门槛',()=>{
    requireValue(Boolean(snapshot));
    const gate=evaluateReleaseGate(snapshot,{now});
    const failedChecks=Object.keys(gateNames).filter(code=>gate.checks[code]?.ok===false);
    return {status:'info',summary:(gate.ok?'通过':'未通过')+'（'+phases[gate.phase]+'）'+
      (failedChecks.length?'：'+failedChecks.map(code=>gateNames[code]).join('、'):''),
    ok:gate.ok,phase:gate.phase,failedChecks};
  });
  await section('verify','发布后核验',warn=>{
    const value=verifyRelease(plan,{probe:()=>{requireValue(Boolean(snapshot));return snapshot;}});
    if(value.status==='fail')warn('verification_failed','发布后核验失败，需要检查部署后的自然运行证据');
    return {status:value.status==='pending'?'info':value.status==='fail'?'attention':'ok',
      summary:({pass:'通过',pending:'待定，等待自然运行证据',fail:'失败，证据缺失或异常'})[value.status],
      result:value.status,reasonCount:value.reasons.length};
  });
  const today=shanghaiDay(now);
  // Before a final run exists, today's derived files may legitimately not
  // exist yet. Reuse the gate's finding; business conclusions belong to WO-04.
  const beforeFinal=result.sections.gate.failedChecks?.includes('final_report_today')===true;
  const readToday=(file,name)=>{
    try{return json(file);}
    catch(error){
      if(error.code!=='ENOENT'||!beforeFinal)throw error;
      recordError(name,error);return null;
    }
  };
  await section('daily','今日主运行结果',()=>{
    const report=readToday(path.join(roots.observation,'outputs/engine-daily-'+today+'.json'),'daily');
    if(report===null)return {status:'info',summary:'今日主运行尚无计数'};
    requireValue(report?.businessDate===today);
    const projected=counts(report.counts,dailyCountNames);
    return {summary:Object.entries(projected).map(([name,value])=>name+'='+value).join('，'),counts:projected};
  });
  await section('pt','今日 PT 结果',()=>{
    const report=readToday(path.join(roots.observation,'outputs/shadow-beta-snapshot.json'),'pt');
    if(report===null||beforeFinal&&/^\d{4}-\d{2}-\d{2}$/.test(report.businessDate??'')&&report.businessDate<today)
      return {status:'info',summary:'今日 PT 计数尚未生成'};
    requireValue(report?.businessDate===today);
    const projected=counts(report.ptStatus?.counts,ptCountNames);
    if(report.ptStatus.counts.status!==undefined)projected.status=counts(report.ptStatus.counts.status,ptStatuses);
    return {summary:Object.entries(projected).filter(([,value])=>typeof value==='number').map(([name,value])=>name+'='+value).join('，')+
      (projected.status?'；状态 '+Object.entries(projected.status).map(([name,value])=>name+'='+value).join('，'):''),counts:projected};
  });
  result.exitCode=toolUnavailable?2:result.attention.length?1:0;
  result.status=({0:'normal',1:'attention',2:'error'})[result.exitCode];
  if(toolUnavailable)result.errors.push({section:'tools',code:'tool_unavailable'});
  return result;
}

export function formatDoctor(result){
  const labels={versions:'版本',audit:'文件与依赖',pending:'待发布',nas:'NAS',tasks:'调度',sync:'同步',
    health:'健康',gate:'发布门槛',verify:'发布后核验',daily:'今日主运行',pt:'今日 PT'};
  const lines=['只读体检：'+({0:'正常',1:'需要关注',2:'体检失败'})[result.exitCode]+'（退出码 '+result.exitCode+'）'];
  if(result.exitCode===2&&result.sections.versions===undefined)lines.push('配置缺失、不可读或不完整，或体检工具不可用。');
  for(const [name,label] of Object.entries(labels)){
    const value=result.sections[name];if(value)lines.push(label+'：'+value.summary);
  }
  if(result.attention.length)lines.push('需要处理：'+[...new Set(result.attention.map(item=>item.message))].join('；'));
  if(result.errors.some(item=>item.code==='tool_unavailable'))lines.push('需要处理：体检工具不可用。');
  return lines.join('\n');
}

export async function runDoctorCli(argv,{stdout=value=>console.log(value),...dependencies}={}){
  let result;
  try{result=await runDoctor(parseDoctorOptions(argv),dependencies);}
  catch{result={schemaVersion:1,exitCode:2,status:'error',sections:{},attention:[],errors:[{section:'config',code:'configuration_or_tool_unavailable'}]};}
  stdout(argv.includes('--json')?JSON.stringify(result):formatDoctor(result));
  return result.exitCode;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))
  process.exitCode=await runDoctorCli(process.argv.slice(2));
