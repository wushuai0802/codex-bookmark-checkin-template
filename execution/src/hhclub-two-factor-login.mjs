import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {validateSiteTwoFactorScope} from './two-factor-scope.mjs';
import {acquireRunLock,releaseRunLock} from './run-lock.mjs';

export const hhclubTwoFactorAdapter='hhclub-nexus-login-v1';
const ORIGIN='https://hhanclub.net',LOGIN=ORIGIN+'/login.php',HOME=ORIGIN+'/index.php';
const UHD='https://www.uhddolby.com';
const loginDefinition=origin=>origin===ORIGIN?{origin,adapterId:hhclubTwoFactorAdapter,otp:'two_step_code',secret:true,journal:'hhclub-authentication'}:
  origin===UHD?{origin,adapterId:'hddolby-nexus-stepup-v1',otp:'2fa',secret:false,journal:'hddolby-password-authentication'}:null;
const inLoginForm=(selector,origin=ORIGIN)=>['takelogin.php','/takelogin.php',origin+'/takelogin.php']
  .map(action=>'form[action="'+action+'"] '+selector).join(', ');
const execute=promisify(execFile);
const day=at=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date(at));
const date=clock=>{const v=new Date(clock());if(!Number.isFinite(v.getTime()))throw Error('clock');return v;};
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const result=(reason,attempted=false,accepted=false,authenticated=accepted)=>({handled:true,status:authenticated?'logged_in':'needs_attention',
  ...(!authenticated?{failureCode:'two_factor_required'}:{}),siteTwoFactorRecovery:{attempted,accepted,reason}});
const providerReasons=new Set(['disabled','profile_mismatch','session_missing','session_invalid','session_unavailable',
  'provider_busy','vault_locked','vault_unauthenticated','vault_sync_failed','totp_read_failed','totp_invalid',
  'totp_near_rotation','clock_invalid','clock_unstable','helper_failed','helper_output_invalid']);
const providerReason=value=>value?.ready===false&&providerReasons.has(value.reason)?'provider_'+value.reason:'provider_unavailable';

/** Only a boolean process/profile proof leaves this native browser check. */
export async function verifyHhclubNativeProfile(profile,port,{executeProcess=execute}={}){
  if(process.platform!=='win32'||!path.isAbsolute(profile??'')||!Number.isSafeInteger(port)||port<=0||port>65535)return false;
  const command="$matches=@(Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" -ErrorAction SilentlyContinue|Where-Object {$line=[string]$_.CommandLine;if([regex]::IsMatch($line,'(?:^|\\s)\"?--type(?:=|\\s|\"|$)')){return $false};$part=[regex]::Match($line,'(?:^|\\s)(?:\"--user-data-dir=([^\"]+)\"|--user-data-dir=\"([^\"]+)\"|--user-data-dir=([^\\s\"]+))');$dir=if($part.Groups[1].Success){$part.Groups[1].Value}elseif($part.Groups[2].Success){$part.Groups[2].Value}else{$part.Groups[3].Value};$portMatch=[regex]::IsMatch($line,'(?:^|\\s)\"?--remote-debugging-port='+[regex]::Escape($env:CHECKIN_HHCLUB_PORT)+'\"?(?:\\s|$)');$dir-and [IO.Path]::GetFullPath($dir).Equals($env:CHECKIN_HHCLUB_PROFILE,[StringComparison]::OrdinalIgnoreCase)-and $portMatch});if($matches.Count-eq 1){'true'}else{'false'}";
  try{
    const {stdout}=await executeProcess(path.join(process.env.SystemRoot??'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoProfile','-NonInteractive','-Command',command],{windowsHide:true,encoding:'utf8',timeout:8000,maxBuffer:2048,
        env:{...process.env,CHECKIN_HHCLUB_PROFILE:path.resolve(profile),CHECKIN_HHCLUB_PORT:String(port)}});
    return stdout.trim()==='true';
  }catch{return false;}
}

