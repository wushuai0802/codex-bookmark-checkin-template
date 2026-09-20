import { overviewMetrics, dailySummaryTitle, statusGradient, statusColors } from './overview-model.mjs';
import { identityTitle, identityCaption, siteTitle, matchesTask, matchesPt } from './dashboard-model.mjs';
import { createNavigation } from './navigation.mjs';
import { installCompactTopbar, recentPages, recentLabels } from './topbar.mjs';
import { playMotion, stopMotion, reducedMotion } from './motion.mjs';
import { createNoticeState, pendingNotices, pausedNotices, attentionPreview } from './notice-state.mjs';
import {dailyRecords, monthCells, moveMonth, dayTotals} from './calendar-model.mjs';

const notices = createNoticeState();
let attentionScrollUntil = 0;

for (const storageName of ['sessionStorage', 'localStorage']) {
  try {
    const storage = globalThis[storageName];
    storage?.removeItem('fabricToken');
    storage?.removeItem('fabricTokenRemembered');
  } catch { /* storage may be disabled by the browser */ }
}

const state = { view: 'overview', data: null, loading: false, ptScope: '', calendarMonth: null, calendarDate: null };
let sidebarReturnFocus = null;
let sidebarExitTimer = null;
let sidebarCloseWatcher = null;
let navigation = null;
let hasRenderedData = false;
let recentViews = [];
try { recentViews = JSON.parse(localStorage.getItem('fabricRecentViews') ?? '[]'); } catch { /* Navigation works with blocked storage. */ }

const STATUS_LABELS = {
  signed: '已签到', already_signed: '今日已完成', not_available: '未开放',
  not_signed: '未签到（已确认）', needs_attention: '需关注', deferred: '已延迟', login_required: '需登录',
  unreachable: '不可访问', failed: '失败', unknown: '未知', not_started:'未执行（缺少回执）'
};

const $ = (selector) => document.querySelector(selector);

function text(value, fallback = '—') {
  return value === null || value === undefined || value === '' ? fallback : String(value);
}

function el(tag, className, value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value !== undefined) node.textContent = text(value, '');
  return node;
}

function append(parent, ...children) {
  for (const child of children) if (child) parent.append(child);
  return parent;
}

function formatTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' }).format(date);
}

function formatHash(value) {
  return value ? `${String(value).slice(0, 10)}…${String(value).slice(-6)}` : '—';
}

function statusChip(status) {
  return el('span', `status-chip ${status ?? ''}`, STATUS_LABELS[status] ?? text(status));
}

function evidenceLabel(task) {
  const evidence = task.evidence;
  if (!evidence) return '无证据';
  const quality = {missing_evidence:'缺少结构化证据',unsupported_evidence:'证据类型未支持',non_authoritative:'非权威证据',wrong_business_date:'证据日期不符',identity_conflict:'身份冲突',unverified_source:'证据待核验',not_started:'尚无执行回执',feature_unavailable:'功能未开放证据',unverified_unavailable:'未开放结论待核验'}[evidence.verification];
  if (quality) return quality;
  const source = { usage_log: '使用日志', api: 'API', page_text: '页面文本', user_confirmation: '用户确认', legacy_authoritative: '旧系统权威', none: '无' }[evidence.source] ?? evidence.source;
  return evidence.authoritative ? `${source} · 已确认` : `${source} · 待确认`;
}

function showLogin(show) {
  const panel = $('#login-panel');
  if (!panel) return;
  panel.classList.toggle('hidden', !show);
  document.body.classList.toggle('unauthenticated', show);
}

function showError(message = '') {
  const node = $('#app-error');
  node.textContent = message;
  node.classList.toggle('hidden', !message);
}

function renderSidebar(open) {
  const wasOpen = document.body.classList.contains('sidebar-open');
  document.body.classList.toggle('sidebar-open', open);
  const toggle = $('#menu-toggle');
  const close = $('#sidebar-close');
  if (toggle) {
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? '关闭导航' : '打开导航');
  }
  if (close) close.setAttribute('aria-expanded', String(open));
  const mobile = matchMedia('(max-width:700px)').matches;
  if (mobile && open && !sidebarCloseWatcher && typeof window.CloseWatcher === 'function') {
    try {
      const watcher = new window.CloseWatcher();
      sidebarCloseWatcher = watcher;
      watcher.addEventListener('close', () => {
        if (sidebarCloseWatcher !== watcher) return;
        sidebarCloseWatcher = null;
        if (navigation?.current.overlay?.type === 'menu') navigation.closeOverlay();
      });
    } catch { /* History remains the fallback on browsers without close signals. */ }
  } else if (!mobile || !open) {
    sidebarCloseWatcher?.destroy(); sidebarCloseWatcher = null;
  }
  const sidebar = $('#main-sidebar');
  sidebar.inert = mobile && !open;
  sidebar.setAttribute('aria-hidden', String(mobile && !open));
  const restoreFocus = () => {
    if (sidebarReturnFocus?.isConnected) sidebarReturnFocus.focus({ preventScroll: true });
    sidebarReturnFocus = null;
  };
  if (open || !mobile) {
    clearTimeout(sidebarExitTimer); document.body.classList.remove('sidebar-exiting');
  } else if (wasOpen) {
    document.body.classList.add('sidebar-exiting');
    clearTimeout(sidebarExitTimer);
    sidebarExitTimer = setTimeout(() => {
      document.body.classList.remove('sidebar-exiting');
      $('.main-content').inert = false;
      restoreFocus();
    }, reducedMotion() ? 0 : 240);
  }
  $('.main-content').inert = mobile && (open || document.body.classList.contains('sidebar-exiting'));
  if (mobile && open && !wasOpen) { sidebarReturnFocus ??= document.activeElement; close?.focus({preventScroll:true}); }
  else if (!mobile) restoreFocus();
}

function setSidebarOpen(open) {
  if (!navigation || !matchMedia('(max-width:700px)').matches) { renderSidebar(false); return; }
  if (open) navigation.openOverlay('menu');
  else if (navigation.current.overlay?.type === 'menu') navigation.closeOverlay();
}

function mountDialog(dialog, previousFocus) {
  dialog.dataset.routeKey = `${navigation.current.overlay.type}:${navigation.current.overlay.id}`;
  dialog.addEventListener('cancel', event => { event.preventDefault(); navigation.closeOverlay(); });
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const rect=dialog.getBoundingClientRect();
    if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom) navigation.closeOverlay();
  });
  dialog.addEventListener('close', () => { dialog.remove(); if (!document.querySelector('dialog[open]') && previousFocus?.isConnected && previousFocus.getClientRects().length) previousFocus.focus({preventScroll:true}); });
  document.body.append(dialog); dialog.showModal();
  playMotion(dialog, [{transform:'translateX(100%)'}, {transform:'translateX(0)'}], 240);
}

