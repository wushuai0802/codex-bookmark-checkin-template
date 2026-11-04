import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {runNativePtGate} from '../../src/native-pt-gate.mjs';
import {piggoOrigin as origin,piggoCalendarUrl,piggoAttendanceUrl,piggoDay} from '../../src/piggo-calendar.mjs';

// Anonymous /login observation from WO-12b. Names below are synthetic shapes,
// not frontend build hashes; each observed request has its own baseline row.
export const observedLoginRequests=[
  ['GET','/login',true],
  ['GET','/assets/css/login-shell.css',true],
  ['GET',`/cdn-cgi/scripts/${'a'.repeat(8)}/cloudflare-static/rocket-loader.min.js`,true],
  ['GET','https://static.cloudflareinsights.com/beacon.min.js/fixture',false],
  ['GET','/assets/js/main.js',true],
  ['GET','/assets/fonts/site.woff2',true],
  ['GET','/assets/js/shared.js',true],
  ['POST','/cdn-cgi/rum',false],
  ['GET','/v1/web/auth/guest-config',true],
  ['GET','/v1/web/plugin-assets/iyuu/plugin.css',false],
  ['GET','/v1/web/plugin-assets/iyuu/plugin.js',false],
  ['GET','/v1/web/plugin-assets/telegram-login/plugin.js',false],
  ['GET','/assets/js/login.js',true],
  ['GET','/assets/js/captcha.js',true],
  ['GET','/assets/css/captcha.css',true],
  ['GET','/assets/js/theme.js',true],
  ['GET','/assets/css/theme.css',true],
  ['GET','/assets/js/password.js',true],
  ['GET','/assets/js/logo.js',true],
  ['GET','/assets/css/shared.css',true],
  ['GET','/assets/fonts/login.woff2',true],
  ['GET','/zhuzhu.png',true],
  ['GET','/v1/web/auth/telegram/client',false],
  ['GET','/v1/web/oauth/login-providers',false],
  ['GET','/v1/web/passkeys/login/options',false],
  ['GET','/v1/web/auth/ws-ticket',false],
];

