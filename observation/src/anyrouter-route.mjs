import dns from 'node:dns';
import https from 'node:https';
import net from 'node:net';
import vm from 'node:vm';
import zlib from 'node:zlib';

const DEFAULT_DNS=['1.1.1.1','9.9.9.9','8.8.8.8'];
let routeCache=new Map();
let routeInflight=new Map();

function validAddress(value){return net.isIPv4(String(value))?String(value):null;}
function bounded(value,fallback,min,max){const number=Number(value);return Number.isInteger(number)?Math.max(min,Math.min(max,number)):fallback;}

export function normalizeAnyRouterRoutePolicy(origin='https://anyrouter.top',raw={}){
  const site=new URL(origin);
  if(site.protocol!=='https:'||site.username||site.password||site.pathname!=='/'||site.search||site.hash)throw Error('AnyRouter origin must be HTTPS');
  const host=site.hostname;
  const names=[host,...(Array.isArray(raw.dnsNames)?raw.dnsNames:[])].map(value=>String(value).trim().toLowerCase()).filter(value=>/^[a-z0-9.-]{1,253}$/.test(value)&&!value.includes('..'));
  const hosts=[host,...(Array.isArray(raw.hostnames)?raw.hostnames:[])].map(value=>String(value).trim().toLowerCase()).filter(value=>/^[a-z0-9.-]{1,253}$/.test(value)&&!value.includes('..'));
  const servers=[...(Array.isArray(raw.dnsServers)?raw.dnsServers:DEFAULT_DNS)].map(validAddress).filter(Boolean);
  if(!servers.length)throw Error('AnyRouter DNS server list is empty');
  const probePath=String(raw.probePath||'/');
  if(!/^\/[^\r\n]{0,199}$/.test(probePath))throw Error('AnyRouter probe path is invalid');
  return {origin:site.origin,host,dnsNames:[...new Set(names)].slice(0,16),hosts:[...new Set(hosts)].slice(0,16),dnsServers:[...new Set(servers)].slice(0,8),probePath,ttlMs:bounded(raw.ttlMs,300000,30000,3600000),timeoutMs:bounded(raw.timeoutMs,7000,1000,15000),maxCandidates:bounded(raw.maxCandidates,8,1,16)};
}

function resolve4(host,server,timeoutMs){
  const resolver=new dns.promises.Resolver();resolver.setServers([server]);
  return Promise.race([resolver.resolve4(host),new Promise((_,reject)=>setTimeout(()=>reject(Error('dns_timeout')),timeoutMs))]).then(values=>Array.isArray(values)?values.map(validAddress).filter(Boolean):[]);
}

function probe(address,policy,probeImpl){
  if(typeof probeImpl==='function')return Promise.resolve(probeImpl({host:policy.host,address,requestPath:policy.probePath,timeoutMs:policy.timeoutMs})).then(value=>({ok:value?.ok===true,statusCode:Number(value?.statusCode)||0})).catch(()=>({ok:false,statusCode:0}));
  return new Promise(resolve=>{
    let done=false;const finish=value=>{if(done)return;done=true;resolve(value);};
    const request=https.request({hostname:address,port:443,servername:policy.host,path:policy.probePath,method:'GET',headers:{Host:policy.host,Accept:'*/*',Connection:'close'},timeout:policy.timeoutMs,rejectUnauthorized:true},response=>{response.resume();response.once('end',()=>finish({ok:response.statusCode>=200&&response.statusCode<500,statusCode:response.statusCode??0}));response.once('error',()=>finish({ok:false,statusCode:0}));});
    request.once('error',()=>finish({ok:false,statusCode:0}));request.once('timeout',()=>{request.destroy();finish({ok:false,statusCode:0});});request.end();
  });
}

