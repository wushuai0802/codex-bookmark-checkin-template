export const TIMED_OUT=Symbol('timed_out');

// A timeout never carries response bodies or exception text. The caller must
// stop its own continuation; this does not cancel an in-flight browser call.
export async function bounded(promise,ms){
  let timer;
  try{return await Promise.race([promise,new Promise(resolve=>{
    timer=setTimeout(()=>resolve(TIMED_OUT),Math.max(0,ms));
  })]);}
  finally{clearTimeout(timer);}
}