async function dismissDialog(dialog) {
  if (dialog.classList.contains('is-closing')) return;
  const from = getComputedStyle(dialog).transform;
  dialog.classList.add('is-closing');
  if (await playMotion(dialog, [{transform:from}, {transform:'translateX(100%)'}], 180)) {
    dialog.close(); dialog.remove();
  }
}

async function api(pathname, options = {}) {
  const headers = { Accept: 'application/json', ...(options.headers ?? {}) };
  const response = await fetch(pathname, { ...options, headers, credentials: 'same-origin', signal: AbortSignal.timeout(12000) });
  let body = null;
  try { body = await response.json(); } catch { /* error body is optional */ }
  if (response.status === 401) {
    showLogin(true);
    throw new Error('需要输入控制台令牌');
  }
  if (!response.ok) throw new Error(body?.message ?? `请求失败（${response.status}）`);
  return body;
}

async function createSession(token, remember) {
  const response = await fetch('/api/session', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ token, remember })
  });
  let body = null;
  try { body = await response.json(); } catch { /* optional error body */ }
  if (!response.ok) throw new Error(body?.message ?? '令牌验证失败');
  return body;
}

async function clearSession() {
  await fetch('/api/session/logout', { method: 'POST', credentials: 'same-origin' });
}

function renderKpis(data) {
  const counts = data?.counts ?? {};
  const status = data?.status ?? {};
  const metrics = overviewMetrics(data);
  const cards = [
    ['成功回执', metrics.success, `已核验 ${metrics.verifiedSuccess} / 待核验 ${metrics.unverifiedSuccess}`, 'success'],
    ['未开放回执', metrics.unavailable, `已核验 ${metrics.verifiedUnavailable} / 待核验 ${metrics.unverifiedUnavailable}`, 'not_available'],
    ['尚未完成', metrics.pending, `${metrics.manual} 项需关注 · ${metrics.deferred} 项延后`, 'pending'],
    ['签到站点 / 账号任务', `${counts.logicalSites ?? 0} / ${metrics.total}`, '同站多账号分别核验', '']
  ];
  const grid = $('#kpi-grid'); grid.replaceChildren();
  for (const [label, value, foot, filter] of cards) {
    const card = el('button', 'kpi kpi-link'); card.type = 'button';
    card.setAttribute('aria-label', `${label}，查看任务`);
    card.addEventListener('click', () => openTasks({ status: filter }));
    append(card, el('div', 'kpi-label', label), el('div', 'kpi-value', value), el('div', 'kpi-foot', foot));
    grid.append(card);
  }
}

function openTasks({ status = '', query = '', account = '' } = {}) {
  navigation.navigate({ view: 'tasks', status, query, account });
}

function openSiteControls(origin) {
  navigation.navigate({view:'sites'});
  requestAnimationFrame(() => {
    const card=[...document.querySelectorAll('#sites-grid .site-card')].find(item=>item.dataset.origin===origin);
    card?.scrollIntoView({block:'center',behavior:reducedMotion()?'instant':'smooth'});
    card?.focus({preventScroll:true});
  });
}

function taskDetails(task) {
  navigation.openOverlay('task', task.taskId);
}

function renderTaskDetails(task) {
  const previousFocus = document.activeElement;
  const dialog = el('dialog', 'task-drawer');
  const heading = el('div', 'panel-heading');
  const title = el('h2', null, siteTitle(task)); title.id = 'task-detail-title';
  dialog.setAttribute('aria-labelledby', title.id);
  const close = el('button', 'icon-button', '×'); close.type = 'button'; close.setAttribute('aria-label', '关闭任务详情');
  close.addEventListener('click', () => navigation.closeOverlay()); append(heading, title, close); dialog.append(heading);
  for (const [label, value] of [['账户', identityTitle(task)], ['身份标识', identityCaption(task)],
    ['身份来源', {result:'执行回执',harvest:'Harvest 账号资料',configuration:'配置中的预期账号', 'user-self':'身份接口核验', 'browser-cache':'本站登录缓存，尚未通过在线核验'}[task.identity?.source]],
    ['身份采集时间', formatTime(task.identity?.observedAt)], ['原始证据类型',task.evidence?.rawSource], ['缓存原证据',task.evidence?.originalSource],
    ['登录方式', task.identity?.provider], ['状态', STATUS_LABELS[task.observedStatus]], ['业务日期', task.businessDate],
    ['观察时间', formatTime(task.observedAt)], ['判定依据', evidenceLabel(task)], ['结果说明', task.evidence?.summary],
    ['执行所有者', task.executionOwner], ['任务 ID', task.taskId]]) {
    const row = el('div', 'detail-row'); append(row, el('span', 'muted', label), el('strong', null, value)); dialog.append(row);
  }
  mountDialog(dialog, previousFocus);
}

function renderHealth(data) {
  const health = data?.health ?? {};
  const freshness = health.freshness ?? {};
  const metrics = overviewMetrics(data);
  const badge = $('#health-badge'); badge.className = `badge ${metrics.healthy ? 'good' : 'warn'}`; badge.textContent = metrics.healthy ? '运行正常' : metrics.healthFresh ? '检查异常' : '数据过期';
  const content = $('#health-content'); content.replaceChildren();
  const values = [
    ['状态', health.healthy ? '正常' : '异常'],
    ['新鲜度', freshness.fresh ? '在窗口内' : '已过期'],
    ['来源检查', formatTime(health.sourceCheckedAt)],
    ['失败检查', health.failedCheckCount ?? '—']
  ];
  for (const [label, value] of values) {
    const stat = el('div', 'health-stat'); append(stat, el('span', null, label), el('b', null, value)); content.append(stat);
  }
}

function renderStatusChart(data) {
  const status = data?.status ?? {};
  const total = Object.values(status).reduce((sum, value) => sum + Number(value || 0), 0);
  const chart = $('#status-chart'); chart.replaceChildren();
  const donut = el('div', 'donut'); donut.style.background = statusGradient(status); append(donut, el('strong', null, total));
  const legend = el('div', 'legend');
  const colors = statusColors;
  for (const key of ['signed', 'already_signed', 'not_available', 'needs_attention', 'deferred', 'login_required', 'failed', 'unknown','not_started']) {
    if (!(status[key] ?? 0)) continue;
    const row = el('button', 'legend-row legend-link'); row.type = 'button';
    row.addEventListener('click', () => openTasks({ status: key }));
    const label = el('span', 'legend-label', STATUS_LABELS[key]); label.style.setProperty('--dot', colors[key] ?? '#8b96a8');
    append(row, label, el('strong', null, `${status[key]} · ${total ? Math.round(status[key] / total * 100) : 0}%`)); legend.append(row);
  }
  append(chart, donut, legend);
}

function renderPlan(data) {
  const snapshot = data ?? {};
  const values = [
    ['业务日期', snapshot.businessDate], ['快照生成', formatTime(snapshot.generatedAt)],
    ['计划哈希', formatHash(snapshot.planHash)], ['结果来源', '执行层签到回执']
  ];
  const container = $('#latest-plan'); container.replaceChildren();
  for (const [label, value] of values) { const item = el('div', 'meta-item'); append(item, el('span', null, label), el('strong', null, value)); container.append(item); }
}

