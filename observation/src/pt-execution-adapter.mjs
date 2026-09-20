import crypto from 'node:crypto';
import {defineAdapter} from './adapter-contract.mjs';
import {normalizeCaptchaCandidates,resolveCaptchaSolver} from './captcha-solver.mjs';

const REQUEST_TIMEOUT_MS=20_000;
const DEFAULT_ACTION_LABEL=/^(?:今日|今天)?(?:签到|簽到|立即签到|立即簽到|打卡|attendance|check[ -]?in)$/i;
const SIGNED_TEXT=/今日已签到|今日已簽到|今天已经签到|今天已簽到|签到成功|簽到成功|已经打卡|已完成签到|already (?:signed|checked in) today|successfully checked in/i;
const UNSIGNED_TEXT=/(?:今日|今天)(?:尚|还)?未[簽签]到|尚未打卡|not (?:signed|checked in) today/i;
const LOGIN_TEXT=/请先登录|請先登入|登录状态.*失效|登入狀態.*失效|sign in to continue|login required/i;
const CHALLENGE_TEXT=/验证码|驗證碼|captcha|hcaptcha|turnstile|recaptcha|verify you are human|安全验证|安全驗證|人机验证|人機驗證/i;
const MAINTENANCE_TEXT=/系统维护|系統維護|站点维护|站點維護|服务暂不可用|服務暫不可用|check.?in (?:is )?disabled|签到功能未开放|簽到功能未開放/i;

function pageFor(context){
  if(!context?.page||typeof context.page.goto!=='function'||typeof context.page.locator!=='function')throw Error('isolated page is required');
  return context.page;
}

function boundedInteger(value,fallback,min,max){const number=Number(value);return Number.isInteger(number)?Math.max(min,Math.min(max,number)):fallback;}

function safeText(value,max=200){return typeof value==='string'?value.replace(/[\r\n\t]+/g,' ').replace(/\s+/g,' ').trim().slice(0,max):'';}

function sameOriginEndpoint(origin,value,fallback,name){
  const url=new URL(value||fallback,origin);
  if(url.protocol!=='https:'||url.origin!==origin||url.username||url.password||url.hash)throw Error(`invalid PT ${name} endpoint`);
  return url.href;
}

function selectorList(value,fallback,max=20){
  const list=value==null?fallback:Array.isArray(value)?value:[value];
  if(list.length===0||list.length>max||list.some(item=>typeof item!=='string'||!item.trim()||item.length>400||/[\r\n]/.test(item)))throw Error('invalid PT selectors');
  return [...new Set(list.map(item=>item.trim()))];
}

function identityPattern(rule){
  if(!rule.identityPattern)return null;
  if(typeof rule.identityPattern!=='string'||rule.identityPattern.length>300||/[\r\n]/.test(rule.identityPattern))throw Error('invalid PT identity pattern');
  try{return new RegExp(String(rule.identityPattern),'i');}catch{throw Error('invalid PT identity pattern');}
}

function normalizeDate(value){
  const text=String(value??'').trim();
  const iso=text.match(/\b(20\d{2}-\d{1,2}-\d{1,2})\b/);
  if(iso){const [year,month,day]=iso[1].split('-').map(Number),date=new Date(Date.UTC(year,month-1,day));if(date.getUTCFullYear()!==year||date.getUTCMonth()!==month-1||date.getUTCDate()!==day)return null;return String(year).padStart(4,'0')+'-'+String(month).padStart(2,'0')+'-'+String(day).padStart(2,'0');}
  const chinese=text.match(/\b(20\d{2})\s*[年./-]\s*(\d{1,2})\s*[月./-]\s*(\d{1,2})\s*日?\b/);
  if(!chinese)return null;const year=Number(chinese[1]),month=Number(chinese[2]),day=Number(chinese[3]),date=new Date(Date.UTC(year,month-1,day));return date.getUTCFullYear()===year&&date.getUTCMonth()===month-1&&date.getUTCDate()===day?String(year).padStart(4,'0')+'-'+String(month).padStart(2,'0')+'-'+String(day).padStart(2,'0'):null;
}

function extractDateTokens(text){return [...String(text??'').matchAll(/\b20\d{2}[-/.]\d{1,2}[-/.]\d{1,2}\b|\b20\d{2}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日?\b/g)].map(match=>normalizeDate(match[0])).filter(Boolean);}

