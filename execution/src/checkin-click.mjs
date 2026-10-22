import {assertBookmarkNavigation} from './security.mjs';

const selector='button, a, [role="button"], input[type="button"], input[type="submit"]';
const started=new WeakSet();
export const checkinClickStarted=page=>started.has(page);
const unavailable=()=>({status:'no_action',failureCode:'checkin_control_unavailable',submissionAttempted:false,
  reason:'签到控件尚未稳定可点击，未提交签到'});
const uncertain=()=>({status:'needs_attention',failureCode:'submission_outcome_unknown',submissionAttempted:true,retryable:false,
  reason:'签到点击已开始但结果未确认，先只读核验'});

export async function clickCheckinCandidate(page,candidate,{allowedOrigins,beforeSubmit,opensDialog=false}={}){
  let handle;
  try{
    try{
      assertBookmarkNavigation(page.url(),allowedOrigins);
      handle=await page.locator(selector).nth(candidate.index).elementHandle();
      if(!handle)return unavailable();
      await handle.click({trial:true,timeout:10000});
      const current=await handle.evaluate(element=>{
        const style=getComputedStyle(element),rect=element.getBoundingClientRect();
        return {tagName:element.tagName,
          text:String(element.innerText||element.value||element.getAttribute('aria-label')||element.title||'').replace(/\s+/g,' ').trim(),
          href:element instanceof HTMLAnchorElement?element.href:null,formAction:element.form?element.form.action:null,
          visible:element.isConnected&&style.display!=='none'&&style.visibility!=='hidden'&&rect.width>0&&rect.height>0,
          disabled:Boolean(element.disabled||element.getAttribute('aria-disabled')==='true')};
      });
      if(!current.visible||current.disabled||['tagName','text','href','formAction'].some(key=>(current[key]??null)!==(candidate[key]??null)))return unavailable();
      assertBookmarkNavigation(page.url(),allowedOrigins);
      for(const destination of [current.href,current.formAction])if(destination)assertBookmarkNavigation(destination,allowedOrigins);
    }catch{return unavailable();}
    // Bind and check the selected element before recording intent. Once the
    // real click starts, a timeout remains uncertain even if the DOM changes.
    if(!opensDialog)beforeSubmit?.();
    if(!opensDialog)started.add(page);
    try{await handle.click({timeout:10000});return null;}
    catch{return opensDialog?unavailable():uncertain();}
  }finally{await handle?.dispose().catch(()=>{});}
}