// DOM structure transcribed from the supplied Login chunk and anonymous form:
// no method/action, named username/password, token-list autocomplete, and a
// button WITHOUT a type attribute (the browser's type property is "submit").
// This small DOM double implements selectors, not the inspection's answer.
export function piggoLoginDom({webauthn=true,captcha=false,otp=false,setup=false,invite=false,
  loading=false,passkey=true,action,target,method,extra=[],iframe=false,unlock=false}={}){
  const node=(tag,attrs={},text='',children=[])=>({tagName:tag.toUpperCase(),attrs,textContent:text,children});
  const username=node('input',{type:'text',name:'username',id:'username',autocomplete:webauthn?'username webauthn':'username'});
  const password=node('input',{type:'password',name:'password',id:'password',autocomplete:webauthn?'current-password webauthn':'current-password'});
  const submit=node('button',{class:'btn',...(loading?{disabled:''}:{})},loading?'登录中…':'登录');
  const form=node('form',{...(action===undefined?{}:{action}),...(target===undefined?{}:{target}),...(method===undefined?{}:{method})},'',
    [username,...(passkey?[node('button',{type:'button','aria-label':'通行密钥登录'},'')]:[]),password]);
  if(unlock){
    Object.assign(form.attrs,{class:'step-up'});
    Object.assign(username.attrs,{class:'username-a11y',autocomplete:'username',readonly:'',tabindex:'-1',hidden:''});
    Object.assign(password.attrs,{class:'cell-input',required:'',placeholder:'当前密码'});
    Object.assign(submit.attrs,{type:'submit'});submit.textContent=loading?'验证中…':'解锁';
  }
  if(setup){
    delete password.attrs.name;password.attrs.autocomplete='new-password';
    form.children.push(node('input',{type:'email',autocomplete:'email'}),node('input',{type:'password',autocomplete:'new-password'}),
      node('input',{type:'radio'}),node('input',{type:'checkbox'}));submit.textContent='完成并登录';
  }
  if(captcha)form.children.push(node('span',{class:'captcha-row'},'',[
    node('input',{name:'captcha',placeholder:'验证码'}),node('button',{type:'button',class:'captcha-img'})]));
  if(otp)form.children.push(node('input',{name:'code',autocomplete:'one-time-code'}));
  form.children.push(submit,...extra.map(attrs=>node('input',attrs)));
  const root=node('main',{},'',[
    node('h1',{},setup?'完善账号':'用账号登录'),form,
    node('p',{},invite?'自由注册已关闭，请使用邀请链接注册。':'登录遇到问题可联系站点管理。'),
    ...(iframe?[node('iframe')]:[]),
  ]);
  const descendants=parent=>parent.children.flatMap(child=>[child,...descendants(child)]);
  const simple=(element,selector)=>{
    let remaining=selector.replace(/:not\(([^)]+)\)/g,(_,excluded)=>simple(element,excluded)?'!':'');
    if(remaining.includes('!'))return false;
    let matches=true;
    remaining=remaining.replace(/\[([\w-]+)(?:(~=|\*=|=)"([^"]*)"\s*(i)?)?\]/g,(_,name,op,value,insensitive)=>{
      let actual=element.getAttribute(name);
      if(insensitive){actual=actual?.toLowerCase()??null;value=value.toLowerCase();}
      matches&&=actual!==null&&(!op||op==='='&&actual===value||op==='~='&&actual.split(/\s+/).includes(value)||op==='*='&&actual.includes(value));
      return '';
    });
    remaining=remaining.replace(/\.([\w-]+)/g,(_,cls)=>{matches&&=(element.attrs.class??'').split(/\s+/).includes(cls);return '';});
    if(remaining&&remaining!=='*')matches&&=element.tagName.toLowerCase()===remaining.toLowerCase();
    return matches;
  };
  const matches=(element,selector)=>{
    const parts=selector.match(/(?:\[[^\]]*\]|[^\s\[])+/g)??[];
    if(!simple(element,parts.pop()??''))return false;
    let parent=element.parent;
    while(parts.length){const part=parts.pop();while(parent&&!simple(parent,part))parent=parent.parent;if(!parent)return false;parent=parent.parent;}
    return true;
  };
  const select=(parent,selector)=>descendants(parent).filter(element=>selector.split(',').some(part=>matches(element,part.trim())));
  const attach=(element,parent)=>{
    element.parent=parent;
    element.getAttribute=name=>Object.hasOwn(element.attrs,name)?String(element.attrs[name]):null;
    element.querySelectorAll=selector=>select(element,selector);
    element.getBoundingClientRect=()=>({width:element.attrs.hidden===undefined?100:0,height:20});
    for(const name of ['name','id','autocomplete','placeholder','target'])Object.defineProperty(element,name,{get:()=>element.getAttribute(name)??''});
    Object.defineProperties(element,{
      type:{get:()=>element.attrs.type??(element.tagName==='BUTTON'?'submit':'text')},
      disabled:{get:()=>Object.hasOwn(element.attrs,'disabled')},readOnly:{get:()=>Object.hasOwn(element.attrs,'readonly')},
      form:{get:()=>{let ancestor=element.parent;while(ancestor&&ancestor.tagName!=='FORM')ancestor=ancestor.parent;return ancestor??null;}},
      value:{get:()=>{throw Error('Inspection must never read an input value');}},
    });
    element.children.forEach(child=>attach(child,element));
  };
  attach(root,null);
  const document={querySelectorAll:selector=>select(root,selector),querySelector:selector=>select(root,selector)[0]??null};
  return {document,form,username,password,submit,root,
    evaluate:(fn,args)=>{
      const keys=['document','location','getComputedStyle'],previous=keys.map(key=>Object.getOwnPropertyDescriptor(globalThis,key));
      Object.assign(globalThis,{document,location:{origin,href:origin+(unlock?'/locked':'/login')},getComputedStyle:element=>({display:'block',visibility:'visible'})});
      try{return fn(args);}finally{keys.forEach((key,index)=>{if(previous[index])Object.defineProperty(globalThis,key,previous[index]);else delete globalThis[key];});}
    }};
}

