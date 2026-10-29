import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const executeFile = promisify(execFile);
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const piggoOrigin = 'https://piggo.me';
export const bitwardenTotpSiteContracts = Object.freeze({
  [piggoOrigin]: Object.freeze({itemName:'piggo.me',adapterId:'piggo-nexus-stepup-v1'}),
  'https://www.hddolby.com': Object.freeze({itemName:'www.hddolby.com',adapterId:'hddolby-nexus-stepup-v1'}),
  'https://www.uhddolby.com': Object.freeze({itemName:'www.hddolby.com',adapterId:'hddolby-nexus-stepup-v1'}),
  'https://hhanclub.net': Object.freeze({itemName:'hhanclub.net',adapterId:'hhclub-nexus-login-v1'}),
});
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const piggoMinimumValidityMs = 6_000;
const additionalAdapterMinimumValidityMs = 12_000;
const fail = reason => ({ready:false,reason});
const reasons = new Set(['disabled','origin_not_allowed','profile_mismatch','invalid_configuration',
  'runtime_unavailable','entrypoint_unavailable','session_missing','session_invalid','session_unavailable',
  'provider_busy','server_mismatch','vault_locked','vault_unauthenticated','vault_state_invalid',
  'cli_status_failed','cli_status_invalid','vault_sync_failed','totp_read_failed','totp_invalid',
  'totp_near_rotation','clock_invalid','clock_unstable','totp_wait_failed','totp_consumer_failed',
  'helper_failed','helper_output_invalid','prepared','totp_ready','totp_consumed',
  'login_not_allowed','login_read_failed','login_invalid','login_ready','login_consumed']);

function clearInheritedVaultSecrets() {
  for (const key of Object.keys(process.env)) {
    if (/^BW_/i.test(key) || /^(?:PIGGO_BW_|BITWARDENCLI_APPDATA_DIR$)/i.test(key)) delete process.env[key];
  }
}

function childEnvironment() {
  const env = {...process.env};
  for (const key of Object.keys(env)) {
    if (/^BW_/i.test(key) || /^(?:PIGGO_BW_|BITWARDENCLI_APPDATA_DIR$|NODE_OPTIONS$|NODE_PATH$)/i.test(key)) delete env[key];
  }
  return env;
}

function absolute(value) {
  return typeof value === 'string' && value.length > 0 && !/[\u0000-\u001f]/.test(value)
    && (process.platform === 'win32' ? /^[A-Za-z]:[\\/]/.test(value) : path.isAbsolute(value));
}

function contained(directory, value) {
  if (!absolute(value)) return null;
  const resolved = path.resolve(value), relative = path.relative(directory, resolved);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) return null;
  for (let current=resolved;;current=path.dirname(current)) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) return null;
    if (current === path.dirname(current)) return resolved;
  }
}

function gitCheckout(directory) {
  for (let current=directory;;current=path.dirname(current)) {
    if (fs.existsSync(path.join(current,'.git'))) return true;
    if (current === path.dirname(current)) return false;
  }
}

