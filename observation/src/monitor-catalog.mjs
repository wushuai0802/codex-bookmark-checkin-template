import fs from 'node:fs';
import crypto from 'node:crypto';
import { shortLabel } from './display-identity.mjs';

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

export function boundMonitorCatalog(bookmarksPath,scope,now=new Date()){
  const bytes=fs.readFileSync(bookmarksPath);
  return {...bookmarkCatalog(JSON.parse(bytes),scope),schemaVersion:1,generatedAt:now.toISOString(),
    scope:{folderId:String(scope.folderId),parentId:String(scope.parentId)},
    sourceHash:crypto.createHash('sha256').update(bytes).digest('hex')};
}

export function validateCurrentPtCatalog(catalog,{bookmarksPath,now=new Date()}={}){
  try{
    const at=Date.parse(catalog.generatedAt);
    if(!Number.isFinite(at)||at>now.getTime()+60_000||now.getTime()-at>30*60_000||
      !catalog.scope?.folderId||!catalog.scope?.parentId)throw Error('stale scope');
    const current=boundMonitorCatalog(bookmarksPath,catalog.scope,now);
    if(current.sourceHash!==catalog.sourceHash||JSON.stringify(current.sites)!==JSON.stringify(catalog.sites))throw Error('scope changed');
    return true;
  }catch{const e=Error('PT current bookmark scope is missing, stale or changed');e.code='PT_PREFLIGHT';throw e;}
}