export async function inspectHhclubLogin(page,{allowFilledOtp=false,origin=ORIGIN}={}){
  const definition=loginDefinition(origin);
  if(!definition||page.url()!==origin+'/login.php')return null;
  try{
    return await page.evaluate(async({origin,allowFilledOtp,otpName,secretRequired})=>{
      if(location.href!==origin+'/login.php')return null;
      const visible=e=>{const s=getComputedStyle(e),r=e.getBoundingClientRect();return s.display!=='none'&&s.visibility!=='hidden'&&r.width>0&&r.height>0;};
      const forms=[...document.forms].filter(f=>f.method.toUpperCase()==='POST'&&f.action===origin+'/takelogin.php');
      if(forms.length!==1||forms[0].target&&!['_self'].includes(forms[0].target))return null;
      const form=forms[0],field=name=>{const a=[...form.querySelectorAll('input')].filter(e=>e.name===name);return a.length===1?a[0]:null;};
      const username=field('username'),password=field('password'),otp=field(otpName),captcha=field('imagestring'),
        secret=field('secret'),imagehash=field('imagehash');
      if(!username||!password||!otp||!captcha||secretRequired&&!secret||!imagehash||username.type!=='text'||password.type!=='password'||
        !['text','tel','number'].includes(otp.type)||captcha.type!=='text'||secret&&secret.type!=='hidden'||imagehash.type!=='hidden'||
        ![username,password,otp,captcha].every(visible)||[username,password,otp,captcha].some(e=>e.disabled||e.readOnly)||
        form.querySelectorAll('button[type="submit"],input[type="submit"]').length!==1||document.querySelector('base[href]'))return null;
      const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(username.value.normalize('NFKC').trim().toLowerCase()));
      const images=[...form.querySelectorAll('img')].filter(image=>{
        try{
          const url=new URL(image.src,origin);
          return url.protocol==='https:'&&url.origin===origin&&url.pathname==='/image.php'&&!url.username&&!url.password&&!url.hash&&
            [...url.searchParams.keys()].every(key=>(secretRequired?['action','imagehash','secret']:['action','imagehash']).includes(key))&&
            (secretRequired?['action','imagehash','secret']:['action','imagehash']).every(key=>url.searchParams.getAll(key).length===1)&&url.searchParams.get('action')==='regimage'&&
            url.searchParams.get('imagehash')===imagehash.value&&(!secretRequired||url.searchParams.get('secret')===secret.value)&&visible(image);
        }catch{return false;}
      });
      let captchaBinding='';
      if(images.length===1){
        const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(imagehash.value+'\0'+(secret?.value??'')+'\0'+images[0].src));
        captchaBinding=[...new Uint8Array(hash)].map(n=>n.toString(16).padStart(2,'0')).join('');
      }
      return {usernameHash:[...new Uint8Array(bytes)].map(n=>n.toString(16).padStart(2,'0')).join(''),
        passwordFilled:Boolean(password.value),captchaFilled:/^[A-Za-z0-9]{1,16}$/.test(captcha.value.trim()),
        hiddenReady:Boolean((!secretRequired||secret.value)&&imagehash.value),otpReady:allowFilledOtp||!otp.value,
        captchaImageReady:images.length===1,captchaBinding,captchaLength:Number.isSafeInteger(captcha.maxLength)?captcha.maxLength:-1,
        submitReady:![...form.querySelectorAll('button[type="submit"],input[type="submit"]')][0].disabled};
    },{origin,allowFilledOtp,otpName:definition.otp,secretRequired:definition.secret});
  }catch{return null;}
}