export const now=new Date('2026-11-01T04:00:00Z');
export const calendarData=(status='today',today=piggoDay(now))=>({cells:[],selected:today,
  detail:{ymd:today,is_today:true,attendance:{status,streak:23,points:918273645,cards:9}}});
export function response(url,data,{status=200,date=now.toUTCString(),method='GET',responseUrl=url,text}={}){
  return {url:()=>responseUrl,status:()=>status,headers:()=>({date}),text:text??(async()=>JSON.stringify(data)),request:()=>({method:()=>method})};
}

export function fixture(t,{network=[],post={},scope=true,lease=true,gateChange,clock=()=>now}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'piggo-spa-fixture-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  for(const dir of ['config','data/profile','logs','tmp','controller/config','controller/data'])fs.mkdirSync(path.join(root,dir),{recursive:true});
  const profile=path.join(root,'data/profile');fs.writeFileSync(path.join(profile,'Local State'),'synthetic-profile');
  const profileBinding=crypto.createHash('sha256').update(process.platform==='win32'?profile.toLowerCase():profile).digest('hex');
  const policy={reviewed:true,piggoCalendar:true,mode:'safe_history_page',url:piggoCalendarUrl,selector:'.cal-page',
    loginPath:'/login',actionPath:'/v1/web/calendar/attendance',nativeIsolatedChrome:true,nativeApiHeaderFallback:true,
    nativeApiExecution:true,proxyServer:'http://127.0.0.1:7890'};
  const config={automationUserDataDir:profile,bookmarksPath:path.join(root,'bookmarks/Bookmarks'),
    nativeWafPreflightUrls:[{url:piggoAttendanceUrl,automationUserDataDir:profile,action:'checkin'}],
    ptReadOnlyPolicies:{[origin]:policy},oauthExpectedAccountIds:{[origin]:'42'}};
  const save=()=>fs.writeFileSync(path.join(root,'config/config.json'),JSON.stringify(config));save();
  const controller=path.join(root,'controller'),nonce=crypto.randomUUID();
  fs.writeFileSync(path.join(root,'data/v2-integration.json'),JSON.stringify({executionEngine:'v1',v2ProjectRoot:controller}));
  fs.writeFileSync(path.join(controller,'config/runtime.local.json'),JSON.stringify({executionEngine:'v1',legacyRoot:root}));
  fs.writeFileSync(path.join(controller,'data/v2-run.lock'),JSON.stringify({nonce,pid:process.pid}));
  const env={root:process.env.CHECKIN_V2_ENGINE_ROOT,lease:process.env.CHECKIN_V2_ENGINE_LEASE};
  process.env.CHECKIN_V2_ENGINE_ROOT=controller;process.env.CHECKIN_V2_ENGINE_LEASE=nonce;
  t.after(()=>{
    if(env.root===undefined)delete process.env.CHECKIN_V2_ENGINE_ROOT;else process.env.CHECKIN_V2_ENGINE_ROOT=env.root;
    if(env.lease===undefined)delete process.env.CHECKIN_V2_ENGINE_LEASE;else process.env.CHECKIN_V2_ENGINE_LEASE=env.lease;
  });
  const calls=[],events=[],posts=[],contexts=[];let signed=false,readIndex=0,launches=0;
  const gate=async options=>{
    events.push(options.phase);
    if(gateChange){const changed=await gateChange(options);if(changed!==undefined)return changed;}
    return runNativePtGate({...options,readPlan:async()=>({targets:scope?[{origin,candidates:[piggoAttendanceUrl],
      allowedOrigins:[origin],folderNames:['PT']}]:[]}),harvest:()=>null,verify:()=>null,verifyHistorical:()=>null});
  };
  const createContext=()=>{
    const routes=[],pages=[];
    const context={routes,pages:()=>pages,closed:false,route:async(pattern,fn)=>routes.push(fn),
      unroute:async(pattern,fn)=>{const i=routes.indexOf(fn);if(i>=0)routes.splice(i,1);},
      routeWebSocket:async(pattern,fn)=>{let closed=false;fn({close:()=>{closed=true;}});assert.equal(closed,true);},
      close:async()=>{context.closed=true;for(const page of pages)await page.close();},
      request:async(method,url,body,metadata={})=>{
        let allowed=false;
        const request={url:()=>url,method:()=>method,postDataJSON:()=>body,isNavigationRequest:()=>false,...metadata};
        const handler=routes.at(-1);assert.ok(handler,'firewall installed before navigation');
        await handler({request:()=>request,continue:async()=>{allowed=true;},abort:async()=>{},fallback:async()=>{throw Error('unexpected fallback');}});
        if(allowed)calls.push({method,url,...(body?{body}:{})});
        return allowed;
      },
      newPage:async()=>{
        const waits=[];let currentUrl='about:blank',record={};
        const emit=value=>{for(const waiter of waits)if(!waiter.done&&waiter.predicate(value)){waiter.done=true;waiter.resolve(value);}};
        const drain=()=>{for(const waiter of waits)if(!waiter.done){waiter.done=true;waiter.resolve(null);}};
        const page={url:()=>currentUrl,context:()=>context,closed:false,
          close:async()=>{page.closed=true;drain();},
          waitForResponse:predicate=>new Promise(resolve=>waits.push({predicate,resolve,done:false})),
          goto:async url=>{
            assert.equal(url,piggoCalendarUrl);assert.equal(await context.request('GET',url),true);currentUrl=url;
            record=network[readIndex++]??{};
            if(record.error)throw Error('PRIVATE transport');
            if(record.redirect){currentUrl=record.redirect;drain();return;}
            if(record.beforeResponses)await record.beforeResponses();
            const meUrl=origin+'/v1/web/me';
            if(await context.request('GET',meUrl))emit(response(meUrl,record.me??{user:{id:42,username:'PRIVATE_ACCOUNT'}},record.meOptions));
            const calUrl=record.requestUrl??origin+'/v1/web/calendar?year=2026&month=11';
            if(await context.request('GET',calUrl))emit(response(calUrl,record.data??calendarData(signed?'checked':'today'),record.options));
            drain();
          },
          locator:selector=>{
            assert.equal(selector,'.cal-page .cal-att button.cal-att-pill.act');
            return {count:async()=>record.buttonCount??1,isVisible:async()=>true,isEnabled:async()=>true,
              innerText:async()=>record.label??'签到 · +10',
              click:async()=>{
                const body=post.body??{ymd:piggoDay(clock())};
                if(await context.request('POST',piggoAttendanceUrl,body)){
                  const journal=JSON.parse(fs.readFileSync(path.join(root,'data/native-pt-attempts.json')));
                  assert.equal(journal.attempts.at(-1).state,'submitted');assert.deepEqual(journal.attempts.at(-1).actions,['click']);
                  posts.push(body);events.push('POST');signed=true;
                  if(post.error)throw Error('PRIVATE post timeout');
                  emit(response(piggoAttendanceUrl,post.data??calendarData('checked'),{method:'POST',...post.options}));
                  if(post.afterResponse)await post.afterResponse();
                  if(post.replay)assert.equal(await context.request('POST',piggoAttendanceUrl,body),false);
                }
                drain();
              }};
          }};
        pages.push(page);return page;
      }};
    contexts.push(context);return context;
  };
  const launch=async options=>{
    launches++;assert.equal(options.automationUserDataDir,profile);assert.equal(options.ptReadProxyServer,policy.proxyServer);
    assert.equal(options.ptPassiveReadOnly,true);assert.equal(options.nativePtReadOrigin,origin);assert.equal(options.failureScreenshots,false);
    return createContext();
  };
  return {root,origin,url:piggoAttendanceUrl,profile,profileBinding,config,policy,save,clock,gate,launch,
    validateLease:async()=>{if(!lease)throw Error('lease');},calls,events,posts,contexts,createContext,
    get launches(){return launches;}};
}