function canonicalServer(value) {
  if (typeof value !== 'string' || value !== value.trim() || /[?#\\]/.test(value)) return null;
  try {
    const url=new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && url.hostname
      && url.pathname === '/' ? url.origin : null;
  } catch { return null; }
}

/** Static opt-in and route validation. This function never reads a vault/session. */
export function bitwardenTotpConfiguration(config={},root,origin,binding) {
  try {
    const raw=config.bitwardenTotp;
    if (raw?.enabled !== true) return fail('disabled');
    const contract=Object.hasOwn(bitwardenTotpSiteContracts,origin) ? bitwardenTotpSiteContracts[origin] : null;
    if (!contract) return fail('origin_not_allowed');
    const route=raw.routes?.[origin], profileBinding=typeof binding === 'string' ? binding : binding?.profileBinding;
    if (route?.enabled !== true) return fail('disabled');
    // Schema-1 PigGo consumers may still pass their historical hash binding.
    // Every additional adapter must identify its exact account and protocol.
    const legacy=origin === piggoOrigin;
    const accountKey=binding && typeof binding === 'object' ? binding.accountKey : legacy ? 'site-default' : null;
    const adapterId=binding && typeof binding === 'object' ? binding.adapterId ?? (legacy ? contract.adapterId : null)
      : legacy ? contract.adapterId : null;
    if (!/^[a-f0-9]{64}$/.test(profileBinding??'') || route.profileBinding !== profileBinding
      || accountKey !== 'site-default' || adapterId !== contract.adapterId
      || (route.accountKey ?? (legacy ? 'site-default' : null)) !== accountKey
      || (route.adapterId ?? (legacy ? contract.adapterId : null)) !== adapterId) return fail('profile_mismatch');
    if (!absolute(root)) return fail('invalid_configuration');
    root=path.resolve(root);
    if (root === path.parse(root).root || gitCheckout(root)) return fail('invalid_configuration');
    const protectedRoot=path.join(root,'data','bitwarden'), toolRoot=path.join(root,'tools','bitwarden-cli');
    const cliEntryPoint=contained(toolRoot,raw.cliEntryPoint), appDataDir=contained(protectedRoot,raw.appDataDir),
      sessionFile=contained(protectedRoot,raw.sessionFile), serverUrl=canonicalServer(raw.serverUrl);
    const periodSeconds=raw.periodSeconds??30;
    const shell=config.powershellExecutable||'pwsh.exe';
    if (!cliEntryPoint || !/\.js$/i.test(cliEntryPoint) || !appDataDir || !sessionFile
      || !/\.(?:dpapi|json)$/i.test(sessionFile) || !serverUrl || serverUrl === origin || route.itemName !== contract.itemName
      || !uuid.test(route.itemId??'')
      || periodSeconds !== 30 || typeof shell !== 'string'
      || !/^(?:pwsh|powershell)(?:\.exe)?$/i.test(path.basename(shell))) return fail('invalid_configuration');
    return {ready:true,reason:'configured',root,origin,accountKey,adapterId,profileBinding,serverUrl,itemId:route.itemId,cliEntryPoint,
      appDataDir,sessionFile,periodSeconds,shell,
      minimumValidityMs:legacy ? piggoMinimumValidityMs : additionalAdapterMinimumValidityMs};
  } catch { return fail('invalid_configuration'); }
}

function loadConfiguration(root,config) {
  if (config !== undefined) return config;
  if (!absolute(root)) return null;
  try { return JSON.parse(fs.readFileSync(path.join(root,'config','config.json'),'utf8')); }
  catch { return null; }
}

async function helper(policy,mode,execute) {
  let output, value;
  try {
    output=await execute(policy.shell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',
      path.join(policy.root,'scripts','Get-BitwardenTotp.ps1'),'-Root',policy.root,'-Origin',policy.origin,
      '-ProfileBinding',policy.profileBinding,'-AccountKey',policy.accountKey,'-AdapterId',policy.adapterId,'-Mode',mode],{encoding:'utf8',windowsHide:true,
      env:childEnvironment(),timeout:mode === 'Prepare' ? 120_000 : 60_000,maxBuffer:65_536});
    if (typeof output?.stdout !== 'string' || output.stdout.length > (mode==='Login'?16_384:4_096)) return fail('helper_output_invalid');
    value=JSON.parse(output.stdout.trim().replace(/^\uFEFF/,''));
    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.ready !== 'boolean'
      || !reasons.has(value.reason)) return fail('helper_output_invalid');
    if (!value.ready) return fail(value.reason);
    if(mode==='Login'){
      if(value.reason!=='login_ready'||typeof value.username!=='string'||!value.username||value.username.length>320||
        /[\x00-\x1f]/.test(value.username)||typeof value.password!=='string'||!value.password||value.password.length>1024)return fail('login_invalid');
      return {ready:true,reason:'login_ready',username:value.username,password:value.password};
    }
    if (mode === 'Prepare') {
      if (value.reason !== 'prepared' || Object.keys(value).some(key=>!['ready','reason'].includes(key))) return fail('helper_output_invalid');
      return {ready:true,reason:'prepared'};
    }
    if (value.reason !== 'totp_ready' || typeof value.code !== 'string' || !/^\d{6}$/.test(value.code)
      || !Number.isSafeInteger(value.validUntilMs)) return fail('totp_invalid');
    // Return the ephemeral code only to this module's private caller.
    return {ready:true,reason:'totp_ready',code:value.code,validUntilMs:value.validUntilMs};
  } catch { return fail('helper_failed'); }
  finally {
    if (output) { output.stdout=''; output.stderr=''; }
    if (value && typeof value === 'object') value.code='';
    if(value&&typeof value==='object'){value.username='';value.password='';}
  }
}

