import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {acquireExecutionLock,releaseExecutionLock} from '../src/execution-lock.mjs';
import {executeDashboardOperation} from '../src/dashboard-operation-executor.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),args=process.argv.slice(2),target=args[args.indexOf('--ssh-target')+1];
const container=args.includes('--container')?args[args.indexOf('--container')+1]:'checkin-fabric-dashboard';
if(!args.includes('--ssh-target')||!/^[A-Za-z0-9._@-]{1,120}$/.test(target??'')||!/^[A-Za-z0-9_-]{1,80}$/.test(container))throw Error('provide a safe SSH target and container');
const remote=input=>JSON.parse(execFileSync('ssh',['-o','BatchMode=yes','-o','ConnectTimeout=5',target,
  'docker exec -i '+container+' node /app/src/dashboard-operations-cli.mjs'],{input:JSON.stringify(input),encoding:'utf8',windowsHide:true,timeout:15000,maxBuffer:64000}));
const directory=path.join(root,'data/dashboard-operations');
const save=(file,value)=>{fs.mkdirSync(directory,{recursive:true});const temp=file+'.tmp';try{fs.writeFileSync(temp,JSON.stringify(value),{mode:0o600});fs.renameSync(temp,file);}finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}};
let lease;
try{
  lease=acquireExecutionLock(root,{name:'dashboard-operation-worker.lock'});
  if(fs.existsSync(directory))for(const name of fs.readdirSync(directory).filter(n=>/^op_[a-f0-9]{32}\.json$/.test(n))){
    const file=path.join(directory,name),saved=JSON.parse(fs.readFileSync(file,'utf8'));
    if(saved.published)continue;
    const result=saved.result??{status:'interrupted',message:'执行中断，结果未确认；请先只读核验'};
    remote({mode:'finish',id:saved.request.id,claimToken:saved.request.claimToken,...result});save(file,{...saved,result,published:true});
  }
  const request=remote({mode:'claim'});
  if(request){
    const file=path.join(directory,request.id+'.json');save(file,{request,phase:'running'});
    let result;
    try{result=await executeDashboardOperation(root,request);}
    catch(error){result=/already active|已有一个签到任务|占用/.test(error.message)?
      {status:'queued',message:'执行器或登录窗口正忙，稍后继续',nextEligibleAt:new Date(Date.now()+5*60_000).toISOString()}:
      {status:'blocked',message:'当前执行条件不满足；请刷新状态后先核验，未强制提交'};}
    save(file,{request,result,phase:'finished'});remote({mode:'finish',id:request.id,claimToken:request.claimToken,...result});save(file,{request,result,published:true});
    console.log(JSON.stringify({id:request.id,status:result.status}));
  }else console.log(JSON.stringify({pending:0}));
}catch(error){console.error('Dashboard operations deferred; scheduled check-ins remain independent.');process.exitCode=error.message==='V2 runner is already active'?0:1;}
finally{if(lease)releaseExecutionLock(lease);}
