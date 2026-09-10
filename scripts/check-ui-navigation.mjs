import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { buildSnapshot } from '../src/bridge.mjs';
import { createDashboardServer } from '../src/dashboard-server.mjs';

const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'fabric-ui-navigation-'));
const dataDir = path.join(artifacts, 'synthetic-data');
fs.mkdirSync(dataDir);
const snapshot = buildSnapshot({
  legacyRoot: fileURLToPath(new URL('../tests/fixtures/legacy/', import.meta.url)),
  generatedAt: new Date().toISOString()
});
fs.writeFileSync(path.join(dataDir, 'shadow-beta-snapshot.json'), JSON.stringify(snapshot));
const { server } = createDashboardServer({ dataDir, adminToken: '', bind: '127.0.0.1', port: 0 });
let browser;
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, channel: process.env.FABRIC_UI_BROWSER ?? 'chrome' });
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport, timezoneId: 'Asia/Shanghai' });
    try {
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(base);
      await page.waitForFunction(() => document.querySelector('#calendar-summary').textContent.length > 0);
      const mobile = viewport.width <= 700;
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
      await page.locator('.calendar-day').first().click();
      assert.match(await page.locator('#calendar-detail').textContent(), /^\d{4}-\d{2}-01/);
      assert.equal(await page.locator('[data-top-view="calendar"]').count(), 1);
      assert.ok(await page.locator('#page-title').textContent());
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await page.screenshot({ path: path.join(artifacts, `calendar-${viewport.width}.png`), fullPage: true });
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
      await page.waitForFunction(() => document.querySelector('#service-status').textContent.includes('已连接'));
      assert.equal(await page.locator('#attention-badge').isVisible(), false);
      for (const view of ['tasks', 'accounts', 'pt-status', 'sites', 'ledger', 'settings']) {
        if (mobile) await page.locator('#menu-toggle').click();
        await page.locator(`.nav-item[data-view="${view}"]`).click();
        await page.waitForFunction(view => document.querySelector(`#view-${view}`).classList.contains('active-view') && !document.querySelector('.main-content').inert, view);
      }
      await page.locator('#refresh-btn').click();
      await page.waitForFunction(() => !document.querySelector('#refresh-btn').disabled);
      assert.equal(await page.locator('#app-error').isVisible(), false);
      assert.deepEqual(errors, []);
      console.log(`PASS ${viewport.width}x${viewport.height}: all navigation, calendar, back, refresh, layout, attention read/reload/repeated-click stability; zero JS errors`);
    } finally { await context.close(); }
  }
  console.log(`Synthetic UI screenshots: ${artifacts}`);
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
