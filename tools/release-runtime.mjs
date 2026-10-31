import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync,spawnSync} from 'node:child_process';
import {auditRelease} from './release-lib.mjs';
import {evaluateReleaseGate,evaluateReleaseVerification,releaseTasks} from './release-gate.mjs';

const probeFile=fileURLToPath(new URL('./release-probe.ps1',import.meta.url));
const shell=()=>process.platform==='win32'?'pwsh.exe':'pwsh';
export function probeRelease(plan,{taskNames,exec=execFileSync}={}){
  if(!taskNames||typeof taskNames!=='object'||Array.isArray(taskNames)||!taskNames.main||!taskNames.sync)
    throw Error('taskNames must provide main and sync task names in --config or --task-names');
  try{
    const output=exec(shell(),['-NoProfile','-NonInteractive','-File',probeFile,
      '-ExecutionRoot',plan.roots.execution,'-ObservationRoot',plan.roots.observation,
      ...(plan.roots.operations?['-OpsRoot',plan.roots.operations]:['-NoOps']),
      '-TaskNamesJson',JSON.stringify(taskNames),'-CallerPid',String(process.pid)],
    {encoding:'utf8',windowsHide:true,timeout:15_000,maxBuffer:4_000_000});
    const value=JSON.parse(output.trim().replace(/^\uFEFF/,''));
    if(value?.schemaVersion!==1)throw Error();
    return value;
  }catch{throw Error('read-only release probe unavailable or invalid (15 second limit)');}
}

export function checkReleaseHealth(plan,{spawn=spawnSync}={}){
  const result=spawn(shell(),['-NoProfile','-NonInteractive','-File',path.join(plan.roots.execution,'scripts/Test-CheckinHealth.ps1')],
    {cwd:plan.roots.execution,encoding:'utf8',windowsHide:true,timeout:30_000,maxBuffer:2_000_000,
      env:{...process.env,POWERSHELL_UPDATECHECK:'Off',PSModuleAnalysisCachePath:process.platform==='win32'?'NUL':'/dev/null'}});
  try{
    // The health script exits 2 for ordinary failing checks and 3 for a
    // diagnostic execution error. Existing failures are a comparison baseline.
    if(result.error||result.signal||![0,2].includes(result.status))throw Error();
    const body=JSON.parse(result.stdout.trim().replace(/^\uFEFF/,''));
    if(!Array.isArray(body.failedChecks)||!body.failedChecks.every(item=>typeof item==='string'&&/^[A-Za-z][A-Za-z0-9_]*$/.test(item))||
      typeof body.healthy!=='boolean'||body.healthy!==(body.failedChecks.length===0))throw Error();
    return {exitCode:result.status,healthy:body.healthy,failedChecks:[...new Set(body.failedChecks)].sort()};
  }catch{throw Error('health check unavailable or invalid');}
}

export function releaseSafetyCallbacks({probe,health=checkReleaseHealth,audit=auditRelease,clock=()=>new Date(),overrideDayGate}={}){
  const inspect=plan=>{
    const snapshot=probe(plan),gate=evaluateReleaseGate(snapshot,{now:clock(),overrideDayGate});
    if(!gate.ok)throw Error('release gate refused: '+gate.reasons.join('; '));
    return {gate,snapshot};
  };
  return {
    beforeLock(plan){const {gate}=inspect(plan);return {gate,overrideDayGate:overrideDayGate?.trim()??null};},
    beforeApply(plan){
      const {gate,snapshot}=inspect(plan);
      return {gate,tasks:releaseTasks(snapshot),health:health(plan)};
    },
    afterApply(plan,{baseline}){
      const checks={};let stage='audit';
      try{
        const result=audit(plan);
        checks.audit={ok:Array.isArray(result.drift)&&Array.isArray(result.dependencyDrift)&&result.drift.length===0&&result.dependencyDrift.length===0};
        if(!checks.audit.ok)throw Error('release audit drift');
        stage='tasks';const tasks=releaseTasks(probe(plan));
        checks.taskDefinitions={ok:tasks.length===baseline.tasks.length&&baseline.tasks.every(before=>tasks.find(after=>after.role===before.role)?.definitionHash===before.definitionHash)};
        if(!checks.taskDefinitions.ok)throw Error('task definition changed');
        checks.scheduleBoundary={ok:baseline.tasks.every(before=>tasks.find(after=>after.role===before.role)?.lastRun===before.lastRun)};
        if(!checks.scheduleBoundary.ok)throw Error('scheduled run boundary crossed');
        stage='health';const after=health(plan),added=after.failedChecks.filter(code=>!baseline.health.failedChecks.includes(code));
        checks.health={ok:added.length===0,before:baseline.health,after,added};
        if(!checks.health.ok)throw Error('new health failures');
        return {ok:true,checks};
      }catch{throw Object.assign(Error('post-apply checks failed'),{validation:{ok:false,stage,checks}});}
    }
  };
}

export function verifyRelease(plan,{probe}={}){
  try{
    const snapshot=probe(plan),deployedAt=snapshot.markers?.value?.execution?.deployedAt;
    return evaluateReleaseVerification(snapshot,{revision:plan.revision,roots:Object.keys(plan.roots),deployedAt});
  }catch{return {status:'fail',reasons:['read-only verification evidence unavailable']};}
}