function renderOverview(data) {
  renderKpis(data); renderHealth(data); renderStatusChart(data); renderPlan(data);
  renderDailySummary(data);
  renderReadiness(data);
}

function renderDailySummary(data) {
  const m = overviewMetrics(data);
  const pausedCount = pausedNotices(data?.tasks ?? []).length;
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
  const previousDay = data?.businessDate && data.businessDate !== today;
  const node = $('#daily-summary'); node.replaceChildren();
  const tone = !m.fresh ? 'stale' : m.allResolved ? 'complete' : 'attention';
  node.className = `daily-summary ${tone}`;
  const copy = el('div', 'daily-copy');
  const title = dailySummaryTitle(m, { previousDay, pausedCount });
  append(copy, el('p', 'eyebrow', `DAILY CHECK-IN / ${data?.businessDate ?? '—'}`), el('h2', null, title),
    el('p', 'daily-note', `${previousDay ? '最近业务日：' : ''}${m.verifiedSuccess} 项签到已核验，${m.unverifiedSuccess} 项成功回执待核验；${m.verifiedUnavailable} 项确认未开放，${m.unverifiedUnavailable} 项未开放结论待核验。`));
  const progress = el('div', 'daily-progress');
  append(progress, el('strong', null, m.rate === null ? '—' : `${m.rate}%`), el('span', null, previousDay ? '最近业务日完成率' : '已核验完成率'));
  progress.title='已核验成功数 /（总任务数 − 已确认未开放数）；待核验回执不计为已核验成功。';
  const bar = el('div', 'completion-track'); const fill = el('i'); fill.style.width = `${Math.min(100, m.rate ?? 0)}%`; bar.append(fill); progress.append(bar);
  append(node, copy, progress);
  $('#sync-age').textContent = `快照生成 ${formatTime(data?.generatedAt)} · ${m.ageMinutes === null ? '尚无数据' : `${m.ageMinutes} 分钟前`} · ${previousDay ? '等待今日业务回执' : m.fresh ? '数据有效' : '请检查同步'}`;
}

function renderReadiness(data) {
  const node = $('#readiness-content'); node.replaceChildren();
  const reconciliation=data?.reconciliation??{}, pt=data?.ptStatus?.counts??{};
  for(const [label,value,caption] of [
    ['计划回执', `${data?.counts?.executionUnits??0} 项`, `${reconciliation.missingCount??0} 项缺少回执`],
    ['账号对账', (reconciliation.conflictCount??0)===0?'无冲突':`${reconciliation.conflictCount} 项冲突`, '以执行层账号为准'],
    ['PT 监测', `${pt.sites??0} 站`, `${pt.inLegacyPlan??0} 站已登记补签`]
  ]){
    const item=el('div','health-stat');append(item,el('span',null,label),el('b',null,value),el('span',null,caption));node.append(item);
  }
}

function renderAttention(tasks) {
  const { all: pending, pausedCount, visible, remaining } = attentionPreview(tasks);
  $('#attention-count').textContent = `${pending.length} 项`;
  const unread = pending.filter(task => !notices.isRead(task)).length;
  const badge = $('#attention-badge');
  if (badge) { badge.textContent = String(unread); badge.hidden = unread === 0; badge.style.display = unread ? '' : 'none'; }
  $('#attention-jump')?.setAttribute('aria-label', unread ? `查看需关注事项，${unread} 项未读` : '查看需关注事项');
  const node = $('#attention-list'); node.replaceChildren();
  if (!pending.length) { node.append(el('div', 'empty-state', pausedCount ? `${pausedCount} 项未完成，已暂缓关注；任务原始状态仍可在任务管理中查看。` : '当前没有未解决的签到项。未开放的站点已单独统计。')); return; }
  const toolbar = el('div', 'attention-toolbar');
  const markAll = el('button', 'mark-all-read-btn', unread ? '全部标记为已读' : '全部已读');
  markAll.type = 'button'; markAll.disabled = unread === 0;
  markAll.title = '仅记住此浏览器的阅读状态，不改变签到结果';
  markAll.addEventListener('click', () => { notices.markRead(pending); renderAttention(tasks); });
  toolbar.append(markAll);
  if (pausedCount) toolbar.append(el('span', 'muted', `${pausedCount} 项已暂缓关注`));
  node.append(toolbar);
  for (const group of visible) {
    const task = group.task;
    const row = el('article', 'attention-item');
    row.classList.toggle('is-read', group.tasks.every(item => notices.isRead(item)));
    const top = el('div', 'attention-top');
    let host; try { host = new URL(task.origin).host; } catch { host = task.origin; }
    append(top, el('strong', null, group.tasks.length > 1 ? `${host} · ${group.tasks.length} 个账号` : host), statusChip(task.observedStatus));
    const reason = el('p', 'attention-reason', task.evidence?.summary || '本次尚未取得明确结果。');
    reason.title = reason.textContent;
    const foot = el('div', 'attention-foot');
    append(foot, el('span', null, task.observedStatus === 'deferred' ? '等待既有重试策略 · 面板不执行补签' : '需要复核身份或流程 · 不自动重复提交'));
    const view = el('button', 'link-button', group.tasks.length > 1 ? '查看相关任务 →' : '查看任务 →');
    view.addEventListener('click', () => {
      notices.markRead(group.tasks); renderAttention(tasks);
      openTasks({ status: 'pending', query: task.origin });
    }); foot.append(view);
    append(row, top, reason, foot); node.append(row);
  }
  if (remaining) {
    const all = el('button', 'attention-view-all', `查看全部 ${pending.length} 项 →`);
    all.type = 'button'; all.addEventListener('click', () => openTasks({ status: 'pending' }));
    node.append(all);
  }
}

function renderTasks(tasks) {
  const body = $('#tasks-body'); body.replaceChildren();
  if (!tasks.length) { const row = el('tr'); const cell = el('td'); cell.colSpan = 6; cell.textContent = '没有匹配的任务'; row.append(cell); body.append(row); return; }
  for (const task of tasks) {
    const row = el('tr');
    const taskCell = el('td'); const detail = el('button', 'link-button', '查看详情'); detail.type = 'button'; detail.addEventListener('click', () => taskDetails(task));
    append(taskCell, detail, el('span', 'subtext', task.businessDate));
    const siteCell = el('td'); append(siteCell, el('span', 'origin', siteTitle(task)), el('span', 'subtext', task.origin));
    const accountCell = el('td'); append(accountCell, el('span', 'origin', identityTitle(task)), el('span', 'subtext', identityCaption(task)));
    const statusCell = el('td'); append(statusCell, statusChip(task.observedStatus),
      task.attention?.pausedUntil ? el('span', 'subtext', `暂缓关注至 ${formatTime(task.attention.pausedUntil)}`) : null);
    const evidenceCell = el('td'); append(evidenceCell, el('span', null, evidenceLabel(task)), el('span', 'subtext evidence-summary', task.evidence?.summary ?? '无详细证据'), el('span', 'subtext', task.observedAt ? formatTime(task.observedAt) : '—'));
    const ownerCell = el('td'); append(ownerCell, el('span', null, task.executionOwner === 'legacy-checkin' || task.executionOwner === 'v2-worker' ? '执行层' : task.executionOwner), el('span', 'subtext', task.executionMode === 'observe_only' ? '观测记录' : '按站点流程执行'));
    append(row, taskCell, siteCell, accountCell, statusCell, evidenceCell, ownerCell); body.append(row);
  }
}

