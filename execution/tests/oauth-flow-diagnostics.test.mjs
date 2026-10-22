import test from 'node:test';
import assert from 'node:assert/strict';
import {createOAuthTrace,readOAuthProgress} from '../src/oauth-flow-diagnostics.mjs';
import {loginHelperOutcome,parseLoginHelperResult} from '../src/login-recovery.mjs';

function fixture(){
  const lines=[],disk=[];let time=1000;
  const trace=createOAuthTrace({root:'fixture',origin:'https://private.example',provider:'LinuxDO',clock:()=>time,
    writeProgress:line=>lines.push(line),io:{mkdirSync:()=>{},existsSync:()=>false,appendFileSync:(_file,line)=>disk.push(line)}});
  return {trace,lines,disk,advance:()=>{time+=1000;}};
}
test('progress uses fixed stages and booleans without copying private context',()=>{
  const f=fixture();f.trace.emit('provider_login',{body:'PRIVATE_BODY',url:'PRIVATE_URL',account:'PRIVATE_ACCOUNT'});f.advance();
  f.trace.emit('callback_wait',{callbackObserved:false});f.trace.finish(false);
  assert.doesNotMatch(f.lines.join(''),/PRIVATE|private\.example|account/);
  const progress=readOAuthProgress(f.lines.join(''));
  assert.equal(progress.oauthStage,'callback_wait');assert.equal(progress.oauthElapsedMs,1000);
  assert.equal(f.disk.length,3);
});
test('a timeout retains the last stage without treating a checkpoint as login success',()=>{
  const f=fixture();f.trace.emit('authorization');
  const outcome=loginHelperOutcome('', 'timeout', f.lines.join(''));
  assert.equal(outcome.succeeded,false);assert.equal(outcome.status,'timeout');assert.match(outcome.diagnostic,/等待授权/);
  assert.equal(outcome.oauthStage,'authorization');
  f.trace.finish(true);assert.equal(loginHelperOutcome('','failed',f.lines.join('')).succeeded,false);
});
test('diagnostic lines do not replace a multiline helper result or alter its failure code',()=>{
  const f=fixture();f.trace.emit('identity_verify');
  const result={status:'needs_attention',failureCode:'account_mismatch'};
  assert.deepEqual(parseLoginHelperResult(JSON.stringify(result,null,2)+'\n'+f.lines.join('')),result);
  const outcome=loginHelperOutcome(JSON.stringify(result),'failed',f.lines.join(''));
  assert.equal(outcome.failureCode,'account_mismatch');assert.equal(outcome.retryable,false);
});
test('unknown stages, raw errors and invalid checkpoint fields are ignored',()=>{
  const f=fixture();f.trace.emit('untrusted_stage');assert.equal(f.lines.length,0);
  f.trace.emit('target_login');const value=JSON.parse(f.lines[0]);
  for(const changed of [{oauthStage:'unknown'},{flowId:'invalid'},{elapsedMs:-1},{elapsedMs:Infinity}])
    assert.equal(readOAuthProgress(JSON.stringify({...value,...changed})),null);
  assert.equal(readOAuthProgress('PRIVATE_ERROR'),null);
});
test('logging failures cannot interrupt the helper and duplicate phases are bounded',()=>{
  const f=fixture();for(let i=0;i<100;i++)f.trace.emit('authorization');assert.equal(f.lines.length,1);
  const trace=createOAuthTrace({root:'fixture',origin:'https://example.test',writeProgress:()=>{throw Error('busy');},
    io:{mkdirSync:()=>{throw Error('busy');}}});assert.doesNotThrow(()=>trace.emit('target_login'));
});

test('a full daily file keeps its byte limit while stderr progress remains available',()=>{
  let appended=0;const progress=[];
  const trace=createOAuthTrace({root:'fixture',origin:'https://example.test',writeProgress:line=>progress.push(line),
    io:{mkdirSync:()=>{},existsSync:()=>true,lstatSync:()=>({isFile:()=>true,isSymbolicLink:()=>false,size:1024*1024-1}),
      appendFileSync:()=>{appended++;}}});
  trace.emit('callback_wait');
  assert.equal(appended,0);assert.equal(readOAuthProgress(progress.join('')).oauthStage,'callback_wait');
});