/** Prepare one ordinary image CAPTCHA only; no password read, login or TOTP. */
export async function prepareHhclubLoginCaptcha(page,{config={},usernameHash,assertCurrent,inspect=inspectHhclubLogin,origin=ORIGIN,
  recognize,secondOpinion}={}){
  let screenshot,recognition,captchaWritten=false,prepared=false;
  const fail=()=>({prepared:false,reason:'login_not_ready'});
  try{
    if(typeof assertCurrent!=='function'||!await assertCurrent())return fail();
    const before=await inspect(page);
    const credentialsReady=value=>value?.usernameHash===usernameHash&&value.passwordFilled===true&&
      value.hiddenReady===true&&value.otpReady===true&&value.submitReady===true;
    if(!credentialsReady(before))return fail();
    if(before.captchaFilled===true)return {prepared:true,reason:'captcha_already_filled'};
    // The current form omits maxlength. Six glyphs are a conservative local
    // recognizer capability, not an assertion about the site's login policy.
    if(before.captchaImageReady!==true||!/^[a-f0-9]{64}$/.test(before.captchaBinding??'')||
      before.captchaLength>0&&before.captchaLength!==6)return fail();
    const image=page.locator(inLoginForm('img[src*="image.php"]',origin));
    if(await image.count()!==1)return fail();
    const box=await image.boundingBox();
    if(!box||![box.x,box.y,box.width,box.height].every(Number.isFinite)||box.width<20||box.height<10||
      box.width>400||box.height>160||box.width*box.height>50_000)return fail();
    screenshot=await image.screenshot();
    if(!Buffer.isBuffer(screenshot)||!screenshot.length||screenshot.length>1_000_000)return fail();
    if(!recognize)({recognizeNexusCaptcha:recognize}=await import('./captcha-ocr.mjs'));
    if(!secondOpinion)({applyOptionalBaiduSecondOpinion:secondOpinion}=await import('./baidu-ocr.mjs'));
    recognition=await recognize(screenshot);
    const threshold=Math.max(70,Math.min(100,Number(config.baiduOcr?.minimumLocalConfidence)||70));
    if(!/^[A-Z0-9]{6}$/.test(recognition?.code??'')||!Number.isFinite(Number(recognition?.confidence))||Number(recognition.confidence)<threshold)
      recognition=await secondOpinion(screenshot,recognition,{config,origin,length:6,alphabet:'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'});
    if(!/^[A-Z0-9]{6}$/.test(recognition?.code??'')||!Number.isFinite(Number(recognition?.confidence))||
      Number(recognition.confidence)<threshold||Number(recognition.confidence)>100||!await assertCurrent())return fail();
    const fresh=await inspect(page);
    if(!credentialsReady(fresh)||fresh.captchaFilled===true||fresh.captchaImageReady!==true||fresh.captchaBinding!==before.captchaBinding)return fail();
    const input=page.locator(inLoginForm('input[name="imagestring"]',origin));
    if(await input.count()!==1)return fail();
    captchaWritten=true;await input.fill(recognition.code);
    if(await input.evaluate((element,expected)=>element.value===expected,recognition.code)!==true)return fail();
    const filled=await inspect(page);
    if(!await assertCurrent()||!credentialsReady(filled)||filled.captchaFilled!==true||filled.captchaBinding!==before.captchaBinding){
      await input.fill('');return fail();
    }
    prepared=true;return {prepared:true,reason:'captcha_prepared'};
  }catch{return fail();}
  finally{
    if(captchaWritten&&!prepared)try{if(page.url()===origin+'/login.php')await page.locator(inLoginForm('input[name="imagestring"]',origin)).fill('');}catch{}
    if(screenshot)try{screenshot.fill(0);}catch{};
    if(recognition&&typeof recognition==='object')try{recognition.code='';}catch{}
  }
}

