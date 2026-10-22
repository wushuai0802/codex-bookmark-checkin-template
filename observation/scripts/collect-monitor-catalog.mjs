import fs from 'node:fs';
import path from 'node:path';
import { currentBoundMonitorCatalog } from '../src/monitor-catalog.mjs';
const [legacyRoot, configFile, out] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
const catalog = await currentBoundMonitorCatalog(legacyRoot, config);
fs.writeFileSync(out, JSON.stringify(catalog));
console.log(`PT bookmark catalog: ${catalog.sites.length} sites`);
