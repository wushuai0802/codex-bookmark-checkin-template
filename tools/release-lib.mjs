import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
const managed=/^(execution\/(?:src|scripts|skills)\/|observation\/(?:src|scripts|public|schemas)\/|(?:execution|observation)\/package(?:-lock)?\.json$)/;
export const fileHash=file=>fs.existsSync(file)?crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'):null;
function safeFile(root,relative){
  if(!/^[A-Za-z0-9_.\/-]+$/.test(relative)||relative.split('/').some(p=>p==='..'||p==='.'||!p))throw Error('unsafe release path');
  let cursor=path.resolve(root);
  for(const piece of ['',...relative.split('/')]){
    if(piece)cursor=path.join(cursor,piece);
    if(fs.existsSync(cursor)&&fs.lstatSync(cursor).isSymbolicLink())throw Error('release paths cannot contain symbolic links');
  }
  return cursor;
}
function destination(roots,file){const [layer,...parts]=file.split('/');if(!roots[layer]||!managed.test(file))throw Error('file outside release scope');return safeFile(roots[layer],parts.join('/'));}
const protectedPaths=roots=>[
  path.join(roots.execution,'config/config.json'),path.join(roots.execution,'config/config.local.json'),
  path.join(roots.execution,'data/v2-integration.json'),path.join(roots.observation,'config/runtime.local.json')];
const marker=root=>path.join(root,'release.json');
function atomic(file,bytes){fs.mkdirSync(path.dirname(file),{recursive:true});const temp=file+'.'+crypto.randomUUID()+'.tmp';
  try{fs.writeFileSync(temp,bytes,{mode:0o600});fs.renameSync(temp,file);}finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}}

export function planRelease({source,executionRoot,observationRoot,files,revision,version}={}){
  const roots={execution:path.resolve(executionRoot),observation:path.resolve(observationRoot)};
  for(const root of Object.values(roots))if(root===path.parse(root).root)throw Error('runtime root cannot be a drive root');
  if(roots.execution===roots.observation)throw Error('execution and observation roots must be distinct');
  source=path.resolve(source);
  files??=execFileSync('git',['ls-files','--cached','--others','--exclude-standard'],{cwd:source,encoding:'utf8'}).trim().split(/\r?\n/).filter(file=>managed.test(file));
  const entries=[...new Set(files)].sort().map(file=>{
    if(!managed.test(file))throw Error('file outside release scope');
    const from=safeFile(source,file),to=destination(roots,file),afterHash=fileHash(from);
    if(!afterHash)throw Error('release source missing: '+file);
    return {file,beforeHash:fileHash(to),afterHash};
  });
  const detectedRevision=revision??execFileSync('git',['rev-parse','HEAD'],{cwd:source,encoding:'utf8'}).trim();
  return {schemaVersion:1,source,roots,revision:detectedRevision,version:version??JSON.parse(fs.readFileSync(path.join(source,'package.json'),'utf8')).version,
    createdAt:new Date().toISOString(),files:entries,protections:protectedPaths(roots).map(file=>({file,hash:fileHash(file)}))};
}

export async function withRuntimeLocks(plan,run){
  const {acquireExecutionLock,releaseExecutionLock}=await import(pathToFileURL(path.join(plan.source,'observation/src/execution-lock.mjs')));
  const {acquireRunLock,releaseRunLock}=await import(pathToFileURL(path.join(plan.source,'execution/src/run-lock.mjs')));
  let worker,engine,runner;
  try{worker=acquireExecutionLock(plan.roots.observation,{name:'harvest-fallback.lock'});engine=acquireExecutionLock(plan.roots.observation);
    runner=await acquireRunLock(path.join(plan.roots.execution,'tmp/run.lock'));return await run();
  }finally{if(runner)await releaseRunLock(runner);if(engine)releaseExecutionLock(engine);if(worker)releaseExecutionLock(worker);}
}

