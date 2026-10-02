import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const helper=fileURLToPath(new URL('../scripts/nas-code-release.sh',import.meta.url));
const bash=process.platform==='win32'
  ? [path.join(process.env.ProgramFiles??'C:/Program Files','Git/bin/bash.exe'),path.join(process.env.LOCALAPPDATA??'','Programs/Git/bin/bash.exe')].find(file=>fs.existsSync(file))
  : '/bin/bash';
const shellPath=value=>process.platform==='win32'?value.replaceAll('\\','/').replace(/^([A-Za-z]):/,(_,drive)=>'/'+drive.toLowerCase()):value;
function command(args,options={}){
  assert.ok(bash,'Git Bash is required for the real NAS shell release drill');
  return spawnSync(bash,[shellPath(helper),...args.map(shellPath)],{encoding:'utf8',timeout:20000,env:{...process.env,MSYS_NO_PATHCONV:'1'},...options});
}
function ok(result){assert.equal(result.status,0,result.stderr||result.stdout);}
function snapshot(root){
  const files={};
  const walk=(dir,relative='')=>{for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
    const name=relative?relative+'/'+entry.name:entry.name;
    if(!relative&&['backups','.staging'].includes(entry.name))continue;
    if(entry.isDirectory())walk(path.join(dir,entry.name),name);else files[name]=fs.readFileSync(path.join(dir,entry.name),'utf8');
  }};
  walk(root);return files;
}
function fixture(t){
  // The system temp directory can be an 8.3 alias on Windows. Keep the drill
  // beneath this checkout so physical-path checks exercise canonical paths.
  const temporary=fileURLToPath(new URL('../tmp/',import.meta.url));fs.mkdirSync(temporary,{recursive:true});
  const base=fs.mkdtempSync(path.join(temporary,'nas-code-drill-')),root=path.join(base,'project'),stage=path.join(root,'.staging/code-fixture'),transaction=path.join(root,'backups/code-fixture.tree');
  t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  for(const directory of [root,stage,path.join(root,'backups'),path.join(root,'src'),path.join(root,'public'),path.join(stage,'src'),path.join(stage,'public')])fs.mkdirSync(directory,{recursive:true});
  const write=(dir,name,text)=>{fs.mkdirSync(path.dirname(path.join(dir,name)),{recursive:true});fs.writeFileSync(path.join(dir,name),text);};
  for(const name of ['package.json','package-lock.json','release.json','Dockerfile','.dockerignore','TRANSFER-MANIFEST.txt','compose.nas.yaml','compose.worker.yaml']){
    write(root,name,'old '+name);write(stage,name,'new '+name);
  }
  write(root,'src/runner.mjs','old runner');write(root,'src/obsolete.mjs','retired source');write(root,'public/app.js','old ui');
  write(stage,'src/runner.mjs','new runner');write(stage,'src/new-module.mjs','new dependency');write(stage,'public/app.js','new ui');write(stage,'public/new.css','new style');
  for(const name of ['nas-data/receipt.json','secrets/fixture.txt','transport-data/queue.json','transport-config/worker.json','profiles/fixture.json'])write(root,name,'preserved '+name);
  return {root,stage,transaction,original:snapshot(root)};
}
function prepare(f,replace='0'){ok(command(['prepare',f.root,f.stage,f.transaction,replace,'1']));}

