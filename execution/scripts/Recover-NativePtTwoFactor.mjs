import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {recoverNativePtTwoFactor} from '../src/native-pt-two-factor.mjs';
import {asciiNativePtReadReceipt} from '../src/native-pt-read.mjs';

// Parent holds the controller lease and V1 wrapper mutex. This helper borrows
// that lease, acquires only the V1 run lock, and returns one bounded receipt.
const defaultRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
try{
  const args=process.argv.slice(2);
  if(args.length!==0&&(args.length!==2||args[0]!=='--root'||!path.isAbsolute(args[1])))throw Error('arguments');
  let input='',bytes=0;
  for await(const chunk of process.stdin){bytes+=chunk.length;if(bytes>16_384)throw Error('input size');input+=chunk;}
  const value=JSON.parse(input.replace(/^\uFEFF/,''));
  if(!value||typeof value!=='object'||Array.isArray(value)||
    Object.keys(value).some(key=>!['origin','expectedProfileBinding','nativeDiagnostic'].includes(key)))throw Error('input');
  console.log(asciiNativePtReadReceipt(await recoverNativePtTwoFactor({...value,root:args[1]??defaultRoot})));
}catch{
  console.log(asciiNativePtReadReceipt({nativeTwoFactorRecovery:{attempted:false,accepted:false,reason:'configuration_invalid'}}));
  process.exitCode=2;
}