export async function applyRelease(plan,{backupRoot,lock=withRuntimeLocks}={}){
  if(plan.schemaVersion!==1||!Array.isArray(plan.files)||!plan.files.length)throw Error('invalid release manifest');
  const backup=path.join(path.resolve(backupRoot),new Date().toISOString().replaceAll(':','-')+'-'+plan.revision.slice(0,12));
  if(fs.existsSync(backup))throw Error('release backup already exists');
  return lock(plan,async()=>{
    const prepared=plan.files.map(entry=>{
      const from=safeFile(plan.source,entry.file),to=destination(plan.roots,entry.file);
      if(fileHash(from)!==entry.afterHash||fileHash(to)!==entry.beforeHash)throw Error('release drift: '+entry.file);
      return {...entry,to,bytes:fs.readFileSync(from)};
    });
    for(const p of plan.protections)if(fileHash(p.file)!==p.hash)throw Error('protected configuration drift');
    fs.mkdirSync(backup,{recursive:true});
    for(const entry of prepared)if(entry.beforeHash){const to=safeFile(backup,entry.file);fs.mkdirSync(path.dirname(to),{recursive:true});fs.copyFileSync(entry.to,to);}
    const markers=Object.fromEntries(Object.entries(plan.roots).map(([layer,root])=>[layer,fs.existsSync(marker(root))?fs.readFileSync(marker(root),'utf8'):null]));
    const release={...plan,appliedAt:new Date().toISOString(),markers};
    atomic(path.join(backup,'manifest.json'),JSON.stringify(release,null,2));
    const modified=[];
    try{
      for(const entry of prepared){atomic(entry.to,entry.bytes);modified.push(entry);}
      for(const p of plan.protections)if(fileHash(p.file)!==p.hash)throw Error('protected configuration changed during deployment');
      for(const root of Object.values(plan.roots))atomic(marker(root),JSON.stringify({version:plan.version,revision:plan.revision,deployedAt:release.appliedAt}));
    }catch(error){
      for(const entry of modified.reverse()){
        if(fileHash(entry.to)!==entry.afterHash)continue;
        if(entry.beforeHash)atomic(entry.to,fs.readFileSync(safeFile(backup,entry.file)));
        else {const saved=safeFile(backup,'retired/'+entry.file);fs.mkdirSync(path.dirname(saved),{recursive:true});fs.renameSync(entry.to,saved);}
      }
      throw error;
    }
    return {backup,files:prepared.length,changed:prepared.filter(e=>e.beforeHash!==e.afterHash).length,revision:plan.revision,version:plan.version};
  });
}

export async function rollbackRelease(backup,{lock=withRuntimeLocks}={}){
  const plan=JSON.parse(fs.readFileSync(path.join(backup,'manifest.json'),'utf8'));
  return lock(plan,async()=>{
    for(const entry of plan.files){
      if(fileHash(destination(plan.roots,entry.file))!==entry.afterHash)throw Error('runtime drift prevents rollback: '+entry.file);
      if(entry.beforeHash&&fileHash(safeFile(backup,entry.file))!==entry.beforeHash)throw Error('backup hash mismatch');
    }
    for(const entry of plan.files){const to=destination(plan.roots,entry.file);
      if(entry.beforeHash)atomic(to,fs.readFileSync(safeFile(backup,entry.file)));
      else{const saved=safeFile(backup,'retired/'+entry.file);fs.mkdirSync(path.dirname(saved),{recursive:true});fs.renameSync(to,saved);}
    }
    for(const [layer,root] of Object.entries(plan.roots)){
      if(plan.markers?.[layer]!=null)atomic(marker(root),plan.markers[layer]);
      else if(fs.existsSync(marker(root))){const saved=path.join(backup,layer+'-release-retired.json');fs.renameSync(marker(root),saved);}
    }
    return {restored:plan.files.length,backup};
  });
}

export function auditRelease(plan){return {version:plan.version,revision:plan.revision,
  files:plan.files.length,drift:plan.files.filter(entry=>fileHash(destination(plan.roots,entry.file))!==entry.afterHash).map(entry=>entry.file)};}
