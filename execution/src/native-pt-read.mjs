import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const runFile=promisify(execFile);
export function nativePtReadBinding(config,target){
  if(target.accountKey!=='site-default')throw Error('Native PT read needs a unique site account');
  const sourceRoot=path.resolve(config.sourceUserDataDir??''),profile=path.dirname(path.resolve(config.bookmarksPath??''));
  const relative=path.relative(sourceRoot,profile);
  if(!/^(Default|Profile [0-9]+)$/.test(relative)||!fs.existsSync(path.join(sourceRoot,'Local State')))
    throw Error('Configured main Chrome profile is unavailable');
  const key=process.platform==='win32'?profile.toLowerCase():profile;
  return {profile,accountKey:target.accountKey,profileBinding:crypto.createHash('sha256').update(key).digest('hex')};
}

export async function inspectNativePtHeader({root,origin,url,execute=runFile}){
  const script=path.join(root,'scripts/Invoke-MainChromeCheckinAccessibility.ps1');
  let stdout;
  try {({stdout}=await execute('pwsh.exe',['-NoProfile','-NonInteractive','-File',script,
    '-Origin',origin,'-Url',url,'-ReadOnly','-TimeoutSeconds','35'],
  {encoding:'utf8',windowsHide:true,timeout:75_000,maxBuffer:200_000}));}
  catch(error){
    if(error.killed)throw Error('Native PT read timed out');
    stdout=error.stdout;
    if(!stdout)throw Error('Native PT read did not return a receipt');
  }
  let value;try{value=JSON.parse(stdout.trim().replace(/^\uFEFF/,''));}catch{throw Error('Native PT read returned invalid JSON');}
  if(value.clicked===true||value.submissionAttempted===true)throw Error('Native PT read attempted a submission');
  const inspected=value.inspection??{};
  const diagnostic={origin,observedAt:new Date().toISOString(),status:value.status,failureCode:value.failureCode??null,
    sameOrigin:inspected.sameOrigin===true,authenticated:inspected.authenticated===true,waf:inspected.waf===true,
    loginRoute:inspected.loginRoute===true,siteBodyLoaded:inspected.siteBodyLoaded===true,
    pageContentAvailable:inspected.pageContentAvailable===true,
    hasDailySignal:Boolean(inspected.successText),hasSignedControl:Boolean(inspected.successControl)};
  try{
    fs.mkdirSync(path.join(root,'logs'),{recursive:true});
    fs.appendFileSync(path.join(root,'logs/native-pt-readback.jsonl'),JSON.stringify(diagnostic)+'\n',{mode:0o600});
  }catch{/* A diagnostic write cannot discard a valid receipt. */}
  return {status:value.status,reason:value.reason,evidence:value.evidence,
    failureCode:value.failureCode,submissionAttempted:false};
}