async function readVisibleText(page,selectors){
  const parts=[];
  for(const selector of selectors){
    try{const locator=page.locator(selector);const count=Math.min(await locator.count(),20);for(let index=0;index<count;index+=1){const item=locator.nth(index);if(await item.isVisible().catch(()=>false))parts.push(await item.innerText().catch(()=>''));}}catch{}
  }
  return safeText(parts.join(' '),30_000);
}

async function readDateMetadata(page){
  try{
    return (await page.locator('[data-date],[data-checkin-date],time[datetime]').evaluateAll(elements=>elements.flatMap(element=>[
      element.getAttribute?.('data-date'),element.getAttribute?.('data-checkin-date'),element.getAttribute?.('datetime')
    ].filter(Boolean)))).join(' ');
  }catch{return '';}
}

async function openPage(page,url){
  try{
    const target=new URL(url),current=new URL(page.url());
    if(current.origin!==target.origin||current.pathname!==target.pathname)await page.goto(url,{waitUntil:'domcontentloaded',timeout:REQUEST_TIMEOUT_MS});
    const after=new URL(page.url());return after.origin===target.origin;
  }catch{return false;}
}

async function reloadPage(page){
  if(typeof page.reload!=='function')return;
  try{await page.reload({waitUntil:'domcontentloaded',timeout:REQUEST_TIMEOUT_MS});}catch{}
}

async function visibleChallenge(page,selectors){
  for(const selector of selectors){try{const locator=page.locator(selector);const count=await locator.count();for(let index=0;index<count;index+=1)if(await locator.nth(index).isVisible().catch(()=>false))return true;}catch{}}
  return false;
}

async function extractIdentity(page,selectors,expected,pattern){
  const text=await readVisibleText(page,selectors);
  if(LOGIN_TEXT.test(text)||MAINTENANCE_TEXT.test(text))return {text,matched:false,reason:LOGIN_TEXT.test(text)?'login_required':'maintenance'};
  let matched=false;
  if(pattern)matched=pattern.test(text)&&new RegExp(String(expected).replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).test(text);
  else {
    const escaped=String(expected).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    matched=new RegExp(`(?:ID|UID|用户(?:ID)?|會員(?:ID)?|会员(?:ID)?|member(?:\\s*id)?|user(?:\\s*id)?)\\s*[:：#]?\\s*${escaped}\\b`,'i').test(text);
  }
  if(!matched){
    try{
      const values=await page.locator('[data-user-id],[data-uid],[data-user]').evaluateAll(elements=>elements.map(element=>String(element.getAttribute('data-user-id')??element.getAttribute('data-uid')??element.getAttribute('data-user')??'')));
      matched=values.some(value=>value===String(expected));
    }catch{}
  }
  return {text,matched,reason:matched?null:'identity_not_visible'};
}

async function actionMeta(item,page){
  if(!await item.isVisible().catch(()=>false)||!await item.isEnabled?.().catch(()=>true))return null;
  const meta=await item.evaluate?.(element=>({text:String(element.innerText||element.value||element.getAttribute?.('aria-label')||element.title||'').replace(/\s+/g,' ').trim(),href:element.href||'',formAction:element.form?.action||'',disabled:Boolean(element.disabled||element.getAttribute?.('aria-disabled')==='true')})).catch(()=>null);
  if(!meta||meta.disabled)return null;
  const pageOrigin=new URL(page.url()).origin;
  for(const value of [meta.href,meta.formAction].filter(Boolean)){try{if(new URL(value,page.url()).origin!==pageOrigin)return null;}catch{return null;}}
  return meta;
}

