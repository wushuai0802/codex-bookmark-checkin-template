import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {validateSiteTwoFactorScope} from './two-factor-scope.mjs';
import {parseLoginHelperResult} from './login-recovery.mjs';

const executeFile=promisify(execFile),ORIGIN='https://hhanclub.net',ADAPTER='hhclub-nexus-login-v1';
const adapters={[ORIGIN]:ADAPTER,'https://www.uhddolby.com':'hddolby-nexus-stepup-v1'};
const reasons=new Set(['already_signed','already_authenticated','authentication_accepted','authentication_unknown',
  'authentication_rejected','account_mismatch','configuration_invalid','scope_unavailable','login_not_ready',
  'authentication_busy','recovery_state_invalid','daily_recovery_limit','business_day_changed','totp_expired',
  'totp_invalid','otp_field_not_ready','provider_unavailable','recovery_unavailable',
  'provider_disabled','provider_profile_mismatch','provider_session_missing','provider_session_invalid',
  'provider_session_unavailable','provider_provider_busy','provider_vault_locked','provider_vault_unauthenticated',
  'provider_vault_sync_failed','provider_totp_read_failed','provider_totp_invalid','provider_totp_near_rotation',
  'provider_clock_invalid','provider_clock_unstable','provider_helper_failed','provider_helper_output_invalid']);
const failed=reason=>({handled:true,status:'needs_attention',failureCode:reason});
const cleanEnvironment=()=>Object.fromEntries(Object.entries(process.env).filter(([key])=>
  !/^BW_|^PIGGO_BW_|^BITWARDENCLI_APPDATA_DIR$|^NODE_OPTIONS$|^NODE_PATH$/i.test(key)));

/** Called only after the mother's PT browser context has closed. No check-in here. */
export async function recoverPtLogin({root,origin,config,profile,scope=validateSiteTwoFactorScope,execute=executeFile}={}){
  const adapterId=adapters[origin];if(!adapterId)return {handled:false};
  const opt=config?.siteTwoFactorRecovery?.[origin];
  if(opt?.enabled!==true||opt.reviewed!==true||opt.provider!=='bitwarden'||opt.adapterId!==adapterId||
    origin!==ORIGIN&&opt.allowPasswordLogin!==true)return {handled:false};
  let guard,output;
  try{
    if(!path.isAbsolute(root??'')||!path.isAbsolute(profile??''))return failed('configuration_mismatch');
    const shell=config.powershellExecutable||'pwsh.exe',loginUrl=config.savedLoginUrls?.[origin];
    if(typeof shell!=='string'||!/^(?:pwsh|powershell)(?:\.exe)?$/i.test(path.basename(shell))||
      loginUrl!==origin+'/login.php')return failed('configuration_mismatch');
    guard=await scope({root,origin,config,profile,adapterId});
    if(!guard||!await guard.assertCurrent())return failed('configuration_mismatch');
    const args=['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',
      path.join(root,'scripts/Recover-NativeLogin.ps1'),'-Origin',origin,'-LoginUrl',loginUrl,'-UserDataDirOverride',profile];
    // A helper rejection/timeout is never a reason to call the helper again.
    try{output=await execute(shell,args,{encoding:'utf8',windowsHide:true,timeout:180_000,maxBuffer:65_536,env:cleanEnvironment()});}
    catch(error){output={stdout:typeof error?.stdout==='string'?error.stdout:'',stderr:''};}
    if(!await guard.assertCurrent())return failed('configuration_mismatch');
    if(typeof output?.stdout!=='string'||output.stdout.length>65_536)return failed('native_readback_unavailable');
    const value=parseLoginHelperResult(output.stdout),meta=value?.siteTwoFactorRecovery;
    if(!meta||typeof meta.attempted!=='boolean'||typeof meta.accepted!=='boolean'||!reasons.has(meta.reason))return failed('native_readback_unavailable');
    const projected={attempted:meta.attempted,accepted:meta.accepted,reason:meta.reason};
    const proven=value.status==='logged_in'&&(
      meta.attempted===true&&meta.accepted===true&&meta.reason==='authentication_accepted'||
      meta.attempted===false&&meta.accepted===false&&['already_signed','already_authenticated'].includes(meta.reason));
    return {handled:true,status:proven?'logged_in':'needs_attention',...(!proven?{failureCode:'two_factor_required'}:{}),
      siteTwoFactorRecovery:projected};
  }catch{return failed('native_readback_unavailable');}
  finally{
    if(output){output.stdout='';output.stderr='';}
    if(guard)try{await guard.release();}catch{}
  }
}
