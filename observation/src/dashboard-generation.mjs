import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {planHash} from './contracts.mjs';
const name='dashboard-generation.json';
const previousName='dashboard-generation.previous.json';
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');

function atomic(file,value){
  const temporary=file+'.'+crypto.randomUUID()+'.tmp';
  try{fs.writeFileSync(temporary,JSON.stringify(value),{mode:0o600});fs.renameSync(temporary,file);}
  finally{if(fs.existsSync(temporary))fs.rmSync(temporary);}
}
function validate(value,directory,file){
  const snapshot=value?.snapshot,anchor=value?.ledger;
  if(value?.schemaVersion!==1||snapshot?.schemaVersion!==1||snapshot.mode!=='shadow_read_only'||
     !Array.isArray(snapshot.tasks)||snapshot.planHash!==planHash(snapshot.tasks)||
     !Number.isFinite(Date.parse(snapshot.generatedAt))||
     !anchor||!['shadow-ledger.jsonl','ledger.jsonl'].includes(anchor.file)||
     !Number.isSafeInteger(anchor.byteLength)||anchor.byteLength<1||anchor.byteLength>256*1024*1024||
     !/^[a-f0-9]{64}$/.test(anchor.sha256??''))throw Error('invalid generation manifest');
  const ledgerFile=path.join(directory,anchor.file),bytes=fs.readFileSync(ledgerFile);
  if(bytes.length<anchor.byteLength||digest(bytes.subarray(0,anchor.byteLength))!==anchor.sha256)throw Error('generation ledger prefix mismatch');
  const records=bytes.subarray(0,anchor.byteLength).toString('utf8').split(String.fromCharCode(10)).filter(line=>line.trim()).map(line=>JSON.parse(line));
  if(!records.some(record=>record.schemaVersion===1&&record.snapshotId===snapshot.snapshotId&&
    record.businessDate===snapshot.businessDate&&record.planHash===snapshot.planHash&&
    Number.isFinite(Date.parse(record.recordedAt))&&Date.parse(record.recordedAt)<=Date.parse(snapshot.generatedAt)+60_000))
    throw Error('generation has no matching ledger receipt');
  return {current:{file,snapshot},ledger:{file:ledgerFile,records},stale:false};
}

export function commitDashboardGeneration({snapshot,snapshotFile,ledgerFile}){
  const directory=path.dirname(path.resolve(snapshotFile));
  if(directory!==path.dirname(path.resolve(ledgerFile)))return null;
  if(!['shadow-ledger.jsonl','ledger.jsonl'].includes(path.basename(ledgerFile)))return null;
  const bytes=fs.readFileSync(ledgerFile);
  const value={schemaVersion:1,generatedAt:snapshot.generatedAt,snapshot,
    ledger:{file:path.basename(ledgerFile),byteLength:bytes.length,sha256:digest(bytes)},
    inputs:{planHash:snapshot.planHash,ptStatusDigest:digest(JSON.stringify(snapshot.ptStatus??{}))}};
  const destination=path.join(directory,name);
  validate(value,directory,destination);
  if(fs.existsSync(destination)){
    try{const previous=JSON.parse(fs.readFileSync(destination,'utf8'));validate(previous,directory,destination);atomic(path.join(directory,previousName),previous);}
    catch{/* retain an existing valid previous manifest when the current one is damaged */}
  }
  // The manifest is the commit point. It embeds the snapshot and identifies
  // the exact immutable ledger prefix; later ledger appends cannot mix views.
  atomic(destination,value);
  return destination;
}

export function readDashboardGeneration(directory){
  const current=path.join(directory,name),previous=path.join(directory,previousName);
  if(!fs.existsSync(current)&&!fs.existsSync(previous))return null;
  for(const file of [current,previous]){
    try{const result=validate(JSON.parse(fs.readFileSync(file,'utf8')),directory,file);
      return {...result,stale:file!==current};
    }catch{/* use only a complete validated generation */}
  }
  throw Error('no complete published dashboard generation');
}
