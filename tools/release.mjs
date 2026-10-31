import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {planRelease,applyRelease,rollbackRelease,auditRelease} from './release-lib.mjs';
import {probeRelease,releaseSafetyCallbacks,verifyRelease} from './release-runtime.mjs';
import {evaluateReleaseGate} from './release-gate.mjs';
const source=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const fields={'--execution-root':'executionRoot','--observation-root':'observationRoot','--ops-root':'opsRoot',
  '--backup-root':'backupRoot','--task-names':'taskNames','--out':'out','--manifest':'manifest','--backup':'backup',
  '--override-day-gate':'overrideDayGate','--config':'config'};
const rootFields=['executionRoot','observationRoot','opsRoot','backupRoot'];
function json(file,label){try{return JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));}catch{throw Error(`${label} missing, unreadable or invalid JSON`);}}
export function parseReleaseOptions(args){
  const cli={};
  for(let i=0;i<args.length;i++){
    if(args[i]==='--no-ops'){if(cli.noOps)throw Error('duplicate --no-ops');cli.noOps=true;continue;}
    const key=fields[args[i]];
    if(!key||!args[i+1]||args[i+1].startsWith('--')||Object.hasOwn(cli,key))throw Error('invalid release arguments');
    cli[key]=args[++i];
  }
  let config={};
  if(cli.config){
    config=json(cli.config,'release config');
    if(!config||typeof config!=='object'||Array.isArray(config)||Object.keys(config).some(key=>![...rootFields,'taskNames'].includes(key)))throw Error('invalid release config fields');
    config={...config};
    for(const key of rootFields)if(Object.hasOwn(config,key)){
      if(typeof config[key]!=='string'||!config[key].trim())throw Error('invalid release config root');
      config[key]=path.resolve(path.dirname(path.resolve(cli.config)),config[key]);
    }
  }
  const options={...config,...cli};
  if(cli.taskNames){try{options.taskNames=JSON.parse(cli.taskNames);}catch{throw Error('--task-names needs a JSON object');}}
  if(options.taskNames!==undefined){
    const names=options.taskNames;
    if(!names||typeof names!=='object'||Array.isArray(names)||!names.main||!names.sync||
      Object.entries(names).some(([role,name])=>!/^([a-z][a-z0-9_]{0,30})$/.test(role)||typeof name!=='string'||!name.trim())||
      new Set(Object.values(names)).size!==Object.keys(names).length)throw Error('taskNames needs distinct main and sync task names');
  }
  if(options.overrideDayGate!==undefined&&!options.overrideDayGate.trim())throw Error('--override-day-gate needs a non-empty reason');
  if(options.noOps){if(cli.opsRoot)throw Error('--no-ops conflicts with --ops-root');delete options.opsRoot;}
  for(const key of rootFields)if(options[key])options[key]=path.resolve(options[key]);
  return options;
}
function assertManifestRoots(plan,options){
  for(const [key,role] of [['executionRoot','execution'],['observationRoot','observation'],['opsRoot','operations']]){
    if(options[key]&&path.resolve(plan.roots[role]??'')!==options[key])throw Error('configured roots disagree with the manifest; create a new plan');
  }
  if(options.noOps&&plan.roots.operations)throw Error('--no-ops disagrees with the manifest');
}
export async function runReleaseCli(argv,{projectSource=source,probe,stdout=value=>console.log(value),stderr=value=>console.error(value)}={}){
  try{
    const [command,...args]=argv,options=parseReleaseOptions(args);
    if(options.overrideDayGate&&command!=='apply')throw Error('--override-day-gate is only valid for apply');
    if(command==='plan'){
      if(!options.opsRoot&&!options.noOps)throw Error('plan requires --ops-root (or config opsRoot), or explicit --no-ops: otherwise the operations runtime would be omitted');
      if(!options.executionRoot||!options.observationRoot||!options.out)throw Error('plan needs runtime roots and --out');
      const plan=planRelease({source:projectSource,executionRoot:options.executionRoot,observationRoot:options.observationRoot,opsRoot:options.opsRoot});
      const file=path.resolve(options.out);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(plan,null,2),{mode:0o600});
      stdout(JSON.stringify({manifest:file,files:plan.files.length,changed:plan.files.filter(f=>f.beforeHash!==f.afterHash).map(f=>f.file)}));
    }else if(command==='gate'){
      // Read only: report whether apply would be admitted now, without taking a lock.
      if(!options.manifest)throw Error('manifest required');
      const plan=json(options.manifest,'release manifest');assertManifestRoots(plan,options);
      const inspect=probe??(current=>probeRelease(current,{taskNames:options.taskNames}));
      const result=evaluateReleaseGate(inspect(plan),{now:new Date()});stdout(JSON.stringify(result));
      return result.ok?0:3;
    }else if(['apply','audit','verify'].includes(command)){
      if(!options.manifest)throw Error('manifest required');
      const plan=json(options.manifest,'release manifest');assertManifestRoots(plan,options);
      const inspect=probe??(current=>probeRelease(current,{taskNames:options.taskNames}));
      if(command==='apply'){
        if(!options.backupRoot)throw Error('backup root required');
        const result=await applyRelease(plan,{backupRoot:options.backupRoot,...releaseSafetyCallbacks({probe:inspect,overrideDayGate:options.overrideDayGate})});
        stdout(JSON.stringify(result));
      }else if(command==='audit'){
        const result=auditRelease(plan);stdout(JSON.stringify(result));
        if(result.drift.length||result.dependencyDrift.length)return 2;
      }else{
        const result=verifyRelease(plan,{probe:inspect});stdout(JSON.stringify(result));
        return {pass:0,pending:3,fail:1}[result.status];
      }
    }else if(command==='rollback'){
      if(!options.backup)throw Error('backup required');stdout(JSON.stringify(await rollbackRelease(options.backup)));
    }else throw Error('use plan, gate, apply, audit, rollback or verify');
    return 0;
  }catch(error){stderr('Release refused: '+error.message);return 1;}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))process.exitCode=await runReleaseCli(process.argv.slice(2));
