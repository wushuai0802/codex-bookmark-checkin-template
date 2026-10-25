import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
// Keep public runtime inputs explicit: allowing the entire config directory
// would also overwrite account bindings and local site/credential settings.
const publicRuntimeFiles=new Set([
  'execution/config/defaults.json','execution/config/qa-rules.json',
  'execution/config/site-rules.public.json','execution/requirements-ocr.txt',
  'observation/Dockerfile','observation/compose.nas.yaml',
  'observation/compose.worker.yaml','observation/.dockerignore'
]);
// The installed scheduler retains its old operations entrypoint paths. Publish
// the exact same canonical code there, rather than maintaining an untracked
// production-only repair. No config/data or unrelated operations script joins.
const operationsSources=new Map([
  ['operations/scripts/Sync-NasShadow.ps1','observation/scripts/Sync-NasShadow.ps1'],
  ['operations/scripts/Start-NasShadowScheduler.ps1','observation/scripts/Start-NasShadowScheduler.ps1'],
  ['operations/scripts/Run-HiddenPowerShell.vbs','execution/scripts/Run-HiddenPowerShell.vbs'],
  ['operations/scripts/Sync-OperationsSupport.ps1','observation/scripts/Sync-OperationsSupport.ps1'],
  ['operations/scripts/Sync-Transport.ps1','observation/scripts/Sync-Transport.ps1']
]);
const operationsCodeFile=/^operations\/(?:src|public|schemas|scripts)\/[A-Za-z0-9_.\/-]+$|^operations\/(?:Dockerfile|compose\.(?:nas|worker)\.yaml|\.dockerignore|package(?:-lock)?\.json)$/;
const managed={test:file=>operationsSources.has(file)||operationsCodeFile.test(file)||publicRuntimeFiles.has(file)||/^(execution\/(?:src|scripts|skills)\/|observation\/(?:src|scripts|public|schemas)\/|(?:execution|observation)\/package(?:-lock)?\.json$)/.test(file)};
const sourceFile=file=>operationsSources.get(file)??(file.startsWith('operations/')?`observation/${file.slice('operations/'.length)}`:file);
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
  path.join(roots.execution,'data/v2-integration.json'),path.join(roots.observation,'config/runtime.local.json'),
  ...(roots.operations?[path.join(roots.operations,'config/config.json'),path.join(roots.operations,'config/pt-monitor.local.json')]:[])];
const marker=root=>path.join(root,'release.json');
function atomic(file,bytes){fs.mkdirSync(path.dirname(file),{recursive:true});const temp=file+'.'+crypto.randomUUID()+'.tmp';
  try{fs.writeFileSync(temp,bytes,{mode:0o600});fs.renameSync(temp,file);}finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}}

export function assertNoManualHandoff(root){
  const pending=new Set(['pending','pending_verification','waiting_for_user','awaiting_user','awaiting_manual_handoff','waiting_login','awaiting_login']);
  for(const relative of ['tmp/manual-handoff.json','tmp/manual-verification.json','tmp/manual-session.json']){
    const file=safeFile(root,relative);
    if(!fs.existsSync(file))continue;
    const state=JSON.parse(fs.readFileSync(file,'utf8'));
    if(pending.has(state.state))throw Error('resolve pending manual handoff before changing code');
    if(Number.isSafeInteger(state.pid)&&state.pid>0){
      try{process.kill(state.pid,0);throw Object.assign(Error('manual window is active'),{code:'MANUAL_ACTIVE'});}
      catch(error){if(error.code!=='ESRCH')throw Error('close the active manual session before changing code');}
    }
  }
}