export async function readHhclubAuthenticated(page,{expectedAccountId,now=new Date(),origin=ORIGIN}={}){
  try{
    const current=new URL(page.url());
    if(!loginDefinition(origin)||current.origin!==origin||!['/login.php','/takelogin.php','/index.php','/'].includes(current.pathname))return null;
    const html=await page.evaluate(async({origin,nowMs})=>{
      if(location.origin!==origin)return null;
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
      let html;
      try{
        // Use the original Chrome network/session; no cookie copy or alternate
        // API request client that might take a different proxy route.
        const response=await fetch(origin+'/index.php',{method:'GET',credentials:'same-origin',redirect:'manual',
          cache:'no-store',signal:controller.signal});
        const serverAt=Date.parse(response.headers.get('date')??'');
        const dateAt=value=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date(value));
        if(response.url!==origin+'/index.php'||response.status!==200||!Number.isFinite(serverAt)||
          dateAt(serverAt)!==dateAt(nowMs)||Math.abs(serverAt-nowMs)>5*60_000)return null;
        html=await response.text();if(!html||html.length>2_000_000)return null;
      }finally{clearTimeout(timer);}
      return html;
    },{origin,nowMs:now.getTime()});
    if(typeof html!=='string')return null;
    const state=await page.evaluate(parseHhclubProfileDocument,{html,origin,expectedAccountId:String(expectedAccountId)});
    return state?{authenticated:state.authenticated===true,accountMatched:state.accountMatched===true,signed:false}:null;
  }catch{return null;}
}

export async function fillNexusBitwardenCredentials({root,origin,page,profile,config,profileProof=async()=>false,
  scope=validateSiteTwoFactorScope,inspect=inspectHhclubLogin,withLogin,prepare}={}){
  if(origin!==UHD)return {handled:false};
  const definition=loginDefinition(origin),opt=config?.siteTwoFactorRecovery?.[origin];
  if(opt?.enabled!==true||opt.reviewed!==true||opt.allowPasswordLogin!==true||opt.loginSource!=='bitwarden')return {handled:false};
  let guard,filled=false;
  try{
    if(!/^[a-f0-9]{64}$/.test(opt.usernameHash??''))return {handled:true,filled:false,reason:'configuration_invalid'};
    guard=await scope({root,origin,config,profile,adapterId:definition.adapterId});
    if(!guard||!await profileProof())return {handled:true,filled:false,reason:'scope_unavailable'};
    const current=await readHhclubAuthenticated(page,{origin,expectedAccountId:String(opt.expectedAccountId)});
    if(current?.authenticated)return {handled:true,filled:false,authenticated:current.accountMatched===true,reason:current.accountMatched?'already_authenticated':'account_mismatch'};
    const form=await inspect(page,{origin});
    if(!form?.hiddenReady||!form.otpReady||!form.submitReady||!form.captchaImageReady)return {handled:true,filled:false,reason:'login_not_ready'};
    if(!withLogin||!prepare){const provider=await import('./bitwarden-totp.mjs');withLogin??=provider.withBitwardenLogin;prepare??=provider.prepareBitwardenTotp;}
    if((await prepare({root,origin,binding:guard.binding,config}))?.ready!==true)return {handled:true,filled:false,reason:'provider_unavailable'};
    const value=await withLogin({root,origin,binding:guard.binding,config,consume:async credential=>{
      const hash=crypto.createHash('sha256').update(credential.username.normalize('NFKC').trim().toLowerCase()).digest('hex');
      if(hash!==opt.usernameHash||!await guard.assertCurrent()||!await profileProof()||page.url()!==origin+'/login.php')throw Error('credential scope');
      await page.locator(inLoginForm('input[name="username"]',origin)).fill(credential.username);
      await page.locator(inLoginForm('input[name="password"]',origin)).fill(credential.password);
      const after=await inspect(page,{origin});filled=after?.usernameHash===opt.usernameHash&&after.passwordFilled===true&&await guard.assertCurrent();
      if(!filled)throw Error('credential scope');
    }});
    return {handled:true,filled:filled&&value.ready===true,reason:filled?'credentials_filled':'provider_unavailable'};
  }catch{return {handled:true,filled:false,reason:'recovery_unavailable'};}
  finally{if(guard)try{await guard.release();}catch{}}
}

