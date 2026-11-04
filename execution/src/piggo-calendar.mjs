import {bounded,TIMED_OUT} from './bounded-wait.mjs';
// Reviewed PigGo SPA contract. No storage, cookie or token access belongs here.
export const piggoOrigin='https://piggo.me';
export const piggoCalendarUrl=piggoOrigin+'/calendar';
export const piggoLockedUrl=piggoOrigin+'/locked';
export const piggoAttendanceUrl=piggoOrigin+'/v1/web/calendar/attendance';
export const piggoDay=value=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date(value));
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);

export function piggoApiData(value){
  if(!object(value))return null;
  // The shipped HTTP interceptor unwraps only this complete envelope.
  if('code' in value||'data' in value||'msg' in value)
    return value.code===0&&'msg' in value&&object(value.data)?value.data:null;
  return value;
}

export function piggoCalendarStatus(value,today){
  const data=piggoApiData(value),detail=data?.detail,attendance=detail?.attendance;
  if(!Array.isArray(data?.cells)||!object(detail)||detail.is_today!==true||data.selected!==today||
    detail.ymd!==today||!object(attendance))return null;
  return attendance.status==='checked'?'already_signed':attendance.status==='today'?'not_signed':null;
}

export function piggoCalendarEvidence(evidence,status){
  return evidence?.source==='api'&&evidence.authoritative===true&&evidence.pagePath==='/calendar'&&
    evidence.evidenceScope==='site_account_day'&&evidence.statusSignal===
      (status==='not_signed'?'piggo_calendar_unsigned':'piggo_calendar_signed')&&
    ['not_signed','signed','already_signed'].includes(status);
}

// Used at both receipt boundaries; the historical Nexus predicates stay separate.
export function acceptedPiggoCalendarReceipt(value,{accountKey,profileBinding},now){
  const evidence=value?.evidence,inspection=value?.inspection,today=piggoDay(now);
  const at=Date.parse(evidence?.confirmedAt??''),observed=Date.parse(value?.observedAt??'');
  if(value?.origin!==piggoOrigin||value.url!==piggoCalendarUrl||value.accountKey!==accountKey||
    value.profileBinding!==profileBinding||value.submissionAttempted!==false||
    ['clicked','checkinClicked','checkinClickAttempted'].some(key=>value[key]===true)||
    value.operationMode!=='safe_history_page'||value.readSafety!=='reviewed_passive'||
    value.businessDate!==today||evidence?.businessDate!==today||!piggoCalendarEvidence(evidence,value.status)||
    !Number.isFinite(at)||!Number.isFinite(observed)||at>now.getTime()||observed>now.getTime()||
    piggoDay(at)!==today||piggoDay(observed)!==today||Math.abs(at-observed)>60_000||now.getTime()-at>300_000||
    inspection?.currentUrl!==piggoCalendarUrl||inspection.sameOrigin!==true||inspection.authenticated!==true||
    inspection.accountMatched!==true||inspection.piggoCalendarVerified!==true||
    inspection.pageContentAvailable!==true||inspection.siteBodyLoaded!==true||
    inspection.waf!==false||inspection.loginRoute!==false||inspection.securityVerification!==false||
    inspection.success!==(value.status!=='not_signed')||
    inspection.signedControlCount!==(value.status==='not_signed'?0:1)||
    inspection.unsignedControlCount!==(value.status==='not_signed'?1:0)||
    inspection.successControl!==''||inspection.unsignedControl!=='')return null;
  return {origin:piggoOrigin,accountKey,profileBinding,status:value.status,businessDate:today,
    observedAt:value.observedAt,receivedAt:now.toISOString(),submissionAttempted:false,
    operationMode:'safe_history_page',readSafety:'reviewed_passive',
    evidence:{source:'api',authoritative:true,confirmedAt:evidence.confirmedAt,businessDate:today,
      pagePath:'/calendar',statusSignal:evidence.statusSignal,evidenceScope:'site_account_day'}};
}

