const state = { view: 'overview', token: sessionStorage.getItem('fabricToken') ?? '', data: null, loading: false };

const STATUS_LABELS = {
  signed: '已签到', already_signed: '今日已完成', not_available: '未开放',
  needs_attention: '需关注', deferred: '已延迟', login_required: '需登录', failed: '失败', unknown: '未知'
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
  const source = { usage_log: '使用日志', api: 'API', page_text: '页面文本', user_confirmation: '用户确认', legacy_authoritative: '旧系统权威', none: '无' }[evidence.source] ?? evidence.source;
  return evidence.authoritative ? `${source} · 已确认` : `${source} · 待确认`;
}

function showLogin(show) {
  $('#login-panel').classList.toggle('hidden', !show);
}

function showError(message = '') {
  const node = $('#app-error');
  node.textContent = message;
  node.classList.toggle('hidden', !message);
}

async function api(pathname, options = {}) {
  const headers = { Accept: 'application/json', ...(options.headers ?? {}) };
  if (state.token) headers['X-Fabric-Token'] = state.token;
  const response = await fetch(pathname, { ...options, headers, credentials: 'same-origin' });
  let body = null;
  try { body = await response.json(); } catch { /* error body is optional */ }
  if (response.status === 401) {
    showLogin(true);
    throw new Error('需要输入控制台令牌');
  }
  if (!response.ok) throw new Error(body?.message ?? `请求失败（${response.status}）`);
  return body;
}

function renderKpis(data) {
  const counts = data?.counts ?? {};
  const status = data?.status ?? {};
  const healthy = data?.health?.freshness?.fresh === true;
  const cards = [
    ['逻辑站点', counts.logicalSites ?? 0, '计划中的独立站点'],
    ['执行单元', counts.executionUnits ?? 0, `${status.signed ?? 0} 个已签到`],
    ['需关注', (status.needs_attention ?? 0) + (status.deferred ?? 0), '不会自动重复点击'],
    ['计划健康', healthy ? 'Fresh' : 'Stale', healthy ? '数据在新鲜度窗口内' : '健康源已过期']
  ];
  const grid = $('#kpi-grid'); grid.replaceChildren();
  for (const [label, value, foot] of cards) {
    const card = el('div', 'kpi');
    append(card, el('div', 'kpi-label', label), el('div', 'kpi-value', value), el('div', 'kpi-foot', foot));
    grid.append(card);
  }
}

function renderHealth(data) {
  const health = data?.health ?? {};
  const freshness = health.freshness ?? {};
  const badge = $('#health-badge'); badge.className = `badge ${freshness.fresh ? 'good' : 'warn'}`; badge.textContent = freshness.fresh ? 'HEALTHY' : 'STALE';
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
  const donut = el('div', 'donut'); append(donut, el('strong', null, total));
  const legend = el('div', 'legend');
  const colors = { signed: '#159570', already_signed: '#6e87e8', not_available: '#8b96a8', needs_attention: '#d5a348', deferred: '#d76f78', failed: '#c54b55' };
  for (const key of ['signed', 'already_signed', 'not_available', 'needs_attention', 'deferred', 'failed']) {
    if (!(status[key] ?? 0)) continue;
    const row = el('div', 'legend-row');
    const label = el('span', 'legend-label', STATUS_LABELS[key]); label.style.setProperty('--dot', colors[key] ?? '#8b96a8');
    append(row, label, el('strong', null, `${status[key]} · ${total ? Math.round(status[key] / total * 100) : 0}%`)); legend.append(row);
  }
  append(chart, donut, legend);
}

function renderPlan(data) {
  const snapshot = data ?? {};
  const values = [
    ['业务日期', snapshot.businessDate], ['快照生成', formatTime(snapshot.generatedAt)],
    ['计划哈希', formatHash(snapshot.planHash)], ['运行模式', snapshot.mode === 'shadow_read_only' ? '只读影子' : snapshot.mode]
  ];
  const container = $('#latest-plan'); container.replaceChildren();
  for (const [label, value] of values) { const item = el('div', 'meta-item'); append(item, el('span', null, label), el('strong', null, value)); container.append(item); }
}

function renderOverview(data) {
  renderKpis(data); renderHealth(data); renderStatusChart(data); renderPlan(data);
}

