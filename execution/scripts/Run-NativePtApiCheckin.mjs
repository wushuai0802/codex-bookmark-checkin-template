import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {runNativePtApiCheckin} from '../src/native-pt-api.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
try{
  const args=process.argv.slice(2),options={root};
  for(let index=0;index<args.length;index+=2){
    const name={'--origin':'origin','--url':'url'}[args[index]];
    if(!name||args[index+1]===undefined||Object.hasOwn(options,name))throw Error('Invalid native API argument');
    options[name]=args[index+1];
  }
  if(!options.origin||!options.url)throw Error('Native API target missing');
  const result=await runNativePtApiCheckin(options);
  console.log(JSON.stringify(result));
  if(!['signed','already_signed'].includes(result.status))process.exitCode=2;
}catch{
  console.log(JSON.stringify({status:'unconfirmed',nativeGate:true,failureCode:'native_readback_unavailable',submissionAttempted:false}));
  process.exitCode=2;
}