// Both readers use this inert DOM contract. No input value or attendance
// control is read; only the current login form and own account are classified.
function parseHhclubProfileDocument({html,origin,expectedAccountId}){
  try{
      if(!['https://hhanclub.net','https://www.uhddolby.com'].includes(origin)||typeof html!=='string'||!html||html.length>2_000_000||
        !/^[1-9][0-9]{0,19}$/.test(String(expectedAccountId??'')))return null;
      const doc=new DOMParser().parseFromString(html,'text/html');
      if(doc.querySelector('base[href]'))return null;
      for(const element of doc.querySelectorAll('script,style,template,noscript'))element.remove();
      const waf=/just a moment|checking your browser|verify you are human|正在检查您的浏览器/i.test(doc.body?.textContent??'');
      if(waf)return null;
      const ordinaryLogin=[...doc.querySelectorAll('form[action]')].some(form=>{
        try{
          const action=new URL(form.getAttribute('action'),origin),method=String(form.getAttribute('method')??'GET').toUpperCase();
          const inputs=[...form.querySelectorAll('input')];
          return method==='POST'&&action.href===origin+'/takelogin.php'&&
            inputs.filter(e=>e.name==='username'&&active(e)&&!e.disabled).length===1&&
            inputs.filter(e=>e.name==='password'&&e.type==='password'&&active(e)&&!e.disabled).length===1;
        }catch{return false;}
      });
      if(ordinaryLogin)return {authenticated:false,accountMatched:false,signed:false,loginRequired:true};
      const blocks=doc.querySelectorAll(origin==='https://hhanclub.net'?'#user-info-panel':'#info_block');if(blocks.length!==1)return null;
      const links=[...doc.querySelectorAll('a[href]')].flatMap(a=>{
        try{const u=new URL(a.getAttribute('href'),origin);return u.origin===origin&&!u.username&&!u.password?[{u}]:[];}catch{return [];}
      });
      const ids=[...new Set([...blocks[0].querySelectorAll('a[href]')].flatMap(a=>{
        try{const u=new URL(a.getAttribute('href'),origin),id=u.searchParams.get('id');return u.origin===origin&&u.pathname==='/userdetails.php'&&
          [...u.searchParams.keys()].every(k=>k==='id')&&/^[1-9][0-9]{0,19}$/.test(id??'')?[id]:[];}catch{return [];}
      }))];
      function active(e){for(let p=e;p;p=p.parentElement)if(p.hidden||/display\s*:\s*none|visibility\s*:\s*hidden/i.test(p.getAttribute('style')??''))return false;return e.type!=='hidden';}
      const password=[...doc.querySelectorAll('input[type="password"]')].some(active);
      const otp=[...doc.querySelectorAll('input')].some(e=>active(e)&&/^(?:two_step_code|otp|totp|two_factor|2fa)$/.test(e.name??''));
      const verification=[...doc.querySelectorAll('form[action]')].some(f=>{
        try{return /^\/(?:take2fa|twofactor|2fa)\.php$/.test(new URL(f.getAttribute('action'),origin).pathname);}catch{return true;}
      });
      const authenticated=ids.length===1&&links.some(l=>l.u.pathname==='/logout.php')&&
        links.some(l=>l.u.pathname==='/usercp.php')&&!password&&!otp&&!verification&&!waf;
      return {authenticated,accountMatched:authenticated&&ids[0]===expectedAccountId,
        // HHCLUB keeps the same attendance link after a successful check-in.
        // This helper proves login only; its ordinary link is not daily proof.
        signed:false};
  }catch{return null;}
}

