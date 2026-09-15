import test from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import {createCaptchaConsensusSolver,createCommandCaptchaSolver,createConfiguredCaptchaSolver,normalizeCaptchaCandidates,resolveCaptchaSolver} from '../src/captcha-solver.mjs';

const options={length:5,alphabet:'ABCDEFGHJKLMNPQRSTUVWXYZ23456789',limit:4};

test('captcha solver normalizes direct, ranked, and row candidates',()=>{
  assert.deepEqual(normalizeCaptchaCandidates({code:' k p t 2 c '},options),['KPT2C']);
  assert.deepEqual(normalizeCaptchaCandidates({candidates:[
    [{character:'K'}],[{character:'P'}],[{character:'T'}],[{character:'2'}],[{character:'C'}]
  ]},options),['KPT2C']);
  assert.deepEqual(normalizeCaptchaCandidates(['bad','KPT2C','KPT2C','kpt3c'],options),['KPT2C','KPT3C']);
});

test('solver resolution is explicit and does not inspect ambient browser state',()=>{
  const primary=()=>['KPT2C'],context={solveCaptcha:()=>['KP74C']};
  assert.equal(resolveCaptchaSolver({solveCaptcha:primary,context}),primary);
  assert.equal(resolveCaptchaSolver({context}),context.solveCaptcha);
  assert.equal(resolveCaptchaSolver({context:{}}),null);
});

test('second opinion can only reinforce a primary candidate',async()=>{
  const agree=createCaptchaConsensusSolver({primary:async()=>['KPT2C','KP74C'],secondOpinion:async()=>['KP74C']});
  assert.deepEqual(await agree(Buffer.from('image'),options),['KP74C']);
  const disagree=createCaptchaConsensusSolver({primary:async()=>['KPT2C'],secondOpinion:async()=>['AAAAA']});
  assert.deepEqual(await disagree(Buffer.from('image'),options),[]);
});

test('command solver uses stdin, bounded output, and no shell',async()=>{
  const solver=createCommandCaptchaSolver({
    command:process.execPath,
    args:['-e','process.stdin.resume(); process.stdin.on(\"end\",()=>process.stdout.write(JSON.stringify({code:\"KPT2C\"})))'],
    timeoutMs:3000
  });
  assert.deepEqual(await solver(Buffer.from('image'),options),['KPT2C']);
});

test('command solver rejects relative executables',()=>assert.throws(()=>createCommandCaptchaSolver({command:'ocr.exe'}),/absolute path/));

test('configured solver stays disabled unless an explicit command is present',()=>{
  assert.equal(createConfiguredCaptchaSolver({env:{}}),null);
  assert.throws(()=>createConfiguredCaptchaSolver({env:{CHECKIN_CAPTCHA_SOLVER_COMMAND:process.execPath,CHECKIN_CAPTCHA_SOLVER_ARGS_JSON:'not-json'}}),/args JSON/);
});
