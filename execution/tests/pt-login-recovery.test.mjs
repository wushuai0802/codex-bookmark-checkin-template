import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import {recoverPtLogin} from '../src/pt-login-recovery.mjs';

const origin='https://hhanclub.net',root=path.resolve('synthetic-pt-root'),profile=path.join(root,'data/profile'),PRIVATE='NEVER_RETURN_RAW';
function fixture(){
  let calls=0,releaseCount=0,current=true;
  const args={root,origin,profile,config:{powershellExecutable:'pwsh.exe',savedLoginUrls:{[origin]:origin+'/login.php'},
    siteTwoFactorRecovery:{[origin]:{enabled:true,reviewed:true,provider:'bitwarden',adapterId:'hhclub-nexus-login-v1'}}},
    scope:async options=>{assert.equal(options.profile,profile);return {assertCurrent:async()=>current,release:async()=>{releaseCount++;}};},
    execute:async(shell,args,options)=>{
      calls++;assert.equal(shell,'pwsh.exe');assert.equal(options.windowsHide,true);assert.equal(options.env.BW_SESSION,undefined);
      assert.equal(args[args.indexOf('-LoginUrl')+1],origin+'/login.php');assert.equal(args[args.indexOf('-UserDataDirOverride')+1],profile);
      return {stdout:JSON.stringify({status:'logged_in',title:PRIVATE,finalUrl:PRIVATE,
        siteTwoFactorRecovery:{attempted:true,accepted:true,reason:'authentication_accepted',code:PRIVATE}}),stderr:PRIVATE};
    }};
  return {args,setCurrent:value=>{current=value;},get calls(){return calls;},get releases(){return releaseCount;}};
}
const safe=value=>assert.doesNotMatch(JSON.stringify(value),/NEVER_RETURN_RAW|code|stdout|stderr|title|finalUrl|password|session|itemId/);

test('PT login invokes the original native helper once with the original exact profile then projects only proof metadata',async()=>{
  const f=fixture(),result=await recoverPtLogin(f.args);
  assert.equal(result.status,'logged_in');assert.equal(result.siteTwoFactorRecovery.accepted,true);
  assert.equal(f.calls,1);assert.equal(f.releases,1);safe(result);
});

test('paused or absent opt-in scopes do not launch a login helper',async()=>{
  for(const issue of ['origin','disabled','unreviewed','adapter','scope','current','loginurl','shell']){
    const f=fixture();
    if(issue==='origin')f.args.origin='https://piggo.me';
    if(issue==='disabled')f.args.config.siteTwoFactorRecovery[origin].enabled=false;
    if(issue==='unreviewed')f.args.config.siteTwoFactorRecovery[origin].reviewed=false;
    if(issue==='adapter')f.args.config.siteTwoFactorRecovery[origin].adapterId='another';
    if(issue==='scope')f.args.scope=async()=>null;
    if(issue==='current')f.setCurrent(false);
    if(issue==='loginurl')f.args.config.savedLoginUrls[origin]='https://other.example/login.php';
    if(issue==='shell')f.args.config.powershellExecutable='cmd.exe';
    const result=await recoverPtLogin(f.args);assert.equal(f.calls,0);safe(result);
  }
});

test('a failed, requested2FA, malformed or unknown helper is not called again or promoted to success',async()=>{
  for(const issue of ['requested2fa','unknown','badmeta','barelogin','throw','scopechange']){
    const f=fixture();let calls=0;
    f.args.execute=async()=>{
      calls++;
      if(issue==='throw')throw Object.assign(Error(PRIVATE),{stdout:'partial '+PRIVATE,stderr:PRIVATE});
      if(issue==='scopechange')f.setCurrent(false);
      return {stdout:JSON.stringify(issue==='barelogin'?{status:'logged_in',secret:PRIVATE}:
        {status:issue==='requested2fa'?'needs_attention':'logged_in',failureCode:'two_factor_required',raw:PRIVATE,
          siteTwoFactorRecovery:{attempted:true,accepted:issue==='badmeta'?'true':false,
            reason:issue==='unknown'?'authentication_unknown':'daily_recovery_limit',raw:PRIVATE}}),stderr:PRIVATE};
    };
    const result=await recoverPtLogin(f.args);assert.equal(calls,1);assert.equal(result.status,'needs_attention');safe(result);
  }
});

test('known already-authenticated/signed proof is accepted without claiming a TOTP request',async()=>{
  const f=fixture();f.args.execute=async()=>({stdout:JSON.stringify({status:'logged_in',
    siteTwoFactorRecovery:{attempted:false,accepted:false,reason:'already_signed'}})});
  const result=await recoverPtLogin(f.args);assert.equal(result.status,'logged_in');assert.equal(result.siteTwoFactorRecovery.attempted,false);safe(result);
});

test('the mature native wrapper stops HHCLUB after handled 2FA failure or unreadable outcome',()=>{
  const source=fs.readFileSync(new URL('../scripts/Recover-NativeLogin.ps1',import.meta.url),'utf8');
  assert.match(source,/\$nativeLoginOutput = @\(& \$node[^\n]+\$profilePath\)/);
  assert.match(source,/\$factorHandled[^\n]+two_factor_required[^\n]+\$null -eq \$nativeLoginResult\) \{ break \}/);
  assert.doesNotMatch(source,/BW_SESSION|two_step_code|totp/);
});
