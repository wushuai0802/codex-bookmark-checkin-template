import fs from 'node:fs';
import path from 'node:path';

function writeJsonAtomic(file,value){const temp=`${file}.${process.pid}.${Date.now()}.tmp`;try{fs.writeFileSync(temp,JSON.stringify(value,null,2),'utf8');fs.renameSync(temp,file);}catch(error){try{fs.rmSync(temp,{force:true});}catch{}throw error;}}

export function promoteMigrationAfterVerifiedSubmission({root=path.resolve('.'),accountKey,origin,completedAt,stage,mutationCount,handoffPending=false,provenance='v2_automated_submission'}={}){
  if(stage!=='succeeded'||mutationCount!==1||handoffPending===true)throw Error('verified V2 submission is required');
  if(!/^[A-Za-z0-9._-]{1,80}$/.test(String(accountKey??'')))throw Error('migration account key is invalid');
  const normalizedOrigin=new URL(String(origin)).origin,timestamp=new Date(completedAt);
  if(!Number.isFinite(timestamp.getTime()))throw Error('migration completion time is invalid');
  const file=path.join(root,'outputs',`migration-${accountKey}.json`),migration=JSON.parse(fs.readFileSync(file,'utf8'));
  if(migration?.accountKey!==accountKey||new URL(String(migration?.origin)).origin!==normalizedOrigin||!['candidate','active'].includes(migration.state))throw Error('migration record is mismatched');
  const at=timestamp.toISOString(),updated={...migration,state:'active',v1Fallback:{enabled:false,owner:'v2-worker'},ownership:{...(migration.ownership??{}),current:'v2-worker',next:'v2-worker',switchedAt:migration.ownership?.switchedAt??at},preconditions:{...(migration.preconditions??{}),v1TaskMustBeDrained:false,firstMutationNotPerformed:false},lastSuccessAt:at,lastSuccessProvenance:String(provenance).slice(0,80)};
  writeJsonAtomic(file,updated);return {file,state:'active',accountKey,owner:'v2-worker',lastSuccessAt:at};
}
