import {displacementField} from './glass-geometry.mjs';
import {readAppearance} from './appearance.mjs';
import {playMotion,reducedMotion} from './motion.mjs';

const NS='http://www.w3.org/2000/svg';
const controls='.topbar,.sidebar .nav,.mobile-dock,.nav-indicator,.ui-select-menu,.button.primary,.icon-button';
const cards='.daily-summary,.kpi,.panel,.site-card,.account-card,.mobile-task-card';
const entries=new Map(),textures=new Map();
let preferences=readAppearance(),serial=0,frame=0,defs,intersection,resize;
const svg=(tag,attributes={})=>{const node=document.createElementNS(NS,tag);for(const [key,value] of Object.entries(attributes))node.setAttribute(key,String(value));return node;};
const isCard=node=>node.matches(cards)&&!node.matches(controls);
const svgBackdrop=()=>CSS.supports('backdrop-filter','url("#fabric-liquid-probe")')&&/(?:Chrome|Chromium|Edg)\//.test(navigator.userAgent);

function texture(width,height,radius,bevel){
  const key=[width,height,radius,bevel].join(':');
  if(textures.has(key))return textures.get(key);
  const map=displacementField(width,height,radius,bevel);
  const canvas=document.createElement('canvas');canvas.width=map.width;canvas.height=map.height;
  canvas.getContext('2d').putImageData(new ImageData(map.data,map.width,map.height),0,0);
  const image=canvas.toDataURL();textures.set(key,image);
  if(textures.size>32)textures.delete(textures.keys().next().value);
  return image;
}

function dropFilter(entry){
  entry.filter?.remove();entry.filter=null;entry.geometry='';
  entry.node.style.removeProperty('--liquid-filter');delete entry.node.dataset.liquidLens;
}

function update(entry){
  const {node}=entry;
  if(!entry.visible||!node.isConnected||preferences.mode==='none'||(isCard(node)&&!preferences.cards)){
    dropFilter(entry);return;
  }
  const width=Math.round(node.offsetWidth),height=Math.round(node.offsetHeight);
  if(width<4||height<4){dropFilter(entry);return;}
  if(!svgBackdrop()){node.dataset.liquidLens='compatible';return;}
  const radius=Math.min(parseFloat(getComputedStyle(node).borderTopLeftRadius)||0,width/2,height/2);
  node.style.setProperty('--liquid-radius',`${radius}px`);
  const ultra=preferences.mode==='ultra',bevel=Math.min(ultra?24:17,Math.max(5,radius));
  const geometry=[width,height,radius,bevel,ultra].join(':');
  if(entry.geometry!==geometry){
    dropFilter(entry);
    const id='fabric-liquid-'+(++serial);
    const filter=svg('filter',{id,x:'0%',y:'0%',width:'100%',height:'100%',filterUnits:'objectBoundingBox',primitiveUnits:'userSpaceOnUse','color-interpolation-filters':'sRGB'});
    filter.append(svg('feImage',{href:texture(width,height,radius,bevel),x:0,y:0,width,height,preserveAspectRatio:'none',result:'lens'}));
    filter.append(svg('feGaussianBlur',{in:'SourceGraphic',stdDeviation:.65,result:'base'}));
    const haze=node.matches('.mobile-dock,.sidebar .nav')?7:node.matches('.ui-select-menu,.topbar')?4.5:isCard(node)?1.6:1.2;
    filter.append(svg('feGaussianBlur',{in:'SourceGraphic',stdDeviation:haze,result:'haze'}));
    if(ultra){
      for(const [name,channel] of [['red',0],['green',1],['blue',2]]){
        filter.append(svg('feDisplacementMap',{in:'base',in2:'lens',scale:0,xChannelSelector:'R',yChannelSelector:'G',result:name+'Shift','data-channel':name}));
        const matrix=Array(20).fill(0);matrix[channel*5+channel]=1;matrix[19]=1;
        filter.append(svg('feColorMatrix',{in:name+'Shift',type:'matrix',values:matrix.join(' '),result:name}));
      }
      filter.append(svg('feBlend',{in:'red',in2:'green',mode:'screen',result:'rg'}));
      filter.append(svg('feBlend',{in:'rg',in2:'blue',mode:'screen',result:'rgb'}));
      filter.append(svg('feComposite',{in:'rgb',in2:'base',operator:'in',result:'glass'}));
    }else filter.append(svg('feDisplacementMap',{in:'base',in2:'lens',scale:0,xChannelSelector:'R',yChannelSelector:'G',result:'glass'}));
    filter.append(svg('feColorMatrix',{in:'lens',type:'matrix',values:'0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 1 0 0',result:'edgeMask'}));
    filter.append(svg('feComposite',{in:'glass',in2:'edgeMask',operator:'in',result:'edgeGlass'}));
    filter.append(svg('feComposite',{in:'haze',in2:'edgeMask',operator:'out',result:'centerGlass'}));
    filter.append(svg('feComposite',{in:'edgeGlass',in2:'centerGlass',operator:'arithmetic',k2:1,k3:1,result:'combined'}));
    filter.append(svg('feColorMatrix',{in:'combined',type:'saturate',values:ultra?1.18:1.08}));
    defs.append(filter);entry.filter=filter;entry.geometry=geometry;
    node.style.setProperty('--liquid-filter',`url("#${id}")`);
  }
  const strength=preferences.refraction/100*Math.min(ultra?38:25,Math.min(width,height)*.45);
  for(const map of entry.filter.querySelectorAll('feDisplacementMap')){
    const dispersion=map.dataset.channel==='red'?1.035:map.dataset.channel==='blue'?.965:1;
    map.setAttribute('scale',String(strength*dispersion));
  }
  node.dataset.liquidLens='refractive';
}

