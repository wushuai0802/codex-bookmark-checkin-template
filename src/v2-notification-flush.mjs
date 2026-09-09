import fs from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {deliverNotification} from './notification-delivery.mjs';

const exec=promisify(execFile);

function writeJsonAtomic(file,value) {
  const temp=`${file}.${process.pid}.${Date.now()}.tmp`;
  try { fs.writeFileSync(temp,JSON.stringify(value,null,2),'utf8');fs.renameSync(temp,file); }
  catch(error) { try { fs.rmSync(temp,{force:true}); } catch {} throw error; }
}

function due(item,now) {
  const at=Date.parse(String(item?.nextAttemptAt??''));
  return item?.state==='pending'&&Number.isFinite(at)&&at<=now;
}

export async function flushV2Notifications({root=path.resolve('.'),legacyRoot,now=new Date(),sendCommand=exec}={}) {
  if(!legacyRoot)throw Error('legacyRoot is required');
  const config=JSON.parse(fs.readFileSync(path.join(legacyRoot,'config','config.json'),'utf8')).notification;
  const outputDir=path.join(path.resolve(root),'outputs');
  if(!fs.existsSync(outputDir))return {processed:0,delivered:0,pending:0,invalid:0};
  const files=fs.readdirSync(outputDir).filter(name=>/^notification-notice_[a-f0-9]+\.json$/.test(name)).slice(-100);
  let processed=0,delivered=0,pending=0,invalid=0;
  for(const file of files){
    const full=path.join(outputDir,file);let item;
    try { item=JSON.parse(fs.readFileSync(full,'utf8')); }
    catch { invalid++;continue; }
    if(item?.state!=='pending')continue;
    if(!due(item,now.getTime())){pending++;continue;}
    processed++;
    const result=await deliverNotification(item,{now:now.toISOString(),send:async(payload)=>{
      if(config?.mode!=='command'||!config.executable)throw Error('sender_unavailable');
      await sendCommand(config.executable,['checkin-report','--task-id','fabric_v2_canary','--name','V2 Canary 验收','--source','browser-fabric-v2','--status',payload.status,'--event-key',item.dedupeKey,'--summary',payload.summary,'--occurred-at',payload.observedAt],{windowsHide:true,timeout:60000,maxBuffer:65536});
    }});
    writeJsonAtomic(full,result);
    if(result.state==='delivered')delivered++;else pending++;
  }
  return {processed,delivered,pending,invalid};
}