export async function resolveAnyRouterRoute(rule={},dependencies={}){
  const policy=normalizeAnyRouterRoutePolicy('https://anyrouter.top',rule),cacheKey=JSON.stringify(policy),now=Date.now(),cached=routeCache.get(cacheKey);
  if(cached&&cached.expiresAt>now)return cached;
  if(routeInflight.has(cacheKey))return routeInflight.get(cacheKey);
  const work=(async()=>{
    const resolver=typeof dependencies.resolve4==='function'?dependencies.resolve4:resolve4,addresses=[];
    for(const name of policy.dnsNames){for(const server of policy.dnsServers){try{const values=await resolver(name,server,policy.timeoutMs);for(const address of (Array.isArray(values)?values:[]).map(validAddress).filter(Boolean))if(!addresses.includes(address))addresses.push(address);}catch{}}}
    const candidates=addresses.slice(0,policy.maxCandidates),probes=await Promise.all(candidates.map(async address=>({address,...await probe(address,policy,dependencies.probe)}))),selected=probes.find(item=>item.ok&&item.statusCode>=200&&item.statusCode<500);
    if(!selected){routeCache.delete(cacheKey);return null;}
    const route={origin:policy.origin,host:policy.host,hosts:policy.hosts,address:selected.address,statusCode:selected.statusCode,cacheKey,expiresAt:Date.now()+policy.ttlMs};routeCache.set(cacheKey,route);return route;
  })();
  routeInflight.set(cacheKey,work);
  try{return await work;}finally{routeInflight.delete(cacheKey);}
}

export function clearAnyRouterRouteCache(){routeCache=new Map();routeInflight=new Map();}

export function createCookieJar(cookies=[]){
  const values=new Map();
  for(const cookie of (Array.isArray(cookies)?cookies:[])){const name=String(cookie?.name??'').trim();if(name&&/^[^=;\s]{1,120}$/.test(name))values.set(name,String(cookie?.value??''));}
  return {update(lines=[]){for(const line of (Array.isArray(lines)?lines:[])){const match=/^([^=;\s]{1,120})=([^;]*)/.exec(String(line));if(!match)continue;const lower=String(line).toLowerCase();if(/(?:^|;\s*)max-age=0(?:;|$)/.test(lower)||lower.includes('expires=thu, 01 jan 1970'))values.delete(match[1]);else values.set(match[1],match[2]);}},header(){return [...values].map(([name,value])=>name+'='+value).join('; ');}};
}

export function solveEsaChallenge(body){
  const source=String(body??'');if(source.length>200_000)return null;
  const script=/<script>([\s\S]*?)<\/script>/i.exec(source)?.[1]??'',arg1=/var\s+arg1\s*=\s*['"]([^'"]*)['"]/.exec(script)?.[1]??'';
  if(!script||!arg1||script.length>50_000)return null;
  if(/\b(?:process|require|globalThis|global|fetch|XMLHttpRequest|WebSocket|Worker|Function|eval|constructor|__proto__|import)\b/i.test(script))return null;
  let cookie='';const document={location:{reload(){}},get cookie(){return cookie;},set cookie(value){cookie=String(value).slice(0,4096);}};
  const runTimer=callback=>{if(typeof callback==='function')callback();return 0;};
  const sandbox={document,window:null,location:document.location,navigator:{userAgent:'Mozilla/5.0',webdriver:false},console:{log(){},warn(){},error(){}},setTimeout:runTimer,clearTimeout(){}};sandbox.window=sandbox;
  try{vm.runInNewContext(script,sandbox,{timeout:3000,contextCodeGeneration:{strings:false,wasm:false}});}catch{return null;}
  const match=/^([^=;\s]{1,120})=([^;]+)/.exec(cookie);return match?match[1]+'='+match[2]:null;
}

function safeRequestPath(value){const requestPath=String(value??'');if(!/^\/[^\r\n]{0,4000}$/.test(requestPath))throw Error('AnyRouter request path is invalid');return requestPath;}
function safeHeaders(headers={}){
  const forbidden=new Set(['host','connection','content-length','transfer-encoding','upgrade','proxy-authorization','proxy-connection']),result={};
  if(!headers||typeof headers!=='object'||Array.isArray(headers))return result;
  for(const [key,value] of Object.entries(headers)){const name=String(key).toLowerCase();if(forbidden.has(name)||!/^[A-Za-z0-9-]{1,80}$/.test(String(key))||typeof value!=='string'||value.length>4096||/[\r\n]/.test(value))continue;result[key]=value;}
  return result;
}

