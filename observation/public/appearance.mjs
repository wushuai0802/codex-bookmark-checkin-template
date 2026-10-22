export const APPEARANCE_KEY='fabricAppearance';
export const APPEARANCE_DEFAULTS=Object.freeze({mode:'ultra',cards:true,motion:true,refraction:70,transparency:70});
const percentage=(value,fallback)=>Number.isFinite(Number(value))&&value!==null
  ? Math.min(100,Math.max(0,Math.round(Number(value)))):fallback;
export function normalizeAppearance(value){
  const input=value&&typeof value==='object'?value:{};
  return {mode:['none','standard','ultra'].includes(input.mode)?input.mode:APPEARANCE_DEFAULTS.mode,
    cards:input.cards!==false,motion:input.motion!==false,
    refraction:percentage(input.refraction,70),transparency:percentage(input.transparency,70)};
}
export function readAppearance(){
  try{return normalizeAppearance(JSON.parse(localStorage.getItem(APPEARANCE_KEY)));}
  catch{return {...APPEARANCE_DEFAULTS};}
}
let current=null;
export function applyAppearance(value){
  current=normalizeAppearance(value);
  const root=document.documentElement;
  root.dataset.liquidGlass=current.mode;root.dataset.liquidCards=String(current.cards);
  root.dataset.liquidMotion=String(current.motion);
  root.style.setProperty('--liquid-alpha',String(.85-current.transparency*.0072));
  for(const button of document.querySelectorAll('[data-glass-mode-choice]')){
    button.setAttribute('aria-pressed',String(button.dataset.glassModeChoice===current.mode));
  }
  for(const key of ['cards','motion','refraction','transparency']){
    const control=document.getElementById('glass-'+key);if(!control)continue;
    if(control.type==='checkbox')control.checked=current[key];else control.value=String(current[key]);
    if(control.type==='range')control.disabled=current.mode==='none';
    const output=document.getElementById('glass-'+key+'-value');if(output)output.value=current[key]+'%';
  }
  window.dispatchEvent(new CustomEvent('fabricappearancechange',{detail:{...current}}));
  return {...current};
}
export function setAppearance(patch){
  const next=normalizeAppearance({...current??readAppearance(),...patch});
  try{localStorage.setItem(APPEARANCE_KEY,JSON.stringify(next));}catch{/* In-memory controls remain usable. */}
  return applyAppearance(next);
}
export function installAppearanceControls(){
  applyAppearance(readAppearance());
  for(const button of document.querySelectorAll('[data-glass-mode-choice]')){
    button.addEventListener('click',()=>setAppearance({mode:button.dataset.glassModeChoice}));
  }
  for(const key of ['cards','motion','refraction','transparency']){
    const control=document.getElementById('glass-'+key);
    control?.addEventListener(control.type==='range'?'input':'change',()=>setAppearance({[key]:control.type==='checkbox'?control.checked:Number(control.value)}));
  }
  document.getElementById('glass-reset')?.addEventListener('click',()=>setAppearance(APPEARANCE_DEFAULTS));
  window.addEventListener('storage',event=>{if(event.key===APPEARANCE_KEY||event.key===null)applyAppearance(readAppearance());});
}
