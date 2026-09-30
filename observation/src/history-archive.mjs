import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const journal=/^(engine-daily|pt-fallback-results|pt-verifications|harvest-fallback-attempts)-(\d{4}-\d{2}-\d{2})\.(json|jsonl)$/;
function directory(value){const root=path.resolve(value);if(root===path.parse(root).root||fs.lstatSync(root).isSymbolicLink())throw Error('history root must be an ordinary project directory');return root;}
function ordinary(file){if(fs.lstatSync(file).isSymbolicLink()||!fs.statSync(file).isFile())throw Error('history item must be an ordinary file');}
export function planHistoryArchive(dataDir,before,{now=new Date()}={}){
  const root=directory(dataDir),month=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(now).slice(0,7);
  if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(before??'')||before>month)throw Error('archive cutoff must not include the current business month');
  const files=[],retained=[];
  for(const name of fs.readdirSync(root)){
    const match=journal.exec(name);if(!match||match[2].slice(0,7)>=before)continue;
    const file=path.join(root,name);ordinary(file);const bytes=fs.readFileSync(file);
    if(match[1]==='harvest-fallback-attempts'){
      const state=JSON.parse(bytes);if(!Array.isArray(state.attempts))throw Error('invalid attempt journal');
      const unsafe=state.attempts.some(a=>!['completed','deferred_busy','deferred_preflight'].includes(a.state)||
        a.outcome?.submissionOutcomeUnknown===true||a.outcome?.failureCode==='submission_outcome_unknown'||
        a.state==='completed'&&!['signed','already_signed','not_available'].includes(a.v1Status));
      if(unsafe){retained.push(name);continue;}
    }
    files.push({name,sha256:hash(bytes),bytes:bytes.length});
  }
  const months={};
  const ledger=path.join(root,'shadow-ledger.jsonl');
  if(fs.existsSync(ledger)){ordinary(ledger);for(const line of fs.readFileSync(ledger,'utf8').split(/\r?\n/).filter(Boolean)){
    const row=JSON.parse(line),date=row.businessDate;if(!/^\d{4}-\d{2}-\d{2}$/.test(date??'')||date.slice(0,7)>=before)continue;
    (months[date.slice(0,7)]??=[]).push(row);
  }}
  return {schemaVersion:1,dataDir:root,before,files,retained,months};
}
function moveVerified(from,to,sha256){ordinary(from);if(hash(fs.readFileSync(from))!==sha256)throw Error('history changed before archive');
  fs.mkdirSync(path.dirname(to),{recursive:true});if(fs.existsSync(to))throw Error('archive destination already exists');
  try{fs.renameSync(from,to);}catch(error){if(error.code!=='EXDEV')throw error;fs.copyFileSync(from,to);
    if(hash(fs.readFileSync(to))!==sha256)throw Error('archive copy mismatch');fs.unlinkSync(from);}}
export function applyHistoryArchive(plan,archiveRoot){
  directory(plan.dataDir);
  for(const item of plan.files){if(!journal.test(item.name)||hash(fs.readFileSync(path.join(plan.dataDir,item.name)))!==item.sha256)throw Error('archive plan drift');}
  const destination=path.join(path.resolve(archiveRoot),new Date().toISOString().replaceAll(':','-')+'-'+crypto.randomUUID());
  fs.mkdirSync(destination,{recursive:true});
  const monthly=[];
  for(const [month,records] of Object.entries(plan.months)){
    const name='ledger-'+month+'.jsonl',bytes=records.map(r=>JSON.stringify(r)).join('\n')+'\n';
    fs.writeFileSync(path.join(destination,name),bytes,{mode:0o600});monthly.push({name,sha256:hash(bytes),records:records.length});
  }
  const manifest={schemaVersion:1,dataDir:plan.dataDir,before:plan.before,createdAt:new Date().toISOString(),moved:plan.files,monthly,retained:plan.retained};
  fs.writeFileSync(path.join(destination,'archive-index.json'),JSON.stringify(manifest,null,2),{mode:0o600});
  for(const item of plan.files)moveVerified(path.join(plan.dataDir,item.name),path.join(destination,item.name),item.sha256);
  return {directory:destination,moved:plan.files.length,monthly:monthly.length,retainedUnresolved:plan.retained.length,activeLedgerChanged:false};
}
export function verifyHistoryArchive(archive){
  const root=directory(archive),manifest=JSON.parse(fs.readFileSync(path.join(root,'archive-index.json'),'utf8'));
  for(const item of [...manifest.moved,...manifest.monthly]){
    if(!journal.test(item.name)&&!/^ledger-\d{4}-\d{2}\.jsonl$/.test(item.name))throw Error('invalid archived filename');
    const file=path.join(root,item.name);ordinary(file);if(hash(fs.readFileSync(file))!==item.sha256)throw Error('archive integrity failure');
  }
  return manifest;
}
export function restoreHistoryArchive(archive,dataDir){
  const root=directory(dataDir),manifest=verifyHistoryArchive(archive);
  if(root!==manifest.dataDir)throw Error('restore target differs from the original project');
  for(const item of manifest.moved)if(fs.existsSync(path.join(root,item.name))&&hash(fs.readFileSync(path.join(root,item.name)))!==item.sha256)throw Error('restore would overwrite an existing journal');
  for(const item of manifest.moved)if(!fs.existsSync(path.join(root,item.name)))fs.copyFileSync(path.join(archive,item.name),path.join(root,item.name),fs.constants.COPYFILE_EXCL);
  return {restored:manifest.moved.length,activeLedgerChanged:false};
}