export function requestAnyRouterRoute(route,path,{method='GET',headers={},body='',timeoutMs=10000}={}){
  let requestPath;try{requestPath=safeRequestPath(path);}catch(error){return Promise.resolve({status:0,body:'',setCookie:[],url:'',networkError:true,error:error.message});}
  const address=validAddress(route?.address),host=String(route?.host??'').toLowerCase();
  if(!address||!/^[a-z0-9.-]{1,253}$/.test(host))return Promise.resolve({status:0,body:'',setCookie:[],url:'',networkError:true,error:'route_invalid'});
  const verb=String(method||'GET').toUpperCase();if(!/^(?:GET|HEAD|POST|PUT|PATCH|DELETE)$/.test(verb))return Promise.resolve({status:0,body:'',setCookie:[],url:'',networkError:true,error:'method_invalid'});
  const payload=body==null?'':String(body);if(payload.length>2*1024*1024)return Promise.resolve({status:0,body:'',setCookie:[],url:'',networkError:true,error:'body_too_large'});
  const timeout=bounded(timeoutMs,10000,500,30000),merged={Host:host,Accept:'application/json, text/plain, */*','Accept-Encoding':'gzip, deflate, br',Connection:'close',...safeHeaders(headers),...(payload?{'Content-Length':String(Buffer.byteLength(payload))}:{})};
  return new Promise(resolve=>{
    let done=false;const finish=value=>{if(done)return;done=true;resolve(value);};
    const req=https.request({hostname:address,port:443,servername:host,path:requestPath,method:verb,headers:merged,timeout,rejectUnauthorized:true},response=>{const chunks=[];let bytes=0;response.on('data',chunk=>{if(bytes<4*1024*1024){chunks.push(chunk);bytes+=chunk.length;}});response.once('error',()=>finish({status:0,body:'',setCookie:[],url:'',networkError:true,error:'response_error'}));response.once('end',()=>{let buffer=Buffer.concat(chunks);const encoding=String(response.headers['content-encoding']||'').toLowerCase();try{if(encoding.includes('gzip'))buffer=zlib.gunzipSync(buffer);else if(encoding.includes('br'))buffer=zlib.brotliDecompressSync(buffer);else if(encoding.includes('deflate'))buffer=zlib.inflateSync(buffer);}catch{}finish({status:response.statusCode??0,body:buffer.toString(),setCookie:Array.isArray(response.headers['set-cookie'])?response.headers['set-cookie']:[],url:'https://'+host+requestPath});});});
    req.once('error',error=>finish({status:0,body:'',setCookie:[],url:'',networkError:true,error:String(error?.code??'network_error')}));req.once('timeout',()=>{req.destroy();finish({status:0,body:'',setCookie:[],url:'',networkError:true,error:'timeout'});});if(payload)req.write(payload);req.end();
  });
}

export async function requestWithEsa(route,path,options={},jar){
  const method=String(options.method||'GET').toUpperCase();let response=await requestAnyRouterRoute(route,path,{...options,headers:{...(options.headers||{}),...(jar?.header()?{Cookie:jar.header()}: {})}});jar?.update(response.setCookie);
  if(method==='GET'||method==='HEAD')for(let attempt=0;attempt<2&&/<script\b/i.test(response.body);attempt+=1){const cookie=solveEsaChallenge(response.body);if(!cookie)break;jar?.update([cookie]);response=await requestAnyRouterRoute(route,path,{...options,headers:{...(options.headers||{}),...(jar?.header()?{Cookie:jar.header()}: {})}});jar?.update(response.setCookie);}
  return response;
}

export function parseRouteJson(response){try{return JSON.parse(String(response?.body??'').replace(/^\uFEFF/,''));}catch{return null;}}