function renderPtStatus(data) {
  const pt = data ?? {};
  const view = $('#view-pt-status');
  if (view && !view.querySelector('.scope-banner')) {
    const banner = el('div', 'scope-banner');
    append(banner, el('strong', null, '执行层与观测层'), el('span', null, '书签计划 · Harvest 回执 · 执行层回执'), el('span', 'scope-divider', '|'), el('span', null, '未完成的已登记 PT 站点会进入一次性复核'));
    view.querySelector('.toolbar')?.before(banner);
  }
  const counts = pt.counts ?? {};
  const reviewCount=(pt.sites??[]).filter(site=>site.inLegacyPlan&&
    !['signed','already_signed','not_available'].includes(site.effective?.status)).length;
  const cards = [
    ['PT 站点', counts.sites ?? 0, `${counts.inLegacyPlan ?? 0} 个在签到计划内`, ''],
    ['未登记 PT', counts.externalOnly ?? 0, '仅展示，需先登记执行任务', 'monitor'],
    ['状态新鲜', counts.fresh ?? 0, `共 ${counts.sites ?? 0} 个站点`, 'fresh'],
    ['待核验', reviewCount, '执行层按原站点流程复核', 'review']
  ];
  const kpis = $('#pt-kpis'); kpis.replaceChildren();
  for (const [label, value, foot, scope] of cards) {
    const card = el('button', 'kpi kpi-link'); card.type = 'button'; card.setAttribute('aria-pressed', String(state.ptScope === scope));
    card.addEventListener('click', () => { state.ptScope = scope; navigation.updateFilters({ ptScope: scope }); renderPtStatus(state.data.ptStatus); });
    append(card, el('div', 'kpi-label', label), el('div', 'kpi-value', value), el('div', 'kpi-foot', foot)); kpis.append(card);
  }
  const body = $('#pt-status-body'); body.replaceChildren();
  const sites = (Array.isArray(pt.sites) ? pt.sites : []).filter(site => matchesPt(site, state.ptScope));
  if (!sites.length) { const row = el('tr'); const cell = el('td'); cell.colSpan = 6; cell.textContent = '暂无 PT 状态观察数据'; row.append(cell); body.append(row); return; }
  for (const site of sites) {
    const row = el('tr');
    const siteCell = el('td'); append(siteCell, el('span', 'origin', site.displayName || site.origin), el('span', 'subtext', site.origin));
    const scopeCell = el('td'); append(scopeCell, el('span', 'status-chip', site.inLegacyPlan ? '已登记执行' : '仅观测'), el('span', 'subtext', site.inLegacyPlan ? '执行层可复核' : '需先登记站点'));
    const effective = site.effective ?? {};
    const statusCell = el('td'); const chip = statusChip(effective.status ?? 'unknown');
    if (!effective.fresh) { chip.className = 'status-chip unknown stale'; chip.textContent = effective.observedAt ? `历史：${STATUS_LABELS[effective.status] ?? '未知'}` : '暂无今日记录'; }
    append(statusCell, chip, site.discrepancy ? el('span', 'subtext discrepancy-text', '来源状态不一致') : null);
    const sourceCell = el('td'); const sourceText = (site.sourceStatuses ?? []).map((item) => `${{'legacy-checkin':'执行层','v2-observer':'书签目录',harvest:'Harvest'}[item.source]??item.source}: ${STATUS_LABELS[item.status] ?? item.status}`).join(' · '); append(sourceCell, el('span', null, sourceText || '—'), el('span', 'subtext', effective.authoritative ? '权威证据' : '状态待核验'));
    const observedCell = el('td'); append(observedCell, el('span', null, formatTime(effective.observedAt)), el('span', 'subtext', effective.fresh ? '当日回执' : effective.observedAt ? '历史记录 · 非今日确认' : '暂无今日记录'));
    const actionCell = el('td');
    if (!site.inLegacyPlan) append(actionCell,el('span',null,'仅观测'),el('span','subtext','需要补签时先登记执行任务'));
    else if (['signed','already_signed'].includes(effective.status) && effective.authoritative) append(actionCell,
      el('span',null,effective.source==='harvest'?'Harvest 今日成功':'执行账号今日完成'),
      effective.source==='harvest'?el('span','subtext','执行账号以自身回执为准'):null);
    else if (effective.status==='not_available' && effective.authoritative) append(actionCell,el('span',null,'功能未开放'));
    else append(actionCell,statusChip('needs_attention'),el('span','subtext','待执行层核验'));
    if(site.inLegacyPlan && state.data?.sites?.some(item=>item.origin===site.origin)){
      const manage=el('button','link-button','管理标记');manage.type='button';manage.addEventListener('click',()=>openSiteControls(site.origin));actionCell.append(manage);
    }
    append(row, siteCell, scopeCell, statusCell, sourceCell, observedCell, actionCell); body.append(row);
  }
}