async function findAction(page,rule){
  // Prefer a single, explicitly reviewed selector. This prevents the same
  // DOM control matching both a site rule and a generic fallback selector.
  for(const selector of rule.actionSelectors){
    try{
      const locator=page.locator(selector),count=Math.min(await locator.count(),20),matches=[];
      for(let index=0;index<count;index+=1){const item=locator.nth(index),meta=await actionMeta(item,page);if(meta&& (DEFAULT_ACTION_LABEL.test(meta.text)||/(?:签到|簽到|打卡|check[ -]?in|attendance)/i.test(meta.text)))matches.push({locator:item,label:meta.text});}
      if(matches.length===1)return matches[0];
      if(matches.length>1)return null;
    }catch{}
  }
  try{
    const locator=page.locator('button,[role="button"],input[type="submit"],input[type="button"],a[href]'),count=Math.min(await locator.count(),80),matches=[];
    for(let index=0;index<count;index+=1){const item=locator.nth(index),meta=await actionMeta(item,page);if(meta&& (DEFAULT_ACTION_LABEL.test(meta.text)||/(?:签到|簽到|打卡|check[ -]?in|attendance)/i.test(meta.text)))matches.push({locator:item,label:meta.text});}
    return matches.length===1?matches[0]:null;
  }catch{return null;}
}

async function solveImageCaptcha(page,rule,context){
  const solve=resolveCaptchaSolver({context});
  if(!solve)return {state:'rejected',reason:'challenge_required',actionMayHaveHappened:false};
  const used=new Set();let repeatedReloaded=false;
  for(let attempt=1;attempt<=rule.captchaMaxAttempts;attempt+=1){
    const input=page.locator(rule.captchaInputSelectors.join(',')),image=page.locator(rule.captchaImageSelectors.join(',')),submit=page.locator(rule.captchaSubmitSelectors.join(','));
    if(await input.count()!==1||await image.count()!==1||await submit.count()!==1)return {state:'rejected',reason:'captcha_structure_changed',actionMayHaveHappened:false};
    const inputElement=input.first(),imageElement=image.first(),submitElement=submit.first();
    if(!await inputElement.isVisible().catch(()=>false)||!await imageElement.isVisible().catch(()=>false)||!await submitElement.isVisible().catch(()=>false))return {state:'rejected',reason:'captcha_controls_hidden',actionMayHaveHappened:false};
    let screenshot;try{screenshot=await imageElement.screenshot();}catch{return {state:'unknown',reason:'captcha_image_unavailable',actionMayHaveHappened:false};}
    const src=await imageElement.getAttribute?.('src').catch(()=>null),key=`${src??''}:${crypto.createHash('sha256').update(screenshot).digest('hex')}`;
    if(used.has(key)){if(!repeatedReloaded){repeatedReloaded=true;await reloadPage(page);if(rule.captchaRetryDelayMs)await page.waitForTimeout?.(rule.captchaRetryDelayMs);continue;}return {state:'rejected',reason:'captcha_not_refreshed',actionMayHaveHappened:false};}used.add(key);repeatedReloaded=false;
    let raw;
    try{raw=await solve(screenshot,{origin:new URL(page.url()).origin,length:rule.captchaLength,alphabet:rule.captchaAlphabet,attempt});}catch{return {state:'unknown',reason:'captcha_solver_failed',actionMayHaveHappened:false};}
    const candidates=normalizeCaptchaCandidates(raw,{length:rule.captchaLength,alphabet:rule.captchaAlphabet,limit:rule.captchaCandidateLimit});
    if(!candidates.length){if(rule.captchaRetryDelayMs)await page.waitForTimeout?.(rule.captchaRetryDelayMs);continue;}
    const code=candidates[0];
    await inputElement.fill(code);
    try{await submitElement.click({timeout:10_000});}catch{return {state:'unknown',reason:'submit_transport_unknown',actionMayHaveHappened:true};}
    await page.waitForTimeout?.(rule.actionWaitMs);
    const text=await readVisibleText(page,['body']);
    if(SIGNED_TEXT.test(text)&&!/(?:失败|失敗|failed)/i.test(text))return {state:'accepted',response:{captchaAttempt:attempt}};
    if(!CHALLENGE_TEXT.test(text))return {state:'accepted',response:{captchaAttempt:attempt}};
    if(!/(?:错误|錯誤|失效|invalid|captcha)/i.test(text))return {state:'unknown',reason:'captcha_result_unconfirmed',actionMayHaveHappened:true};
    if(rule.captchaRefreshSelectors.length){try{const refresh=page.locator(rule.captchaRefreshSelectors.join(','));if(await refresh.count()===1&&await refresh.isVisible().catch(()=>false))await refresh.click({timeout:5000});else await reloadPage(page);}catch{await reloadPage(page);}}
    else await reloadPage(page);
    if(rule.captchaRetryDelayMs)await page.waitForTimeout?.(rule.captchaRetryDelayMs);
  }
  return {state:'rejected',reason:'captcha_unresolved',actionMayHaveHappened:true};
}