/** Current profile/login state only; unknown is never a daily not-signed proof. */
export async function readHhclubProfileState(context,{expectedAccountId,now=new Date()}={}){
  const unknown=()=>({status:'unknown',authenticated:false,accountMatched:false,submissionAttempted:false});
  let parser;
  try{
    if(!/^[1-9][0-9]{0,19}$/.test(String(expectedAccountId??''))||!Number.isFinite(now?.getTime()))return unknown();
    const response=await context.request.get(HOME,{maxRedirects:0,maxRetries:0,ignoreHTTPSErrors:false,
      timeout:15000,headers:{'Cache-Control':'no-cache'}});
    if(response.url()!==HOME)return unknown();
    if(response.status()===302){
      try{if(new URL(response.headers().location??'',HOME).href===LOGIN)return {status:'login_required',submissionAttempted:false};}catch{}
      return unknown();
    }
    const at=Date.parse(response.headers().date??'');
    if(response.status()!==200||!Number.isFinite(at)||day(at)!==day(now)||Math.abs(at-now.getTime())>5*60_000)return unknown();
    const html=await response.text();
    if(typeof html!=='string'||!html||Buffer.byteLength(html)>2_000_000)return unknown();
    parser=await context.newPage();await parser.route('**/*',route=>route.abort('blockedbyclient'));
    const state=await parser.evaluate(parseHhclubProfileDocument,{html,origin:ORIGIN,expectedAccountId:String(expectedAccountId)});
    if(state?.loginRequired===true)return {status:'login_required',submissionAttempted:false};
    return {status:'unknown',authenticated:state?.authenticated===true,accountMatched:state?.accountMatched===true,submissionAttempted:false};
  }catch{return unknown();}
  finally{if(parser)try{await parser.close();}catch{}}
}

function journal(file,origin=ORIGIN,adapterId=hhclubTwoFactorAdapter){
  if(!fs.existsSync(file))return {schemaVersion:1,attempts:[]};
  const value=read(file);
  if(value.schemaVersion!==1||!Array.isArray(value.attempts)||value.attempts.length>4096||value.attempts.some(e=>
    e.origin!==origin||e.accountKey!=='site-default'||e.adapterId!==adapterId||!/^[a-f0-9]{64}$/.test(e.profileBinding??'')||
    !['pending','accepted','rejected','unknown'].includes(e.state)||!Number.isFinite(Date.parse(e.attemptedAt??''))||e.businessDate!==day(e.attemptedAt)))throw Error('state');
  return {schemaVersion:1,attempts:value.attempts.map(e=>({origin:e.origin,accountKey:e.accountKey,adapterId:e.adapterId,
    profileBinding:e.profileBinding,businessDate:e.businessDate,state:e.state,attemptedAt:e.attemptedAt,
    ...(Number.isFinite(Date.parse(e.finishedAt??''))?{finishedAt:e.finishedAt}:{})}))};
}
function save(file,value){
  fs.mkdirSync(path.dirname(file),{recursive:true});const tmp=file+'.'+crypto.randomUUID()+'.tmp';
  try{fs.writeFileSync(tmp,JSON.stringify(value,null,2),{mode:0o600});fs.renameSync(tmp,file);}
  finally{if(fs.existsSync(tmp))fs.unlinkSync(tmp);}
}