function renderSites(sites) {
  const grid = $('#sites-grid'); grid.replaceChildren();
  if (!sites.length) { grid.append(el('p', 'muted', '暂无站点数据')); return; }
  for (const site of sites) {
    const card = el('article', 'site-card'); card.dataset.origin=site.origin;card.tabIndex=-1;
    const top = el('div', 'card-top');
    let host; try { host = new URL(site.origin).host; } catch { host = site.origin; }
    append(top, el('h3', null, siteTitle(site)), site.logicalGroup ? el('span', 'badge', site.logicalGroup) : null);
    const tasksLink = el('button', 'link-button', '查看此站任务 →'); tasksLink.addEventListener('click', () => openTasks({ query: site.origin }));
    const stats = el('div', 'card-stats');
    const total = site.executionUnitCount ?? 0; const done = (site.status?.signed ?? 0) + (site.status?.already_signed ?? 0);
    append(stats, el('div', 'card-stat', null)); stats.lastChild.append(el('b', null, total), el('span', null, '执行单元'));
    const statusStat = el('div', 'card-stat'); statusStat.append(el('b', null, done), el('span', null, '已完成')); stats.append(statusStat);
    const bar = el('div', 'mini-bar'); const fill = el('i'); fill.style.width = `${total ? Math.round(done / total * 100) : 0}%`; bar.append(fill);
    const controls = el('div', 'site-controls');
    const policy = el('select');
    for (const [value, label] of [['monitor', '正常观察'], ['review', '标记复核'], ['pause', '暂缓关注']]) {
      const option = el('option', null, label); option.value = value; option.selected = (site.control?.policy ?? 'monitor') === value; policy.append(option);
    }
    const duration = el('select'); duration.setAttribute('aria-label', '暂缓时长');
    for (const [hours, label] of [[24, '24 小时'], [72, '3 天'], [168, '7 天']]) {
      const option = el('option', null, label); option.value = String(hours); duration.append(option);
    }
    duration.hidden = policy.value !== 'pause';
    policy.addEventListener('change', () => { duration.hidden = policy.value !== 'pause'; });
    const note = el('input'); note.type = 'text'; note.maxLength = 240; note.placeholder = '备注（可选）'; note.value = site.control?.note ?? '';
    const save = el('button', 'button control-button', '保存标记');
    save.addEventListener('click', async () => {
      save.disabled = true; save.textContent = '保存中…';
      try {
        await api('/api/controls/sites', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ origin: site.origin, policy: policy.value, note: note.value, ...(policy.value === 'pause' ? {pauseHours: Number(duration.value)} : {}) }) });
        await loadData();
        save.textContent = '已保存'; setTimeout(() => { save.textContent = '保存标记'; save.disabled = false; }, 900);
      } catch (error) { save.textContent = '保存失败'; save.disabled = false; showError(error.message); }
    });
    append(controls, policy, duration, note, save);
    append(card, top, el('span', 'subtext', host), stats, bar, tasksLink, controls,
      el('span', 'subtext control-note', site.control?.policy === 'pause'
        ? `暂缓关注至 ${formatTime(site.control.expiresAt)} · 签到任务照常运行`
        : '关注标记不改变签到任务。')); grid.append(card);
  }
}

function renderAccounts(accounts) {
  const grid = $('#accounts-grid'); grid.replaceChildren();
  if (!accounts.length) { grid.append(el('p', 'muted', '暂无账户任务')); return; }
  for (const account of accounts) {
    const card = el('article', 'account-card'); const top = el('div', 'card-top');
    append(top, el('h3', null, identityTitle(account)), el('span', account.identity?.source === 'browser-cache' ? 'badge warn' : 'badge', account.identity?.source === 'browser-cache' ? '缓存身份' : account.identity?.provider || '站点账号'));
    const stats = el('div', 'card-stats'); const done = (account.status?.signed ?? 0) + (account.status?.already_signed ?? 0);
    const count = el('div', 'card-stat'); count.append(el('b', null, account.taskCount), el('span', null, '任务')); stats.append(count);
    const completed = el('div', 'card-stat'); completed.append(el('b', null, done), el('span', null, '已完成')); stats.append(completed);
    const sites = (account.sites ?? []).join(' · ');
    const link = el('button', 'link-button', '查看账号任务 →');
    link.addEventListener('click', () => openTasks({ account: `${account.origin}|${account.accountRef}` }));
    append(card, el('span', 'subtext', siteTitle(account)), top, el('span', 'subtext account-id', identityCaption(account)),
      stats, el('span', 'subtext', sites || '无站点'), link); grid.append(card);
  }
}

function renderLedger(records) {
  const view = $('#view-ledger');
  view.querySelector('.table-panel')?.remove();
  let body = $('#ledger-list');
  if (!body) { body = el('div', 'ledger-list'); body.id = 'ledger-list'; view.append(body); }
  body.replaceChildren();
  view.querySelector('.toolbar .muted').textContent = '同步观察记录 · 不代表重新执行签到';
  if (!records.length) { body.append(el('p', 'empty-state', '暂无运行记录')); return; }
  for (const record of [...records].reverse()) {
    const row = el('article', 'ledger-entry');
    const top = el('div', 'ledger-entry-heading');
    append(top, el('h3', null, `${record.businessDate} 签到结果观察`), el('time', 'muted', formatTime(record.recordedAt)));
    const counts = record.counts?.status ?? {};
    const success = (counts.signed ?? 0) + (counts.already_signed ?? 0);
    const pending = Math.max(0, (record.counts?.executionUnits ?? 0) - success - (counts.not_available ?? 0));
    const totals = el('div', 'ledger-totals');
    append(totals, el('span', 'badge good', `成功 ${success}`), el('span', pending ? 'badge warn' : 'badge', `待处理 ${pending}`), el('span', 'badge', `未开放 ${counts.not_available ?? 0}`), el('span', 'muted', `${record.counts?.logicalSites ?? 0} 站 / ${record.counts?.executionUnits ?? 0} 个账号任务`));
    const changed = record.drift?.statusChanges?.length ?? 0;
    const classification = record.drift?.classification;
    const summary = changed ? `${changed} 项任务状态变化` : classification === 'initial' ? '首次记录' : classification === 'plan_changed' ? '签到范围发生变化' : '签到计划未变';
    const outstanding = (record.taskSummaries ?? []).filter(task => !['signed','already_signed','not_available'].includes(task.observedStatus));
    const names = outstanding.slice(0, 3).map(task => `${siteTitle(task)} · ${identityTitle(task)}`).join('；');
    const detail = el('button', 'link-button', record.taskSummaries ? '查看任务明细 →' : '查看历史摘要 →');
    detail.addEventListener('click', () => navigation.openOverlay('ledger', record.recordId));
    append(row, top, totals, el('p', 'ledger-note', summary), names ? el('p', 'ledger-attention', `待处理：${names}`) : null, detail);
    body.append(row);
  }
}

function renderLedgerDetails(record) {
  const previousFocus = document.activeElement;
  const dialog = el('dialog', 'task-drawer ledger-drawer');
  const header = el('div', 'panel-heading'); const title = el('h2', null, `${record.businessDate} 运行记录`);
  title.id = 'ledger-detail-title'; dialog.setAttribute('aria-labelledby', title.id);
  const close = el('button', 'icon-button', '×'); close.setAttribute('aria-label', '关闭运行记录');
  close.addEventListener('click', () => navigation.closeOverlay()); append(header, title, close); dialog.append(header);
  dialog.append(el('p', 'muted', `观察时间：${formatTime(record.recordedAt)}`));
  if (!record.taskSummaries) dialog.append(el('p', 'alert', '该历史记录未保存逐站明细，仅保留当时的汇总与计划变化。'));
  for (const change of record.changes ?? []) {
    const label = change.kind === 'status' ? `${STATUS_LABELS[change.from] ?? change.from} → ${STATUS_LABELS[change.to] ?? change.to}`
      : { added: '新增任务', removed: '移除任务', changed: '任务配置变化' }[change.kind];
    dialog.append(el('p', 'ledger-note', `${siteTitle(change.task)} · ${identityTitle(change.task)}：${label}`));
  }
  for (const task of record.taskSummaries ?? []) {
    const item = el('section', 'ledger-task');
    append(item, el('h3', null, siteTitle(task)), el('p', 'muted', `${identityTitle(task)} · ${identityCaption(task)}`),
      statusChip(task.observedStatus), el('p', null, task.evidence?.summary || '未保存详细证据'), el('span', 'muted', formatTime(task.observedAt)));
    dialog.append(item);
  }
  const technical = el('details', 'ledger-technical');
  append(technical, el('summary', null, '技术标识'), el('p', null, `批次：${record.sourceRunId ?? '未记录'}`), el('p', null, `计划：${record.planHash}`));
  dialog.append(technical); mountDialog(dialog, previousFocus);
}

