import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath,pathToFileURL} from 'node:url';

const execute=promisify(execFile),execution=fileURLToPath(new URL('../../',import.meta.url));

// Run the actual scheduler entrypoint on synthetic files. Only the browser
// launcher and helper process boundary are replaced; neither can reach a site.
export async function runOfflinePiggoIndex(f,helperResult,{preflightChange={},otherOrigin}={}){
  const root=f.root,origin=otherOrigin??f.origin;
  fs.cpSync(path.join(execution,'src'),path.join(root,'src'),{recursive:true});
  fs.symlinkSync(path.join(execution,'node_modules'),path.join(root,'node_modules'),'junction');
  const config={...f.config,minimumBookmarkTargetCount:1,mobileFolderIds:['10'],targetFolderNames:['PT'],
    sessionPreflightEnabled:false,recoveryRounds:1,recoveryDelaysMs:[0],logRetentionDays:1};
  if(otherOrigin){
    config.nativeWafPreflightUrls=[{url:origin+'/calendar',automationUserDataDir:f.profile}];
    config.protectedCredentialOrigins=[origin];
    delete config.ptReadOnlyPolicies;delete config.oauthExpectedAccountIds;delete config.nativePtTwoFactorRecovery;
  }
  fs.mkdirSync(path.dirname(config.bookmarksPath),{recursive:true});
  fs.writeFileSync(config.bookmarksPath,JSON.stringify({roots:{other:{type:'folder',name:'fixture',id:'10',children:[
    {type:'folder',name:'PT',id:'11',children:[{type:'url',name:'synthetic',url:origin+'/calendar'}]}]}}}));
  fs.writeFileSync(path.join(root,'config/config.json'),JSON.stringify(config));
  fs.writeFileSync(path.join(root,'config/qa-rules.json'),JSON.stringify({rules:[]}));
  fs.mkdirSync(path.join(root,'controller/src'),{recursive:true});
  fs.writeFileSync(path.join(root,'controller/src/legacy-engine.mjs'),
    `export {validateEngineLease} from ${JSON.stringify(new URL('../../../observation/src/legacy-engine.mjs',import.meta.url).href)};`);
  fs.writeFileSync(path.join(root,'tmp/native-waf-preflight.json'),JSON.stringify({generatedAt:f.clock().toISOString(),results:[
    {origin,url:origin+'/calendar',status:'login_required',inspectionStatus:'login_required',failureCode:'idle_locked',
      nativeGate:true,submissionAttempted:false,profileBinding:f.profileBinding,...preflightChange}]}));
  fs.writeFileSync(path.join(root,'tmp/synthetic-helper-result.json'),JSON.stringify(helperResult));
  const hooks=path.join(root,'tmp/offline-index-hooks.mjs');
  fs.writeFileSync(hooks,`import fs from 'node:fs';
import path from 'node:path';
import childProcess from 'node:child_process';
import {promisify} from 'node:util';
import {registerHooks,syncBuiltinESMExports} from 'node:module';
const root=${JSON.stringify(root)},at=${JSON.stringify(f.clock().getTime())},NativeDate=Date;
globalThis.Date=class extends NativeDate{constructor(...args){super(...(args.length?args:[at]));}static now(){return at;}};
const original=childProcess.execFile,originalAsync=promisify(original);
const fake=(...args)=>{throw Error('Unexpected direct process execution');};
fake[promisify.custom]=async(file,args,options)=>{
 if(args.some(value=>/Recover-(?:NativeLogin|ProtectedLogin)\\.ps1$/.test(value))){
  fs.appendFileSync(path.join(root,'tmp/helper-calls.jsonl'),JSON.stringify({file,args})+'\\n');
  return {stdout:fs.readFileSync(path.join(root,'tmp/synthetic-helper-result.json'),'utf8'),stderr:''};
 }
 if(args.some(value=>value.includes('Win32_Process')))return originalAsync(file,args,options);
 throw Error('Unexpected process execution');
};
childProcess.execFile=fake;syncBuiltinESMExports();
const browserUrl=new URL('../src/browser.mjs',import.meta.url).href;
registerHooks({load(url,context,next){
 if(url===browserUrl){const source=fs.readFileSync(new URL(url),'utf8');
  const start=source.indexOf('export async function launchAutomationContext('),end=source.indexOf('export async function processTarget(',start);
  if(start<0||end<0)throw Error('Offline browser boundary not found');
  return {format:'module',shortCircuit:true,source:source.slice(0,start)+
   'export async function launchAutomationContext(){return {close:async()=>{},newPage:async()=>{throw Error("Offline browser has no pages")}};}\\n'+source.slice(end)};
 }
 return next(url,context);
}});
`);
  let output;
  try{output={code:0,...await execute(process.execPath,['--import',pathToFileURL(hooks).href,path.join(root,'src/index.mjs')],
    {cwd:root,env:process.env,windowsHide:true,timeout:30000,maxBuffer:65536})};}
  catch(error){if(typeof error.code!=='number')throw error;output={code:error.code,stdout:error.stdout,stderr:error.stderr};}
  assert.ok(fs.existsSync(path.join(root,'logs/latest.json')),output.stderr+output.stdout);
  const report=JSON.parse(fs.readFileSync(path.join(root,'logs/latest.json'),'utf8'));
  const callsFile=path.join(root,'tmp/helper-calls.jsonl');
  const calls=fs.existsSync(callsFile)?fs.readFileSync(callsFile,'utf8').trim().split('\n').map(JSON.parse):[];
  return {...output,report,calls};
}
