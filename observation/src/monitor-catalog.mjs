import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import { shortLabel } from './display-identity.mjs';
import {ptReadPolicies,nativePtHeaderOrigins} from './checkin-contract.generated.mjs';
import {loadEffectiveConfig} from './effective-config.mjs';

// Folder labels are presentation metadata, not the PT execution boundary.
// Reuse the execution layer's current, exact-scope plan for reviewed PT sites
// (for example OpenCD) that live in another approved bookmark folder.
export function reviewedPtOrigin(origin,config={}){
  if(Object.hasOwn(ptReadPolicies,origin)||nativePtHeaderOrigins.includes(origin))return true;
  const policy=config.ptReadOnlyPolicies?.[origin];
  if(policy?.reviewed!==true||policy.mode!=='safe_history_page')return false;
  try{const url=new URL(policy.url);return url.protocol==='https:'&&url.origin===origin&&!url.username&&!url.password;}
  catch{return false;}
}

function registeredPtSites(plan,config={}){
  const sites=new Map(),excluded=new Set(config.excludedOrigins??[]);
  for(const target of plan?.targets??[]){
    const origin=target.origin;
    if(excluded.has(origin)||!reviewedPtOrigin(origin,config))continue;
    try{
      const parsed=new URL(origin);
      if(parsed.origin!==origin||parsed.protocol!=='https:'||parsed.username||parsed.password)continue;
      const candidates=(target.candidates??[]).flatMap(value=>{
        try{const url=new URL(value);return url.protocol==='https:'&&url.origin===origin&&!url.username&&!url.password
          ?[url.origin+url.pathname]:[];}catch{return [];}
      });
      if(!candidates.length)continue;
      const entryUrl=candidates.find(value=>/\/(?:attendance|check[-_]?in|sign)[^/]*$/i.test(new URL(value).pathname))??candidates[0];
      if(entryUrl.length>255)continue;
      sites.set(origin,{origin,entryUrl,displayName:shortLabel(target.title)||parsed.hostname});
    }catch{/* A malformed plan entry cannot enlarge the approved scope. */}
  }
  return [...sites.values()].sort((a,b)=>a.origin.localeCompare(b.origin));
}

export function bookmarkCatalog(bookmarks, { folderId, parentId }) {
  const matches = [];
  function visit(node, ancestors = []) {
    if (String(node.id) === String(folderId) && ancestors.includes(String(parentId))) matches.push(node);
    for (const child of node.children ?? []) visit(child, [...ancestors, String(node.id)]);
  }
  for (const node of Object.values(bookmarks.roots ?? {})) visit(node);
  if (matches.length !== 1) throw new Error('PT bookmark folder is missing or ambiguous');
  const sites = new Map();
  function collect(node) {
    if (node.type === 'url') {
      try {
        const url = new URL(node.url);
        if (url.protocol === 'https:' && !url.username && !url.password) {
          const entryUrl = `${url.origin}${url.pathname}`;
          if (entryUrl.length > 255) return;
          const previous = sites.get(url.origin);
          const preferred = /\/(?:attendance|check[-_]?in|sign)[^/]*$/i.test(url.pathname);
          if (!previous || (preferred && !/\/(?:attendance|check[-_]?in|sign)[^/]*$/i.test(new URL(previous.entryUrl).pathname))) {
            sites.set(url.origin, {
              origin: url.origin, entryUrl,
              displayName: shortLabel(node.name?.replace(/\s*(?:::| - Powered by).*$/, '')) || url.hostname
            });
          }
        }
      } catch { /* Malformed bookmarks cannot become monitoring targets. */ }
    }
    for (const child of node.children ?? []) collect(child);
  }
  collect(matches[0]);
  return { sites: [...sites.values()].sort((a, b) => a.origin.localeCompare(b.origin)) };
}

export function readMonitorCatalog(bookmarksPath, scope) {
  return bookmarkCatalog(JSON.parse(fs.readFileSync(bookmarksPath, 'utf8')), scope);
}

export function boundMonitorCatalog(bookmarksPath,scope,now=new Date(),{plan,config}={}){
  const bytes=fs.readFileSync(bookmarksPath);
  const catalog=bookmarkCatalog(JSON.parse(bytes),scope);
  const registered=plan&&config?registeredPtSites(plan,config):null;
  if(registered){
    const sites=new Map(catalog.sites.map(site=>[site.origin,site]));
    for(const site of registered)if(!sites.has(site.origin))sites.set(site.origin,site);
    catalog.sites=[...sites.values()].sort((a,b)=>a.origin.localeCompare(b.origin));
    catalog.registration='current-execution-plan';
    catalog.registeredPlanHash=crypto.createHash('sha256').update(JSON.stringify(registered)).digest('hex');
  }
  return {...catalog,schemaVersion:1,generatedAt:now.toISOString(),
    scope:{folderId:String(scope.folderId),parentId:String(scope.parentId)},
    sourceHash:crypto.createHash('sha256').update(bytes).digest('hex')};
}

export async function currentBoundMonitorCatalog(legacyRoot,scope,now=new Date(),{readPlan}={}){
  const config=loadEffectiveConfig(legacyRoot);
  readPlan??=(await import(pathToFileURL(path.join(legacyRoot,'src/bookmarks.mjs')).href)).readBookmarkPlan;
  const plan=await readPlan(config.bookmarksPath,config);
  return boundMonitorCatalog(config.bookmarksPath,scope,now,{plan,config});
}

export function validateCurrentPtCatalog(catalog,{bookmarksPath,now=new Date(),plan,config}={}){
  const reject=reason=>{const error=Error('PT scope preflight rejected');error.preflightReason=reason;throw error;};
  try{
    const at=Date.parse(catalog.generatedAt);
    if(!Number.isFinite(at)||at>now.getTime()+60_000||now.getTime()-at>30*60_000||
      !catalog.scope?.folderId||!catalog.scope?.parentId)reject('catalog_stale');
    if(catalog.registration!==undefined&&catalog.registration!=='current-execution-plan')reject('registration_invalid');
    if(catalog.registration==='current-execution-plan'&&(!plan||!config))reject('execution_plan_missing');
    const current=boundMonitorCatalog(bookmarksPath,catalog.scope,now,
      catalog.registration==='current-execution-plan'?{plan,config}:{});
    if(current.registeredPlanHash!==catalog.registeredPlanHash)reject('execution_plan_changed');
    if(current.sourceHash!==catalog.sourceHash)reject('bookmark_source_changed');
    if(JSON.stringify(current.sites)!==JSON.stringify(catalog.sites))reject('site_scope_changed');
    return true;
  }catch(error){const e=Error('PT current bookmark scope is missing, stale or changed');e.code='PT_PREFLIGHT';
    e.preflightReason=error.preflightReason??'scope_unavailable';throw e;}
}