export function planRelease({source,executionRoot,observationRoot,opsRoot,files,revision,version}={}){
  const roots={execution:path.resolve(executionRoot),observation:path.resolve(observationRoot),...(opsRoot?{operations:path.resolve(opsRoot)}:{})};
  for(const root of Object.values(roots))if(root===path.parse(root).root)throw Error('runtime root cannot be a drive root');
  const canonical=value=>{let resolved=path.resolve(value);try{resolved=fs.realpathSync.native(resolved);}catch{}
    return process.platform==='win32'?resolved.toLowerCase():resolved;};
  if(new Set(Object.values(roots).map(canonical)).size!==Object.values(roots).length)throw Error('execution, observation and operations roots must be distinct');
  source=path.resolve(source);
  let gitRoot=null,sourceTree=null;
  try{gitRoot=execFileSync('git',['rev-parse','--show-toplevel'],{cwd:source,encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();}catch{}
  if(gitRoot&&canonical(path.resolve(gitRoot))===canonical(source)){
    if(execFileSync('git',['status','--porcelain=v1','--untracked-files=normal'],{cwd:source,encoding:'utf8'}).trim())
      throw Error('release source has uncommitted changes; commit and verify it first');
    sourceTree=execFileSync('git',['rev-parse','HEAD^{tree}'],{cwd:source,encoding:'utf8'}).trim();
  }
  files??=execFileSync('git',['ls-files','--cached','--others','--exclude-standard'],{cwd:source,encoding:'utf8'}).trim().split(/\r?\n/).filter(file=>managed.test(file));
  if(roots.operations){
    const operationCode=[...files].filter(file=>file.startsWith('observation/')&&
      /^(?:observation\/(?:src|public|schemas|scripts)\/|observation\/(?:Dockerfile|compose\.(?:nas|worker)\.yaml|\.dockerignore|package(?:-lock)?\.json)$)/.test(file))
      .map(file=>`operations/${file.slice('observation/'.length)}`);
    files=[...files,...operationsSources.keys(),...operationCode];
  }
  const entries=[...new Set(files)].sort().map(file=>{
    if(!managed.test(file))throw Error('file outside release scope');
    const from=safeFile(source,sourceFile(file)),to=destination(roots,file),afterHash=fileHash(from);
    if(!afterHash)throw Error('release source missing: '+file);
    return {file,beforeHash:fileHash(to),afterHash};
  });
  const detectedRevision=revision??execFileSync('git',['rev-parse','HEAD'],{cwd:source,encoding:'utf8'}).trim();
  const artifactHash=crypto.createHash('sha256').update(JSON.stringify(entries.map(entry=>[entry.file,entry.afterHash]))).digest('hex');
  return {schemaVersion:1,source,roots,revision:detectedRevision,sourceTree,artifactHash,version:version??JSON.parse(fs.readFileSync(path.join(source,'package.json'),'utf8')).version,
    createdAt:new Date().toISOString(),files:entries,protections:protectedPaths(roots).map(file=>({file,hash:fileHash(file)}))};
}

export async function withRuntimeLocks(plan,run){
  const {acquireExecutionLock,releaseExecutionLock}=await import(pathToFileURL(path.join(plan.source,'observation/src/execution-lock.mjs')));
  const {acquireRunLock,releaseRunLock}=await import(pathToFileURL(path.join(plan.source,'execution/src/run-lock.mjs')));
  let worker,engine,runner;
  try{worker=acquireExecutionLock(plan.roots.observation,{name:'harvest-fallback.lock'});engine=acquireExecutionLock(plan.roots.observation);
    const {reconcilePtWorker}=await import(pathToFileURL(path.join(plan.source,'observation/src/pt-worker-lifecycle.mjs')));
    await reconcilePtWorker(plan.roots.observation,{legacyRoot:plan.roots.execution});
    runner=await acquireRunLock(path.join(plan.roots.execution,'tmp/run.lock'));return await run();
  }finally{if(runner)await releaseRunLock(runner);if(engine)releaseExecutionLock(engine);if(worker)releaseExecutionLock(worker);}
}

export async function applyRelease(plan,{backupRoot,lock=withRuntimeLocks}={}){
  if(plan.schemaVersion!==1||!Array.isArray(plan.files)||!plan.files.length)throw Error('invalid release manifest');
  const backup=path.join(path.resolve(backupRoot),new Date().toISOString().replaceAll(':','-')+'-'+plan.revision.slice(0,12));
  if(fs.existsSync(backup))throw Error('release backup already exists');
  return lock(plan,async()=>{
    assertNoManualHandoff(plan.roots.execution);
    const prepared=plan.files.map(entry=>{
      const from=safeFile(plan.source,sourceFile(entry.file)),to=destination(plan.roots,entry.file);
      if(fileHash(from)!==entry.afterHash||fileHash(to)!==entry.beforeHash)throw Error('release drift: '+entry.file);
      return {...entry,to,bytes:fs.readFileSync(from)};
    }).sort((a,b)=>{
      const order=entry=>entry.file.includes('/scripts/')?2:entry.beforeHash===null?0:1;
      return order(a)-order(b)||a.file.localeCompare(b.file);
    });
    for(const p of plan.protections)if(fileHash(p.file)!==p.hash)throw Error('protected configuration drift');
    fs.mkdirSync(backup,{recursive:true});
    for(const entry of prepared)if(entry.beforeHash){const to=safeFile(backup,entry.file);fs.mkdirSync(path.dirname(to),{recursive:true});fs.copyFileSync(entry.to,to);}
    const markers=Object.fromEntries(Object.entries(plan.roots).map(([layer,root])=>[layer,fs.existsSync(marker(root))?fs.readFileSync(marker(root),'utf8'):null]));
    const release={...plan,appliedAt:new Date().toISOString(),markers};
    const markerBytes=Object.fromEntries(Object.keys(plan.roots).map(layer=>[layer,JSON.stringify({version:plan.version,revision:plan.revision,
      deployedAt:release.appliedAt,sourceTree:plan.sourceTree??null,artifactHash:plan.artifactHash??null,
      packageHash:plan.files.find(entry=>entry.file===layer+'/package.json')?.afterHash??null,
      lockHash:plan.files.find(entry=>entry.file===layer+'/package-lock.json')?.afterHash??null})]));
    atomic(path.join(backup,'manifest.json'),JSON.stringify(release,null,2));
    const modified=[];
    try{
      for(const root of Object.values(plan.roots))atomic(path.join(root,'tmp/release-in-progress.json'),JSON.stringify({kind:'managed-release',pid:process.pid,startedAt:release.appliedAt}));
      for(const entry of prepared)if(entry.beforeHash!==entry.afterHash){atomic(entry.to,entry.bytes);modified.push(entry);}
      for(const p of plan.protections)if(fileHash(p.file)!==p.hash)throw Error('protected configuration changed during deployment');
      for(const [layer,root] of Object.entries(plan.roots))atomic(marker(root),markerBytes[layer]);
    }catch(error){
      for(const entry of modified.reverse()){
        if(fileHash(entry.to)!==entry.afterHash)continue;
        if(entry.beforeHash)atomic(entry.to,fs.readFileSync(safeFile(backup,entry.file)));
        else {const saved=safeFile(backup,'retired/'+entry.file);fs.mkdirSync(path.dirname(saved),{recursive:true});fs.renameSync(entry.to,saved);}
      }
      for(const [layer,root] of Object.entries(plan.roots))if(fs.existsSync(marker(root))&&fs.readFileSync(marker(root),'utf8')===markerBytes[layer]){
        if(markers[layer]!=null)atomic(marker(root),markers[layer]);
        else fs.renameSync(marker(root),path.join(backup,layer+'-failed-release.json'));
      }
      throw error;
    }finally{
      for(const root of Object.values(plan.roots)){
        const file=path.join(root,'tmp/release-in-progress.json');
        if(fs.existsSync(file))try{if(JSON.parse(fs.readFileSync(file,'utf8')).pid===process.pid)fs.unlinkSync(file);}catch{}
      }
    }
    return {backup,files:prepared.length,changed:prepared.filter(e=>e.beforeHash!==e.afterHash).length,revision:plan.revision,version:plan.version};
  });
}

export async function rollbackRelease(backup,{lock=withRuntimeLocks}={}){
  const plan=JSON.parse(fs.readFileSync(path.join(backup,'manifest.json'),'utf8'));
  return lock(plan,async()=>{
    assertNoManualHandoff(plan.roots.execution);
    for(const entry of plan.files){
      if(fileHash(destination(plan.roots,entry.file))!==entry.afterHash)throw Error('runtime drift prevents rollback: '+entry.file);
      if(entry.beforeHash&&fileHash(safeFile(backup,entry.file))!==entry.beforeHash)throw Error('backup hash mismatch');
    }
    for(const entry of [...plan.files].sort((a,b)=>Number(Boolean(b.beforeHash))-Number(Boolean(a.beforeHash)))){const to=destination(plan.roots,entry.file);
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

export function auditRelease(plan){
  const dependencyDrift=[];
  for(const layer of ['execution','observation']){
    const root=plan.roots[layer],pkg=path.join(root,'package.json'),lock=path.join(root,'package-lock.json');
    if(!fs.existsSync(pkg)||!fs.existsSync(lock))continue;
    const dependencies=JSON.parse(fs.readFileSync(pkg,'utf8')).dependencies??{},packages=JSON.parse(fs.readFileSync(lock,'utf8')).packages??{};
    for(const name of Object.keys(dependencies)){
      const expected=packages['node_modules/'+name]?.version,file=path.join(root,'node_modules',name,'package.json');
      let actual=null;try{actual=JSON.parse(fs.readFileSync(file,'utf8')).version;}catch{}
      if(expected&&actual!==expected)dependencyDrift.push({package:layer+'/'+name,expected,actual});
    }
  }
  return {version:plan.version,revision:plan.revision,sourceTree:plan.sourceTree??null,artifactHash:plan.artifactHash??null,
    files:plan.files.length,drift:plan.files.filter(entry=>fileHash(destination(plan.roots,entry.file))!==entry.afterHash).map(entry=>entry.file),dependencyDrift};
}
