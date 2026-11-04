import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath,pathToFileURL} from 'node:url';

const execute=promisify(execFile),execution=fileURLToPath(new URL('../../',import.meta.url));

// Run the actual scheduler entrypoint on synthetic files. Only the browser
// launcher and helper process boundary are replaced; neither can reach a site.
export async function runOfflinePiggoIndex(f,helperResult,{preflightChange={},otherOrigin,hangHelper=false}={}){
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
  if(hangHelper)fs.writeFileSync(path.join(root,'tmp/hanging-helper.mjs'),`import fs from 'node:fs';import {spawn} from 'node:child_process';
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});
fs.writeFileSync(new URL('./helper-pids.json',import.meta.url),JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000);`);
  const hooks=path.join(root,'tmp/offline-index-hooks.mjs');
  fs.writeFileSync(hooks,`import fs from 'node:fs';
import path from 'node:path';
import childProcess from 'node:child_process';
import {promisify} from 'node:util';
import {registerHooks,syncBuiltinESMExports} from 'node:module';
const root=${JSON.stringify(root)},at=${JSON.stringify(f.clock().getTime())},NativeDate=Date,hangHelper=${JSON.stringify(hangHelper)};
globalThis.Date=class extends NativeDate{constructor(...args){super(...(args.length?args:[at]));}static now(){return at;}};
const original=childProcess.execFile,originalAsync=promisify(original);
const fake=(...args)=>{throw Error('Unexpected direct process execution');};
fake[promisify.custom]=(file,args,options)=>{
 if(args.some(value=>/Recover-(?:NativeLogin|ProtectedLogin)\\.ps1$/.test(value))){
  fs.appendFileSync(path.join(root,'tmp/helper-calls.jsonl'),JSON.stringify({file,args,timeout:options.timeout})+'\\n');
  if(hangHelper)return originalAsync(process.execPath,[path.join(root,'tmp/hanging-helper.mjs')],options);
  return Promise.resolve({stdout:fs.readFileSync(path.join(root,'tmp/synthetic-helper-result.json'),'utf8'),stderr:''});
 }
 if(file==='taskkill.exe'&&hangHelper){
  const pids=JSON.parse(fs.readFileSync(path.join(root,'tmp/helper-pids.json')));
  if(args.join(' ')!=='/PID '+pids[0]+' /T /F')throw Error('Unexpected tree kill target');
  fs.writeFileSync(path.join(root,'tmp/tree-kill.json'),JSON.stringify(args));
  for(const pid of pids.reverse())process.kill(pid,'SIGKILL');
  return Promise.resolve({stdout:'',stderr:''});
 }
 if(args.some(value=>value.includes('Win32_Process')))return originalAsync(file,args,options);
 throw Error('Unexpected process execution');
};
childProcess.execFile=fake;syncBuiltinESMExports();
const browserUrl=new URL('../src/browser.mjs',import.meta.url).href;
registerHooks({load(url,context,next){
 if(hangHelper&&url===new URL('../src/login-helper-process.mjs',import.meta.url).href){
  const source=fs.readFileSync(new URL(url),'utf8');
  if(!source.includes('?300000:180000'))throw Error('Timeout seam changed');
  return {format:'module',shortCircuit:true,source:source.replace('?300000:180000','?1500:180000')};
 }
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
  finally{
    const pids=path.join(root,'tmp/helper-pids.json');
    if(hangHelper&&fs.existsSync(pids))for(const pid of JSON.parse(fs.readFileSync(pids)))try{process.kill(pid,'SIGKILL');}catch{}
  }
  assert.ok(fs.existsSync(path.join(root,'logs/latest.json')),output.stderr+output.stdout);
  const report=JSON.parse(fs.readFileSync(path.join(root,'logs/latest.json'),'utf8'));
  const callsFile=path.join(root,'tmp/helper-calls.jsonl');
  const calls=fs.existsSync(callsFile)?fs.readFileSync(callsFile,'utf8').trim().split('\n').map(JSON.parse):[];
  return {...output,report,calls};
}
