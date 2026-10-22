import test from 'node:test';
import assert from 'node:assert/strict';
import {preserveResultObservationTimes} from '../src/result-identity.mjs';

const initial='2026-10-15T00:05:00.000Z',later='2026-10-15T11:00:00.000Z';
const unknown={origin:'https://pt.example',accountKey:'site-default',status:'needs_attention',
  failureCode:'submission_outcome_unknown',submissionAttempted:true};

test('targeted resumes preserve the original time of an untouched uncertain submission',()=>{
  const original=[unknown],first=preserveResultObservationTimes(original,initial);
  const second=preserveResultObservationTimes(first,later);
  assert.equal(second[0].observedAt,initial);
  assert.equal(second[0].failureCode,'submission_outcome_unknown');
  assert.equal(second[0].submissionAttempted,true);
  assert.equal(original[0].observedAt,undefined);
});

test('a genuinely new result receives the new observation time without changing the old result',()=>{
  const inherited=preserveResultObservationTimes([unknown],initial)[0];
  const fresh={...unknown,origin:'https://other.example'};
  const merged=preserveResultObservationTimes([inherited,fresh],later);
  assert.equal(merged[0].observedAt,initial);
  assert.equal(merged[1].observedAt,later);
});

test('evidence timestamps survive newer report publication and explicit times are never rewritten',()=>{
  const confirmed={origin:'https://pt.example',status:'already_signed',evidence:{confirmedAt:initial}};
  const results=preserveResultObservationTimes([confirmed,{...unknown,observedAt:initial},{...unknown,observedAt:'invalid'}],later);
  assert.equal(results[0].observedAt,initial);
  assert.equal(results[1].observedAt,initial);
  assert.equal(results[2].observedAt,'invalid');
  assert.equal(preserveResultObservationTimes([unknown],'invalid')[0].observedAt,undefined);
});