function renderCalendar(data) {
  const view=$('#checkin-calendar'),summary=$('#calendar-summary'),detail=$('#calendar-detail'),nav=$('#calendar-nav');if(!view||!summary||!detail||!nav)return;
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date());
  const records=dailyRecords({ledger:data?.ledger,snapshot:data?.snapshot,tasks:data?.tasks});
  state.calendarMonth ??= today.slice(0,7); state.calendarDate ??= today;
  const {offset,days}=monthCells(state.calendarMonth),labels=['一','二','三','四','五','六','日'];
  summary.textContent=`${state.calendarMonth.slice(0,4)} 年 ${Number(state.calendarMonth.slice(5))} 月 · ${[...records.keys()].filter(date=>date.startsWith(state.calendarMonth)).length} 个有执行记录的日期`;
  nav.replaceChildren();
  const heading=el('h3','calendar-month-title',`${state.calendarMonth.slice(0,4)} 年 ${Number(state.calendarMonth.slice(5))} 月`);
  const buttons=el('div','calendar-nav-buttons');
  const previous=el('button','calendar-nav-btn','上个月');previous.type='button';previous.addEventListener('click',()=>{state.calendarMonth=moveMonth(state.calendarMonth,-1);state.calendarDate=null;renderCalendar(data);});
  const next=el('button','calendar-nav-btn','下个月');next.type='button';next.addEventListener('click',()=>{state.calendarMonth=moveMonth(state.calendarMonth,1);state.calendarDate=null;renderCalendar(data);});
  const todayButton=el('button','calendar-nav-btn today-btn','回到今天');todayButton.type='button';todayButton.disabled=state.calendarMonth===today.slice(0,7);todayButton.addEventListener('click',()=>{state.calendarMonth=today.slice(0,7);state.calendarDate=today;renderCalendar(data);});
  append(buttons,previous,todayButton,next);append(nav,heading,buttons);
  view.replaceChildren();for(const label of labels)view.append(el('span','calendar-weekday',label));for(let i=0;i<offset;i++)view.append(el('span','calendar-empty',''));
  const stateOf=entry=>{if(!entry)return 'none';const totals=dayTotals(entry);if(totals.pending>0)return 'warn';if(totals.completed>0)return 'success';if(totals.unavailable>0)return 'done';return 'observe';};
  for(let day=1;day<=days;day++){
    const date=`${state.calendarMonth}-${String(day).padStart(2,'0')}`,entry=records.get(date),totals=dayTotals(entry),button=el('button',`calendar-day ${stateOf(entry)}${date===today?' today':''}`,String(day));button.type='button';button.setAttribute('aria-label',`${date} ${entry?`${totals.completed} 项完成，${totals.pending} 项待处理`:'无执行记录'}`);
    button.addEventListener('click',()=>{state.calendarDate=date;renderCalendar(data);});view.append(button);
  }
  const selected=records.get(state.calendarDate);const totals=dayTotals(selected);detail.replaceChildren();
  const header=el('div','calendar-detail-header');append(header,el('strong',null,state.calendarDate??`${state.calendarMonth}-01`),el('span','muted',selected?`更新于 ${formatTime(selected.recordedAt)}`:'没有执行记录'));detail.append(header);
  if(!selected){detail.append(el('p','calendar-empty-state','当天没有签到执行回执。'));return;}
  detail.append(el('p','muted',`${totals.completed} 项完成 · ${totals.unavailable} 项未开放 · ${totals.pending} 项待处理`));
  for(const task of selected.tasks??[]){const card=el('div','calendar-receipt-card');append(card,el('span','receipt-account',siteTitle(task)),statusChip(task.observedStatus),el('span','subtext',`${identityTitle(task)} · ${evidenceLabel(task)}`));detail.append(card);}
}

function renderSettings(data) {
  const snapshot = data?.snapshot ?? {};
  const content = $('#settings-content'); content.replaceChildren();
  const rows = [
    ['系统角色', '执行层签到 · 观测层对账与面板'], ['今日执行', `${snapshot.counts?.executionUnits??0} 个账号任务 · ${(data?.status?.signed??0) + (data?.status?.already_signed??0)} 项已完成`],
    ['Harvest 对账', '每日任务完成后复核登记的 PT 站点'], ['补签规则', '仅由执行层按站点原有流程补签一次'],
    ['人工控制', '站点标记、暂缓提醒、复核备注可操作'], ['计划来源', snapshot.source?.system === 'legacy-checkin' ? '书签签到计划' : snapshot.source?.system ?? '书签签到计划'],
    ['认证状态', data?.authConfigured ? '已配置' : '仅回环访问'], ['数据目录', '服务端已配置（路径不展示）']
  ];
  for (const [label, value] of rows) { const row = el('div', 'setting-row'); append(row, el('span', null, label), el('strong', null, value)); content.append(row); }
  const observations=data?.adapterObservations;
  if(observations){
    const section=el('section','adapter-validation');
    append(section,el('h2',null,'站点观测诊断'),el('p','muted',`验证时间 ${formatTime(observations.finishedAt)} · ${observations.counts.confirmed}/${observations.counts.total} 项取得明确观察证据。诊断数据不替代执行层回执。`));
    const causes={expected_identity_missing:'缺少预期身份',pt_native_adapter_not_yet_enabled:'PT 原生适配待验证',access_challenge:'访问验证阻挡',login_required:'需要有效登录态',upstream_unavailable:'当前访问路径不可用',identity_mismatch:'身份不符',feature_disabled:'签到功能未开放',entitlement_contract_review:'权益格式待适配',entitlement_inactive_or_expired:'权益过期或未激活'};
    for(const observed of observations.results){
      const row=el('div','setting-row');
      const name=el('div');append(name,el('strong',null,observed.origin.replace('https://','')),el('span','subtext',observed.identity?.userId?identityCaption(observed):observed.accountKey??''));
      const state=el('div');append(state,el('strong',null,observed.status==='entitlement_active'?'权益有效':observed.status==='skipped'?'暂未验证':STATUS_LABELS[observed.status]??observed.status),el('span','subtext',causes[observed.cause]??observed.cause??'身份与业务证据匹配'));
      append(row,name,state);section.append(row);
    }
    content.append(section);
  }
  const note = el('div', 'alert', '面板上的站点操作只影响提醒与复核标记，不会修改账号、Cookie 或站点签到规则。需要真正补签时，由执行层按原登记流程接手。'); note.style.marginTop = '18px'; content.append(note);
}

