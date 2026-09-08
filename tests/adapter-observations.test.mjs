import test from 'node:test';
import assert from 'node:assert/strict';
import {publicAdapterObservations} from '../src/adapter-observations.mjs';
test('adapter evidence stays a separate sanitized observation report',()=>{
 const input={mode:'observe_only',results:[{origin:'https://fixture.example',status:'signed',accountKey:'primary',identity:{userId:'123',username:'reader',password:'secret'},evidence:{authoritative:true,source:'api',cookie:'private'},mutationCount:0}]};
 const r=publicAdapterObservations(input);assert.equal(r.counts.confirmed,1);assert.equal(r.results[0].identity.userId,'123');assert.doesNotMatch(JSON.stringify(r),/password|secret|cookie|private/);
 assert.equal(publicAdapterObservations({...input,mode:'execute'}),null);
 assert.equal(publicAdapterObservations({...input,results:[{origin:'https://name:secret@fixture.example',status:'signed'}]}).counts.total,0);
 assert.equal(publicAdapterObservations({...input,results:[{origin:'https://fixture.example',identity:null,status:'unknown',mutationCount:0}]}).counts.blocked,1);
 assert.equal(publicAdapterObservations({...input,results:[{origin:'https://fixture.example',identity:null,status:'signed',mutationCount:1}]}).counts.total,0);
});
