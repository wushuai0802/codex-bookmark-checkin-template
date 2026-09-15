import {spawn} from 'node:child_process';

const DEFAULT_ALPHABET='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const DEFAULT_LIMIT=8;

function boundedInteger(value,fallback,min,max){
  const number=Number(value);
  return Number.isInteger(number)?Math.max(min,Math.min(max,number)):fallback;
}

function validCandidate(value,{length,alphabet}){
  const code=String(value??'').toUpperCase().replace(/[^A-Z0-9]/g,'');
  if(code.length!==length)return null;
  return [...code].every(character=>alphabet.includes(character))?code:null;
}

function candidatesFromRecognition(value,{length,alphabet,limit}){
  if(typeof value==='string')return [value];
  if(Array.isArray(value))return value.flatMap(item=>candidatesFromRecognition(item,{length,alphabet,limit}));
  if(!value||typeof value!=='object')return [];
  const direct=[value.code,value.answer,value.text,value.value];
  const rows=Array.isArray(value.candidates)?value.candidates:null;
  const flattened=rows?.flatMap(row=>Array.isArray(row)?row:[row])??[];
  const rowCandidates=[];
  if(rows?.length===length&&rows.every(row=>Array.isArray(row))){
    let partial=[''];
    for(const row of rows){
      const options=row.slice(0,3).map(item=>typeof item==='string'?item:item?.character??item?.code).filter(Boolean);
      partial=partial.flatMap(prefix=>options.map(option=>`${prefix}${option}`)).slice(0,limit*2);
    }
    rowCandidates.push(...partial);
  }
  return [...direct,...rowCandidates,...flattened.map(item=>item?.code??item?.answer??item?.character??item)]
    .slice(0,Math.max(limit*4,length));
}

/**
 * Normalize a provider result to a short, ordered list of safe candidates.
 * Providers never receive cookies or page objects; the caller supplies only
 * the challenge image and bounded metadata.
 */
export function normalizeCaptchaCandidates(value,{length=5,alphabet=DEFAULT_ALPHABET,limit=DEFAULT_LIMIT}={}){
  const safeLength=boundedInteger(length,5,1,16);
  const safeAlphabet=String(alphabet||DEFAULT_ALPHABET).slice(0,80);
  const safeLimit=boundedInteger(limit,DEFAULT_LIMIT,1,32);
  const result=[];
  for(const item of candidatesFromRecognition(value,{length:safeLength,alphabet:safeAlphabet,limit:safeLimit})){
    const candidate=validCandidate(item,{length:safeLength,alphabet:safeAlphabet});
    if(candidate&&!result.includes(candidate))result.push(candidate);
    if(result.length>=safeLimit)break;
  }
  return result;
}

/** Resolve an explicitly supplied solver without silently discovering one. */
export function resolveCaptchaSolver({solveCaptcha=null,context=null}={}){
  if(typeof solveCaptcha==='function')return solveCaptcha;
  if(typeof context?.solveCaptcha==='function')return context.solveCaptcha;
  if(typeof context?.captchaSolver==='function')return context.captchaSolver;
  return null;
}

function parseProviderOutput(stdout){
  const text=String(stdout??'').trim();
  if(!text)return null;
  try{return JSON.parse(text);}catch{return text;}
}

/**
 * Build a solver backed by a local executable. The executable receives the
 * image on stdin and may return a plain code or JSON {code,candidates}. No
 * temporary image file, shell, cookie, or browser state is used.
 */
export function createCommandCaptchaSolver({command,args=[],timeoutMs=8000,env}={}){
  if(typeof command!=='string'||!command.trim())throw Error('captcha solver command is required');
  if(!/^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(command.trim()))throw Error('captcha solver command must be an absolute path');
  if(!Array.isArray(args)||args.length>20||args.some(value=>typeof value!=='string'||value.length>200||/[\r\n]/.test(value)))throw Error('captcha solver arguments are invalid');
  const timeout=boundedInteger(timeoutMs,8000,500,30000);
  return (image,{length=5,alphabet=DEFAULT_ALPHABET,limit=DEFAULT_LIMIT}={})=>new Promise(resolve=>{
    if(!Buffer.isBuffer(image)||image.length===0||image.length>4*1024*1024)return resolve([]);
    let settled=false,timer=null;
    const finish=value=>{if(settled)return;settled=true;clearTimeout(timer);resolve(normalizeCaptchaCandidates(value,{length,alphabet,limit}));};
    let child;
    const runtimeEnv={PATH:process.env.PATH??'',SystemRoot:process.env.SystemRoot??'',TEMP:process.env.TEMP??'',TMP:process.env.TMP??''};
    if(env&&typeof env==='object')for(const [key,value] of Object.entries(env))if(/^[A-Za-z_][A-Za-z0-9_]{0,80}$/.test(key)&&value!=null)runtimeEnv[key]=String(value);
    try{child=spawn(command,args,{shell:false,windowsHide:true,stdio:['pipe','pipe','ignore'],env:runtimeEnv});}
    catch{return finish(null);}
    const chunks=[];let outputBytes=0;
    child.stdout.on('data',chunk=>{const remaining=128*1024-outputBytes;if(remaining<=0)return;const value=chunk.length>remaining?chunk.subarray(0,remaining):chunk;chunks.push(value);outputBytes+=value.length;});
    child.once('error',()=>finish(null));
    child.once('close',code=>finish(code===0?parseProviderOutput(Buffer.concat(chunks).toString('utf8')):null));
    timer=setTimeout(()=>{try{child.kill();}catch{};finish(null);},timeout);
    try{child.stdin.end(image);}catch{finish(null);}
  });
}

export function createConfiguredCaptchaSolver({env=process.env,timeoutMs=8000}={}){
  const command=String(env?.CHECKIN_CAPTCHA_SOLVER_COMMAND??'').trim();
  if(!command)return null;
  let args=[];
  const rawArgs=String(env?.CHECKIN_CAPTCHA_SOLVER_ARGS_JSON??'').trim();
  if(rawArgs){try{args=JSON.parse(rawArgs);}catch{throw Error('captcha solver args JSON is invalid');}}
  return createCommandCaptchaSolver({command,args,timeoutMs});
}

/**
 * Compose providers in priority order. An optional second opinion can only
 * reinforce a code already present in the primary candidate list; it cannot
 * independently force a submission.
 */
export function createCaptchaConsensusSolver({primary,secondOpinion=null}={}){
  if(typeof primary!=='function')throw Error('primary captcha solver is required');
  return async(image,options={})=>{
    const primaryCandidates=normalizeCaptchaCandidates(await primary(image,options),options);
    if(!primaryCandidates.length||typeof secondOpinion!=='function')return primaryCandidates;
    let external=[];try{external=normalizeCaptchaCandidates(await secondOpinion(image,options),options);}catch{return primaryCandidates;}
    return external.filter(candidate=>primaryCandidates.includes(candidate));
  };
}

export {DEFAULT_ALPHABET};