export function createPtExecutionAdapter({origin,rule={}}={}){
  const site=new URL(origin).origin;
  const attendanceUrl=sameOriginEndpoint(site,rule.url,'/attendance.php','attendance');
  const identityUrl=sameOriginEndpoint(site,rule.identityPath,attendanceUrl,'identity');
  const pattern=identityPattern(rule);
  const normalized={
    actionSelectors:selectorList(rule.actionSelectors,['#showupbutton','input[type="submit"][value*="签到"]','input[type="submit"][value*="簽到"]'],20),
    identitySelectors:selectorList(rule.identitySelectors,['body'],12),statusSelectors:selectorList(rule.statusSelectors,['body'],12),
    challengeSelectors:selectorList(rule.challengeSelectors,['.cf-turnstile:visible','.h-captcha:visible','.g-recaptcha:visible','iframe[src*="turnstile" i]:visible','iframe[src*="hcaptcha" i]:visible','iframe[src*="captcha" i]:visible'],20),
    captchaImageSelectors:selectorList(rule.captchaImageSelectors,['#showupimg','img[alt="CAPTCHA" i][src*="image.php"]','img[src*="/image.php"]','img[src*="captcha" i]'],12),
    captchaInputSelectors:selectorList(rule.captchaInputSelectors,['input[name="imagestring"]:visible','#imagestring:visible','input[name="captcha"]:visible','input[name*="captcha" i]:visible'],12),
    captchaSubmitSelectors:selectorList(rule.captchaSubmitSelectors,['#showupbutton','input[type="submit"][value="立即签到"]','input[type="submit"][value="立即簽到"]','input[type="submit"][name^="captcha_"]'],12),
    captchaRefreshSelectors:selectorList(rule.captchaRefreshSelectors,['#showupimg','img[alt="CAPTCHA" i][src*="image.php"]'],12),
    captchaLength:boundedInteger(rule.captchaLength,6,1,12),captchaCandidateLimit:boundedInteger(rule.captchaCandidateLimit,4,1,12),captchaMaxAttempts:boundedInteger(rule.captchaMaxAttempts,3,1,6),captchaRetryDelayMs:boundedInteger(rule.captchaRetryDelayMs,750,0,5000),
    captchaAlphabet:String(rule.captchaAlphabet||'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789').slice(0,80),actionWaitMs:boundedInteger(rule.actionWaitMs,1200,100,10_000),allowUndatedStatus:rule.allowUndatedStatus===true,buttonImpliesNotSigned:rule.buttonImpliesNotSigned!==false,passiveOnly:rule.passiveOnly===true
  };
  if(!normalized.captchaAlphabet||normalized.captchaAlphabet.length<2)throw Error('invalid PT captcha alphabet');

  const readPageState=async(context,identity,businessDate)=>{
    const page=pageFor(context);if(!await openPage(page,attendanceUrl))return {state:'unknown',reason:'cross_origin_redirect'};
    const text=await readVisibleText(page,normalized.statusSelectors),metadata=await readDateMetadata(page);
    if(LOGIN_TEXT.test(text))return {state:'unknown',reason:'login_required'};
    if(MAINTENANCE_TEXT.test(text))return {state:'not_available',reason:'maintenance',evidence:{authoritative:true,source:'pt_page',businessDate,accountId:String(identity?.userId??''),statusSignal:'maintenance'}};
    const challenge=await visibleChallenge(page,normalized.challengeSelectors);
    const imageCaptcha=await visibleChallenge(page,normalized.captchaImageSelectors);
    if(challenge&&!imageCaptcha)return {state:'unknown',reason:'challenge_required'};
    const dates=extractDateTokens(text+' '+metadata);
    if(!normalized.allowUndatedStatus&&!dates.includes(businessDate))return {state:'unknown',reason:'status_date_missing'};
    const identityState=await extractIdentity(page,normalized.identitySelectors,String(identity?.userId??''),pattern);
    if(!identityState.matched)return {state:'unknown',reason:identityState.reason};
    const failed=/(?:签到失败|簽到失敗|check.?in failed|失败|失敗)/i.test(text);
    if(SIGNED_TEXT.test(text)&&!failed)return {state:'already_done',evidence:{authoritative:true,source:'pt_page',businessDate,accountId:String(identity.userId),statusSignal:'signed_text'}};
    if(UNSIGNED_TEXT.test(text)&&!SIGNED_TEXT.test(text))return {state:'not_signed',evidence:{authoritative:true,source:'pt_page',businessDate,accountId:String(identity.userId),statusSignal:'unsigned_text'}};
    if(normalized.buttonImpliesNotSigned&&!challenge){const action=await findAction(page,normalized);if(action)return {state:'not_signed',evidence:{authoritative:true,source:'pt_page',businessDate,accountId:String(identity.userId),statusSignal:'checkin_control'}};}
    return {state:'unknown',reason:'status_not_proven'};
  };

  const adapter=defineAdapter({id:'pt-native.execute.v1',origin:site,capabilities:['identity','read_status','submit_once','verify','classify_error'],
    async identity({expectedIdentity,context}={}){
      const id=String(expectedIdentity??'');if(!/^\d{1,20}$/.test(id))return null;
      const page=pageFor(context);if(!await openPage(page,identityUrl))return null;
      const state=await extractIdentity(page,normalized.identitySelectors,id,pattern);
      if(!state.matched)return state.reason==='challenge_required'?{blockedReason:'challenge_required'}:null;
      let username=null;const match=state.text.match(/(?:用户名|會員名稱|会员名|username|user)\s*[:：]?\s*([A-Za-z0-9_.-]{1,80})/i);if(match)username=match[1];
      return {userId:id,username,origin:site};
    },
    async read_status({identity,businessDate,context}={}){return readPageState(context,identity,businessDate);},
    async submit_once({identity,businessDate,context}={}){
      if(normalized.passiveOnly)return {state:'rejected',reason:'operator_disabled',actionMayHaveHappened:false};
      const page=pageFor(context);if(!await openPage(page,attendanceUrl))return {state:'rejected',reason:'cross_origin_redirect',actionMayHaveHappened:false};
      const text=await readVisibleText(page,normalized.statusSelectors);
      if(LOGIN_TEXT.test(text))return {state:'rejected',reason:'login_required',actionMayHaveHappened:false};
      if(MAINTENANCE_TEXT.test(text))return {state:'rejected',reason:'maintenance',actionMayHaveHappened:false};
      const imageCaptcha=await visibleChallenge(page,normalized.captchaImageSelectors),interactive=await visibleChallenge(page,normalized.challengeSelectors);
      if(interactive&&!imageCaptcha)return {state:'rejected',reason:'challenge_required',actionMayHaveHappened:false};
      if(imageCaptcha)return solveImageCaptcha(page,normalized,context);
      const identityState=await extractIdentity(page,normalized.identitySelectors,String(identity?.userId??''),pattern);if(!identityState.matched)return {state:'rejected',reason:'identity_not_visible',actionMayHaveHappened:false};
      const action=await findAction(page,normalized);if(!action)return {state:'rejected',reason:'checkin_button_missing',actionMayHaveHappened:false};
      try{await action.locator.click({timeout:10_000});await page.waitForTimeout?.(normalized.actionWaitMs);return {state:'accepted',response:{label:action.label}};}catch{return {state:'unknown',reason:'submit_transport_unknown',actionMayHaveHappened:true};}
    },
    async verify({identity,businessDate,context}={}){
      for(let attempt=0;attempt<3;attempt+=1){const status=await readPageState(context,identity,businessDate);if(status.state==='already_done'||status.state==='not_available')return status.state==='already_done'?{state:'confirmed',evidence:status.evidence}:status;if(status.state==='unknown'&&!['status_not_proven','status_date_missing'].includes(status.reason))return status;if(attempt<2)await pageFor(context).waitForTimeout?.(500*(attempt+1));}
      return {state:'unknown',reason:'submission_not_visible'};
    },
    classify_error(error){const status=Number(error?.status),text=String(error?.message??error);if(status===401)return'auth_expired';if(status===403||/captcha|验证|驗證|turnstile|hcaptcha/i.test(text))return'challenge_required';if(status===429||/429|rate/i.test(text))return'rate_limited';if(status>=500||!status)return'unreachable';return'unknown';}
  });
  return adapter;
}