/** Prepare encrypted cache once per day; never request an item or a TOTP here. */
export async function prepareBitwardenTotp({root,origin,binding,config,execute=executeFile}={}) {
  clearInheritedVaultSecrets();
  const loaded=loadConfiguration(root,config);
  if (!loaded || typeof execute !== 'function') return fail('invalid_configuration');
  const policy=bitwardenTotpConfiguration(loaded,root,origin,binding);
  return policy.ready ? helper(policy,'Prepare',execute) : policy;
}

/** Selected login fields stay within a bound consumer; never return them to a caller or logger. */
export async function withBitwardenLogin({root,origin,binding,config,consume,execute=executeFile}={}){
  clearInheritedVaultSecrets();
  const loaded=loadConfiguration(root,config),opt=loaded?.siteTwoFactorRecovery?.[origin];
  if(origin!=='https://www.uhddolby.com'||opt?.enabled!==true||opt.reviewed!==true||opt.allowPasswordLogin!==true||
    opt.loginSource!=='bitwarden'||typeof consume!=='function')return fail('login_not_allowed');
  const policy=bitwardenTotpConfiguration(loaded,root,origin,binding);if(!policy.ready)return policy;
  const result=await helper(policy,'Login',execute);
  if(!result.ready)return result;
  const credential={username:result.username,password:result.password};
  try{await consume(credential);return {ready:true,reason:'login_consumed'};}
  catch{return fail('login_invalid');}
  finally{
    credential.username='';
    credential.password='';
    result.username='';
    result.password='';
  }
}

function timeWindow(clock,periodMs) {
  try {
    const current=clock(), now=current instanceof Date ? current.getTime() : current;
    if (!Number.isSafeInteger(now) || now<0) return null;
    const validUntilMs=(Math.floor(now/periodMs)+1)*periodMs;
    return {now,validUntilMs,remainingMs:validUntilMs-now};
  } catch { return null; }
}

/**
 * Deliver this route's six-digit TOTP to a scoped consumer in memory. Callback
 * return values and all exceptions are discarded. Readiness is not login proof.
 * There is at most one boundary recovery; no indefinite retry or stored code.
 */
export async function withBitwardenTotp({root,origin,binding,config,consume,
  execute=executeFile,clock=Date.now,sleep=wait}={}) {
  clearInheritedVaultSecrets();
  const loaded=loadConfiguration(root,config);
  if (!loaded || typeof execute !== 'function' || typeof consume !== 'function'
    || typeof clock !== 'function' || typeof sleep !== 'function') return fail('invalid_configuration');
  const policy=bitwardenTotpConfiguration(loaded,root,origin,binding);
  if (!policy.ready) return policy;
  const periodMs=policy.periodSeconds*1_000;
  const minimumValidityMs=policy.minimumValidityMs;
  let recoveryUsed=false, reads=0;
  const waitNext=async window=>{
    try { await sleep(window.remainingMs+250); return true; } catch { return false; }
  };
  while (reads<2) {
    const before=timeWindow(clock,periodMs);
    if (!before) return fail('clock_invalid');
    if (before.remainingMs<=minimumValidityMs) {
      if (recoveryUsed) return fail('totp_near_rotation');
      recoveryUsed=true;
      if (!await waitNext(before)) return fail('totp_wait_failed');
      continue;
    }
    reads++;
    const result=await helper(policy,'Get',execute);
    let code=result.code??'';
    result.code='';
    try {
      const after=timeWindow(clock,periodMs);
      if (!after) return fail('clock_invalid');
      if (after.now<before.now) return fail('clock_unstable');
      if (!result.ready && result.reason !== 'totp_near_rotation') return fail(result.reason);
      if (!result.ready || before.validUntilMs !== after.validUntilMs
        || result.validUntilMs !== after.validUntilMs || after.remainingMs<=minimumValidityMs) {
        if (recoveryUsed || reads>=2) return fail('totp_near_rotation');
        recoveryUsed=true;
        if (after.remainingMs<=minimumValidityMs && !await waitNext(after)) return fail('totp_wait_failed');
        continue;
      }
      try { await consume(code,{validUntilMs:result.validUntilMs}); }
      catch { return fail('totp_consumer_failed'); }
      return {ready:true,reason:'totp_consumed'};
    } finally { code=''; }
  }
  return fail('totp_near_rotation');
}
