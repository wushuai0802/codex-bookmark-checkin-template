// Opt-in diagnostics only. No config/vault/Profile files, credentials or submits.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {piggoOrigin,installPiggoCalendarFirewall,readPiggoAccountIdInContext} from '../src/piggo-calendar.mjs';
import {inspectPiggoSpaLogin} from '../src/piggo-login-form.mjs';

const usage=`Default: help only; nothing is opened.
Anonymous fresh-profile comparison (plugin assets blocked, then allowed):
  node scripts/Diagnose-Piggo.mjs --run-anonymous-login [--proxy <http://loopback:port>] [--runtime-root <dependency-root>]
Candidate ID from an already manually authenticated dedicated Chrome CDP session:
  node scripts/Diagnose-Piggo.mjs --run-account-id --cdp-url <http://127.0.0.1:port> [--runtime-root <dependency-root>]
Account mode prints only a numeric candidate ID to stdout, never a receipt or configuration.
Confirm that candidate independently before manually setting oauthExpectedAccountIds.
Do not point account mode at a shared or concurrently executing browser.`;

export function diagnosticOptions(args){
  const result={};
  for(let index=0;index<args.length;index++){
    const arg=args[index];
    if(arg==='--help')return {help:true};
    if(['--run-anonymous-login','--run-account-id'].includes(arg)){
      if(result.mode)throw Error('invalid_options');result.mode=arg.slice(6);continue;
    }
    const key={'--proxy':'proxy','--cdp-url':'cdpUrl','--runtime-root':'runtimeRoot'}[arg];
    if(!key||result[key]||!args[index+1]||args[index+1].startsWith('--'))throw Error('invalid_options');
    result[key]=args[++index];
  }
  if(!result.mode){if(args.length)throw Error('invalid_options');return {help:true};}
  const localUrl=value=>{
    const url=new URL(value);
    if(url.protocol!=='http:'||!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||!url.port||
      url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw Error('invalid_options');
    return url.origin;
  };
  if(result.mode==='account-id'){
    if(!result.cdpUrl||result.proxy)throw Error('invalid_options');result.cdpUrl=localUrl(result.cdpUrl);
  }else{
    if(result.cdpUrl)throw Error('invalid_options');if(result.proxy)result.proxy=localUrl(result.proxy);
  }
  return result;
}

const describeRequest=request=>{
  try{const url=new URL(request.url());return {method:request.method(),
    path:(url.origin===piggoOrigin?'':url.hostname)+url.pathname.slice(0,512),queryPresent:!!url.search};}
  catch{return {method:'unknown',path:'unavailable',queryPresent:false};}
};

export async function runPiggoDiagnostic(args,{chromium,stdout=process.stdout,stderr=process.stderr}={}){
  let options;
  try{options=diagnosticOptions(args);}catch{stderr.write('invalid_options\n');return 2;}
  if(options.help){stdout.write(usage+'\n');return 0;}
  try{
    if(!chromium){
      const require=options.runtimeRoot?createRequire(pathToFileURL(path.resolve(options.runtimeRoot,'package.json'))):createRequire(import.meta.url);
      ({chromium}=require('playwright-core'));
    }
    if(options.mode==='account-id'){
      // Connect only; this mode never launches Chrome or selects a Profile.
      const browser=await chromium.connectOverCDP(options.cdpUrl,{timeout:15000});
      try{
        const contexts=browser.contexts();
        if(contexts.length!==1)throw Error('account_id_unavailable');
        const id=await readPiggoAccountIdInContext(contexts[0]);
        if(!id)throw Error('account_id_unavailable');
        stdout.write(id+'\n');return 0;
      }finally{await browser.close();} // Disconnect this CDP client.
    }
    const reports=[];
    for(const allowPluginAssets of [false,true]){
      const temporaryParent=path.resolve(os.tmpdir());
      const profile=fs.mkdtempSync(path.join(temporaryParent,'piggo-anonymous-'));
      const relative=path.relative(temporaryParent,path.resolve(profile));
      if(!relative||relative.startsWith('..')||path.isAbsolute(relative))throw Error('temporary_path_rejected');
      let context;
      const report={allowPluginAssets,navigationCompleted:false,requests:[],failed:[],formContract:null};
      try{
        context=await chromium.launchPersistentContext(profile,{channel:'chrome',headless:true,serviceWorkers:'block',
          ignoreHTTPSErrors:false,viewport:{width:1280,height:800},...(options.proxy?{proxy:{server:options.proxy}}:{})});
        context.on('request',request=>report.requests.push(describeRequest(request)));
        context.on('requestfailed',request=>report.failed.push(describeRequest(request)));
        await installPiggoCalendarFirewall(context,{allowPluginAssets});
        const page=await context.newPage();
        try{
          await page.goto(piggoOrigin+'/login',{waitUntil:'domcontentloaded',timeout:30000});
          report.navigationCompleted=true;
          await page.waitForFunction(()=>document.querySelectorAll('form').length>0,undefined,{timeout:15000});
          await page.waitForTimeout(1500);
        }catch{/* Fixed booleans only; navigation errors may contain private URLs. */}
        report.formContract=await inspectPiggoSpaLogin(page).catch(()=>null);
      }finally{
        try{await context?.close();}finally{fs.rmSync(profile,{recursive:true,force:true,maxRetries:3});}
      }
      reports.push(report);
    }
    stdout.write(JSON.stringify({anonymous:true,reports},null,2)+'\n');return 0;
  }catch{stderr.write(options.mode==='account-id'?'piggo_account_id_unavailable\n':'piggo_anonymous_diagnostic_failed\n');return 1;}
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))
  process.exitCode=await runPiggoDiagnostic(process.argv.slice(2));
