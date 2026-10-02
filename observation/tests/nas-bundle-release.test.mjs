import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('NAS export preserves a matching deployed revision over a legacy runtime Git head and falls back for clean checkouts',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nas-release-marker-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  for(const dir of ['scripts','src','public','secrets'])fs.mkdirSync(path.join(root,dir));
  for(const file of ['Dockerfile','compose.nas.yaml','compose.worker.yaml','.dockerignore','package-lock.json'])fs.writeFileSync(path.join(root,file),'fixture');
  fs.writeFileSync(path.join(root,'secrets/README.md'),'fixture');
  fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({version:'1.1.10',type:'module'}));
  const observation=fileURLToPath(new URL('../',import.meta.url));
  fs.copyFileSync(path.join(observation,'scripts/export-nas-bundle.mjs'),path.join(root,'scripts/export-nas-bundle.mjs'));
  fs.copyFileSync(path.join(observation,'src/release-info.mjs'),path.join(root,'src/release-info.mjs'));
  const git=args=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  const fixtureEmail=['fixture','invalid'].join('@');
  git(['init','-q']);git(['-c','user.name=Fixture','-c','user.email='+fixtureEmail,'-c','commit.gpgsign=false','commit','--allow-empty','-qm','fixture runtime']);
  const legacyHead=git(['rev-parse','HEAD']),deployed='a'.repeat(40);
  for(const fixture of [
    {marker:{version:'1.1.10',revision:deployed},expected:deployed},
    {marker:{version:'1.1.9',revision:deployed},expected:legacyHead},
    {marker:{version:'1.1.10',revision:null},expected:legacyHead}
  ]){
    fs.writeFileSync(path.join(root,'release.json'),JSON.stringify(fixture.marker));
    execFileSync(process.execPath,[path.join(root,'scripts/export-nas-bundle.mjs')],{cwd:root,encoding:'utf8'});
    const release=JSON.parse(fs.readFileSync(path.join(root,'outputs/nas-bundle/release.json'),'utf8'));
    assert.equal(release.version,'1.1.10');assert.equal(release.revision,fixture.expected);
    assert.ok(Number.isFinite(Date.parse(release.deployedAt)));
  }
});
