import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';
import sharp from 'sharp';
import {buildSnapshot} from '../src/bridge.mjs';
import {createDashboardServer} from '../src/dashboard-server.mjs';

const artifacts=fs.mkdtempSync(path.join(os.tmpdir(),'fabric-liquid-glass-'));
const publicRoot=fileURLToPath(new URL('../public/',import.meta.url));
const dataDir=path.join(artifacts,'data');fs.mkdirSync(dataDir);
const snapshot=buildSnapshot({legacyRoot:fileURLToPath(new URL('../tests/fixtures/legacy/',import.meta.url)),generatedAt:new Date().toISOString()});
snapshot.businessDate=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date());
snapshot.tasks=snapshot.tasks.map(task=>({...task,businessDate:snapshot.businessDate}));
fs.writeFileSync(path.join(dataDir,'shadow-beta-snapshot.json'),JSON.stringify(snapshot));
const {server}=createDashboardServer({dataDir,adminToken:'',bind:'127.0.0.1',port:0,rateLimitPerMinute:10000});
let browser;
try{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true,channel:process.env.FABRIC_UI_BROWSER??'chrome'});
  const optical=await browser.newContext({viewport:{width:650,height:450}});
  try{
    const page=await optical.newPage();
    const html=`<!doctype html><html data-workspace="cpam" data-theme="light" data-liquid-glass="ultra"><head><meta charset="utf-8"><link rel="stylesheet" href="/liquid-glass.css"><style>
body{margin:0;background:#eff5fd!important;font-family:system-ui;color:#19314b}.pattern{position:fixed;inset:0;background-color:#eff5fd;background-image:repeating-linear-gradient(90deg,rgba(46,112,186,.9) 0 3px,transparent 3px 25px),repeating-linear-gradient(0deg,rgba(208,96,168,.9) 0 3px,transparent 3px 25px)}
.panel{position:absolute;left:100px;top:90px;width:420px;height:250px;border:1px solid #fff;border-radius:48px;box-sizing:border-box;padding:35px;overflow:hidden}.panel h1{font-size:26px}.panel p{font-size:16px}
</style></head><body><div class="pattern"></div><article class="panel"><h1>Liquid Glass</h1><p>Background refraction and dispersion</p></article><script type="module">import {installLiquidGlass} from '/liquid-glass.mjs';installLiquidGlass();</script></body></html>`;
    await page.route('http://glass.test/**',route=>{
      const file=new URL(route.request().url()).pathname;
      if(file==='/lab')return route.fulfill({contentType:'text/html',body:html});
      if(!['/liquid-glass.css','/liquid-glass.mjs','/appearance.mjs','/glass-geometry.mjs','/motion.mjs'].includes(file))return route.abort();
      return route.fulfill({contentType:file.endsWith('.css')?'text/css':'text/javascript',body:fs.readFileSync(path.join(publicRoot,file))});
    });
    await page.goto('http://glass.test/lab');
    await page.waitForFunction(()=>document.querySelector('.panel').dataset.liquidLens==='refractive');
    const refracted=await page.locator('.panel').screenshot({path:path.join(artifacts,'refraction-on.png')});
    await page.evaluate(()=>{for(const map of document.querySelectorAll('feDisplacementMap'))map.setAttribute('scale','0');});
    const neutral=await page.locator('.panel').screenshot({path:path.join(artifacts,'refraction-zero.png')});
    const a=await sharp(refracted).ensureAlpha().raw().toBuffer({resolveWithObject:true}),b=await sharp(neutral).ensureAlpha().raw().toBuffer();
    let edge=0,center=0,edgeN=0,centerN=0;
    for(let y=10;y<a.info.height-10;y++)for(let x=10;x<a.info.width-10;x++){
      const rim=x<30||x>a.info.width-30||y<30||y>a.info.height-30;
      const middle=x>80&&x<a.info.width-80&&y>85&&y<a.info.height-55;
      if(!rim&&!middle)continue;
      const i=(y*a.info.width+x)*4,d=(Math.abs(a.data[i]-b[i])+Math.abs(a.data[i+1]-b[i+1])+Math.abs(a.data[i+2]-b[i+2]))/3;
      if(rim){edge+=d;edgeN++;}else{center+=d;centerN++;}
    }
    const edgeDifference=edge/edgeN,centerDifference=center/centerN;
    assert.ok(edgeDifference>2,'background pixels must move when refraction is enabled');
    assert.ok(edgeDifference>centerDifference*2,'distortion should concentrate at the bevel');
    console.log(`PASS optical pixels: edge=${edgeDifference.toFixed(2)}, center=${centerDifference.toFixed(2)}`);
  }finally{await optical.close();}

  const context=await browser.newContext({viewport:{width:390,height:900},reducedMotion:'reduce'});
  try{
    const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(base+'/#settings');
    await page.waitForFunction(()=>document.querySelector('#service-status').textContent.includes('已连接'));
    const choose=mode=>page.locator(`[data-glass-mode-choice="${mode}"]`).click();
    await choose('none');
    await page.waitForFunction(()=>document.querySelectorAll('.liquid-definitions filter').length===0);
    await page.reload();await page.waitForFunction(()=>document.documentElement.dataset.liquidGlass==='none');
    assert.equal(await page.locator('[data-glass-mode-choice="none"]').getAttribute('aria-pressed'),'true');
    await choose('standard');
    await page.waitForFunction(()=>document.querySelectorAll('.liquid-definitions feDisplacementMap').length>0);
    assert.equal(await page.locator('.liquid-definitions [data-channel]').count(),0);
    await choose('ultra');
    await page.waitForFunction(()=>document.querySelectorAll('.liquid-definitions [data-channel]').length>0);
    await page.locator('#glass-refraction').focus();await page.keyboard.press('Home');await page.keyboard.press('ArrowRight');
    assert.equal(await page.locator('#glass-refraction-value').textContent(),'1%');
    await page.locator('#glass-cards').uncheck();await page.locator('#glass-motion').uncheck();
    await page.waitForFunction(()=>!document.querySelector('.appearance-panel').classList.contains('liquid-surface'));
    assert.equal(await page.locator('.topbar').evaluate(node=>node.classList.contains('liquid-surface')),true);
    await page.reload();await page.waitForFunction(()=>document.querySelector('#service-status').textContent.includes('已连接'));
    assert.equal(await page.locator('#glass-refraction').inputValue(),'1');
    assert.equal(await page.locator('#glass-cards').isChecked(),false);
    assert.equal(await page.locator('#glass-motion').isChecked(),false);
    await page.locator('#glass-reset').click();
    await page.waitForFunction(()=>document.documentElement.dataset.liquidMotion==='true');
    assert.equal(await page.locator('#glass-refraction').inputValue(),'70');
    assert.equal(await page.locator('#glass-cards').isChecked(),true);
    await page.locator('#mobile-dock [data-view="overview"]').click();
    await page.locator('#refresh-btn').click();
    await page.waitForFunction(()=>!document.querySelector('#refresh-btn').disabled&&document.querySelector('#daily-summary').classList.contains('liquid-surface'));
    assert.equal(await page.locator('#daily-summary > .liquid-sheen').evaluate(node=>getComputedStyle(node).position),'absolute');
    await page.locator('#mobile-dock [data-view="tasks"]').click();
    for(let i=0;i<5;i++){
      await page.locator('.ui-select[data-for="task-status"] .ui-select-trigger').click();
      await page.getByRole('listbox').waitFor();await page.keyboard.press('Escape');
      await page.getByRole('listbox').waitFor({state:'hidden'});
    }
    await page.waitForFunction(()=>!document.querySelector('.ui-select-menu'));
    assert.ok(await page.locator('.liquid-definitions filter').count()<40,'closed surfaces must release optical filters');
    assert.deepEqual(errors,[]);
    console.log('PASS glass settings: quality modes, keyboard sliders, persistence, reset, refresh and cleanup');
  }finally{await context.close();}
  console.log(`Synthetic liquid-glass screenshots: ${artifacts}`);
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