function renderTasks(tasks) {
  const body = $('#tasks-body'); body.replaceChildren();
  if (!tasks.length) { const row = el('tr'); const cell = el('td'); cell.colSpan = 6; cell.textContent = '没有匹配的任务'; row.append(cell); body.append(row); return; }
  for (const task of tasks) {
    const row = el('tr');
    const taskCell = el('td'); append(taskCell, el('span', 'task-id', task.taskId), el('span', 'subtext', `${task.actionType} · ${task.scheduleOccurrence}`));
    const siteCell = el('td'); append(siteCell, el('span', 'origin', task.origin), el('span', 'subtext', task.logicalGroup ?? task.logicalSiteKey));
    const accountCell = el('td', null, task.accountRef ?? '站点默认');
    const statusCell = el('td'); statusCell.append(statusChip(task.observedStatus));
    const evidenceCell = el('td'); append(evidenceCell, el('span', null, evidenceLabel(task)), el('span', 'subtext', task.observedAt ? formatTime(task.observedAt) : '—'));
    const ownerCell = el('td'); append(ownerCell, el('span', null, task.executionOwner), el('span', 'subtext', task.executionMode === 'observe_only' ? '只读观察' : task.executionMode));
    append(row, taskCell, siteCell, accountCell, statusCell, evidenceCell, ownerCell); body.append(row);
  }
}

function renderSites(sites) {
  const grid = $('#sites-grid'); grid.replaceChildren();
  if (!sites.length) { grid.append(el('p', 'muted', '暂无站点数据')); return; }
  for (const site of sites) {
    const card = el('article', 'site-card'); const top = el('div', 'card-top');
    append(top, el('h3', null, site.origin), site.logicalGroup ? el('span', 'badge', site.logicalGroup) : null);
    const stats = el('div', 'card-stats');
    const total = site.executionUnitCount ?? 0; const done = (site.status?.signed ?? 0) + (site.status?.already_signed ?? 0);
    append(stats, el('div', 'card-stat', null)); stats.lastChild.append(el('b', null, total), el('span', null, '执行单元'));
    const statusStat = el('div', 'card-stat'); statusStat.append(el('b', null, done), el('span', null, '已完成')); stats.append(statusStat);
    const bar = el('div', 'mini-bar'); const fill = el('i'); fill.style.width = `${total ? Math.round(done / total * 100) : 0}%`; bar.append(fill);
    const controls = el('div', 'site-controls');
    const policy = el('select');
    for (const [value, label] of [['monitor', '正常观察'], ['review', '标记复核'], ['pause', '计划暂停']]) {
      const option = el('option', null, label); option.value = value; option.selected = (site.control?.policy ?? 'monitor') === value; policy.append(option);
    }
    const note = el('input'); note.type = 'text'; note.maxLength = 240; note.placeholder = '备注（可选）'; note.value = site.control?.note ?? '';
    const save = el('button', 'button control-button', '保存策略');
    save.addEventListener('click', async () => {
      save.disabled = true; save.textContent = '保存中…';
      try {
        await api('/api/controls/sites', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ origin: site.origin, policy: policy.value, note: note.value }) });
        save.textContent = '已保存'; setTimeout(() => { save.textContent = '保存策略'; save.disabled = false; }, 900);
      } catch (error) { save.textContent = '保存失败'; save.disabled = false; showError(error.message); }
    });
    append(controls, policy, note, save);
    append(card, top, stats, bar, controls, el('span', 'subtext control-note', 'Beta 中只影响 V2 管理视图，不会暂停旧签到任务。')); grid.append(card);
  }
}

function renderAccounts(accounts) {
  const grid = $('#accounts-grid'); grid.replaceChildren();
  if (!accounts.length) { grid.append(el('p', 'muted', '暂无账户任务')); return; }
  for (const account of accounts) {
    const card = el('article', 'account-card'); const top = el('div', 'card-top');
    append(top, el('h3', null, account.accountRef), el('span', 'badge good', '隔离'));
    const stats = el('div', 'card-stats'); const done = (account.status?.signed ?? 0) + (account.status?.already_signed ?? 0);
    const count = el('div', 'card-stat'); count.append(el('b', null, account.taskCount), el('span', null, '任务')); stats.append(count);
    const completed = el('div', 'card-stat'); completed.append(el('b', null, done), el('span', null, '已完成')); stats.append(completed);
    const sites = (account.sites ?? []).join(' · ');
    append(card, top, stats, el('span', 'subtext', sites || '无站点')); grid.append(card);
  }
}

