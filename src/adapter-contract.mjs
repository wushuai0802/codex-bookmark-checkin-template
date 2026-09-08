const phases=new Set(['planned','identity_verified','status_read','prepared','submitting','verifying','succeeded','already_done','not_available','submission_unknown','blocked']);
const capabilities=new Set(['identity','read_status','submit_once','verify','classify_error']);
const errors=new Set(['auth_expired','identity_mismatch','rate_limited','unreachable','challenge_required','feature_disabled','invalid_response','submission_unknown','timeout','unknown']);
function text(value,name,max=120){if(typeof value!=='string'||!value.trim()||value.length>max||/[\r\n]/.test(value))throw Error(`${name} invalid`);return value.trim();}
export function defineAdapter(input={}){
 const id=text(input.id,'adapter.id',80);if(!/^[a-z0-9][a-z0-9._-]+\.v\d+$/.test(id))throw Error('adapter.id invalid');
 const origin=new URL(text(input.origin,'adapter.origin',255));if(origin.protocol!=='https:'||origin.username||origin.password||origin.pathname!=='/')throw Error('adapter.origin invalid');
 const declared=[...(input.capabilities??[])];if(!declared.length||declared.some(cap=>!capabilities.has(cap))||new Set(declared).size!==declared.length)throw Error('adapter capabilities invalid');
 if(!declared.includes('identity')||!declared.includes('read_status')||!declared.includes('classify_error'))throw Error('adapter must prove identity, status and error classification');
 const methods=Object.fromEntries([...capabilities].map(cap=>[cap,input[cap]]));if(Object.entries(methods).some(([cap,fn])=>declared.includes(cap)&&typeof fn!=='function'))throw Error(`adapter method missing: ${cap}`);
 return Object.freeze({id,origin:origin.origin,capabilities:declared,mutating:declared.includes('submit_once'),methods});
}
export function adapterManifest(adapter){return {schemaVersion:1,id:adapter.id,origin:adapter.origin,capabilities:[...adapter.capabilities],mutating:adapter.mutating,phase:'v2-clean-adapter'};}
export function classifyAdapterError(error){const value=String(error?.code??error?.name??error?.message??'').toLowerCase();for(const item of errors)if(value.includes(item))return item;return 'unknown';}
export function validateObservation(adapter,observation={}){
 if(!adapter||observation.adapterId!==adapter.id)throw Error('observation adapter binding invalid');
 const phase=String(observation.phase??'');if(!phases.has(phase))throw Error('observation phase invalid');
 if(observation.mutationCount!==0)throw Error('read-only observation performed mutation');
 if(phase==='succeeded'&&!observation.evidence?.authoritative)throw Error('success observation requires authoritative evidence');
 if(phase==='identity_verified'&&(!observation.identity?.userId||observation.identity.origin!==adapter.origin))throw Error('identity observation invalid');
 return {schemaVersion:1,adapterId:adapter.id,origin:adapter.origin,phase,identity:observation.identity??null,evidence:observation.evidence??null,mutationCount:0,observedAt:observation.observedAt??null};
}