/** Augment one reviewed normal login; never visits or submits attendance. */
export async function recoverHhclubTwoFactorLogin({root,origin=ORIGIN,config,page,profile,submit,clock=Date.now,
  scope=validateSiteTwoFactorScope,inspect=inspectHhclubLogin,readAuthenticated=readHhclubAuthenticated,
  prepare,withTotp,prepareCaptcha=prepareHhclubLoginCaptcha,acquire=acquireRunLock,release=releaseRunLock,profileProof=async()=>true}={}){
  const definition=loginDefinition(origin);if(!definition)return {handled:false};
  const adapterId=definition.adapterId,rawInspect=inspect;
  inspect=(value,options={})=>rawInspect(value,{...options,origin});
  let guard,authLock,attempted=false,accepted=false,otpWritten=false,reason='recovery_unavailable',authRoute,authPosts=0;
  try{
    if(!config)config=read(path.join(root,'config/config.json'));
    const opt=config.siteTwoFactorRecovery?.[origin];
    if(opt?.enabled!==true)return {handled:false};
    if(origin===UHD&&opt.allowPasswordLogin!==true)return {handled:false};
    if(opt.reviewed!==true||opt.provider!=='bitwarden'||opt.adapterId!==adapterId||
      !/^[1-9][0-9]{0,19}$/.test(String(opt.expectedAccountId??''))||!/^[a-f0-9]{64}$/.test(opt.usernameHash??'')||
      typeof submit!=='function'||!page)return result('configuration_invalid');
    guard=await scope({root,origin,config,profile,clock,adapterId});
    if(!guard||!await profileProof())return result('scope_unavailable');
    const startedDay=day(date(clock)),stateFile=path.join(root,'data/bitwarden/'+definition.journal+'.json');
    const proof=()=>readAuthenticated(page,{expectedAccountId:String(opt.expectedAccountId),now:date(clock),origin});
    const before=await proof();
    if(before?.authenticated){
      if(!before.accountMatched)return result('account_mismatch');
      return result(before.signed?'already_signed':'already_authenticated',false,false,true);
    }
    const readyForm=async(allowFilledOtp=false)=>{
      const value=await inspect(page,{allowFilledOtp});
      return value&&value.usernameHash===opt.usernameHash&&value.passwordFilled===true&&value.captchaFilled===true&&
        value.hiddenReady===true&&value.otpReady===true&&value.submitReady===true;
    };
    if(!await readyForm()){
      const preparedCaptcha=await prepareCaptcha(page,{config,usernameHash:opt.usernameHash,inspect,origin,
        assertCurrent:async()=>await guard.assertCurrent()&&await profileProof()});
      if(preparedCaptcha?.prepared!==true||!await readyForm())return result('login_not_ready');
    }
    try{authLock=await acquire(path.join(root,'data/bitwarden/'+definition.journal+'.lock'));}catch{return result('authentication_busy');}
    let state;try{state=journal(stateFile,origin,adapterId);}catch{return result('recovery_state_invalid');}
    const used=()=>state.attempts.some(e=>e.profileBinding===guard.binding.profileBinding&&e.businessDate===startedDay);
    if(used())return result('daily_recovery_limit');
    if(!prepare||!withTotp){const provider=await import('./bitwarden-totp.mjs');prepare??=provider.prepareBitwardenTotp;withTotp??=provider.withBitwardenTotp;}
    if(!await guard.assertCurrent()||!await profileProof())return result('scope_unavailable');
    const prepared=await prepare({root,origin,binding:guard.binding,config});
    if(prepared?.ready!==true)return result(providerReason(prepared));
    const refreshed=await proof();
    if(refreshed?.authenticated){
      if(!refreshed.accountMatched)return result('account_mismatch');
      return result(refreshed.signed?'already_signed':'already_authenticated',false,false,true);
    }
    if(day(date(clock))!==startedDay)return result('business_day_changed');
    if(!await readyForm()||!await guard.assertCurrent()||!await profileProof())return result('scope_unavailable');
    let called=false,accepting=true,pending;
    reason='provider_unavailable';
    const use=async(code,metadata)=>{
      if(typeof code!=='string'||!/^\d{6}$/.test(code)){reason='totp_invalid';return;}
      const at=date(clock);
      if(day(at)!==startedDay){reason='business_day_changed';return;}
      if(!Number.isSafeInteger(metadata?.validUntilMs)||metadata.validUntilMs-at.getTime()<3000||
        metadata.validUntilMs-at.getTime()>30_000){reason='totp_expired';return;}
      if(!await guard.assertCurrent()||!await profileProof()||!await readyForm()){reason='scope_unavailable';return;}
      let entry;
      if(origin===UHD){
        state=journal(stateFile,origin,adapterId);if(used()){reason='daily_recovery_limit';return;}
        entry={origin,accountKey:'site-default',adapterId,profileBinding:guard.binding.profileBinding,businessDate:startedDay,state:'pending',attemptedAt:at.toISOString()};
        state.attempts.push(entry);save(stateFile,state);attempted=true;reason='authentication_unknown';
        authRoute=async route=>{
          const request=route.request();let url;try{url=new URL(request.url());}catch{return route.abort('blockedbyclient');}
          if(!['GET','HEAD'].includes(request.method())){
            if(request.method()!=='POST'||url.href!==origin+'/takelogin.php'||authPosts>=1)return route.abort('blockedbyclient');
            authPosts++;return route.continue();
          }
          if(url.origin===origin&&['/attendance.php','/takelogin.php'].includes(url.pathname))return route.abort('blockedbyclient');
          return route.continue();
        };
        await page.route('**/*',authRoute);
      }
      otpWritten=true;
      const otp=page.locator(inLoginForm('input[name="'+definition.otp+'"]',origin));
      await otp.fill(code);
      if(await otp.evaluate((element,expected)=>element.value===expected,code)!==true){reason='otp_field_not_ready';return;}
      const dispatch=date(clock);
      if(day(dispatch)!==startedDay){reason='business_day_changed';return;}
      if(metadata.validUntilMs-dispatch.getTime()<3000||metadata.validUntilMs-dispatch.getTime()>30_000){reason='totp_expired';return;}
      if(!await guard.assertCurrent()||!await profileProof()||!await readyForm(true)){reason='scope_unavailable';return;}
      if(origin!==UHD){state=journal(stateFile,origin,adapterId);if(used()){reason='daily_recovery_limit';return;}}
      const finalDispatch=date(clock);
      if(day(finalDispatch)!==startedDay){reason='business_day_changed';return;}
      if(metadata.validUntilMs-finalDispatch.getTime()<3000||metadata.validUntilMs-finalDispatch.getTime()>30_000){reason='totp_expired';return;}
      if(!entry){entry={origin,accountKey:'site-default',adapterId,profileBinding:guard.binding.profileBinding,
        businessDate:startedDay,state:'pending',attemptedAt:finalDispatch.toISOString()};state.attempts.push(entry);save(stateFile,state);}
      attempted=true;reason='authentication_unknown';
      try{
        if(origin!==UHD||authPosts===0)await submit();
        await page.waitForLoadState('domcontentloaded',{timeout:15000}).catch(()=>{});
        if(day(date(clock))===startedDay&&await guard.assertCurrent()){
          const after=await proof();
          if(after?.authenticated&&after.accountMatched){accepted=true;reason='authentication_accepted';}
          else if(after?.authenticated&&!after.accountMatched)reason='account_mismatch';
          else{
            const rejected=await page.evaluate(()=>/验证码错误|验证码无效|二级验证.{0,8}(?:错误|无效)|密码错误|incorrect password|invalid (?:otp|verification code)/i.test(document.body?.innerText??'')).catch(()=>false);
            if(rejected===true)reason='authentication_rejected';
          }
        }else reason='business_day_changed';
      }catch{reason='authentication_unknown';}
      entry.state=accepted?'accepted':reason==='authentication_rejected'?'rejected':'unknown';entry.finishedAt=date(clock).toISOString();
      try{save(stateFile,state);}catch{}
    };
    const consume=(code,metadata)=>{if(!accepting||called)return Promise.resolve();called=true;pending=use(code,metadata);return pending;};
    let providerResult;
    try{providerResult=await withTotp({root,origin,binding:guard.binding,config,consume,clock});}catch{}
    finally{accepting=false;}
    if(pending)await pending;
    if(!attempted&&reason==='provider_unavailable')reason=providerReason(providerResult);
    return result(reason,attempted,accepted);
  }catch{return result(attempted?'authentication_unknown':'recovery_unavailable',attempted,accepted);}
  finally{
    // Never carry an unused/failed code into another submit, helper or retry.
    try{if(otpWritten&&page?.url()===origin+'/login.php')await page.locator('input[name="'+definition.otp+'"]').fill('');}catch{}
    if(authLock)try{await release(authLock);}catch{}
    if(guard)try{await guard.release();}catch{}
  }
}
