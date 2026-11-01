import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {runNativePtGate} from '../../src/native-pt-gate.mjs';

export const origin='https://audiences.me',url=origin+'/attendance.php',now=new Date('2026-10-11T04:00:00Z');
export const ownId='73182940';
export function header({signed=false,controls,headerText,bodyText,headerCount=1,baseHrefs=[],hasPassword=false,inputs=[],forms=[],headings=[]}={}){
  return {headerCount,baseHrefs,hasPassword,inputs,forms,headings,headerText:headerText??'欢迎回来 PRIVATE_ACCOUNT 分享率 2.3 上传 10 GB 下载 4 GB 魔力 100 爆米花 20 H&R 0/0/0',
    bodyText:bodyText??'已登录的私人页面 PRIVATE_BODY',controls:controls??[
      {text:'PRIVATE_ACCOUNT',href:'/userdetails.php?id='+ownId},
      {text:'控制面板',href:'/usercp.php?action=security'},
      {text:signed?'已签到':'签到得魔力',href:'/attendance.php'},
    ]};
}
export function nexusFixture(t,{configChange={},scope=true,network=[{}],lease=true,gateChange}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'native-nexus-api-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const profile=path.join(root,'data/private-nexus'),defaultProfile=path.join(root,'data/default');
  for(const dir of ['config','logs','tmp','data/private-nexus','data/default'])fs.mkdirSync(path.join(root,dir),{recursive:true});
  fs.writeFileSync(path.join(profile,'Local State'),'private fixture profile');
  const policy={reviewed:true,mode:'safe_history_page',url:origin+'/index.php',selector:'#info_block',dailyHeader:true,
    nativeIsolatedChrome:true,nativeApiHeaderFallback:true,proxyServer:'http://127.0.0.1:7890',
    actionPath:'/attendance.php',unsignedText:'签到得魔力',unsignedTexts:['签到','签到得魔力'],signedRewardControl:true};
  const config={automationUserDataDir:defaultProfile,bookmarksPath:path.join(root,'bookmarks/Bookmarks'),
    nativeWafPreflightUrls:[{url,automationUserDataDir:profile,passiveOnly:true}],nativeAccessibilityCheckinOrigins:[],
    ptReadOnlyPolicies:{[origin]:policy},...configChange};
  fs.writeFileSync(path.join(root,'config/config.json'),JSON.stringify(config));
  if(lease){
    const controller=path.join(root,'controller'),nonce=crypto.randomUUID();
    for(const dir of ['config','data'])fs.mkdirSync(path.join(controller,dir),{recursive:true});
    fs.writeFileSync(path.join(root,'data/v2-integration.json'),JSON.stringify({executionEngine:'v1',v2ProjectRoot:controller}));
    fs.writeFileSync(path.join(controller,'config/runtime.local.json'),JSON.stringify({executionEngine:'v1',legacyRoot:root}));
    fs.writeFileSync(path.join(controller,'data/v2-run.lock'),JSON.stringify({nonce,pid:process.pid}));
    const oldRoot=process.env.CHECKIN_V2_ENGINE_ROOT,oldLease=process.env.CHECKIN_V2_ENGINE_LEASE;
    process.env.CHECKIN_V2_ENGINE_ROOT=controller;process.env.CHECKIN_V2_ENGINE_LEASE=nonce;
    t.after(()=>{
      if(oldRoot===undefined)delete process.env.CHECKIN_V2_ENGINE_ROOT;else process.env.CHECKIN_V2_ENGINE_ROOT=oldRoot;
      if(oldLease===undefined)delete process.env.CHECKIN_V2_ENGINE_LEASE;else process.env.CHECKIN_V2_ENGINE_LEASE=oldLease;
    });
  }
  const calls=[],events=[],snapshots=new Map();let launchCount=0,contextClosed=0,parserClosed=0;
  const gate=async options=>{
    events.push('gate:'+options.phase);
    if(gateChange){const changed=await gateChange(options);if(changed!==undefined)return changed;}
    return runNativePtGate({...options,
      readPlan:async()=>({targets:scope?[{origin,allowedOrigins:[origin],folderNames:['PT'],candidates:[url]}]:[]}),
      harvest:()=>null,verify:()=>null});
  };
  const launch=async cfg=>{
    launchCount++;events.push('launch');
    assert.equal(cfg.automationUserDataDir,profile);assert.equal(cfg.ptPassiveReadOnly,true);
    assert.equal(cfg.ptReadProxyServer,policy.proxyServer);assert.equal(cfg.failureScreenshots,false);
    const context={route:async(pattern,handler)=>{
      assert.equal(pattern,'**/*');let aborted=false;
      await handler({abort:async code=>{assert.equal(code,'blockedbyclient');aborted=true;}});
      assert.equal(aborted,true);
    },request:{post:async()=>{throw Error('POST forbidden in passive Nexus fixture');},get:async(requested,options)=>{
      const index=calls.length,record=network[index]??network[0]??{};
      assert.ok(requested===origin+'/index.php'||requested===origin+'/userdetails.php?id='+ownId,'only passive self reads');
      calls.push({url:requested,options});events.push('GET:'+new URL(requested).pathname);
      if(record.error)throw Error('PRIVATE transport failure');
      assert.equal(options.maxRedirects,0);assert.equal(options.maxRetries,0);assert.equal(options.ignoreHTTPSErrors,false);
      const token='html-'+index;snapshots.set(token,record.snapshot??header());
      return {status:()=>record.status??200,url:()=>record.responseUrl??requested,
        headers:()=>({date:record.date===undefined?now.toUTCString():record.date,...(record.location?{location:record.location}:{})}),text:async()=>token};
    }},newPage:async()=>({route:context.route,setContent:async(content,options)=>{
      assert.match(content,/Content-Security-Policy/);assert.match(content,/script-src &#39;none&#39;/);
      assert.doesNotMatch(content,/PRIVATE/);assert.equal(options.waitUntil,'domcontentloaded');
    },evaluate:async(fn,args)=>{
      const snapshot=snapshots.get(args.html),oldParser=globalThis.DOMParser;
      globalThis.DOMParser=class{
        parseFromString(){
          const block={textContent:snapshot.headerText,getAttribute:()=>null,
            querySelectorAll:selector=>selector==='[alt],[title],[aria-label]'?[]:snapshot.controls.map(control=>({
            tagName:control.tag??'A',textContent:control.text,getAttribute:()=>control.href??null,matches:()=>control.button===true,
          }))};
          const inputControls=snapshot.inputs.map(attributes=>({getAttribute:attribute=>{
            if(attribute==='value')throw Error('Input values must not be read');
            return Object.hasOwn(attributes,attribute)?attributes[attribute]:null;
          }}));
          return {querySelectorAll:selector=>selector===args.selector?Array.from({length:snapshot.headerCount},()=>block):
            selector==='base[href]'?snapshot.baseHrefs.map(href=>({getAttribute:()=>href})):
            selector==='input'?inputControls:selector==='form[action]'?snapshot.forms.map(action=>({getAttribute:()=>action})):
            selector==='h1,h2,h3,legend'?snapshot.headings.map(textContent=>({textContent})):
            selector==='input[type="password"]'&&(snapshot.hasPassword||snapshot.inputs.some(input=>input.type==='password'))?[{}]:[],
            body:{textContent:snapshot.bodyText}};
        }
      };
      try{return fn(args);}finally{if(oldParser===undefined)delete globalThis.DOMParser;else globalThis.DOMParser=oldParser;}
    },close:async()=>{parserClosed++;}}),close:async()=>{contextClosed++;}};
    return context;
  };
  const validateLease=async()=>{events.push('lease');if(!lease)throw Error('lease unavailable');};
  return {root,origin,url,profile,config,policy,gate,launch,validateLease,clock:()=>now,calls,events,
    get launchCount(){return launchCount;},get contextClosed(){return contextClosed;},get parserClosed(){return parserClosed;}};
}
export const nexusJournal=f=>path.join(f.root,'data/native-pt-attempts.json');
export function assertNoPrivate(result){assert.doesNotMatch(JSON.stringify(result),new RegExp('PRIVATE|'+ownId+'|bodyText|headerText|accountId'));}

