import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {inspectNativePtHeader,nativePtReadFailure,asciiNativePtReadReceipt} from '../src/native-pt-read.mjs';

// ASCII JSON survives Windows PowerShell's native-console decoding boundary.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
try{
  const args=process.argv.slice(2),options={root};
  for(let index=0;index<args.length;index+=2){
    const name={'--origin':'origin','--url':'url','--isolated':'isolated'}[args[index]];
    if(!name||args[index+1]===undefined||Object.hasOwn(options,name))throw Error('invalid read argument');
    if(name==='isolated'&&!['true','false'].includes(args[index+1]))throw Error('invalid native read route');
    options[name]=name==='isolated'?args[index+1]==='true':args[index+1];
  }
  console.log(asciiNativePtReadReceipt(await inspectNativePtHeader(options)));
}catch(error){console.log(asciiNativePtReadReceipt(nativePtReadFailure(error)));process.exitCode=2;}
