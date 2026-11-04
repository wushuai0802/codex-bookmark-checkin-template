import {piggoOrigin,piggoLockedUrl} from './piggo-calendar.mjs';

const loginUrl=piggoOrigin+'/login';
export const usernameSelector='form input[name="username"][autocomplete~="username"]';
export const passwordSelector='form input[name="password"][type="password"][autocomplete~="current-password"]';
// Vue omits type on its login button; HTML defaults a form button to submit.
export const submitSelector='form button:not([type]), form button[type="submit"]';
export const unlockPasswordSelector='form.step-up input.cell-input[name="password"][type="password"][autocomplete~="current-password"]';
export const unlockSubmitSelector='form.step-up button.btn[type="submit"]';

// Supplied StepUpGate contract. The hidden username is structural proof only.
export async function inspectPiggoIdleUnlock(page){
  if(page.url()!==piggoLockedUrl)return null;
  return page.evaluate(({unlockPasswordSelector,unlockSubmitSelector})=>{
    const visible=element=>{const rect=element.getBoundingClientRect(),style=getComputedStyle(element);
      return rect.width>0&&rect.height>0&&style.display!=='none'&&style.visibility!=='hidden';};
    const challenge=!!document.querySelector('iframe, [data-sitekey], .cf-turnstile, .g-recaptcha, .h-captcha, [class*="captcha" i], [id*="captcha" i]');
    const inputs=[...document.querySelectorAll('input')];
    const otp=inputs.some(input=>/one-time-code|otp|totp|two.?step|2fa|验证码|驗證碼/i.test(
      [input.autocomplete,input.name,input.id,input.placeholder].join(' ')));
    const forms=[...document.querySelectorAll('form')],form=forms[0];
    const usernames=[...document.querySelectorAll('form.step-up input.username-a11y')];
    const passwords=[...document.querySelectorAll(unlockPasswordSelector)],username=usernames[0],password=passwords[0];
    const submits=[...document.querySelectorAll('button,input')].filter(element=>element.type==='submit'&&visible(element));
    const buttons=[...document.querySelectorAll(unlockSubmitSelector)];
    const action=form?.getAttribute('action');let destination;
    try{destination=action==null?null:new URL(action,location.href);}catch{}
    const reviewed=!challenge&&!otp&&forms.length===1&&document.querySelectorAll('form.step-up').length===1&&
      usernames.length===1&&passwords.length===1&&username.form===form&&password.form===form&&
      username.type==='text'&&username.name==='username'&&username.autocomplete==='username'&&username.readOnly&&
      username.getAttribute('tabindex')==='-1'&&!username.disabled&&
      visible(password)&&!password.disabled&&!password.readOnly&&password.getAttribute('required')!==null&&
      inputs.length===2&&inputs.every(input=>input===username||input===password)&&
      submits.length===1&&buttons.length===1&&submits[0]===buttons[0]&&buttons[0].form===form&&
      buttons[0].textContent.trim()==='解锁'&&!buttons[0].disabled&&
      (!form.target||form.target==='_self')&&(action==null||destination?.href===location.origin+'/locked')&&
      !document.querySelector('base[href]');
    return {reviewed,challenge,otp};
  },{unlockPasswordSelector,unlockSubmitSelector});
}

// Reviewed against the supplied login chunk and anonymous DOM observation.
// The private review opt-in and rejection of any challenge remain mandatory.
export async function inspectPiggoSpaLogin(page){
  if(page.url()!==loginUrl)return null;
  return page.evaluate(({usernameSelector,passwordSelector})=>{
    const visible=element=>{const rect=element.getBoundingClientRect(),style=getComputedStyle(element);
      return rect.width>0&&rect.height>0&&style.display!=='none'&&style.visibility!=='hidden';};
    const challenge=!!document.querySelector('iframe, [data-sitekey], .cf-turnstile, .g-recaptcha, .h-captcha, [class*="captcha" i], [id*="captcha" i]');
    const inputs=[...document.querySelectorAll('input')].filter(visible);
    const otp=inputs.some(input=>/one-time-code|otp|totp|two.?step|2fa|验证码|驗證碼/i.test(
      [input.autocomplete,input.name,input.id,input.placeholder].join(' ')));
    const usernames=[...document.querySelectorAll(usernameSelector)],passwords=[...document.querySelectorAll(passwordSelector)];
    const username=usernames[0],password=passwords[0],form=username?.form;
    const buttons=[...document.querySelectorAll('button,input')].filter(element=>element.type==='submit'&&visible(element));
    const action=form?.getAttribute('action');
    let destination;try{destination=action==null?null:new URL(action,location.href);}catch{}
    const reviewed=usernames.length===1&&passwords.length===1&&form===password.form&&
      (!form.target||form.target==='_self')&&(action==null||destination?.href===location.origin+'/login')&&
      !document.querySelector('base[href]')&&username.type==='text'&&
      inputs.every(input=>input===username||input===password)&&
      [username,password].every(input=>visible(input)&&!input.disabled&&!input.readOnly)&&
      buttons.length===1&&buttons[0].form===form&&buttons[0].textContent.trim()==='登录'&&!buttons[0].disabled;
    return {reviewed,challenge,otp};
  },{usernameSelector,passwordSelector});
}

