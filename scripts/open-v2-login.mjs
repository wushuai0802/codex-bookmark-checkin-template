#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadRuntimeConfig} from '../src/runtime-config.mjs';
import {dedicatedLoginPlan,launchDedicatedLogin,validateLoginFiles} from '../src/dedicated-login.mjs';

// Resolve against the script, not the terminal's working directory.
const root=fileURLToPath(new URL('../',import.meta.url));
try {
  const args=process.argv.slice(2),accountKey=args[0];
  if(args.length!==2||!['--check','--visible'].includes(args[1]))throw Error('Usage: node scripts/open-v2-login.mjs ACCOUNT --check|--visible');
  const runtime=loadRuntimeConfig(root);
  const registry=JSON.parse(fs.readFileSync(path.join(root,'outputs/v2-profile-registry.json'),'utf8'));
  const plan=dedicatedLoginPlan({root,registry,accountKey,executablePath:runtime.chromeExecutable,visible:true});
  validateLoginFiles(plan,root);
  if(args[1]==='--check')console.log(JSON.stringify({accountKey,origin:plan.origin,expectedIdentity:plan.expectedIdentity,profileBound:true,mode:'check_only',launched:false}));
  else {
    console.log(`Dedicated login: ${accountKey}; expected site ID ${plan.expectedIdentity}. Close this dedicated browser after login. Other V2 execution is locked until it closes.`);
    await launchDedicatedLogin({root,plan,onStarted:({pid})=>console.log(`Chrome process started: ${pid}. Window visibility and account identity still require verification.`)});
    console.log('Dedicated Chrome exited; execution lock released. Login identity has NOT yet been verified.');
  }
}catch(error){console.error(`Dedicated login: ${error.message}`);process.exitCode=1;}
