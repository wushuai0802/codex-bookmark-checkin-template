import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {freshProfilePath} from './v2-profile-registry.mjs';
import {acquireExecutionLock,releaseExecutionLock} from './execution-lock.mjs';

// Only launches a registered site's native browser for user-assisted login.
// No CDP, credentials, session copying, site mutation or ownership transition.
export function dedicatedLoginPlan({root,registry,accountKey,executablePath,visible=false}={}) {
  if(visible!==true)throw Error('visible login requires explicit --visible');
  if(!/^[A-Za-z0-9._-]{1,80}$/.test(String(accountKey??'')))throw Error('account key is invalid');
  if(!root||!path.isAbsolute(root))throw Error('absolute V2 root is required');
  const matches=registry?.profiles?.filter(profile=>profile.accountKey===accountKey)??[];
  if(matches.length!==1)throw Error('exactly one registered account is required');
  const profile=matches[0];
  if(!['pending_login','ready'].includes(profile.state))throw Error('profile state is not eligible for login');
  if(!/^\d{1,20}$/.test(String(profile.expectedIdentity??'')))throw Error('expected identity is required');
  const expected=freshProfilePath({v2Root:root,accountKey,origin:profile.origin});
  if(!profile.profileDir||path.resolve(profile.profileDir)!==expected)throw Error('profile path does not match registered account and site');
  if(!executablePath||!path.isAbsolute(executablePath)||!/^chrome(?:\.exe)?$/i.test(path.basename(executablePath)))throw Error('configured Chrome executable is required');
  return {accountKey,origin:profile.origin,expectedIdentity:String(profile.expectedIdentity),profileDir:expected,executablePath,
    args:[`--user-data-dir=${expected}`,'--new-window','--no-first-run','--no-default-browser-check','--window-position=100,80','--window-size=1200,850',profile.origin]};
}

export function validateLoginFiles(plan,root) {
  if(!fs.statSync(plan.executablePath).isFile())throw Error('Chrome executable is missing');
  const physicalRoot=fs.realpathSync(root);
  const expected=path.resolve(physicalRoot,path.relative(root,plan.profileDir));
  if(!fs.statSync(plan.profileDir).isDirectory()||fs.realpathSync(plan.profileDir)!==expected)throw Error('profile directory missing or redirected outside its registered path');
}

export async function launchDedicatedLogin({root,plan,spawnBrowser=spawn,onStarted=()=>{},validateFiles=validateLoginFiles}={}) {
  validateFiles(plan,root);
  const lease=acquireExecutionLock(root);
  try {
    await new Promise((resolve,reject)=>{
      let child;
      try {child=spawnBrowser(plan.executablePath,plan.args,{shell:false,windowsHide:false,stdio:'ignore'});}catch(error){reject(error);return;}
      child.once('error',reject);
      child.once('spawn',()=>{try{onStarted({pid:child.pid,accountKey:plan.accountKey,expectedIdentity:plan.expectedIdentity});}catch(error){reject(error);}});
      child.once('exit',(code,signal)=>code===0?resolve():reject(Error(`dedicated Chrome exited: ${signal??code}`)));
    });
  } finally {releaseExecutionLock(lease);}
}