function renderLedger(records) {
  const body = $('#ledger-body'); body.replaceChildren();
  if (!records.length) { const row = el('tr'); const cell = el('td'); cell.colSpan = 6; cell.textContent = '暂无运行记录'; row.append(cell); body.append(row); return; }
  for (const record of [...records].reverse()) {
    const row = el('tr'); const drift = record.drift?.classification ?? '—';
    const driftNode = el('span', `status-chip ${drift === 'same_plan' ? 'already_signed' : drift === 'plan_changed' ? 'deferred' : ''}`, drift === 'same_plan' ? '无变化' : drift === 'initial' ? '初始' : drift);
    const cells = [formatTime(record.recordedAt), record.businessDate, formatHash(record.planHash), driftNode, record.counts?.executionUnits ?? '—', record.health?.freshness?.fresh ? 'Fresh' : 'Stale'];
    for (const [index, value] of cells.entries()) { const cell = el('td'); if (value instanceof Node) cell.append(value); else cell.textContent = text(value); if (index === 0) cell.className = 'subtext'; row.append(cell); }
    body.append(row);
  }
}

function renderSettings(data) {
  const snapshot = data?.snapshot ?? {};
  const content = $('#settings-content'); content.replaceChildren();
  const rows = [
    ['运行模式', '只读影子（Beta）'], ['执行所有者', 'legacy-checkin'],
    ['签到执行', '由现有 Windows runner 独占'], ['租约发放', '已禁用'],
    ['通知发送', '本控制台不发送通知'], ['计划来源', snapshot.source?.system ?? '—'],
    ['认证状态', data?.authConfigured ? '已配置' : '仅回环访问'], ['数据目录', '服务端已配置（路径不展示）']
  ];
  for (const [label, value] of rows) { const row = el('div', 'setting-row'); append(row, el('span', null, label), el('strong', null, value)); content.append(row); }
  const note = el('div', 'alert', '管理动作目前仅保留控制面展示，不会修改旧签到项目。进入 V2.0 candidate 前，需要完成 NAS 影子观察和人工批准。'); note.style.marginTop = '18px'; content.append(note);
}

function renderAll() {
  const data = state.data;
  if (!data) return;
  renderOverview(data.snapshot);
  renderTasks(data.tasks ?? []);
  renderSites(data.sites ?? []);
  renderAccounts(data.accounts ?? []);
  renderLedger(data.ledger ?? []);
  renderSettings(data);
  $('#service-status').textContent = '已连接 · 影子模式'; $('.status-dot').style.background = '#45c59d';
}

async function loadData() {
  if (state.loading) return;
  state.loading = true; showError(''); $('#refresh-btn').disabled = true; $('#refresh-btn').textContent = '刷新中…';
  try {
    const [summary, tasks, sites, accounts, ledger, config] = await Promise.all([api('/api/summary'), api('/api/tasks'), api('/api/sites'), api('/api/accounts'), api('/api/ledger'), api('/api/config')]);
    state.data = { snapshot: summary, tasks: tasks.tasks ?? [], sites: sites.sites ?? [], accounts: accounts.accounts ?? [], ledger: ledger.records ?? [], authConfigured: config.authConfigured };
    showLogin(false); renderAll();
  } catch (error) {
    $('#service-status').textContent = '连接失败'; $('.status-dot').style.background = '#d76f78'; showError(error.message);
  } finally { state.loading = false; $('#refresh-btn').disabled = false; $('#refresh-btn').textContent = '刷新数据'; }
}

function switchView(view) {
  state.view = view;
  document.querySelectorAll('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.view === view));
  document.querySelectorAll('.view').forEach((item) => item.classList.toggle('active-view', item.id === `view-${view}`));
  const titles = { overview: '签到运行总览', tasks: '任务管理', sites: '站点管理', accounts: '账户管理', ledger: '运行记录', settings: '设置与边界' };
  $('#page-title').textContent = titles[view] ?? titles.overview;
}

function applyTaskFilter() {
  if (!state.data) return;
  const query = ($('#task-search').value ?? '').trim().toLowerCase(); const status = $('#task-status').value;
  const tasks = state.data.tasks.filter((task) => (!status || task.observedStatus === status) && (!query || `${task.origin} ${task.logicalSiteKey} ${task.accountRef ?? ''} ${task.taskId}`.toLowerCase().includes(query)));
  renderTasks(tasks);
}

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.nav-item').forEach((item) => item.addEventListener('click', () => switchView(item.dataset.view)));
  document.querySelectorAll('[data-view-link]').forEach((item) => item.addEventListener('click', () => switchView(item.dataset.viewLink)));
  $('#refresh-btn').addEventListener('click', loadData);
  $('#task-search').addEventListener('input', applyTaskFilter); $('#task-status').addEventListener('change', applyTaskFilter);
  $('#login-form').addEventListener('submit', (event) => { event.preventDefault(); state.token = $('#token-input').value; sessionStorage.setItem('fabricToken', state.token); $('#login-error').textContent = ''; loadData(); });
  loadData();
});
