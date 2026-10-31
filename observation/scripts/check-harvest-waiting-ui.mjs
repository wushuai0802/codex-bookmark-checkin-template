import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';
import {buildSnapshot} from '../src/bridge.mjs';
import {createDashboardServer} from '../src/dashboard-server.mjs';
import {projectHarvestWindow} from '../public/harvest-window.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'harvest-wait-ui-'));
const at=new Date().toISOString(),day=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date());
const snapshot=buildSnapshot({legacyRoot:fileURLToPath(new URL('../tests/fixtures/legacy/',import.meta.url)),generatedAt:at});
snapshot.businessDate=day;snapshot.tasks=snapshot.tasks.map(task=>({...task,businessDate:day,observedStatus:'signed'}));
snapshot.receipts=snapshot.tasks.map(task=>({taskId:task.taskId,status:'signed',observedAt:at,
  evidence:{source:'page_text',authoritative:true,verification:'verified',summary:'今日已签到',redacted:true}}));
snapshot.counts={...snapshot.counts,status:{signed:snapshot.tasks.length}};
snapshot.health={healthy:true,sourceCheckedAt:at,freshness:{fresh:true},failedCheckCount:0};
const site=(name,managed)=>({origin:'https://'+name+'.example',displayName:managed?'等待站点':'独立站点',inLegacyPlan:false,
  fallbackEnabled:true,harvestManaged:managed,effective:{source:'harvest',status:'unknown',fresh:false,authoritative:false,observedAt:null,
    evidence:{source:'none',authoritative:false,summary:'暂无今日回执'}},observations:[],sourceStatuses:[]});
snapshot.ptStatus={businessDate:day,generatedAt:at,sites:[site('waiting',true),site('independent',false)],counts:{sites:2,inLegacyPlan:0,fallbackOnly:2},
  harvestWindow:projectHarvestWindow({schemaVersion:1,source:'harvest',businessDate:day,generatedAt:at,taskSchedule:{businessDate:day,scheduledAt:at}})};
fs.writeFileSync(path.join(root,'shadow-beta-snapshot.json'),JSON.stringify(snapshot));
const {server}=createDashboardServer({dataDir:root,bind:'127.0.0.1',port:0,adminToken:'',rateLimitPerMinute:10000});
let browser;
try{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  browser=await chromium.launch({headless:true,channel:process.env.FABRIC_UI_BROWSER??'chrome'});
  for(const width of [1440,390,320]){
    const context=await browser.newContext({viewport:{width,height:900},timezoneId:'Asia/Shanghai',reducedMotion:'reduce'});
    try{
      const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
      await page.goto(base+'/#overview');
      await page.waitForFunction(()=>document.querySelector('.summary-waiting'));
      const view=await fetch(base+'/api/overview').then(r=>r.json());
      assert.equal(view.tasks.filter(task=>task.waiting).length,1);
      // The independent site has no receipt: today's verdict is verifying, not actionNeeded.
      assert.equal(await page.locator('#kpi-grid [data-kind="actionable"] .kpi-value').textContent(),'0');
      assert.equal(await page.locator('#kpi-grid [data-kind="proof"] .kpi-value').textContent(),'1');
      assert.equal(await page.locator('#kpi-grid [data-kind="waiting"] .kpi-value').textContent(),'1');
      assert.match(await page.locator('#daily-summary h2').textContent(),/1 项等待 Harvest/);
      await page.locator('.summary-waiting').click();
      await page.waitForFunction(()=>document.querySelector('#task-status')?.value==='waiting');
      assert.ok(page.url().includes('status=waiting'));
      const waiting=await fetch(base+'/api/tasks?status=waiting').then(r=>r.json());
      assert.equal(waiting.total,1);assert.equal(waiting.tasks[0].origin,'https://waiting.example');
      await page.goto(base+'/#pt-status');
      await page.locator('#pt-kpis').getByRole('button',{name:/等待 Harvest/}).click();
      assert.equal(await page.locator('#pt-status-body tr').count(),1);
      assert.match(await page.locator('#pt-status-body').textContent(),/等待 Harvest/);
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
      assert.deepEqual(errors,[]);console.log('PASS waiting '+width+'px: summary, filters, PT stage and layout');
    }finally{await context.close();}
  }
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));fs.rmSync(root,{recursive:true,force:true,maxRetries:30,retryDelay:100});}