test('NAS full release installs exact code and failed build rollback restores the full old set',t=>{
  const f=fixture(t);
  fs.unlinkSync(path.join(f.root,'release.json'));f.original=snapshot(f.root);
  prepare(f);ok(command(['apply',f.root,f.transaction]));
  assert.equal(fs.existsSync(path.join(f.root,'src/obsolete.mjs')),false);
  assert.equal(fs.readFileSync(path.join(f.root,'src/new-module.mjs'),'utf8'),'new dependency');
  for(const [name,content] of Object.entries(f.original).filter(([name])=>/^(nas-data|secrets|transport-|profiles|compose\.)/.test(name)))assert.equal(fs.readFileSync(path.join(f.root,name),'utf8'),content);
  // A later Docker build/health failure uses the same rollback entry point.
  ok(command(['rollback',f.root,f.transaction]));
  assert.deepEqual(snapshot(f.root),f.original);
  assert.equal(fs.readFileSync(path.join(f.transaction,'failed/src/new-module.mjs'),'utf8'),'new dependency');
  assert.equal(fs.readFileSync(path.join(f.transaction,'failed/public/new.css'),'utf8'),'new style');
  ok(command(['rollback',f.root,f.transaction]));
});

test('NAS prepare/apply refuses a later runtime repair without changing any other file',t=>{
  const f=fixture(t);prepare(f);fs.writeFileSync(path.join(f.root,'public/app.js'),'later local repair');
  const before=snapshot(f.root),result=command(['apply',f.root,f.transaction]);
  assert.notEqual(result.status,0);assert.match(result.stderr,/runtime drift: public/);
  assert.deepEqual(snapshot(f.root),before);
});

test('NAS rollback refuses post-release drift before restoring any code',t=>{
  const f=fixture(t);prepare(f);ok(command(['apply',f.root,f.transaction]));
  fs.writeFileSync(path.join(f.root,'public/new.css'),'later local repair');
  const before=snapshot(f.root),result=command(['rollback',f.root,f.transaction]);
  assert.notEqual(result.status,0);assert.match(result.stderr,/runtime drift prevents rollback: public/);
  assert.deepEqual(snapshot(f.root),before);
});

test('NAS rollback rejects a damaged backup before changing the active tree',t=>{
  const f=fixture(t);prepare(f);ok(command(['apply',f.root,f.transaction]));
  fs.writeFileSync(path.join(f.transaction,'before/src/runner.mjs'),'corrupted backup');
  const before=snapshot(f.root),result=command(['rollback',f.root,f.transaction]);
  assert.notEqual(result.status,0);assert.match(result.stderr,/backup integrity failure/);
  assert.deepEqual(snapshot(f.root),before);
});

test('NAS journal restores a failed directory rename after the first tree has changed',t=>{
  const f=fixture(t);prepare(f);
  const script='mv() { if test "$2" = "$FAIL_RENAME_TARGET" && test "$1" = "$FAIL_RENAME_SOURCE"; then return 73; fi; command mv "$@"; }; export -f mv; exec bash "$@"';
  const result=spawnSync(bash,['-c',script,'fixture',shellPath(helper),'apply',shellPath(f.root),shellPath(f.transaction)],{
    encoding:'utf8',timeout:20000,env:{...process.env,MSYS_NO_PATHCONV:'1',FAIL_RENAME_SOURCE:shellPath(path.join(f.transaction,'replacement')),FAIL_RENAME_TARGET:shellPath(path.join(f.root,'public'))}
  });
  assert.equal(result.status,73,result.stderr);
  assert.equal(fs.readFileSync(path.join(f.root,'src/runner.mjs'),'utf8'),'new runner');
  assert.equal(fs.existsSync(path.join(f.root,'public')),false);
  ok(command(['rollback',f.root,f.transaction]));
  assert.deepEqual(snapshot(f.root),f.original);
});

test('NAS explicit Compose replacement is reversible and wrong project paths are refused',t=>{
  const f=fixture(t);prepare(f,'1');ok(command(['apply',f.root,f.transaction]));
  assert.equal(fs.readFileSync(path.join(f.root,'compose.nas.yaml'),'utf8'),'new compose.nas.yaml');
  ok(command(['rollback',f.root,f.transaction]));assert.deepEqual(snapshot(f.root),f.original);
  const unsafe=command(['prepare',f.root,f.stage,path.join(f.root,'nas-data/code-fixture.tree'),'0','0']);
  assert.notEqual(unsafe.status,0);assert.match(unsafe.stderr,/outside project backups/);
});
