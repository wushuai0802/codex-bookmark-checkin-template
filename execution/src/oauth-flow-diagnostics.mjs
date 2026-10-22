import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';

export const oauthStageLabels=Object.freeze({browser_start:'启动浏览器',browser_ready:'浏览器就绪',target_login:'目标站登录',
  provider_login:'上游账号登录',authorization:'等待授权',callback_wait:'等待回调',identity_verify:'核对账号',
  result_verify:'核对当日结果',logout:'确认退出',complete:'登录恢复完成'});
const stages=new Set(Object.keys(oauthStageLabels));
const marker='checkin_oauth_progress';
const validId=value=>/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value??'');

export function readOAuthProgress(text){
  let latest=null;
  for(const line of String(text??'').slice(-64000).split(/\r?\n/).slice(-128)){
    try{
      const value=JSON.parse(line);
      if(value.type!==marker||!stages.has(value.oauthStage)||!validId(value.flowId)||
        !Number.isFinite(value.elapsedMs)||value.elapsedMs<0||value.elapsedMs>600000)continue;
      latest={oauthStage:value.oauthStage,oauthFlowId:value.flowId,oauthElapsedMs:Math.round(value.elapsedMs)};
    }catch{/* Arbitrary stderr and page data cannot enter a diagnostic. */}
  }
  return latest;
}

export function createOAuthTrace({root,origin,flow='browser',provider,clock=Date.now,
  writeProgress=line=>process.stderr.write(line),io=fs}={}){
  const flowId=randomUUID(),started=clock(),siteRef=createHash('sha256').update(String(origin)).digest('hex').slice(0,16);
  let current='browser_start',events=0,last='';
  const emit=(stage,flags={})=>{
    if(!stages.has(stage)||events>=64)return;
    let at;try{at=Number(clock());}catch{return;}
    if(!Number.isFinite(at))return;
    const safe={type:marker,flowId,siteRef,flow:flow==='native'?'native':'browser',
      provider:['LinuxDO','GitHub','Google'].includes(provider)?provider:'other',oauthStage:stage,
      elapsedMs:Math.max(0,Math.min(600000,Math.round(at-started))),
      ...(typeof flags.failed==='boolean'?{failed:flags.failed}:{}),
      ...(typeof flags.callbackObserved==='boolean'?{callbackObserved:flags.callbackObserved}:{})};
    const signature=stage+'|'+String(safe.failed)+'|'+String(safe.callbackObserved);
    if(last===signature)return;last=signature;current=stage;events++;
    const line=JSON.stringify(safe)+'\n';
    try{writeProgress(line);}catch{/* Diagnostics never change login behavior. */}
    try{
      const directory=path.join(root,'logs');io.mkdirSync(directory,{recursive:true});
      const date=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date(at));
      const file=path.join(directory,`oauth-stage-diagnostics-${date}.jsonl`);
      const existing=io.existsSync(file)?io.lstatSync(file):null;
      if((!existing||existing.isFile()&&!existing.isSymbolicLink())&&
         (existing?.size??0)+Buffer.byteLength(line,'utf8')<=1024*1024)
        io.appendFileSync(file,line,{encoding:'utf8',mode:0o600});
      if(events===1&&typeof io.readdirSync==='function')for(const name of io.readdirSync(directory)){
        const match=/^oauth-stage-diagnostics-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name);
        if(!match||Date.parse(match[1]+'T00:00:00Z')>=at-14*86400000)continue;
        const old=path.join(directory,name),stat=io.lstatSync(old);
        if(stat.isFile()&&!stat.isSymbolicLink())io.unlinkSync(old);
      }
    }catch{/* The stderr checkpoint remains usable when disk logging is unavailable. */}
  };
  return {emit,finish:success=>emit(success?'complete':current,{failed:!success}),flowId};
}
