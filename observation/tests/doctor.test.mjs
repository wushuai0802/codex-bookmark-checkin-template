import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {runDoctor,runDoctorCli,formatDoctor,isNasSource,parseDoctorOptions} from '../../tools/doctor.mjs';
import {collectNasRuntime,nasEntrypoints} from '../../tools/nas-runtime.mjs';
import {fileHash} from '../../tools/release-lib.mjs';
import {shanghaiDay} from '../../tools/release-gate.mjs';

const project=fileURLToPath(new URL('../../',import.meta.url));
const now=new Date('2026-10-31T04:00:00Z'),revision='a'.repeat(40),nextRevision='b'.repeat(40),olderRevision='c'.repeat(40);
const deployedAt='2026-10-31T01:00:00Z',finishedAt='2026-10-31T03:00:00Z',today=shanghaiDay(now);
const good=value=>({ok:true,value});
const save=(file,value)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(value));};
function nasSources(){
  return {
    'observation/Dockerfile':'FROM node:24-alpine\nWORKDIR /app\nCMD ["node", "src/dashboard-server.mjs"]\n',
    'observation/compose.nas.yaml':'services:\n  dashboard:\n    healthcheck:\n      test: ["CMD", "node", "-e", "fetch(\'http://127.0.0.1/healthz\')"]\n',
    'observation/compose.worker.yaml':'services:\n  dashboard:\n    environment:\n      FABRIC_WORKER_STATE_FILE: /transport-data/server.sqlite\n',
    'observation/src/dashboard-server.mjs':'export const ready=true;',
    'observation/package.json':JSON.stringify({name:'fixture',version:'1.2.3',dependencies:{'fixture-sdk':'1.0.0'}}),
    'observation/package-lock.json':JSON.stringify({name:'fixture',version:'1.2.3',lockfileVersion:3,
      packages:{'':{name:'fixture',version:'1.2.3',dependencies:{'fixture-sdk':'1.0.0'}},
        'node_modules/fixture-sdk':{version:'1.0.0'}}})
  };
}
function fixture(t){
  fs.mkdirSync(path.join(project,'tmp'),{recursive:true});
  const root=fs.mkdtempSync(path.join(project,'tmp/doctor-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const roots=Object.fromEntries(['execution','observation','operations'].map(role=>[role,path.join(root,role)]));
  const options={executionRoot:roots.execution,observationRoot:roots.observation,opsRoot:roots.operations,
    backupRoot:path.join(root,'backups'),taskNames:{main:'synthetic-main-task',sync:'synthetic-sync-task'}};
  const privateValues=['sensitive-account-marker',['synthetic-identity','unit.example'].join('@'),
    'https://private-site.example',path.join(root,'private-data'),'synthetic command line --private'];
  const privateFields={account:privateValues[0],email:privateValues[1],site:privateValues[2],
    privatePath:privateValues[3],commandLine:privateValues[4]};
  for(const role of Object.keys(roots))save(path.join(roots[role],'release.json'),{version:'1.2.3',revision,deployedAt,...privateFields});
  const stateFile=path.join(roots.operations,'outputs/scheduler-state.json');
  save(stateFile,{lastSuccessAt:finishedAt,failureCount:0,lastFailureCause:null,...privateFields});
  const operationsConfig=path.join(roots.operations,'config/config.json');
  save(operationsConfig,{sshTarget:'synthetic-nas',...privateFields});
  const dailyFile=path.join(roots.observation,'outputs/engine-daily-'+today+'.json');
  save(dailyFile,{businessDate:today,counts:{completed:4,unavailable:2,cancelled:0,unresolved:1,
    [privateValues[0]]:999},results:[privateFields],...privateFields});
  const ptFile=path.join(roots.observation,'outputs/shadow-beta-snapshot.json');
  save(ptFile,{businessDate:today,generatedAt:now.toISOString(),tasks:Array.from({length:7},(_,i)=>({taskId:'synthetic_'+i,
    origin:`https://task-${i}.example`,businessDate:today,observedAt:finishedAt,
    observedStatus:i<4?'signed':i<6?'not_available':'needs_attention',
    ...(i>=4&&i<6?{availabilityKind:'feature_disabled'}:{}),
    evidence:{source:'pt_page',authoritative:i<6,businessDate:today,confirmedAt:finishedAt}})),ptStatus:{counts:{sites:3,inLegacyPlan:1,verificationPending:1,
    status:{signed:2,unknown:1,[privateValues[0]]:999},[privateValues[0]]:999},sites:[privateFields]},...privateFields});
  const runId=today.replaceAll('-','')+'-080500-001-abcdef';
  const snapshot={schemaVersion:1,capturedAt:now.toISOString(),
    tasks:good(['main','sync'].map(role=>({role,state:'Ready',nextRunMs:now.getTime()+300_000,
      lastRun:finishedAt,lastResult:0,definitionHash:'d'.repeat(64),...privateFields}))),
    processes:good({count:0,roles:[],...privateFields}),lifecycle:good({exists:false}),
    manualSessions:good(Array.from({length:3},()=>({exists:false}))),
    finalReport:good({runId,runState:'final',executionComplete:true,isComplete:true,finishedAt,nextRetryAt:null,results:[],...privateFields}),
    scheduler:good({phase:'finished',lastAttemptDate:today,lastRunId:runId,reportValid:true,
      reportExecutionComplete:true,automaticRetryCount:0,nextEligibleAt:null}),
    harvest:good({enabled:false}),evidence:good({enabled:false}),fallback:good({pending:[]}),notifications:good([]),
    markers:good(Object.fromEntries(Object.keys(roots).map(role=>[role,{revision,deployedAt,...privateFields}]))),
    gatewayEvents:good([]),...privateFields};
  const files=['execution/src/runner.mjs','execution/package.json','execution/package-lock.json','observation/public/app.js'];
  save(path.join(roots.execution,'src/runner.mjs'),{publicCode:'fixture'});
  save(path.join(roots.execution,'package.json'),{dependencies:{'fixture-sdk':'1.0.0'}});
  save(path.join(roots.execution,'package-lock.json'),{packages:{'node_modules/fixture-sdk':{version:'1.0.0'}}});
  const dependencyFile=path.join(roots.execution,'node_modules/fixture-sdk/package.json');
  save(dependencyFile,{version:'1.0.0'});
  save(path.join(roots.observation,'public/app.js'),{publicCode:'fixture'});
  const plan={schemaVersion:1,roots,revision,version:'1.2.3',createdAt:deployedAt,
    files:files.map(file=>{const [role,...pieces]=file.split('/');return {file,afterHash:fileHash(path.join(roots[role],...pieces))};}),
    ...privateFields};
  const manifestFile=path.join(options.backupRoot,'release-a/manifest.json');
  save(manifestFile,plan);
  const calls={probe:0,health:0,ssh:[],git:[],delays:[]};
  const f={root,roots,options,snapshot,plan,stateFile,operationsConfig,dailyFile,ptFile,manifestFile,dependencyFile,
    privateValues,privateFields,calls,head:revision,pendingFiles:[],nasFiles:[],nas:{version:'1.2.3',revision,...privateFields},
    sources:{[revision]:nasSources(),[olderRevision]:nasSources()},health:{healthy:true,failedChecks:[],...privateFields}};
  f.dependencies={
    projectSource:project,clock:()=>now,
    probe:current=>{calls.probe++;assert.deepEqual(current.roots,roots);return f.snapshot;},
    health:()=>{calls.health++;return f.health;},
    delay:async ms=>{calls.delays.push(ms);},
    ssh:(file,args,settings)=>{
      calls.ssh.push({file,args,settings});
      assert.equal(file,'ssh');
      assert.deepEqual(args,['-T','-o','BatchMode=yes','-o','ConnectTimeout=8',
        '-o','StrictHostKeyChecking=yes','-o','UpdateHostKeys=no','-o','ControlMaster=no',
        '-o','ControlPath=none','-o','ClearAllForwardings=yes','-o','PermitLocalCommand=no','synthetic-nas',
        'cat -- /volume3/docker/checkin-fabric-v2/release.json']);
      assert.equal(settings.timeout,20_000);
      assert.equal(settings.stdio[2],'ignore');
      return JSON.stringify(f.nas);
    },
    gitExec:(file,args,settings)=>{
      calls.git.push(args);assert.equal(file,'git');assert.equal(settings.env.GIT_OPTIONAL_LOCKS,'0');
      assert.equal(settings.stdio[2],'ignore');
      if(args[0]==='rev-parse'){assert.deepEqual(args,['rev-parse','HEAD']);return f.head+'\n';}
      if(args[0]==='show'){
        assert.equal(args.length,2);
        const [at,file]=args[1].split(':');
        assert.ok(Object.hasOwn(f.sources[at]??{},file),'unexpected revision source read: '+args[1]);
        return f.sources[at][file];
      }
      assert.deepEqual(args.slice(0,6),['diff','--name-only','-z','--no-renames','--no-ext-diff','--no-textconv']);
      assert.equal(args.at(-1),'--');
      const [from,to]=args.slice(6,8);
      const changed=from===to?[]:to===f.head&&f.head!==revision?f.pendingFiles:f.nasFiles;
      return changed.join('\0')+(changed.length?'\0':'');
    }
  };
  return f;
}
const edit=(file,update)=>{const value=JSON.parse(fs.readFileSync(file,'utf8'));update(value);save(file,value);};
const run=f=>runDoctor(f.options,f.dependencies);

test('all healthy evidence produces a concise Chinese summary and exit 0',async t=>{
  const f=fixture(t),result=await run(f);
  assert.equal(result.exitCode,0);assert.deepEqual(result.attention,[]);
  assert.equal(result.sections.gate.ok,true);assert.equal(result.sections.gate.phase,'settled');
  assert.equal(result.sections.verify.result,'pass');assert.equal(result.sections.audit.fileDrift,0);
  assert.deepEqual(result.sections.daily.counts,{done:4,verifying:1,actionNeeded:0,external:0,paused:0,noFeature:2});
  assert.deepEqual(result.sections.pt.counts.status,{signed:2,unknown:1});
  assert.equal(f.calls.probe,1);assert.equal(f.calls.health,1);
  const summary=formatDoctor(result);
  assert.match(summary,/只读体检：正常/);assert.match(summary,/调度：主任务 Ready/);
  assert.match(summary,/版本：.*1\.2\.3 \/ a{12}/);
  assert.ok(summary.split('\n').length<=15);
});

test('only actionNeeded from the daily verdict adds daily attention, independent of sync state',async t=>{
  const f=fixture(t);
  let result=await run(f);assert.equal(result.sections.daily.counts.verifying,1);
  assert.equal(result.attention.some(item=>item.section==='daily'),false);
  edit(f.ptFile,v=>Object.assign(v.tasks[6],{observedStatus:'login_required',retryable:false,retryExhaustedForDay:true}));
  result=await run(f);assert.equal(result.sections.daily.counts.actionNeeded,1);
  assert.ok(result.attention.some(item=>item.section==='daily'&&item.code==='action_needed'));
  fs.writeFileSync(f.stateFile,'{');result=await run(f);
  assert.equal(result.sections.daily.counts.actionNeeded,1);
  edit(f.ptFile,v=>Object.assign(v.tasks[6],{retryable:true,retryExhaustedForDay:false,nextEligibleAt:'2026-10-31T05:00:00Z'}));
  result=await run(f);assert.equal(result.sections.daily.counts.actionNeeded,0);
  assert.equal(result.attention.some(item=>item.section==='daily'),false);
});

const attentionCases=[
  ['file drift','audit','file_drift',f=>save(path.join(f.roots.execution,'src/runner.mjs'),{changed:true}),/受管文件存在漂移/],
  ['dependency drift','audit','dependency_drift',f=>save(f.dependencyFile,{version:'2.0.0'}),/已安装依赖存在漂移/],
  ['version mismatch','versions','version_mismatch',f=>edit(path.join(f.roots.observation,'release.json'),v=>{v.version='1.2.4';}),/版本或提交不一致/],
  ['revision mismatch','versions','version_mismatch',f=>edit(path.join(f.roots.operations,'release.json'),v=>{v.revision=nextRevision;}),/版本或提交不一致/],
  ['main disabled','tasks','task_state',f=>{f.snapshot.tasks.value[0].state='Disabled';},/主任务状态异常/],
  ['sync disabled','tasks','task_state',f=>{f.snapshot.tasks.value[1].state='Disabled';},/同步任务状态异常/],
  ['main abnormal result','tasks','task_result',f=>{f.snapshot.tasks.value[0].lastResult=1;},/主任务上次结果码异常/],
  ['sync abnormal result','tasks','task_result',f=>{f.snapshot.tasks.value[1].lastResult=2;},/同步任务上次结果码异常/],
  ['three sync failures','sync','sync_failures',f=>edit(f.stateFile,v=>{v.failureCount=3;}),/同步已连续失败至少三次/],
  ['stale sync','sync','sync_stale',f=>edit(f.stateFile,v=>{v.lastSuccessAt=new Date(now.getTime()-121*60_000).toISOString();}),/同步最后成功已超过两小时/],
  ['health failure','health','health_failures',f=>{f.health={healthy:false,failedChecks:['stalePrivateTempClean']};},/stalePrivateTempClean/],
  ['verify failure','verify','verification_failed',f=>{f.snapshot.gatewayEvents.value=[{time:finishedAt,...f.privateFields}];},/发布后核验失败/],
  ['NAS application difference','nas','nas_behind',f=>{f.nas.revision=olderRevision;f.nasFiles=['observation/public/app.js'];},/NAS 面板相关文件/],
  ['NAS unreadable','nas','unavailable',f=>{f.dependencies.ssh=()=>{throw Error(f.privateValues.join(' '));};},/NAS无法校验/],
  ['NAS invalid JSON','nas','unavailable',f=>{f.dependencies.ssh=()=>'{';},/NAS无法校验/]
];
for(const [name,section,code,mutate,message] of attentionCases)test(name+' independently requires attention',async t=>{
  const f=fixture(t);mutate(f);const result=await run(f);
  assert.equal(result.exitCode,1);
  assert.ok(result.attention.some(item=>item.section===section&&item.code===code),JSON.stringify(result.attention));
  assert.match(formatDoctor(result),message);
  if(section==='nas'&&code==='unavailable')assert.match(result.sections.nas.summary,/无法校验/);
});

test('gate before_run and settling are informational; long-lived site states do not require attention',async t=>{
  const f=fixture(t);
  f.snapshot.finalReport.value.runId='20261030-080500-001-abcdef';
  f.snapshot.finalReport.value.results=[{status:'verification_pending'},{status:'external_blocked'},
    {status:'submission_outcome_unknown',submissionAttempted:true}];
  let result=await run(f);
  assert.equal(result.exitCode,0);assert.equal(result.sections.gate.ok,false);
  assert.equal(result.sections.gate.phase,'before_run');
  f.snapshot.finalReport.value.runId=today.replaceAll('-','')+'-080500-001-abcdef';
  f.snapshot.notifications.value=[{delivered:false}];
  result=await run(f);assert.equal(result.exitCode,0);assert.equal(result.sections.gate.phase,'settling');
});

test('before the main run, absent daily results and a previous-day PT snapshot remain informational',async t=>{
  const f=fixture(t);fs.unlinkSync(f.dailyFile);
  edit(f.ptFile,v=>{v.businessDate='2026-10-30';});
  f.snapshot.finalReport.value.runId='20261030-080500-001-abcdef';
  f.snapshot.finalReport.value.finishedAt='2026-10-30T03:00:00Z';
  f.snapshot.tasks.value[0].lastRun=deployedAt;
  let result=await run(f);
  assert.equal(result.exitCode,0);assert.equal(result.sections.verify.result,'pending');
  assert.equal(result.sections.daily.status,'info');assert.equal(result.sections.pt.status,'info');
  assert.equal(result.sections.daily.counts,undefined);assert.equal(result.sections.pt.counts,undefined);
  fs.unlinkSync(f.ptFile);result=await run(f);
  assert.equal(result.exitCode,0);assert.equal(result.sections.pt.status,'info');
});

for(const [role,state,code] of [['main','Ready',2],['main','Running',267009],['sync','Running',267009]]){
  test(role+' accepts '+state+' with result '+code,async t=>{
    const f=fixture(t),task=f.snapshot.tasks.value.find(task=>task.role===role);
    task.state=state;task.lastResult=code;
    const result=await run(f);assert.equal(result.exitCode,0);
    if(state==='Running')assert.equal(result.sections.verify.result,'pending');
  });
}

test('verify pending and newer managed source remain informational, NAS compares to Windows deployment',async t=>{
  const f=fixture(t);f.snapshot.tasks.value[0].lastRun=deployedAt;
  f.head=nextRevision;
  f.pendingFiles=['execution/src/runner.mjs','observation/scripts/helper.ps1','docs/note.md','execution/config/config.local.json'];
  const result=await run(f);
  assert.equal(result.exitCode,0);assert.equal(result.sections.verify.result,'pending');
  assert.equal(result.sections.pending.files,2);assert.equal(result.sections.nas.files,0);
  assert.ok(f.calls.git.some(args=>args[0]==='diff'&&args[6]===revision&&args[7]===nextRevision));
});

for(const failures of [1,2])test(failures+' sync failures and a recent success remain informational',async t=>{
  const f=fixture(t);edit(f.stateFile,v=>{v.failureCount=failures;v.lastFailureCause='connection_timeout';});
  const result=await run(f);assert.equal(result.exitCode,0);
  assert.equal(result.sections.sync.lastFailureCause,'connection_timeout');
});

test('exactly two hours since sync success is accepted',async t=>{
  const f=fixture(t);edit(f.stateFile,v=>{v.lastSuccessAt=new Date(now.getTime()-120*60_000).toISOString();});
  assert.equal((await run(f)).exitCode,0);
});

test('NAS ignores different revisions with only Windows-side files changed',async t=>{
  const f=fixture(t);f.nas.revision=olderRevision;f.nas.version='1.0.0';
  f.nasFiles=['execution/scripts/Test-CheckinHealth.ps1','observation/scripts/Sync-NasShadow.ps1',
    'observation/schemas/snapshot.schema.json','docs/release-and-recovery.md','tools/doctor.mjs'];
  const result=await run(f);
  assert.equal(result.exitCode,0);assert.equal(result.sections.nas.files,0);
});

for(const file of ['observation/src/dashboard-server.mjs','observation/public/app.js','observation/Dockerfile',
  'observation/compose.nas.yaml','observation/compose.worker.yaml','observation/.dockerignore',
  'observation/compose.extra.yaml']){
  test('NAS includes runtime source '+file,async t=>{
    const f=fixture(t);f.nas.revision=olderRevision;f.nasFiles=[file];
    const result=await run(f);assert.equal(result.exitCode,1);assert.equal(result.sections.nas.files,1);
  });
}

test('unreachable packaged modules and the secrets README are informational',async t=>{
  const f=fixture(t);f.nas.revision=olderRevision;
  f.nasFiles=['gateway-error.mjs','harvest-fallback.mjs','legacy-engine.mjs','pt-site-execution.mjs']
    .map(file=>'observation/src/'+file).concat('observation/secrets/README.md');
  const result=await run(f);
  assert.equal(result.exitCode,0);assert.deepEqual(result.attention,[]);
  assert.equal(result.sections.nas.files,0);assert.equal(result.sections.nas.bundledOnlyFiles,5);
  assert.equal(result.sections.nas.status,'info');
  assert.match(formatDoctor(result),/5 个打包文件不同，NAS 不运行，无需部署/);
});

test('NAS follows a directly imported runtime module',async t=>{
  const f=fixture(t);f.nas.revision=olderRevision;f.nasFiles=['observation/src/runtime.mjs'];
  f.sources[revision]['observation/src/dashboard-server.mjs']="import './runtime.mjs';";
  f.sources[revision]['observation/src/runtime.mjs']='export const ready=true;';
  const result=await run(f);
  assert.equal(result.exitCode,1);assert.equal(result.sections.nas.files,1);
  assert.ok(result.attention.some(item=>item.code==='nas_behind'));
});

test('NAS follows indirect re-exports and literal dynamic imports at the deployed target revision',async t=>{
  const f=fixture(t);f.nas.revision=olderRevision;f.head=nextRevision;
  f.nasFiles=['observation/src/b.mjs'];
  Object.assign(f.sources[revision],{
    'observation/src/dashboard-server.mjs':"import {a} from './a.mjs';",
    'observation/src/a.mjs':"export {b as a} from './middle.mjs';",
    'observation/src/middle.mjs':"await import('./b.mjs');",
    'observation/src/b.mjs':'export const b=true;'
  });
  const result=await run(f);
  assert.equal(result.exitCode,1);assert.equal(result.sections.nas.files,1);
  assert.equal(result.sections.nas.reachableModules,4);
  assert.ok(f.calls.git.filter(args=>args[0]==='show').every(args=>args[1].startsWith(revision+':')));
});

for(const file of ['observation/package.json','observation/package-lock.json']){
  test(file+' ignores just root package versions',async t=>{
    const f=fixture(t);f.nas.revision=olderRevision;f.nasFiles=[file];
    const old=JSON.parse(f.sources[olderRevision][file]);old.version='1.0.0';
    if(old.packages)old.packages[''].version='1.0.0';
    f.sources[olderRevision][file]=JSON.stringify(old,null,2);
    const result=await run(f);
    assert.equal(result.exitCode,0);assert.equal(result.sections.nas.files,0);
    assert.equal(result.sections.nas.versionOnlyFiles,1);assert.deepEqual(result.attention,[]);
    assert.match(result.sections.nas.summary,/仅版本不同，无需部署/);
  });
  test(file+' still warns about dependency changes',async t=>{
    const f=fixture(t);f.nas.revision=olderRevision;f.nasFiles=[file];
    const current=JSON.parse(f.sources[revision][file]);
    if(current.packages)current.packages['node_modules/fixture-sdk'].version='2.0.0';
    else current.dependencies['fixture-sdk']='2.0.0';
    f.sources[revision][file]=JSON.stringify(current);
    const result=await run(f);
    assert.equal(result.exitCode,1);assert.equal(result.sections.nas.files,1);
    assert.ok(result.attention.some(item=>item.code==='nas_behind'));
  });
}

test('nonliteral imports conservatively include only their module directory',async t=>{
  const f=fixture(t);f.nas.revision=olderRevision;
  Object.assign(f.sources[revision],{
    'observation/src/dashboard-server.mjs':"import './plugins/loader.mjs';",
    'observation/src/plugins/loader.mjs':"export const load=name=>import('./'+name+'.mjs');"
  });
  f.nasFiles=['observation/src/plugins/nested/extra.mjs','observation/src/outside.mjs'];
  const result=await run(f);
  assert.equal(result.exitCode,1);assert.equal(result.sections.nas.files,1);
  assert.equal(result.sections.nas.bundledOnlyFiles,1);assert.equal(result.sections.nas.unresolvedImports,1);
  assert.match(result.sections.nas.summary,/动态 import 无法解析，已按所在目录保守计入/);
  assert.ok(!JSON.stringify(result).includes('plugins/'));
  f.nasFiles=['observation/src/outside.mjs'];
  assert.equal((await run(f)).exitCode,0);
});

test('pure graph walk supports side effects, multiline imports, re-exports, literals and cycles',()=>{
  const sources={...nasSources(),
    'observation/src/dashboard-server.mjs':"import './side.mjs';\nimport {\n a\n} from './a.mjs';",
    'observation/src/side.mjs':"export * from './a.mjs';",
    'observation/src/a.mjs':"export {b as a} from './b.mjs';",
    'observation/src/b.mjs':"import './a.mjs'; await import( /* literal */ './dynamic.mjs', {with:{type:'javascript'}});",
    'observation/src/dynamic.mjs':'export const ready=true;'
  };
  const reads=[];
  const runtime=collectNasRuntime(file=>{reads.push(file);assert.ok(Object.hasOwn(sources,file),file);return sources[file];});
  assert.deepEqual([...runtime.modules].sort(),['a.mjs','b.mjs','dashboard-server.mjs','dynamic.mjs','side.mjs'].map(file=>'observation/src/'+file));
  assert.equal(reads.filter(file=>file==='observation/src/a.mjs').length,1);
  assert.equal(runtime.unresolvedImports.length,0);
});

test('imports from the Windows execution root stay out of the NAS graph',()=>{
  const sources=nasSources();
  sources['observation/src/dashboard-server.mjs']="const {x}=await import(pathToFileURL(path.join(legacyRoot,'src/x.mjs')).href);";
  const external=collectNasRuntime(file=>sources[file]);
  assert.deepEqual([...external.conservativeDirectories],[]);
  assert.equal(external.unresolvedImports.length,0);
  sources['observation/src/dashboard-server.mjs']='await import(chooseModule());';
  const unknown=collectNasRuntime(file=>sources[file]);
  assert.deepEqual([...unknown.conservativeDirectories],['observation/src/']);
});

test('import text in comments, strings and regexes does not create dependencies',()=>{
  const sources=nasSources();
  sources['observation/src/dashboard-server.mjs']=[
    '// import "./comment.mjs";',
    '/* export * from "./block.mjs"; */',
    'const example="import(\'./string.mjs\')";',
    'const pattern=/import(\'regex\')/;',
    'const url=import.meta.url;',
    'const object={import(){}}; object.import("./method.mjs");'
  ].join('\n');
  const runtime=collectNasRuntime(file=>{assert.ok(Object.hasOwn(sources,file),file);return sources[file];});
  assert.deepEqual([...runtime.modules],['observation/src/dashboard-server.mjs']);
  assert.equal(runtime.unresolvedImports.length,0);
});

test('entry discovery reads Docker commands and both Compose command forms',()=>{
  const sources=nasSources();
  sources['observation/Dockerfile']='ENTRYPOINT ["node"]\nCMD ["src/dashboard-server.mjs"]\n';
  sources['observation/compose.nas.yaml']='services:\n  dashboard:\n    command: node /app/src/base.mjs\n';
  sources['observation/compose.worker.yaml']='services:\n  dashboard:\n    entrypoint:\n      - node\n      - ./src/worker.mjs\n';
  assert.deepEqual(nasEntrypoints(file=>sources[file]),['base.mjs','dashboard-server.mjs','worker.mjs'].map(file=>'observation/src/'+file));
});

test('template expressions retain literal imports and conservatively classify computed arguments',()=>{
  const sources={...nasSources(),
    'observation/src/dashboard-server.mjs':[
      'const result=`text ${await import("./a.mjs")} ${`nested ${await import("./b.mjs")}`}`;',
      'await import(`./c.mjs`);',
      'await import(`./${name}.mjs`);'
    ].join('\n'),
    'observation/src/a.mjs':'export const a=true;',
    'observation/src/b.mjs':'export const b=true;',
    'observation/src/c.mjs':'export const c=true;'
  };
  const runtime=collectNasRuntime(file=>{assert.ok(Object.hasOwn(sources,file),file);return sources[file];});
  assert.equal(runtime.modules.size,4);
  assert.equal(runtime.unresolvedImports.length,1);
  assert.deepEqual([...runtime.conservativeDirectories],['observation/src/']);
});

test('the real repository revision graph includes the dashboard entrypoint',()=>{
  const settings={cwd:project,encoding:'utf8',windowsHide:true,timeout:8_000,
    stdio:['ignore','pipe','ignore'],env:{...process.env,GIT_OPTIONAL_LOCKS:'0'}};
  const at=execFileSync('git',['rev-parse','HEAD'],settings).trim();
  const runtime=collectNasRuntime(file=>execFileSync('git',['show',at+':'+file],settings));
  assert.ok(runtime.modules.has('observation/src/dashboard-server.mjs'));
  assert.deepEqual(runtime.entrypoints,['observation/src/dashboard-server.mjs']);
});

test('SSH retries once after three seconds and a successful retry is normal',async t=>{
  const f=fixture(t),ssh=f.dependencies.ssh;
  f.dependencies.ssh=(...args)=>{
    const body=ssh(...args);
    if(f.calls.ssh.length===1)throw Error(f.privateValues.join(' '));
    return body;
  };
  const result=await run(f);
  assert.equal(result.exitCode,0);assert.equal(f.calls.ssh.length,2);
  assert.deepEqual(f.calls.delays,[3_000]);assert.deepEqual(result.errors,[]);
  assert.deepEqual(f.calls.ssh[0],f.calls.ssh[1]);
});

test('two SSH failures require attention and record only the ssh stage',async t=>{
  const f=fixture(t),ssh=f.dependencies.ssh;
  f.dependencies.ssh=(...args)=>{ssh(...args);throw Error(f.privateValues.join(' '));};
  const result=await run(f);
  assert.equal(result.exitCode,1);assert.equal(f.calls.ssh.length,2);
  assert.deepEqual(f.calls.delays,[3_000]);
  assert.deepEqual(result.errors,[{section:'nas',code:'read_failed',stage:'ssh'}]);
  for(const value of f.privateValues)assert.ok(!JSON.stringify(result).includes(value));
});

for(const body of ['{',JSON.stringify({version:'1.2.3',revision:'invalid'})]){
  test('invalid NAS marker is a parse failure and never retried: '+body,async t=>{
    const f=fixture(t),ssh=f.dependencies.ssh;
    f.dependencies.ssh=(...args)=>{ssh(...args);return body;};
    const result=await run(f);
    assert.equal(result.exitCode,1);assert.equal(f.calls.ssh.length,1);
    assert.deepEqual(f.calls.delays,[]);assert.equal(result.errors[0].stage,'parse');
  });
}

test('revision source read failure records diff stage without retrying SSH',async t=>{
  const f=fixture(t),git=f.dependencies.gitExec;
  f.dependencies.gitExec=(file,args,settings)=>{
    if(args[0]==='show')throw Error(f.privateValues.join(' '));
    return git(file,args,settings);
  };
  const result=await run(f);
  assert.equal(result.exitCode,1);assert.equal(f.calls.ssh.length,1);assert.deepEqual(f.calls.delays,[]);
  assert.deepEqual(result.errors,[{section:'nas',code:'read_failed',stage:'diff'}]);
  for(const value of f.privateValues)assert.ok(!JSON.stringify(result).includes(value));
});

test('NAS does not compare generated release metadata or non-exported inputs',()=>{
  for(const file of ['observation/release.json','observation/TRANSFER-MANIFEST.txt','observation/nas-data/data.json',
    'observation/secrets/admin.txt','observation/scripts/export-nas-bundle.mjs','observation/tests/ui.test.mjs'])
    assert.equal(isNasSource(file),false,file);
});

test('--no-nas does not read operations config or invoke SSH',async t=>{
  const f=fixture(t);f.options.noNas=true;fs.unlinkSync(f.operationsConfig);
  f.dependencies.ssh=()=>assert.fail('SSH must be skipped');
  const result=await run(f);assert.equal(result.exitCode,0);assert.match(result.sections.nas.summary,/已跳过/);
});

test('missing matching manifest is informational',async t=>{
  const f=fixture(t);edit(f.manifestFile,v=>{v.revision=olderRevision;});
  let result=await run(f);assert.equal(result.exitCode,0);assert.equal(result.sections.audit.status,'info');
  assert.equal(result.sections.audit.summary,'无法校验（没有匹配的清单）');
  f.options.backupRoot=path.join(f.root,'no-backups');
  result=await run(f);assert.equal(result.exitCode,0);assert.equal(result.sections.audit.status,'info');
});

test('manifest discovery chooses the newest matching revision, and --manifest takes precedence',async t=>{
  const f=fixture(t),old=structuredClone(f.plan);
  old.files[0].afterHash='f'.repeat(64);
  save(f.manifestFile,old);fs.utimesSync(f.manifestFile,1,1);
  const matching=path.join(f.options.backupRoot,'release-b/manifest.json');
  save(matching,f.plan);fs.utimesSync(matching,2,2);
  const unrelated=path.join(f.options.backupRoot,'release-c/manifest.json');
  save(unrelated,{...old,revision:olderRevision});fs.utimesSync(unrelated,3,3);
  assert.equal((await run(f)).sections.audit.fileDrift,0);
  f.options.manifest=f.manifestFile;
  const result=await run(f);assert.equal(result.exitCode,1);assert.equal(result.sections.audit.fileDrift,1);
});

test('manifest for another root is rejected before auditing',async t=>{
  const f=fixture(t);edit(f.manifestFile,v=>{v.roots.execution=path.join(f.root,'unselected');});
  const result=await run(f);assert.equal(result.exitCode,1);assert.equal(result.sections.audit.status,'unavailable');
  assert.equal(result.sections.health.healthy,true);
});

const unavailableCases=[
  ['versions',f=>fs.unlinkSync(path.join(f.roots.observation,'release.json'))],
  ['probe',f=>{f.dependencies.probe=()=>{throw Error(f.privateValues.join(' '));};}],
  ['audit',f=>fs.writeFileSync(f.manifestFile,'{')],
  ['pending',f=>{f.dependencies.gitExec=()=>{throw Error(f.privateValues.join(' '));};}],
  ['tasks',f=>{f.snapshot.tasks={ok:false,error:'read_failed',private:f.privateFields};}],
  ['sync',f=>fs.writeFileSync(f.stateFile,'{')],
  ['health',f=>{f.dependencies.health=()=>{throw Error(f.privateValues.join(' '));};}],
  ['daily',f=>edit(f.ptFile,v=>{v.tasks='invalid';})],
  ['pt',f=>edit(f.ptFile,v=>{v.businessDate='2026-10-30';})]
];
for(const [section,mutate] of unavailableCases)test(section+' read failure preserves independent sections',async t=>{
  const f=fixture(t);mutate(f);const result=await run(f);
  assert.equal(result.exitCode,1);assert.equal(Object.keys(result.sections).length,12);
  assert.ok(result.errors.some(item=>item.section===section||item.section.startsWith(section+'.')));
  assert.ok(result.attention.some(item=>item.section===section));
  assert.ok(result.sections.nas.summary.length>0);
  if(section!=='health')assert.equal(result.sections.health.healthy,true);
  if(!['daily','pt'].includes(section))assert.equal(result.sections.daily.counts.done,4);
});

test('missing local tool returns 2 while keeping available evidence',async t=>{
  const f=fixture(t);f.dependencies.gitExec=()=>{throw Object.assign(Error('unavailable'),{code:'ENOENT',syscall:'spawnSync git'});};
  const result=await run(f);assert.equal(result.exitCode,2);
  assert.ok(result.errors.some(item=>item.code==='tool_unavailable'));
  assert.equal(result.sections.daily.counts.done,4);assert.equal(result.sections.health.healthy,true);
});

test('missing or incomplete configuration and invalid arguments return 2 without invoking probes',async t=>{
  const f=fixture(t),file=path.join(f.root,'config.local.json');save(file,f.options);
  for(const argv of [[],['--config',path.join(f.root,'missing.local.json'),'--json'],
    ['--config',file,'--unknown'],['--config',file,'--json','--json']]){
    let output;assert.equal(await runDoctorCli(argv,{probe:assert.fail,health:assert.fail,stdout:value=>{output=value;}}),2);
    assert.doesNotMatch(output,/missing.local|synthetic-main-task/);
  }
  save(file,{executionRoot:f.options.executionRoot});
  let output;assert.equal(await runDoctorCli(['--config',file,'--json'],{probe:assert.fail,stdout:value=>{output=value;}}),2);
  assert.equal(JSON.parse(output).errors[0].section,'config');
});

test('CLI resolves config-relative roots and supports JSON and Chinese output',async t=>{
  const f=fixture(t),file=path.join(f.root,'release.local.json');
  save(file,{...f.options,executionRoot:'execution',observationRoot:'observation',opsRoot:'operations',backupRoot:'backups'});
  assert.equal(parseDoctorOptions(['--config',file]).executionRoot,f.roots.execution);
  for(const asJson of [true,false]){
    let output;
    assert.equal(await runDoctorCli(['--config',file,...(asJson?['--json']:[])],
      {...f.dependencies,stdout:value=>{output=value;}}),0);
    if(asJson)assert.equal(JSON.parse(output).sections.verify.result,'pass');
    else assert.match(output,/只读体检：正常/);
  }
});

function hashes(root){
  const result={};
  function walk(dir){
    for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
      const file=path.join(dir,entry.name);
      if(entry.isDirectory())walk(file);
      else result[path.relative(root,file)]=crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    }
  }
  walk(root);return result;
}
test('one complete invocation neither writes files nor opens browser credential stores',async t=>{
  const f=fixture(t),configFile=path.join(f.root,'release.local.json');save(configFile,f.options);
  for(const name of ['Cookies','Login Data'])save(path.join(f.roots.execution,'data/profile',name),{sentinel:true});
  const before=hashes(f.root),read=fs.readFileSync,open=fs.openSync;
  for(const method of ['mkdirSync','writeFileSync','renameSync','unlinkSync','rmSync','copyFileSync','appendFileSync'])
    t.mock.method(fs,method,()=>assert.fail('doctor attempted '+method));
  t.mock.method(fs,'readFileSync',(file,...args)=>{
    assert.ok(!['Cookies','Login Data'].includes(path.basename(String(file))),'credential store opened');
    return read(file,...args);
  });
  t.mock.method(fs,'openSync',(file,flags,...args)=>{
    assert.ok(flags==='r'||flags===fs.constants.O_RDONLY,'write or lock opened');
    return open(file,flags,...args);
  });
  let output;
  const code=await runDoctorCli(['--config',configFile,'--json'],{...f.dependencies,stdout:value=>{output=value;}});
  t.mock.restoreAll();
  assert.equal(code,0);assert.equal(JSON.parse(output).exitCode,0);
  assert.deepEqual(hashes(f.root),before);
});

test('JSON, summaries and failures omit synthetic identities, sites, paths and command lines',async t=>{
  const f=fixture(t);
  edit(f.stateFile,v=>{v.failureCount=1;v.lastFailureCause='upload '+f.privateValues.join(' ')+' (cause=connection_timeout)';});
  let result=await run(f);
  for(const text of [JSON.stringify(result),formatDoctor(result)])
    for(const value of [...f.privateValues,...Object.values(f.roots),f.options.taskNames.main,'synthetic-nas'])
      assert.ok(!text.includes(value),'private fixture value leaked');
  f.health={healthy:false,failedChecks:[f.privateValues[0],f.privateValues[1],f.privateValues[2]]};
  f.dependencies.ssh=()=>{throw Error(f.privateValues.join(' '));};
  result=await run(f);
  for(const text of [JSON.stringify(result),formatDoctor(result)])
    for(const value of f.privateValues)assert.ok(!text.includes(value),'private failure value leaked');
  assert.ok(result.sections.health.failedChecks.every(code=>code==='unrecognizedCheck'));
});
