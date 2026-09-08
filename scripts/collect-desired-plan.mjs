import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {loadEffectiveConfig} from '../src/effective-config.mjs';
import {desiredTargets} from '../src/desired-plan.mjs';
const [root,out]=process.argv.slice(2);
const config=loadEffectiveConfig(root);
// These existing readers have no browser/login/check-in side effects.
const {readBookmarkPlan}=await import(pathToFileURL(path.join(root,'src/bookmarks.mjs')));
const plan=await readBookmarkPlan(config.bookmarksPath,config);
const targets=desiredTargets(plan,config);
const destination=path.resolve(out);
if(destination.toLowerCase().startsWith(path.resolve(root).toLowerCase()+path.sep))throw Error('desired plan output cannot be inside V1');
fs.writeFileSync(destination,JSON.stringify({schemaVersion:1,generatedAt:new Date().toISOString(),source:'current-bookmarks-runtime-config',targets}));
console.log(`Desired plan read: ${targets.length} account tasks`);
