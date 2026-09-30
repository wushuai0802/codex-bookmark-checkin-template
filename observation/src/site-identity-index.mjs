export function siteIdentityIndex({catalog=null,planTargets=[]}={}){
  const index=new Map();
  const originOf=value=>{try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password?url.origin:null;}catch{return null;}};
  const ensure=origin=>{if(!index.has(origin))index.set(origin,{origin,kind:'service',monitored:false,targets:[],accountKeys:[],ambiguous:false});return index.get(origin);};
  for(const site of catalog?.sites??[]){
    const origin=originOf(site.origin);if(!origin)continue;
    const entry=ensure(origin);entry.monitored=true;entry.kind='pt';
  }
  for(const target of planTargets){
    const origin=originOf(target.origin);if(!origin)continue;
    const entry=ensure(origin);entry.targets.push(target);
    if((target.folderNames??[]).some(folder=>typeof folder==='string'&&/pt/i.test(folder)))entry.kind='pt';
    entry.accountKeys=[...new Set(entry.targets.map(item=>String(item.accountKey??'').trim()||'site-default'))];
    entry.ambiguous=entry.targets.length>1;
  }
  // Harvest IDs and compatibility folder labels never become account keys.
  return index;
}
