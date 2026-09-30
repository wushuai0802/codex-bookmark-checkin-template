import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { buildSnapshot } from '../src/bridge.mjs';
import {createLedgerRecord} from '../src/shadow-ledger.mjs';
import { createDashboardServer } from '../src/dashboard-server.mjs';

const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'fabric-ui-navigation-'));
const dataDir = path.join(artifacts, 'synthetic-data');
fs.mkdirSync(dataDir);
const snapshot = buildSnapshot({
  legacyRoot: fileURLToPath(new URL('../tests/fixtures/legacy/', import.meta.url)),
  generatedAt: new Date().toISOString()
});
const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date());
snapshot.businessDate=today;
snapshot.tasks=snapshot.tasks.map(task=>({...task,businessDate:today,
  ...(task.observedStatus==='needs_attention'?{condition:'upstream_unavailable'}:{})}));
snapshot.ptStatus.businessDate=today;
const ptSite = (host, status, authoritative) => ({
  origin: `https://${host}.example`, displayName: host, fallbackEnabled: true,
  effective: { source: authoritative ? 'harvest' : 'execution-supplement', status,
    observedAt: snapshot.generatedAt, fresh: true, authoritative,
    evidence: { source: authoritative ? 'harvest' : 'page_text', authoritative,
      summary: authoritative ? '今日已完成' : '执行回执待补证' } },
  sourceStatuses: [], observations: []
});
snapshot.ptStatus.sites = [ptSite('confirmed','signed',true),ptSite('reported','signed',false),ptSite('unknown','unknown',false)];
snapshot.ptStatus.sites[0].origin='https://cspt.top';
snapshot.ptStatus.counts = { ...snapshot.ptStatus.counts, sites: 3, externalOnly: 3, fallbackOnly: 3,
  status: { ...snapshot.ptStatus.counts.status, signed: 2, unknown: 1 } };
fs.writeFileSync(path.join(dataDir, 'shadow-beta-snapshot.json'), JSON.stringify(snapshot));
const baseRecord=createLedgerRecord(snapshot),dayMs=86_400_000;
// Real installations have dozens of receipts; small counts hide phone clipping.
const calendarTasks=Array.from({length:48},(_,index)=>({...baseRecord.taskSummaries[0],
  taskId:`task_calendar_${index}`,origin:`https://calendar-${index}.example`,
  displayName:index>=44?`待核验站点 ${index} · 较长名称与回执说明布局检查`:`日历站点 ${index}`,
  observedStatus:index<40?'signed':index<44?'not_available':'needs_attention',
  evidence:{source:'page_text',authoritative:index<44,summary:'站点回执需要核验，请查看上次访问结果及后续状态。'}}));
const historical=Array.from({length:36},(_,index)=>{
  const businessDate=new Date(Date.parse(`${snapshot.businessDate}T00:00:00Z`)-(36-index)*dayMs).toISOString().slice(0,10);
  return {...baseRecord,businessDate,recordedAt:`${businessDate}T12:00:00Z`,
    recordId:`ledger_${(index+1).toString(16).padStart(24,'0')}`,
    counts:{executionUnits:48,status:{signed:40,not_available:4,needs_attention:4}},ptSummaries:[],
    taskSummaries:calendarTasks.map(task=>({...task,businessDate}))};
});
fs.writeFileSync(path.join(dataDir,'shadow-ledger.jsonl'),
  [...historical,baseRecord].map(record=>JSON.stringify(record)).join('\n')+'\n');