function sameOriginUrl(value){
  try{const url=new URL(value);return url.origin===piggoOrigin&&url.protocol==='https:'&&
    !url.username&&!url.password&&!url.hash?url:null;}catch{return null;}
}
function calendarQuery(url,today){
  const values={year:String(Number(today.slice(0,4))),month:String(Number(today.slice(5,7))),day:String(Number(today.slice(8,10)))};
  return [...url.searchParams].every(([key,value])=>key in values&&value===values[key]&&url.searchParams.getAll(key).length===1);
}
export function piggoCalendarResponseUrl(value,today){
  const url=sameOriginUrl(value);
  return !!url&&url.pathname==='/v1/web/calendar'&&calendarQuery(url,today);
}
export function piggoResponseFresh(response,now){
  const date=Object.entries(response.headers()).find(([key])=>key.toLowerCase()==='date')?.[1],at=Date.parse(date??'');
  return Number.isFinite(at)&&piggoDay(at)===piggoDay(now)&&at<=now.getTime()+60_000&&now.getTime()-at<=300_000;
}

/** All writes and legacy endpoints are blocked until one dated intent is armed. */
export async function installPiggoCalendarFirewall(context,{clock=()=>new Date(),allowPluginAssets=false,allowIdleUnlock=false,allowAuthLanding=false}={}){
  let armedDay=null,used=false;
  const route=async intercepted=>{
    const request=intercepted.request(),raw=request.url(),url=sameOriginUrl(raw);
    if(!url)return intercepted.abort('blockedbyclient');
    // URL parsing normalizes dot segments before pathname can be inspected.
    if(/\.\.|\\|%(?:2e|2f|5c)/i.test(raw.split(/[?#]/)[0]))return intercepted.abort('blockedbyclient');
    if(request.method()==='POST'){
      let body;try{body=request.postDataJSON();}catch{}
      if(!used&&armedDay&&piggoDay(clock())===armedDay&&url.href===piggoAttendanceUrl&&
        object(body)&&Object.keys(body).length===1&&body.ymd===armedDay){
        used=true;return intercepted.continue();
      }
      return intercepted.abort('blockedbyclient');
    }
    if(request.method()!=='GET')return intercepted.abort('blockedbyclient');
    const api=['/v1/web/me','/v1/web/boot','/v1/web/auth/sign','/v1/web/auth/guest-config'];
    // Shape-based assets survive frontend releases without accepting arbitrary
    // API routes. Optional passkey, OAuth and WS bootstrap APIs stay blocked.
    const asset=url.pathname.length<=512&&(
      /^\/assets\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:js|css|woff2?|ttf|svg|png|webp|ico|jpe?g|gif|avif)$/.test(url.pathname)||
      /^\/cdn-cgi\/scripts\/[a-f0-9]{8,64}\/cloudflare-static\/rocket-loader\.min\.js$/.test(url.pathname)||
      allowPluginAssets&&/^\/v1\/web\/plugin-assets\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+\.(?:js|css)$/.test(url.pathname)||
      /^\/[A-Za-z0-9_.-]+\.(?:svg|png|webp|ico|jpe?g|gif|avif)$/.test(url.pathname));
    const authLanding=allowAuthLanding&&raw===piggoOrigin+'/'&&request.isNavigationRequest()&&
      request.resourceType()==='document'&&request.frame()===request.frame().page().mainFrame();
    const safe=authLanding||(!url.search&&(['/calendar','/login'].includes(url.pathname)||allowIdleUnlock&&url.href===piggoLockedUrl||api.includes(url.pathname)||asset))||
      piggoCalendarResponseUrl(url.href,piggoDay(clock()));
    return safe?intercepted.continue():intercepted.abort('blockedbyclient');
  };
  await context.route('**/*',route);
  // WebSocket messages bypass HTTP request routing and are unnecessary here.
  await context.routeWebSocket('**/*',socket=>socket.close());
  return {arm:today=>{if(armedDay||used||today!==piggoDay(clock()))throw Error('Calendar intent rejected');armedDay=today;},
    get used(){return used;},dispose:()=>context.unroute('**/*',route)};
}

async function responseData(response){
  const text=await bounded(response.text(),5000);
  if(text===TIMED_OUT)throw Error('Calendar response unavailable');
  if(Buffer.byteLength(text,'utf8')>1_000_000)throw Error('Calendar response too large');
  return JSON.parse(text);
}

// Project only the lock code from a bounded envelope. Never retain its message or data.
async function idleLocked(response){
  if(response?.status()!==423)return false;
  try{
    const text=await bounded(response.text(),5000);if(text===TIMED_OUT||Buffer.byteLength(text)>100_000)return false;
    const value=JSON.parse(text);
    return value?.code==='idle_locked'||value?.data?.code==='idle_locked';
  }catch{return false;}
}

/** Manual first-binding diagnostic. A candidate ID is never an accepted receipt. */
export async function readPiggoAccountIdInContext(context,{clock=()=>new Date()}={}){
  let page,cdp;
  try{
    page=await context.newPage();
    // Route only this diagnostic tab; keep other tabs and their routes intact.
    // CDP bypass also prevents an existing service worker evading its firewall.
    cdp=await context.newCDPSession(page);
    await cdp.send('Network.setBypassServiceWorker',{bypass:true});
    await installPiggoCalendarFirewall(page,{clock});
    const meWait=page.waitForResponse(response=>response.url()===piggoOrigin+'/v1/web/me'&&
      response.request().method()==='GET',{timeout:15000}).catch(()=>null);
    await page.goto(piggoCalendarUrl,{waitUntil:'domcontentloaded',timeout:15000});
    const me=await meWait;
    if(page.url()!==piggoCalendarUrl||!me||me.status()!==200||!piggoResponseFresh(me,clock()))return null;
    const id=piggoApiData(await responseData(me))?.user?.id;
    return Number.isSafeInteger(id)&&id>0?String(id):null;
  }catch{return null;}
  finally{await bounded(page?.close(),5000).catch(()=>{});await bounded(cdp?.detach(),5000).catch(()=>{});}
}

/** Capture only requests made by the real page; never reconstruct its auth client. */
export async function readPiggoCalendarInContext(context,state,clock,diagnostic={},keepPage=false){
  let page,retained=false;const started=clock(),today=piggoDay(started);
  const identity=state.identity;
  const fail=code=>({result:{...identity,status:['login_required','idle_locked'].includes(code)?'login_required':'unconfirmed',
    failureCode:code??'authoritative_status_unavailable',nativeGate:true,submissionAttempted:false,
    reason:'猪猪日历尚未取得当日同账号权威回执',nativeReadback:{stage:'readback',code:'authoritative_evidence_rejected',
      apiStage:diagnostic.apiStage,httpStatus:diagnostic.httpStatus}},accountId:null});
  try{
    diagnostic.apiStage='request';
    page=await context.newPage();
    const meWait=page.waitForResponse(response=>response.url()===piggoOrigin+'/v1/web/me'&&response.request().method()==='GET',
      {timeout:15000}).catch(()=>null);
    const calendarWait=page.waitForResponse(response=>piggoCalendarResponseUrl(response.url(),today)&&response.request().method()==='GET',
      {timeout:15000}).catch(()=>null);
    await page.goto(piggoCalendarUrl,{waitUntil:'domcontentloaded',timeout:15000});
    if(sameOriginUrl(page.url())?.pathname==='/locked'){diagnostic.apiStage='idle_lock';return fail('idle_locked');}
    if(sameOriginUrl(page.url())?.pathname==='/login'){diagnostic.apiStage='authentication';return fail('login_required');}
    const [me,calendar]=await Promise.all([meWait,calendarWait]);
    if(sameOriginUrl(page.url())?.pathname==='/locked'||await idleLocked(me)||await idleLocked(calendar)){
      diagnostic.apiStage='idle_lock';diagnostic.httpStatus=me?.status()===423||calendar?.status()===423?423:undefined;
      return fail('idle_locked');
    }
    diagnostic.apiStage='authentication';
    if(me?.status()===401||calendar?.status()===401||sameOriginUrl(page.url())?.pathname==='/login'){
      diagnostic.httpStatus=401;return fail('login_required');
    }
    diagnostic.apiStage='http_status';diagnostic.httpStatus=calendar?.status()??me?.status();
    if(!me||!calendar||me.status()!==200||calendar.status()!==200||page.url()!==piggoCalendarUrl)return fail();
    const now=clock();diagnostic.apiStage='response_freshness';
    if(!piggoResponseFresh(me,now)||!piggoResponseFresh(calendar,now))return fail();
    diagnostic.apiStage='response_structure';
    const account=piggoApiData(await responseData(me))?.user;
    const accountId=Number.isSafeInteger(account?.id)&&account.id>0?String(account.id):null;
    diagnostic.apiStage='identity';
    if(!accountId||accountId!==state.expectedAccountId)return fail('account_mismatch');
    diagnostic.apiStage='daily_fields';
    const status=piggoCalendarStatus(await responseData(calendar),today);
    diagnostic.apiStage='day_boundary';
    if(!status||piggoDay(clock())!==today||piggoDay(now)!==today)return fail();
    const evidence={source:'api',authoritative:true,confirmedAt:now.toISOString(),businessDate:today,
      pagePath:'/calendar',statusSignal:status==='not_signed'?'piggo_calendar_unsigned':'piggo_calendar_signed',
      evidenceScope:'site_account_day'};
    const inspection={currentUrl:piggoCalendarUrl,sameOrigin:true,authenticated:true,accountMatched:true,
      piggoCalendarVerified:true,pageContentAvailable:true,siteBodyLoaded:true,waf:false,loginRoute:false,
      securityVerification:false,success:status!=='not_signed',successText:false,
      signedControlCount:status==='not_signed'?0:1,unsignedControlCount:status==='not_signed'?1:0,
      successControl:'',unsignedControl:''};
    const metadata={...identity,url:piggoCalendarUrl,status,businessDate:today,observedAt:now.toISOString(),
      submissionAttempted:false,operationMode:'safe_history_page',readSafety:'reviewed_passive',evidence};
    diagnostic.apiStage='completed';
    retained=keepPage;
    return {accountId,...(retained?{page}:{}),result:{...metadata,nativeGate:true,inspection,readbackReceipt:{...metadata,inspection},
      nativeReadback:{stage:'completed',code:'receipt_accepted',apiStage:'completed',httpStatus:200}}};
  }catch{return fail();}
  finally{if(!retained)await bounded(page?.close(),5000).catch(()=>{});}
}

// The published Calendar component supplies this exact unique button class.
export async function clickPiggoAttendance(page){
  if(page.url()!==piggoCalendarUrl)throw Error('Calendar page changed');
  const button=page.locator('.cal-page .cal-att button.cal-att-pill.act');
  if(await button.count()!==1||!await button.isVisible()||!await button.isEnabled()||
    !/^签到(?:\s*·\s*\+[0-9,.]+)?$/.test((await button.innerText()).trim()))throw Error('Calendar action unreviewed');
  await button.click({timeout:10000});
}

export async function submitPiggoCalendar(page,firewall,today,clock,readCurrent){
  // Keep the actual pre-read page open while clicking. A new navigation here
  // could select another date; both the DOM and outgoing body are checked.
  if(!page||piggoDay(clock())!==today)throw Error('Calendar action unavailable');
  const responseWait=page.waitForResponse(response=>response.url()===piggoAttendanceUrl&&response.request().method()==='POST',
    {timeout:15000}).catch(()=>null);
  firewall.arm(today);
  await clickPiggoAttendance(page);
  const response=await responseWait;
  if(!firewall.used||!response||response.status()!==200||!piggoResponseFresh(response,clock())||
    piggoDay(clock())!==today||piggoCalendarStatus(await responseData(response),today)!=='already_signed')return null;
  return readCurrent();
}
