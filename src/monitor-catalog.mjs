import fs from 'node:fs';
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
        if (url.protocol === 'https:' && !url.username && !url.password) sites.set(url.origin, {
          origin: url.origin, displayName: shortLabel(node.name?.replace(/\s*(?:::| - Powered by).*$/, '')) || url.hostname
        });
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