function scan(){
  cancelAnimationFrame(frame);
  frame=requestAnimationFrame(()=>{
    const enabled=preferences.mode!=='none'&&document.documentElement.dataset.workspace==='cpam';
    for(const [node,entry] of entries){
      if(!node.isConnected||!enabled||(isCard(node)&&!preferences.cards)){
        intersection.unobserve(node);resize.unobserve(node);dropFilter(entry);entry.sheen.remove();
        node.classList.remove('liquid-surface');entries.delete(node);
      }else{
        node.classList.add('liquid-surface');
        if(entry.sheen.parentNode!==node)node.prepend(entry.sheen);
      }
    }
    if(!enabled)return;
    for(const node of document.querySelectorAll(preferences.cards?controls+','+cards:controls)){
      if(entries.has(node))continue;
      const sheen=document.createElement('span');sheen.className='liquid-sheen';sheen.setAttribute('aria-hidden','true');
      node.classList.add('liquid-surface');node.prepend(sheen);
      const entry={node,sheen,visible:false,filter:null,geometry:''};entries.set(node,entry);
      intersection.observe(node);resize.observe(node);
    }
    for(const entry of entries.values())update(entry);
  });
}

export function installLiquidGlass(){
  const root=svg('svg',{'aria-hidden':'true',focusable:'false',class:'liquid-definitions'});
  defs=svg('defs');root.append(defs);document.body.append(root);
  intersection=new IntersectionObserver(records=>{for(const record of records){const entry=entries.get(record.target);if(entry){entry.visible=record.isIntersecting;update(entry);}}},{rootMargin:'80px'});
  resize=new ResizeObserver(records=>{for(const record of records){const entry=entries.get(record.target);if(entry)update(entry);}});
  const observer=new MutationObserver(scan);observer.observe(document.body,{childList:true,subtree:true});
  window.addEventListener('fabricappearancechange',event=>{preferences=event.detail;scan();});
  const status=document.getElementById('glass-capability');
  if(status)status.textContent=svgBackdrop()?'当前浏览器支持背景折射':'当前浏览器使用兼容材质';
  let pressed=null,pressFrame=0;
  const move=event=>{
    if(!pressed)return;const point={x:event.clientX,y:event.clientY};
    cancelAnimationFrame(pressFrame);pressFrame=requestAnimationFrame(()=>{
      if(!pressed?.isConnected)return;const box=pressed.getBoundingClientRect();
      pressed.style.setProperty('--liquid-light-x',`${(point.x-box.left)/box.width*100}%`);
      pressed.style.setProperty('--liquid-light-y',`${(point.y-box.top)/box.height*100}%`);
    });
  };
  document.addEventListener('pointerdown',event=>{
    if(event.button!==0||preferences.mode==='none')return;
    pressed=event.target.closest('.liquid-surface');if(!pressed)return;
    pressed.dataset.liquidPressed='true';move(event);
  },{passive:true});
  document.addEventListener('pointermove',move,{passive:true});
  const release=event=>{
    if(pressed)delete pressed.dataset.liquidPressed;pressed=null;
    const button=event.target.closest('button:not(:disabled)');
    if(event.type==='pointerup'&&preferences.mode!=='none'&&preferences.motion&&!reducedMotion()
      &&button?.matches('.button,.icon-button,.dock-item,.ui-select-trigger,.nav-item')){
      void playMotion(button,[{transform:'scale(.975)'},{transform:'scale(1.025)',offset:.6},{transform:'scale(1)'}],280);
    }
  };
  document.addEventListener('pointerup',release,{passive:true});document.addEventListener('pointercancel',release,{passive:true});
  scan();
}