const { server } = createDashboardServer({ dataDir, adminToken: '', bind: '127.0.0.1', port: 0 });
let browser;
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, channel: process.env.FABRIC_UI_BROWSER ?? 'chrome' });
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 768, height: 1024 },
    { width: 700, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 740 }]) {
    fs.writeFileSync(path.join(dataDir, 'control-state.json'), JSON.stringify({ schemaVersion: 1, sites: {}, audit: [] }));
    fs.writeFileSync(path.join(dataDir,'operation-requests.json'),JSON.stringify({schemaVersion:1,requests:[],worker:{lastSeenAt:new Date().toISOString()}}));
    const context = await browser.newContext({ viewport, timezoneId: 'Asia/Shanghai' });
    try {
      const page = await context.newPage();
      const errors = [];
      const overviewResponses = [];
      const failedResponses = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('response', response => { if (response.url().includes('/api/overview')) overviewResponses.push(response.status()); });
      page.on('response', response => { if (response.status() >= 400) failedResponses.push(`${new URL(response.url()).pathname}:${response.status()}`); });
      await page.goto(base);
      await page.waitForFunction(() => document.querySelector('#calendar-summary').textContent.length > 0);
      const mobile = viewport.width <= 700;
      await page.locator('#kpi-grid .kpi').nth(2).click();
      assert.equal(await page.locator('#task-status').inputValue(),'pending');
      assert.equal(await page.locator('#tasks-body tr').count(),1);
      if (mobile) {
        assert.equal(await page.locator('#task-mobile-list .mobile-task-card').count(),1);
        assert.equal(await page.locator('#task-mobile-list .mobile-task-card .status-chip').isVisible(),true);
        assert.equal(await page.locator('#view-tasks .table-wrap').isVisible(),false);
      }
      await page.reload();
      await page.waitForFunction(() => document.querySelector('#task-status').value==='pending'
        && document.querySelector('#task-result-count').textContent.includes('1 / 3'));
      assert.equal(await page.locator('#tasks-body tr').count(),1);
      const statusTrigger=page.locator('.ui-select[data-for="task-status"] .ui-select-trigger');
      assert.equal(await page.locator('#task-status').getAttribute('aria-hidden'),'true');
      assert.equal(await page.locator('#task-status').getAttribute('tabindex'),'-1');
      await statusTrigger.click();
      assert.equal(await page.getByRole('listbox',{name:'筛选任务状态'}).isVisible(),true);
      const menuBox=await page.locator('.ui-select-menu').boundingBox();
      assert.ok(menuBox.height<viewport.height*.55,'option list covers too much of the screen');
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('.ui-select-menu').count(),0);
      assert.equal(await statusTrigger.evaluate(node=>document.activeElement===node),true);
      await statusTrigger.click();
      await page.getByRole('listbox').getByRole('option',{name:'已完成'}).click();
      assert.equal(await page.locator('#task-status').inputValue(),'completed');
      assert.equal(await page.locator('#tasks-body tr').count(),2);
      await statusTrigger.click();
      await page.getByRole('listbox').getByRole('option',{name:'尚未完成'}).click();
      assert.equal(await page.locator('#tasks-body tr').count(),1);
      await statusTrigger.press('ArrowDown');
      await page.keyboard.press('Home');
      assert.equal(await page.locator('.ui-select-option:focus').textContent(),'全部任务');
      await page.keyboard.press('Escape');
      await page.goto(base);
      await page.waitForFunction(() => document.querySelector('#calendar-summary').textContent.length > 0);
      await page.locator('#kpi-grid .kpi').nth(1).click();
      assert.equal(await page.locator('#task-status').inputValue(),'unavailable');
      assert.match(await page.locator('#tasks-body').textContent(),/没有匹配的任务/);
      await page.goto(base);
      await page.waitForFunction(() => document.querySelector('#calendar-summary').textContent.length > 0);
      const openCalendar = async () => {
        if (mobile) await page.locator('#menu-toggle').click();
        await page.locator('.nav-item[data-view="calendar"]').click();
        await page.waitForFunction(() => location.hash === '#calendar'
          && document.querySelector('#view-calendar').classList.contains('active-view')
          && !document.querySelector('.main-content').inert);
      };
      await openCalendar();
      assert.equal(await page.locator('#view-overview').isVisible(), false);
      assert.ok(await page.locator('.calendar-day').count() >= 28);
      await page.waitForFunction(()=>document.querySelector('#calendar-summary').textContent.includes('天有回执')
        && !document.querySelector('#calendar-summary').textContent.includes('正在读取历史'));
      const history=await(await fetch(`${base}/api/calendar`)).json();
      assert.equal(history.days.length,37);
      const currentYear=Number(snapshot.businessDate.slice(0,4));
      const choosePeriod=async(id,label,name)=>{
        await page.locator(`.ui-select[data-for="${id}"] .ui-select-trigger`).click();
        await page.getByRole('listbox',{name:label,exact:true}).getByRole('option',{name,exact:true}).click();
        assert.equal(await page.locator(`.ui-select[data-for="${id}"] .ui-select-trigger`).evaluate(el=>el===document.activeElement),true);
      };
      assert.equal(await page.getByRole('button',{name:'后一天',exact:true}).isDisabled(),true);
      await page.getByRole('button',{name:'前一天',exact:true}).click();
      const yesterday=new Date(Date.parse(snapshot.businessDate+'T12:00:00Z')-86400000).toISOString().slice(0,10);
      assert.equal(await page.locator('.calendar-day.selected').getAttribute('data-date'),yesterday);
      await page.getByRole('button',{name:'后一天',exact:true}).click();
      assert.equal(await page.locator('.calendar-day.selected').getAttribute('data-date'),snapshot.businessDate);
      await page.locator('.ui-select[data-for="calendar-year"] .ui-select-trigger').click();
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('.ui-select[data-for="calendar-year"] .ui-select-trigger').evaluate(el=>el===document.activeElement),true);
      await choosePeriod('calendar-year','选择年份',`${currentYear-1} 年`);
      await choosePeriod('calendar-month','选择月份','12 月');
      await page.locator(`.calendar-day[data-date="${currentYear-1}-12-31"]`).click();
      await page.getByRole('button',{name:'后一天',exact:true}).click();
      assert.equal(await page.locator('#calendar-year').inputValue(),String(currentYear));
      assert.equal(await page.locator('#calendar-month').inputValue(),'01');
      assert.equal(await page.locator('.calendar-day.selected').getAttribute('data-date'),`${currentYear}-01-01`);
      await page.getByRole('button',{name:'前一天',exact:true}).click();
      assert.equal(await page.locator('.calendar-day.selected').getAttribute('data-date'),`${currentYear-1}-12-31`);
      await page.getByRole('button',{name:'回到今天'}).click();
      assert.equal((await(await fetch(`${base}/api/overview`)).json()).ledger.length,30);
      await page.locator('.calendar-day').first().click();
      assert.match(await page.locator('#calendar-detail').textContent(), /^\d{4}-\d{2}-01/);
      assert.equal(await page.getByRole('button',{name:'回到今天'}).isEnabled(),true);
      await page.getByRole('button',{name:'回到今天'}).click();
      await page.locator(`.calendar-day[aria-label^="${snapshot.businessDate}"]`).click();
      assert.match(await page.locator('#calendar-detail').textContent(), /项完成/);
      assert.equal(await page.locator('#calendar-detail .calendar-receipt-row').count(),2);
      if(mobile)assert.ok(await page.evaluate(()=>{
        const filters=document.querySelector('.calendar-filters'),right=filters.getBoundingClientRect().right;
        return [...filters.querySelectorAll('button')].every(button=>button.getBoundingClientRect().right<=right+1&&
          button.scrollWidth<=button.clientWidth+1);
      }),`calendar filters are clipped at ${viewport.width}px`);
      const selectedDay=Number(snapshot.businessDate.slice(-2));
      if(selectedDay>1){
        await page.locator(`.calendar-day[data-date="${snapshot.businessDate}"]`).press('ArrowLeft');
        assert.equal(await page.locator('.calendar-day:focus').getAttribute('data-date'),
          `${snapshot.businessDate.slice(0,8)}${String(selectedDay-1).padStart(2,'0')}`);
      }
      await page.locator('.calendar-filters').getByRole('button',{name:/全部/}).click();
      assert.equal(await page.locator('#calendar-detail .calendar-receipt-row').count(),snapshot.tasks.length+snapshot.ptStatus.sites.length);
      assert.equal(await page.locator('.calendar-filters button:focus').getAttribute('aria-pressed'),'true');
      await page.locator('.ui-select[data-for="calendar-scope"] .ui-select-trigger').click();
      await page.getByRole('listbox',{name:'日历范围'}).getByRole('option',{name:'PT 站点'}).click();
      await page.locator('.calendar-filters').getByRole('button',{name:/全部/}).click();
      assert.equal(await page.locator('#calendar-detail .calendar-receipt-row').count(),snapshot.ptStatus.sites.length);
      await page.locator('.ui-select[data-for="calendar-scope"] .ui-select-trigger').click();
      await page.getByRole('listbox',{name:'日历范围'}).getByRole('option',{name:'常规任务'}).click();
      await page.locator('.calendar-filters').getByRole('button',{name:/全部/}).click();
      assert.equal(await page.locator('#calendar-detail .calendar-receipt-row').count(),snapshot.tasks.length);
      const pastMonth=new Date(Date.UTC(currentYear,Number(snapshot.businessDate.slice(5,7))-2,1)).toISOString().slice(0,7);
      if(pastMonth.slice(0,4)!==String(currentYear))await choosePeriod('calendar-year','选择年份',`${pastMonth.slice(0,4)} 年`);
      await choosePeriod('calendar-month','选择月份',`${Number(pastMonth.slice(5))} 月`);
      assert.ok(await page.locator('.calendar-day.warn, .calendar-day.success').count()>0);
      await page.getByRole('button', {name:'回到今天'}).click();
      await page.getByRole('button', {name:'前一天',exact:true}).click();
      assert.equal(await page.locator('.calendar-day.selected .calendar-day-count').textContent(),'40/48');
      assert.equal(await page.locator('#calendar-detail .calendar-receipt-row').count(),4);
      const calendarLayout=await page.evaluate(()=>{
        const rect=node=>node.getBoundingClientRect();
        const controls=[...document.querySelectorAll('#calendar-nav .ui-select-trigger, #calendar-nav .calendar-nav-btn')].map(rect);
        const cells=[...document.querySelectorAll('.calendar-day-count')];
        const counterOverflow=cells.flatMap(node=>{
          const range=document.createRange();range.selectNodeContents(node);
          const text=range.getBoundingClientRect(),cell=rect(node.closest('button'));
          return !node.textContent||text.left>=cell.left+1&&text.right<=cell.right-1?[]:
            [{text:node.textContent,textWidth:text.width,cellWidth:cell.width,font:getComputedStyle(node).font}];
        });
        const filtersFit=[...document.querySelectorAll('.calendar-filters button')].every(node=>node.scrollWidth<=node.clientWidth+1);
        const statsFit=[...document.querySelectorAll('.calendar-stat-label,.calendar-stat-value')].every(node=>{
          const box=rect(node),parent=rect(node.parentElement);return box.left>=parent.left-1&&box.right<=parent.right+1;
        });
        const rowsFit=[...document.querySelectorAll('.calendar-receipt-row')].every(row=>
          rect(row.querySelector('.calendar-receipt-identity')).right<=rect(row.querySelector('.status-chip')).left);
        return {countersFit:!counterOverflow.length,counterOverflow,filtersFit,statsFit,rowsFit,heights:controls.map(box=>box.height),
          rows:new Set(controls.map(box=>Math.round(box.top))).size};
      });
      for(const key of ['countersFit','filtersFit','statsFit','rowsFit'])assert.ok(calendarLayout[key],
        `calendar ${key} at ${viewport.width}px: ${JSON.stringify(calendarLayout)}`);
      assert.ok(calendarLayout.heights.every(height=>height>=40&&Math.abs(height-calendarLayout.heights[0])<=1),
        `calendar controls need consistent touch heights at ${viewport.width}px`);
      assert.equal(calendarLayout.rows,mobile?2:1,`calendar toolbar rows at ${viewport.width}px`);
      assert.equal(await page.locator('[data-top-view="calendar"]').count(), 1);
      assert.ok(await page.locator('#page-title').textContent());
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await page.screenshot({ path: path.join(artifacts, `calendar-${viewport.width}.png`), fullPage: true });
      if(viewport.width===390){
        await page.emulateMedia({colorScheme:'dark'});
        await page.waitForFunction(()=>document.documentElement.dataset.theme==='dark');
        await page.screenshot({path:path.join(artifacts,'calendar-390-dark.png'),fullPage:true,animations:'disabled'});
        await page.emulateMedia({colorScheme:'light'});
        await page.waitForFunction(()=>document.documentElement.dataset.theme==='light');
      }
      await page.goBack();
      await page.waitForFunction(() => location.hash === '#overview'
        && document.querySelector('#view-overview').classList.contains('active-view'));
      await openCalendar();
      await page.reload();
      await page.waitForFunction(() => document.querySelector('.calendar-day')
        && document.querySelector('#view-calendar').classList.contains('active-view'));
      assert.equal(new URL(page.url()).hash, '#calendar');
      // Repeated attention clicks must not hide every view or restart scrolling.
      await page.locator('#attention-jump').click();
      await page.waitForFunction(() => location.hash === '#overview');
      // Opening the queue preserves unread state; acknowledgement is explicit.
      assert.equal(await page.locator('#attention-badge').isVisible(), true);
      await page.getByRole('button',{name:'全部标记为已读'}).click();
      await page.waitForTimeout(1000);
      const scrollBefore = await page.evaluate(() => scrollY);
      for (let i = 0; i < 5; i++) {
        // Click the visible sticky button as a user would; locator.click can
        // scroll its original flow position into view on narrow layouts.
        const box = await page.locator('#attention-jump').boundingBox();
        assert.ok(box && box.y >= 0 && box.y + box.height <= viewport.height);
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      }
      await page.waitForTimeout(900);
      const scrollAfter = await page.evaluate(() => scrollY);
      assert.ok(Math.abs(scrollAfter - scrollBefore) <= 2, `repeated attention scroll: ${scrollBefore} -> ${scrollAfter}`);
      assert.equal(await page.locator('#attention-badge').isVisible(), false);
      assert.equal(await page.locator('.active-view').count(), 1);
      await page.reload();
      try {
        await page.waitForFunction(() => document.querySelector('#service-status').textContent.includes('已连接'), null, { timeout: 8000 });
      } catch {
        await page.screenshot({ path: path.join(artifacts, `reload-failure-${viewport.width}.png`) });
        const diagnostic = await page.evaluate(() => ({ readyState: document.readyState, hash: location.hash,
          activeViews: document.querySelectorAll('.active-view').length,
          calendarLoaded: Boolean(document.querySelector('.calendar-day')) }));
        throw new Error(`reload ${viewport.width}: ${JSON.stringify(diagnostic)}, service=${await page.locator('#service-status').textContent()}, error=${await page.locator('#app-error').textContent()}, overview=${overviewResponses.join(',')}, failedResponses=${failedResponses.join(',')}, pageErrors=${errors.join(' | ')}, artifact=${artifacts}`);
      }
      assert.equal(await page.locator('#attention-badge').isVisible(), false);
      for (const view of ['tasks', 'accounts', 'pt-status', 'sites', 'ledger', 'settings']) {
        if (mobile) await page.locator('#menu-toggle').click();
        await page.locator(`.nav-item[data-view="${view}"]`).click();
        await page.waitForFunction(view => document.querySelector(`#view-${view}`).classList.contains('active-view') && !document.querySelector('.main-content').inert, view);
      }
      if (mobile) await page.locator('#menu-toggle').click();
      await page.locator('.nav-item[data-view="pt-status"]').click();
      assert.match(await page.locator('#pt-kpis').textContent(), /权威完成\s*1/);
      assert.match(await page.locator('#pt-kpis').textContent(), /执行成功待补证\s*1/);
      assert.match(await page.locator('#pt-kpis').textContent(), /状态未知\s*1/);
      await page.locator('#pt-kpis .kpi').filter({hasText:'执行成功待补证'}).click();
      assert.equal(await page.locator('#pt-status-body tr').count(),1);
      assert.match(await page.locator('#pt-status-body').textContent(),/reported\.example/);
      assert.equal(new URL(page.url()).hash,'#pt-status?scope=reported');
      await page.reload();
      await page.waitForFunction(() => document.querySelector('#pt-status-body').textContent.includes('reported.example'));
      assert.equal(await page.locator('#pt-status-body tr').count(),1);
      await page.locator('#pt-kpis .kpi').filter({hasText:'状态未知'}).click();
      assert.equal(await page.locator('#pt-status-body tr').count(),1);
      assert.match(await page.locator('#pt-status-body').textContent(),/unknown\.example/);
      await page.locator('#pt-kpis .kpi').filter({hasText:'PT 站点'}).click();
      await page.locator('#pt-status-body tr').filter({hasText:'https://cspt.top'}).getByRole('button',{name:'只读核验',exact:true}).click();
      await page.waitForFunction(()=>document.querySelector('#pt-status-body').textContent.includes('已排队'));
      const queued=await(await fetch(base+'/api/operations')).json();
      assert.equal(queued.requests.length,1);assert.equal(queued.requests[0].action,'verify');
      assert.equal(queued.requests[0].status,'queued');
      if(mobile)assert.ok(await page.evaluate(()=>{
        const wrap=document.querySelector('#view-pt-status .table-wrap');
        return wrap.querySelector('table').scrollWidth<=wrap.clientWidth+1;
      }), 'PT rows should fit the phone width without a horizontal table scroll');
      await page.screenshot({ path: path.join(artifacts, `pt-status-${viewport.width}.png`), fullPage: true });
      if (mobile) await page.locator('#menu-toggle').click();
      await page.locator('.nav-item[data-view="settings"]').click();
      await page.screenshot({ path: path.join(artifacts, `settings-${viewport.width}.png`), fullPage: true });
      if (mobile) await page.locator('#menu-toggle').click();
      await page.locator('.nav-item[data-view="ledger"]').click();
      await page.locator('#ledger-list .link-button').first().click();
      await page.locator('dialog.ledger-drawer[open]').waitFor();
      if (mobile) await page.keyboard.press('Escape');
      else {
        const rect=await page.locator('dialog.ledger-drawer[open]').boundingBox();
        await page.mouse.click(rect.x+8,rect.y+8);
        assert.equal(await page.locator('dialog.ledger-drawer[open]').count(),1);
        await page.mouse.click(2, Math.floor(viewport.height / 2));
      }
      await page.locator('dialog.ledger-drawer[open]').waitFor({state:'hidden'});
      await page.locator('#refresh-btn').click();
      await page.waitForFunction(() => !document.querySelector('#refresh-btn').disabled);
      if (mobile) await page.locator('#menu-toggle').click();
      await page.locator('.nav-item[data-view="sites"]').click();
      const siteCard = page.locator('#sites-grid .site-card').filter({ hasText: 'daily.example' });
      const controls = siteCard.locator('.site-controls');
      await controls.locator('.ui-select-trigger').first().click();
      await page.getByRole('listbox').getByRole('option',{name:'暂缓关注'}).click();
      assert.equal(await controls.locator('select').first().inputValue(),'pause');
      await controls.locator('.ui-select-trigger').nth(1).click();
      await page.getByRole('listbox').getByRole('option',{name:'24 小时'}).click();
      await controls.getByRole('button', { name: '保存标记' }).click();
      await page.locator('#sites-grid .site-card').filter({ hasText: 'daily.example' })
        .locator('.control-note').filter({ hasText: '暂缓关注至' }).waitFor();
      await page.reload();
      assert.match(await page.locator('#sites-grid .site-card').filter({ hasText: 'daily.example' })
        .locator('.control-note').textContent(), /暂缓关注至/);
      await page.screenshot({ path: path.join(artifacts, `pause-sites-${viewport.width}.png`), fullPage: true });
      const overview = await (await fetch(`${base}/api/overview`)).json();
      const original = overview.tasks.find(task => task.origin === 'https://daily.example');
      assert.equal(original.observedStatus, 'needs_attention');
      assert.ok(Date.parse(original.attention.pausedUntil) > Date.now());
      if (mobile) await page.locator('#menu-toggle').click();
      await page.locator('.nav-item[data-view="overview"]').click();
      await page.waitForFunction(() => document.querySelector('#attention-count').textContent.trim().startsWith('0 待关注'));
      await page.waitForFunction(() => !document.body.classList.contains('sidebar-open')
        && !document.body.classList.contains('sidebar-exiting')
        && !document.querySelector('.main-content').inert);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await page.screenshot({ path: path.join(artifacts, `attention-${viewport.width}.png`), fullPage: true });
      assert.equal(await page.locator('#app-error').isVisible(), false);
      assert.deepEqual(errors, []);
      console.log(`PASS ${viewport.width}x${viewport.height}: navigation, calendar, pause persistence, attention, layout; zero JS errors`);
    } finally { await context.close(); }
  }
  for(const width of [1001,1024,1160,1199,1200,1280,1440]){
    const context=await browser.newContext({viewport:{width,height:800}});
    try{
      await context.addInitScript(()=>localStorage.setItem('fabricRecentViews',
        JSON.stringify(['overview','tasks','accounts','ledger','settings','sites'])));
      const page=await context.newPage();
      await page.goto(`${base}/#sites`);
      await page.waitForFunction(()=>document.querySelector('.top-nav button.active')?.textContent==='站点');
      const layout=await page.evaluate(()=>{
        const nav=document.querySelector('.top-nav'),heading=document.querySelector('.topbar-heading');
        const rect=element=>element.getBoundingClientRect();
        return {navVisible:getComputedStyle(nav).display!=='none',
          headingRight:rect(heading).right, actionsLeft:rect(document.querySelector('.top-actions')).left,
          actionsRight:rect(document.querySelector('.top-actions')).right,
          pageWidth:document.documentElement.scrollWidth,viewport:innerWidth};
      });
      assert.equal(layout.navVisible,false,'workspace navigation lives in the sidebar');
      assert.ok(layout.headingRight<=layout.actionsLeft+1,`topbar controls overlap at ${width}px: ${JSON.stringify(layout)}`);
      assert.ok(layout.actionsRight<=width&&layout.pageWidth<=width+1,`topbar overflows at ${width}px`);
      if(width===1160)await page.screenshot({path:path.join(artifacts,'topbar-1160.png')});
    }finally{await context.close();}
  }
  console.log(`Synthetic UI screenshots: ${artifacts}`);
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
