import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function processIsAlive(pid) {
  if(!Number.isSafeInteger(pid)||pid<=0)return null;
  try { process.kill(pid,0); return true; }
  catch(error) { if(error?.code==='ESRCH')return false; return true; }
}

function lockFile(root) { return path.join(path.resolve(root),'data','v2-run.lock'); }

export function acquireExecutionLock(root) {
  const file=lockFile(root);fs.mkdirSync(path.dirname(file),{recursive:true});
  const owner={schemaVersion:1,pid:process.pid,startedAt:new Date(Date.now()-Math.round(process.uptime()*1000)).toISOString(),nonce:crypto.randomUUID()};
  for(let attempt=0;attempt<2;attempt++){
    let created=false,handle=null;
    try { handle=fs.openSync(file,'wx',0o600);created=true;fs.writeFileSync(handle,`${JSON.stringify(owner)}\n`,'utf8');fs.closeSync(handle);handle=null;return {file,owner}; }
    catch(error) {
      try { if(handle!==null)fs.closeSync(handle); } catch {}
      if(created){try{fs.rmSync(file,{force:true});}catch{};throw error;}
      if(error?.code!=='EEXIST')throw error;
      let current;
      try { current=JSON.parse(fs.readFileSync(file,'utf8')); }
      catch {
        const stat=fs.statSync(file,{throwIfNoEntry:false});
        if(stat&&Date.now()-stat.mtimeMs>5_000){fs.rmSync(file,{force:true});continue;}
        throw Error('V2 runner lock is unreadable');
      }
      const alive=processIsAlive(Number(current?.pid));
      if(alive!==false)throw Error('V2 runner is already active');
      fs.rmSync(file,{force:true});
    }
  }
  throw Error('V2 runner lock could not be acquired');
}

export function releaseExecutionLock(lease) {
  if(!lease?.file||!lease.owner?.nonce)return false;
  let current;
  try { current=JSON.parse(fs.readFileSync(lease.file,'utf8')); } catch { return false; }
  if(current?.nonce!==lease.owner.nonce)return false;
  try { fs.rmSync(lease.file,{force:true});return true; } catch { return false; }
}