function renderAll() {
  const data = state.data;
  if (!data) return;
  $('#mode-pill').textContent = '执行层 + 观测层';
  const liveSnapshot={...(data.snapshot??{}),tasks:data.tasks??[],ptStatus:data.ptStatus,readiness:data.readiness,evidenceQuality:data.evidenceQuality??data.snapshot?.evidenceQuality,status:data.status??data.snapshot?.counts?.status??{},counts:{...(data.snapshot?.counts??{}),status:data.status??data.snapshot?.counts?.status??{}}};
  renderOverview(liveSnapshot);
  renderCalendar(data);
  let integrity = $('#integrity-note');
  if (!integrity) { integrity=el('div','scope-banner');integrity.id='integrity-note';$('#daily-summary').after(integrity); }
  const reconciliation=data.snapshot?.reconciliation;
  const quality=data.evidenceQuality??data.snapshot?.evidenceQuality;
  integrity.textContent=`执行计划对账：缺少回执 ${reconciliation?.missingCount??0} · 身份冲突 ${reconciliation?.conflictCount??0} · 计划外回执 ${reconciliation?.unexpectedCount??0} · ${quality?.unverifiedSuccess??0} 项成功结论待核验。`;
  let shortcuts = $('#overview-shortcuts');
  if (!shortcuts) { shortcuts = el('div', 'overview-shortcuts'); shortcuts.id = 'overview-shortcuts'; $('#kpi-grid').after(shortcuts); }
  shortcuts.replaceChildren();
  for (const [label, view] of [[`PT 监测 ${data.ptStatus?.counts?.sites ?? 0}`, 'pt-status'], ['站点目录', 'sites'], ['账号与 ID', 'accounts'], ['观察验收记录', 'ledger'], ['系统健康', 'settings']]) {
    const button = el('button'); button.type = 'button';
    const arrow = el('span', 'shortcut-arrow', '→'); arrow.setAttribute('aria-hidden', 'true');
    append(button, el('span', 'shortcut-label', label), arrow);
    button.addEventListener('click', () => switchView(view)); shortcuts.append(button);
  }
  $('#view-accounts .toolbar .muted').textContent = '站点用户名与用户 ID · 不展示登录凭据';
  const selectedAccount = $('#task-account').value;
  $('#task-account').replaceChildren(el('option', null, '所有账号'));
  $('#task-account').firstChild.value = '';
  for (const account of data.accounts ?? []) { const option = el('option', null, `${siteTitle(account)} · ${identityTitle(account)}`); option.value = `${account.origin}|${account.accountRef}`; $('#task-account').append(option); }
  $('#task-account').value = [...$('#task-account').options].some(option => option.value === selectedAccount) ? selectedAccount : '';
  applyTaskFilter();
  renderAttention(data.tasks ?? []);
  renderPtStatus(data.ptStatus);
  renderSites(data.sites ?? []);
  renderAccounts(data.accounts ?? []);
  renderLedger(data.ledger ?? []);
  renderSettings(data);
  for (const [target, label, view] of [['#health-content', '系统健康详情 →', 'settings'], ['#readiness-content', '查看观察记录 →', 'ledger']]) {
    const link = el('button', 'link-button', label); link.addEventListener('click', () => switchView(view)); $(target).append(link);
  }
  $('#service-status').textContent = '已连接 · 数据新鲜'; $('.status-dot').style.background = '#45c59d';
  applyRoute(navigation.current, { restoreScroll: !hasRenderedData }); hasRenderedData = true;
}

async function loadData() {
  if (state.loading) return;
  state.loading = true; showError(''); $('#refresh-btn').disabled = true; $('#refresh-btn').textContent = '刷新中…';
  try {
    const overview = await api('/api/overview');
    state.data = { ...overview, ledger: overview.ledger ?? [] };
    showLogin(false); renderAll();
  } catch (error) {
    $('#service-status').textContent = '连接失败'; $('.status-dot').style.background = '#d76f78'; showError(error.name === 'TimeoutError' ? '请求超时，保留上次数据；请稍后刷新。' : error.message);
  } finally { state.loading = false; $('#refresh-btn').disabled = false; $('#refresh-btn').textContent = '刷新数据'; }
}

function switchView(view) {
  navigation.navigate({ view });
}

