import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
const execute=promisify(execFile),read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const marker=root=>path.join(root,'data/pt-worker-lifecycle.json');
const canonical=value=>path.resolve(value).toLowerCase();
const pending=()=>Object.assign(Error('PT worker cleanup is pending; execution remains blocked'),{code:'PT_CLEANUP_PENDING'});
async function boundedCleanup(cleanup,record,timeoutMs){
  let timer;
  try{return await Promise.race([Promise.resolve().then(()=>cleanup(record)).catch(()=>false),
    new Promise(resolve=>{timer=setTimeout(()=>resolve(false),timeoutMs);})]);}
  finally{clearTimeout(timer);}
}
function save(file,value){fs.mkdirSync(path.dirname(file),{recursive:true});const temporary=file+'.'+crypto.randomUUID()+'.tmp';
  try{fs.writeFileSync(temporary,JSON.stringify(value),{mode:0o600,flag:'wx'});fs.renameSync(temporary,file);}
  finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}}

export async function ptWorkerScope({legacyRoot,origin,readOnly}){
  const config=read(path.join(legacyRoot,'config/config.json')),plan=read(path.join(legacyRoot,'data/last-valid-bookmark-plan.json'));
  const targets=(plan.targets??[]).filter(target=>target.origin===origin);if(targets.length>1)throw Error('PT worker account is ambiguous');
  const target={origin,accountKey:targets[0]?.accountKey??'site-default'};
  const {ptExecutionBinding,ptReadPolicy}=await import(pathToFileURL(path.join(legacyRoot,'src/pt-read-policy.mjs')).href);
  const {nativePtReadBinding}=await import(pathToFileURL(path.join(legacyRoot,'src/native-pt-read.mjs')).href);
  const policy=readOnly?ptReadPolicy(origin,config):null;
  const native=readOnly&&(policy.nativeMainChrome||policy.nativeIsolatedChrome);
  const binding=native?nativePtReadBinding(config,target,{root:legacyRoot,isolated:policy.nativeIsolatedChrome===true}):ptExecutionBinding(config,legacyRoot,target);
  return {profileBinding:binding.profileBinding,privateProfile:native&&policy.nativeMainChrome?null:binding.profile,
    shell:config.powershellExecutable||'pwsh.exe'};
}

export async function cleanupPtWorker(record,{executeFile=execute}={}){
  if(process.platform!=='win32')return false;
  if(record.workerPid!==null&&(!Number.isSafeInteger(record.workerPid)||record.workerPid<0)||
    !Number.isSafeInteger(record.observerPid)||record.observerPid<=0||!/^[a-f0-9-]{36}$/.test(record.ownerId??'')||
    !Number.isFinite(Date.parse(record.startedAt??''))||!path.isAbsolute(record.legacyRoot??''))return false;
  const shell=record.shell||'pwsh.exe';if(!/^(?:pwsh|powershell)(?:\.exe)?$/i.test(path.basename(shell)))return false;
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^BW_|^PIGGO_BW_|^BITWARDENCLI_APPDATA_DIR$|^NODE_OPTIONS$|^NODE_PATH$/i.test(key)));
  try{
    const {stdout}=await executeFile(shell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',
      path.join(record.legacyRoot,'scripts/Cleanup-PtWorker.ps1'),'-WorkerProcessId',String(record.workerPid??0),
      '-ObserverProcessId',String(record.observerPid),'-OwnerId',record.ownerId,'-StartedAt',record.startedAt,
      '-RuntimeRoot',record.legacyRoot,...(record.privateProfile?['-PrivateProfile',record.privateProfile]:[])],
    {windowsHide:true,encoding:'utf8',timeout:20_000,maxBuffer:4096,env});
    const value=JSON.parse(stdout.trim().replace(/^\uFEFF/,''));return value.completed===true;
  }catch{return false;}
}

export async function reconcilePtWorker(root,{legacyRoot,cleanup=cleanupPtWorker,cleanupTimeoutMs=25_000}={}){
  const file=marker(root);if(!fs.existsSync(file))return;
  let value;try{value=read(file);}catch{throw pending();}
  if(!value||value.schemaVersion!==1||typeof value.legacyRoot!=='string'||legacyRoot&&canonical(value.legacyRoot)!==canonical(legacyRoot)||
    !await boundedCleanup(cleanup,value,cleanupTimeoutMs))throw pending();
  if(read(file).ownerId!==value.ownerId)throw pending();fs.unlinkSync(file);
}

/** A durable barrier covers both timeout cleanup and an interrupted controller. */
export function beginPtWorker(root,record){
  const file=marker(root);if(fs.existsSync(file))throw pending();
  const value={schemaVersion:1,...record,observerPid:process.pid,workerPid:null};save(file,value);
  return {record:value,started(pid){value.workerPid=pid;save(file,value);},
    async finish(){
      for(const delay of [0,50,100,200,400]){
        if(delay)await new Promise(resolve=>setTimeout(resolve,delay));
        if(!fs.existsSync(file))return;
        if(read(file).ownerId!==value.ownerId)throw pending();
        try{fs.unlinkSync(file);return;}catch(error){if(!['EPERM','EACCES','EBUSY'].includes(error.code))throw error;}
      }
      throw pending();
    },
    async cleanup(clean=cleanupPtWorker,timeoutMs=25_000){value.state='cleanup_pending';try{save(file,value);}catch{/* The initial durable record still blocks a replacement. */}
      return boundedCleanup(clean,value,timeoutMs);}};
}

export function ptCleanupPendingError(){return pending();}
