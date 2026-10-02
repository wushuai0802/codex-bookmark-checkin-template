import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {runNativePtGate} from '../src/native-pt-gate.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
try{
  const args=process.argv.slice(2),options={root};
  for(let i=0;i<args.length;i+=2){
    const name={'--origin':'origin','--url':'url','--profile':'profile','--phase':'phase','--attempt':'attemptId','--action':'action','--status':'status','--evidence64':'evidence','--main-profile':'mainProfile'}[args[i]];
    if(!name||args[i+1]===undefined||Object.hasOwn(options,name))throw Error('invalid native gate argument');
    options[name]=name==='evidence'?JSON.parse(Buffer.from(args[i+1],'base64').toString('utf8')):name==='mainProfile'?args[i+1]==='true':args[i+1];
  }
  console.log(JSON.stringify(await runNativePtGate(options)));
}catch{
  console.log(JSON.stringify({managed:true,allow:false,decision:{status:'deferred',retryCause:'native_readback_unavailable',
    submissionAttempted:false,nativeGate:true,reason:'原生签到提交前校验不可用，已停止写操作'}}));process.exitCode=2;
}
