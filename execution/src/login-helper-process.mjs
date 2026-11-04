import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const executeFile=promisify(execFile);

export async function killLoginHelperTree(pid,{execute=executeFile,platform=process.platform}={}){
  if(!Number.isSafeInteger(pid)||pid<=0)throw Error('Helper PID unavailable');
  if(platform==='win32')await execute('taskkill.exe',['/PID',String(pid),'/T','/F'],{windowsHide:true,timeout:10000});
  else try{process.kill(-pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}
}

// Keep the parent alive until tree termination starts: execFile's built-in
// timeout kills only that parent and loses the Windows descendant relationship.
export async function execLoginHelper(file,args,options={},
  {execute=executeFile,killTree=killLoginHelperTree,platform=process.platform}={}){
  const {timeout=180000,...rest}=options;
  const pending=execute(file,args,{...rest,timeout:0,...(platform!=='win32'?{detached:true}:{})});
  let timer,timedOut=false,output={};
  const completion=Promise.resolve(pending).then(value=>{output=value;return value;},error=>{output=error;throw error;});
  const expiry=new Promise((resolve,reject)=>{
    timer=setTimeout(()=>{
      timedOut=true;
      Promise.resolve().then(()=>killTree(pending.child?.pid)).then(()=>rejectTimeout(),()=>rejectTimeout());
      function rejectTimeout(){
        const error=Object.assign(Error('Login helper timed out'),{code:'ETIMEDOUT',
          stdout:output.stdout??'',stderr:output.stderr??''});
        reject(error);
      }
    },timeout);
  });
  // During tree termination the child may close first; still wait for the kill
  // command and report a timeout, never a partial logged_in result.
  try{return await Promise.race([completion.then(value=>timedOut?expiry:value,error=>{
    if(timedOut)return expiry;throw error;
  }),expiry]);}
  finally{clearTimeout(timer);}
}

export function loginHelperTimeout(origin){return origin==='https://piggo.me'?300000:180000;}
