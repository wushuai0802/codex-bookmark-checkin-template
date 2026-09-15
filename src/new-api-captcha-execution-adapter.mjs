import {defineAdapter} from './adapter-contract.mjs';
import {createNewApiExecutionAdapter,requestNewApiAuthenticated} from './new-api-execution-adapter.mjs';
import {normalizeCaptchaCandidates,resolveCaptchaSolver} from './captcha-solver.mjs';

const MAX_ATTEMPTS=8;
const CAPTCHA_ALPHABET='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function pageFor(context){
  if(!context?.page||typeof context.page.evaluate!=='function')throw Error('isolated page is required');
  return context.page;
}

function pathOf(origin,value,fallback,name){
  const url=new URL(value||fallback,origin);
  if(url.protocol!=='https:'||url.origin!==origin||url.username||url.password||url.hash)throw Error(`invalid ${name} endpoint`);
  return `${url.pathname}${url.search}`;
}

function boundedInteger(value,fallback,min,max){
  const number=Number(value);return Number.isInteger(number)?Math.max(min,Math.min(max,number)):fallback;
}

function sameOrigin(response,origin){
  if(!response?.url)return true;
  try{return new URL(response.url).origin===origin;}catch{return false;}
}

function bodyMessage(body){return String(body?.message??body?.msg??'').replace(/[\r\n\t]+/g,' ').slice(0,180);}

function imageBuffer(value){
  if(typeof value!=='string')return null;
  const data=value.match(/^data:image\/[a-z0-9.+-]+;base64,([A-Za-z0-9+/=]+)$/i)?.[1]??(/^[A-Za-z0-9+/=]{32,}$/.test(value)?value:null);
  if(!data)return null;
  try{const buffer=Buffer.from(data,'base64');return buffer.length>0&&buffer.length<=4*1024*1024?buffer:null;}catch{return null;}
}

export function createNewApiCaptchaExecutionAdapter({origin,rule={},solveCaptcha=null}={}){
  const site=new URL(origin).origin;
  const captchaPath=pathOf(site,rule.captchaPath,'/api/user/checkin/captcha','captcha');
  const checkinPath=pathOf(site,rule.checkinPath??rule.signInPath,'/api/user/checkin','checkin');
  const maxAttempts=boundedInteger(rule.maxAttempts,6,1,MAX_ATTEMPTS);
  const candidateLimit=boundedInteger(rule.candidateLimit,6,1,12);
  const retryDelayMs=boundedInteger(rule.retryDelayMs,250,0,3000);
  const base=createNewApiExecutionAdapter({origin:site,rule});

  async function submitOnce({identity,context={}}={}){
    const solve=resolveCaptchaSolver({solveCaptcha,context});
    if(!solve)return {state:'rejected',reason:'captcha_solver_not_configured',actionMayHaveHappened:false};
    const page=pageFor(context),userId=String(identity?.userId??''),usedIds=new Set();
    if(!/^\d{1,20}$/.test(userId))return {state:'rejected',reason:'identity_missing',actionMayHaveHappened:false};
    for(let attempt=1;attempt<=maxAttempts;attempt+=1){
      const challenge=await requestNewApiAuthenticated(context,{origin:site,rule,path:captchaPath,method:'POST',userId});
      if(!sameOrigin(challenge,site))return {state:'rejected',reason:'cross_origin_redirect',actionMayHaveHappened:false};
      if(challenge?.status===401||challenge?.authRefreshFailed)return {state:'rejected',reason:'auth_expired',actionMayHaveHappened:false};
      if(challenge?.status===403)return {state:'rejected',reason:'challenge_required',actionMayHaveHappened:false};
      if(challenge?.networkError)return {state:'unknown',reason:'captcha_endpoint_unreachable',actionMayHaveHappened:false};
      const payload=challenge?.body?.data?.captcha??challenge?.body?.data??challenge?.body??{},id=String(payload?.captcha_id??payload?.captchaId??payload?.id??'');
      const image=imageBuffer(payload?.captcha_image??payload?.captchaImage??payload?.image);
      if(challenge?.status!==200||challenge?.body?.success!==true||!id||!image)return {state:'rejected',reason:'captcha_endpoint_invalid',actionMayHaveHappened:false};
      if(usedIds.has(id))return {state:'rejected',reason:'captcha_not_refreshed',actionMayHaveHappened:false};
      usedIds.add(id);
      let rawCandidates;
      try{rawCandidates=await solve(image,{attempt,origin:site,length:5,alphabet:CAPTCHA_ALPHABET,limit:candidateLimit});}
      catch{return {state:'unknown',reason:'captcha_solver_failed',actionMayHaveHappened:false};}
      const candidates=normalizeCaptchaCandidates(rawCandidates,{length:5,alphabet:CAPTCHA_ALPHABET,limit:candidateLimit});
      if(!candidates.length){if(retryDelayMs)await page.waitForTimeout?.(retryDelayMs);continue;}
      const answer=candidates.find(Boolean);
      if(answer){
        const submitted=await requestNewApiAuthenticated(context,{origin:site,rule,path:checkinPath,method:'POST',userId,body:{captcha_id:id,captcha_answer:answer}});
        if(!sameOrigin(submitted,site))return {state:'rejected',reason:'cross_origin_redirect',actionMayHaveHappened:false};
        if(submitted?.networkError||submitted?.status>=500)return {state:'unknown',reason:'submit_transport_unknown',actionMayHaveHappened:true};
        if(submitted?.status===401)return {state:'rejected',reason:'auth_expired',actionMayHaveHappened:false};
        if(submitted?.status===403)return {state:'rejected',reason:'challenge_required',actionMayHaveHappened:false};
        if(submitted?.status===429)return {state:'rejected',reason:'rate_limited',actionMayHaveHappened:false};
        const message=bodyMessage(submitted?.body);
        if(submitted?.status>=200&&submitted?.status<300&&submitted?.body?.success===true)return {state:'accepted',response:{status:submitted.status,attempt}};
        if(/已签到|已簽到|already/i.test(message))return {state:'accepted',response:{status:submitted.status,attempt}};
        if(!/验证码(?:错误|已失效)|驗證碼(?:錯誤|已失效)|captcha/i.test(message))return {state:'rejected',reason:'captcha_submission_rejected',actionMayHaveHappened:false};
      }
      if(retryDelayMs)await page.waitForTimeout?.(retryDelayMs);
    }
    return {state:'rejected',reason:'captcha_unresolved',actionMayHaveHappened:false};
  }

  return defineAdapter({id:'new-api-captcha.execute.v1',origin:site,capabilities:['identity','read_status','submit_once','verify','classify_error'],
    async identity(args={}){return base.methods.identity(args);},
    async read_status(args={}){return base.methods.read_status(args);},
    async submit_once(args={}){return submitOnce(args);},
    async verify(args={}){return base.methods.verify(args);},
    classify_error(error){return base.methods.classify_error(error);}
  });
}