function renderView(view) {
  state.view = view;
  document.querySelectorAll('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.view === view));
  document.querySelectorAll('.view').forEach((item) => item.classList.toggle('active-view', item.id === `view-${view}`));
  const titles = { overview: '签到运行总览', calendar: '签到日历', tasks: '任务管理', 'pt-status': 'PT 状态', sites: '站点管理', accounts: '账户管理', ledger: '运行记录', settings: '运行设置' };
  $('#page-title').textContent = titles[view] ?? titles.overview;
  renderRecentPages(view);
  const context=$('#topbar-context');if(context)context.textContent={overview:'执行层回执 · 观测层对账',tasks:'执行任务 · 结果与证据','pt-status':'PT 执行状态 · Harvest 对账',sites:'书签站点 · 关注控制',accounts:'账号身份 · 隔离视图',ledger:'审计历史 · 追加记录',settings:'执行与观测设置'}[view]??'控制平面';
}

function renderRecentPages(view) {
  recentViews = recentPages(recentViews, view);
  try { localStorage.setItem('fabricRecentViews', JSON.stringify(recentViews)); } catch { /* In-memory recent pages suffice. */ }
  const nav = $('.top-nav'); nav.replaceChildren();
  $('.topbar').classList.toggle('no-recents', recentViews.length < 2);
  $('.topbar-shell').classList.toggle('no-recents', recentViews.length < 2);
  nav.append(el('span','recent-caption','最近'));
  for (const page of recentViews) {
    const button = el('button', page === view ? 'active' : '', recentLabels[page]);
    button.type='button'; button.dataset.topView=page;
    if (page === view) button.setAttribute('aria-current','page');
    button.addEventListener('click', () => switchView(page)); nav.append(button);
  }
  // Reveal horizontally only: scrollIntoView would move the page on every route.
  const selected=nav.querySelector('[aria-current="page"]');
  if (selected) {
    const itemRect=selected.getBoundingClientRect(), navRect=nav.getBoundingClientRect();
    if (itemRect.right > navRect.right) nav.scrollLeft += itemRect.right - navRect.right + 6;
    else if (itemRect.left < navRect.left + 36) nav.scrollLeft += itemRect.left - navRect.left - 36;
  }
}

function applyRoute(route, { restoreScroll = true } = {}) {
  const changedView = state.view !== route.view;
  const changedFilters = $('#task-search').value !== route.query || $('#task-status').value !== route.status
    || $('#task-account').value !== route.account || state.ptScope !== route.ptScope;
  if (changedView) renderView(route.view);
  $('#task-search').value = route.query; $('#task-status').value = route.status;
  $('#task-account').value = route.account;
  state.ptScope = route.ptScope;
  if (state.data && (changedView || changedFilters)) { applyTaskFilter(); renderPtStatus(state.data.ptStatus); }
  renderSidebar(route.overlay?.type === 'menu' && matchMedia('(max-width:700px)').matches);
  const key = route.overlay ? `${route.overlay.type}:${route.overlay.id}` : '';
  const dialogs = [...document.querySelectorAll('dialog[open]')];
  const matching = dialogs.find(dialog => dialog.dataset.routeKey === key);
  for (const dialog of dialogs) if (dialog !== matching) dismissDialog(dialog);
  if (matching?.classList.contains('is-closing')) {
    const from = getComputedStyle(matching).transform;
    stopMotion(matching); matching.classList.remove('is-closing');
    playMotion(matching, [{transform:from}, {transform:'translateX(0)'}], 180);
  }
  if (!matching && state.data) {
    if (route.overlay?.type === 'task') { const task = state.data.tasks.find(task => task.taskId === route.overlay.id); if (task) renderTaskDetails(task); }
    if (route.overlay?.type === 'ledger') { const record = state.data.ledger.find(record => record.recordId === route.overlay.id); if (record) renderLedgerDetails(record); }
  }
  if (restoreScroll && Math.abs(window.scrollY - route.scrollY) > 1) window.scrollTo({ top: route.scrollY, behavior: 'instant' });
  if (changedView && hasRenderedData) playMotion($(`#view-${route.view}`), [{opacity:0,transform:'translateY(6px)'}, {opacity:1,transform:'translateY(0)'}], 180);
}

function applyTaskFilter() {
  if (!state.data) return;
  const query = ($('#task-search').value ?? '').trim().toLowerCase(); const status = $('#task-status').value;
  const account = $('#task-account').value;
  const tasks = state.data.tasks.filter(task => (!account || `${task.origin}|${task.accountRef}` === account) && matchesTask(task, { status, query }));
  renderTasks(tasks);
}

document.addEventListener('DOMContentLoaded', () => {
  renderRecentPages(state.view);
  installCompactTopbar({topbar:document.querySelector('.topbar')});
  const accountFilter = el('select'); accountFilter.id = 'task-account'; accountFilter.setAttribute('aria-label', '筛选账号');
  $('#task-status').after(accountFilter); accountFilter.addEventListener('change', applyTaskFilter);
  $('#task-search').placeholder = '搜索站点、用户名或 ID';
  for (const [key, label] of [['success', '全部成功'], ['pending', '全部未完成'], ...['login_required', 'failed', 'unknown','not_started'].map(key => [key, STATUS_LABELS[key]])]) { const option = el('option', null, label); option.value = key; $('#task-status').append(option); }
  history.scrollRestoration = 'manual';
  navigation = createNavigation({ history, location, onChange: applyRoute, readScroll: () => window.scrollY });
  applyRoute(navigation.current);
  window.addEventListener('popstate', event => navigation.restore(event.state));
  window.addEventListener('pagehide', () => navigation.remember());
  matchMedia('(max-width:700px)').addEventListener('change', () => {
    const mobile = matchMedia('(max-width:700px)').matches;
    const menuOpen = navigation.current.overlay?.type === 'menu';
    if (!mobile && menuOpen) navigation.closeOverlay();
    else renderSidebar(mobile && menuOpen);
  });
  document.querySelectorAll('.nav-item').forEach((item) => item.addEventListener('click', () => switchView(item.dataset.view)));
  document.querySelectorAll('[data-view-link]').forEach((item) => item.addEventListener('click', () => switchView(item.dataset.viewLink)));
  $('#menu-toggle').addEventListener('click', () => setSidebarOpen(!document.body.classList.contains('sidebar-open')));
  $('#sidebar-close').addEventListener('click', () => setSidebarOpen(false));
  $('#sidebar-backdrop').addEventListener('click', () => setSidebarOpen(false));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && navigation.current.overlay?.type === 'menu') setSidebarOpen(false);
    if (event.key === 'Tab' && document.body.classList.contains('sidebar-open') && matchMedia('(max-width:700px)').matches) {
      const nodes = [...$('#main-sidebar').querySelectorAll('button:not([disabled]), select:not([disabled]):not([tabindex="-1"])')].filter(node => node.getClientRects().length);
      const first = nodes[0], last = nodes.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  });
  $('#refresh-btn').addEventListener('click', loadData);
  $('#attention-jump')?.addEventListener('click', () => {
    if (navigation.current.view !== 'overview') switchView('overview');
    if (!state.data) return;
    const unread = pendingNotices(state.data.tasks ?? []).filter(task => !notices.isRead(task));
    if (unread.length) {
      notices.markRead(unread);
      renderAttention(state.data.tasks ?? []);
    }
    if (performance.now() < attentionScrollUntil) return;
    const target = $('#attention-list').closest('.panel');
    const top = target.getBoundingClientRect().top;
    const inset = $('.topbar-shell').getBoundingClientRect().bottom + 16;
    // Compact mobile headers change height after scrolling. Do not realign an
    // already visible panel against the new header on every subsequent click.
    if (top >= 0 && top < innerHeight - 80) return;
    attentionScrollUntil = performance.now() + 800;
    window.scrollTo({ top: Math.max(0, window.scrollY + top - inset), behavior: reducedMotion() ? 'instant' : 'smooth' });
  });
  const saveFilters = () => { applyTaskFilter(); navigation.updateFilters({ query: $('#task-search').value, status: $('#task-status').value, account: $('#task-account').value }); };
  $('#task-search').addEventListener('input', saveFilters); $('#task-status').addEventListener('change', saveFilters); $('#task-account').addEventListener('change', saveFilters);
  $('#token-visibility').addEventListener('click', () => {
    const input = $('#token-input');
    const visible = input.type === 'text';
    input.type = visible ? 'password' : 'text';
    $('#token-visibility').textContent = visible ? '显示' : '隐藏';
    $('#token-visibility').setAttribute('aria-label', visible ? '显示令牌' : '隐藏令牌');
  });
  $('#clear-token').addEventListener('click', async () => {
    await clearSession().catch(() => {});
    $('#token-input').value = '';
    $('#remember-token').checked = false;
    $('#login-error').textContent = '已清除安全会话，请重新输入';
    showLogin(true);
    state.data = null;
    $('#token-input').focus();
  });
  $('#login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const token = $('#token-input').value.trim();
    if (!token) { $('#login-error').textContent = '请输入管理令牌'; return; }
    try {
      await createSession(token, $('#remember-token').checked);
      $('#token-input').value = '';
      $('#login-error').textContent = '';
      await loadData();
    } catch (error) {
      $('#login-error').textContent = error.message;
    }
  });
  loadData();
  setInterval(() => {
    const editing = document.activeElement?.matches('input:not([type="checkbox"]), select, textarea');
    const overlayActive = navigation.current.overlay || document.body.classList.contains('sidebar-exiting') || document.querySelector('dialog[open]');
    if (!document.hidden && !editing && !overlayActive && $('#auto-refresh').checked && !document.body.classList.contains('unauthenticated')) loadData();
  }, 60000);
});
