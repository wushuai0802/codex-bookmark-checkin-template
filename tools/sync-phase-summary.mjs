import fs from 'node:fs';
import readline from 'node:readline';
import {pathToFileURL} from 'node:url';

const causes='none|connection_timeout|connection_interrupted|authentication_failed|host_key_verification_failed|name_resolution_failed|remote_storage_full|ssh_transport_failed|remote_command_failed|executable_missing|input_missing';
const pattern=new RegExp(`^(\\d{4})-(\\d{2})-(\\d{2}) (\\d{2}):(\\d{2}):(\\d{2}) (Status sync phase|Shadow phase): name=(export|status_preflight|status_upload|status_install|cleanup|dashboard_status_sync|nas_snapshot_preflight|nas_snapshot_upload|nas_snapshot_extract|nas_commit|nas_snapshot_cleanup) attempt=([1-9][0-9]*) ms=([0-9]+) exit=(-?[0-9]+) timedOut=(True|False) cause=(${causes})$`);

export function parseSyncPhaseLine(line){
  const match=pattern.exec(line.replace(/^\uFEFF/,''));
  if(!match)return null;
  const [,year,month,day,hour,minute,second,family,name,attempt,ms,exit,timedOut,cause]=match;
  // shadow-sync.log uses the Windows machine's local wall clock, with no offset.
  const at=new Date(+year,+month-1,+day,+hour,+minute,+second);
  if(at.getFullYear()!==+year||at.getMonth()!==+month-1||at.getDate()!==+day||at.getHours()!==+hour||at.getMinutes()!==+minute||at.getSeconds()!==+second)return null;
  if(![attempt,ms,exit].every(value=>Number.isSafeInteger(Number(value))))return null;
  if((family==='Status sync phase')!==!name.startsWith('nas_'))return null;
  return {at,family,name,attempt:+attempt,ms:+ms,exit:+exit,timedOut:timedOut==='True',cause};
}

export async function summarizeSyncPhases(lines,{days=7,now=new Date()}={}){
  if(!Number.isSafeInteger(days)||days<1||!Number.isFinite(now.getTime()))throw new Error('Invalid summary window');
  const since=now.getTime()-days*86400000,groups=new Map();
  for await(const line of lines){
    const record=parseSyncPhaseLine(line);
    if(!record||record.at.getTime()<since||record.at>now)continue;
    const key=`${record.family}/${record.name}`;
    if(!groups.has(key))groups.set(key,{family:record.family,name:record.name,failures:0,durations:[]});
    const group=groups.get(key);
    group.durations.push(record.ms);
    if(record.exit!==0||record.timedOut)group.failures++;
  }
  return [...groups.values()].sort((a,b)=>`${a.family}/${a.name}`.localeCompare(`${b.family}/${b.name}`)).map(({durations,...group})=>{
    durations.sort((a,b)=>a-b);
    const middle=Math.floor(durations.length/2);
    return {...group,count:durations.length,medianMs:durations.length%2?durations[middle]:(durations[middle-1]+durations[middle])/2,maxMs:durations.at(-1)};
  });
}

async function main(args){
  if(args.length===1&&args[0]==='--help'){
    console.log('Usage: node tools/sync-phase-summary.mjs --log <shadow-sync.log> [--days 7]\nRead-only; timestamps use this machine\'s local time. Counts include each retry attempt; incomplete/old-format lines are ignored.');
    return;
  }
  let log='',days=7;
  for(let index=0;index<args.length;index++){
    if(args[index]==='--log'&&args[index+1])log=args[++index];
    else if(args[index]==='--days'&&args[index+1])days=Number(args[++index]);
    else throw new Error('Invalid arguments');
  }
  if(!log||!Number.isSafeInteger(days)||days<1)throw new Error('Invalid arguments');
  const stream=fs.createReadStream(log,{encoding:'utf8'});
  const lines=readline.createInterface({input:stream,crlfDelay:Infinity});
  try { console.log(JSON.stringify({days,phases:await summarizeSyncPhases(lines,{days})},null,2)); }
  finally { lines.close();stream.destroy(); }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  main(process.argv.slice(2)).catch(()=>{console.error('Could not summarize sync phases; check arguments and the local log file.');process.exitCode=1;});
}
