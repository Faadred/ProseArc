// Settings tabs (General / Providers / Built-in translator) and the Providers
// page: a card per AI provider and a panel to set it up (key or address,
// Test, model list, "Use for new books"). Uses renderer.js helpers.

const pv = { filter: 'all', q: '', running: {}, open: null, models: null, testing: false, result: null };

// Last test result per provider ('ok' | 'bad'), so a refused key doesn't look "Activated".
function pvChecks() { try { return JSON.parse(localStorage.getItem('providerChecks') || '{}'); } catch { return {}; } }
function setPvCheck(id, val) {
  const c = pvChecks();
  if (val) c[id] = val; else delete c[id];
  try { localStorage.setItem('providerChecks', JSON.stringify(c)); } catch { /* storage off */ }
}

// ---- Tabs -------------------------------------------------------------------
function currentSettingsTab() {
  let tab = 'general';
  try { tab = localStorage.getItem('settingsTab') || 'general'; } catch { /* storage off */ }
  return tab;
}
function showSettingsTab(tab) {
  try { localStorage.setItem('settingsTab', tab); } catch { /* storage off */ }
  $$('#set-tabs [data-tab]').forEach((b) => {
    const on = b.dataset.tab === tab;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  $$('#view-settings .tab-page').forEach((p) => { p.hidden = p.dataset.page !== tab; });
  renderSettingsTab();
}
function renderSettingsTab() {
  const tab = currentSettingsTab();
  $$('#set-tabs [data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $$('#view-settings .tab-page').forEach((p) => { p.hidden = p.dataset.page !== tab; });
  if (tab === 'providers') renderProviders();
  if (tab === 'builtin') renderModelsPanel();
}
$('#set-tabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tab]');
  if (b) showSettingsTab(b.dataset.tab);
});
// Open Settings on a given tab (used by notes and buttons elsewhere).
function openSettingsTab(tab) {
  try { localStorage.setItem('settingsTab', tab); } catch { /* storage off */ }
  showView('settings');
}

// ---- Provider cards ---------------------------------------------------------
function providerKindLabel(p) {
  return t(p.kind === 'cloud' ? 'pv.kindCloud' : p.kind === 'custom' ? 'pv.kindCustom' : 'pv.kindLocal');
}
async function providerStatus(p, settings) {
  const { configured } = providersCache;
  if (p.kind === 'builtin') {
    const [engines, models] = await Promise.all([window.api.builtinEngines(), getModelFiles()]);
    return engines.length && models.length ? 'active' : 'setup';
  }
  if (p.kind === 'local') return pv.running[p.id] ? 'running' : 'stopped';
  if (!configured[p.id]) return 'setup';
  return pvChecks()[p.id] === 'bad' ? 'bad' : 'active';
}

async function renderProviders() {
  await loadProviders(true);
  const grid = $('#pv-grid');
  const settings = await window.api.getSettings();
  // Local apps: are they running right now? (quick, in the background)
  window.api.detectLocalServers().then((servers) => {
    const before = JSON.stringify(pv.running);
    for (const s of servers) pv.running[s.id] = s.running;
    if (JSON.stringify(pv.running) !== before && currentSettingsTab() === 'providers') renderProviders();
  });
  const q = pv.q.toLowerCase();
  const list = providersCache.providers.filter((p) =>
    (pv.filter === 'all' || (pv.filter === 'local' ? p.kind === 'local' || p.kind === 'builtin' : p.kind === 'cloud' || p.kind === 'custom'))
    && (!q || providerName(p).toLowerCase().includes(q) || p.id.includes(q)));
  const cards = await Promise.all(list.map(async (p) => {
    const st = await providerStatus(p, settings);
    const badge = st === 'active' ? `<span class="pv-badge on">${icon('circle-check')}${escapeHtml(t('pv.activated'))}</span>`
      : st === 'running' ? `<span class="pv-badge on">${icon('circle-check')}${escapeHtml(t('pv.running'))}</span>`
        : st === 'stopped' ? `<span class="pv-badge">${escapeHtml(t('pv.notRunning'))}</span>`
          : st === 'bad' ? `<span class="pv-badge bad">${icon('circle-alert')}${escapeHtml(t('pv.checkKey'))}</span>`
          : `<span class="pv-badge">${escapeHtml(t('pv.setUp'))}</span>`;
    return `
      <button class="pv-card ${st === 'active' || st === 'running' ? 'is-on' : ''}" data-id="${p.id}">
        <span class="pv-logo">${providerLogo(p)}</span>
        <span class="pv-card-text">
          <strong>${escapeHtml(providerName(p))}</strong>
          <small>${escapeHtml(t('pv.desc.' + p.id))}</small>
        </span>
        <span class="pv-card-foot">${badge}
          ${settings.provider === p.id ? `<span class="pv-default">${escapeHtml(t('mdl.isDefault'))}</span>` : ''}</span>
      </button>`;
  }));
  grid.innerHTML = cards.join('') || `<p class="settings-note">${escapeHtml(t('pv.none'))}</p>`;
  $('#pv-safe').innerHTML = `${icon(providersCache.encrypted ? 'check' : 'info')}<span>${escapeHtml(t(providersCache.encrypted ? 'pv.encrypted' : 'pv.notEncrypted'))}</span>`;
}

$('#pv-search').addEventListener('input', (e) => { pv.q = e.target.value.trim(); renderProviders(); });
$('#pv-filter').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-value]');
  if (!b) return;
  pv.filter = b.dataset.value;
  $$('#pv-filter button').forEach((x) => x.classList.toggle('active', x === b));
  renderProviders();
});
$('#pv-grid').addEventListener('click', (e) => {
  const c = e.target.closest('.pv-card');
  if (c) openProviderPanel(c.dataset.id);
});

// ---- Provider panel ---------------------------------------------------------
async function openProviderPanel(id) {
  await loadProviders();
  const p = providerInfo(id);
  if (!p) return;
  if (p.kind === 'builtin') { openSettingsTab('builtin'); showSettingsTab('builtin'); return; }
  pv.open = id;
  pv.models = null;
  pv.result = null;
  $('#pv-logo').innerHTML = providerLogo(p);
  $('#pv-title').textContent = providerName(p);
  $('#pv-kind').textContent = providerKindLabel(p);
  const sec = await window.api.getSecrets();
  renderProviderPanel(p, sec);
  $('#pv-modal').classList.add('open');
  const first = $('#pv-body input');
  if (first) first.focus();
}
function closeProviderPanel() {
  $('#pv-modal').classList.remove('open');
  pv.open = null;
  if (currentSettingsTab() === 'providers' && $('#view-settings').classList.contains('active')) renderProviders();
}

function renderProviderPanel(p, sec) {
  const needsKey = p.kind === 'cloud' || p.kind === 'custom';
  const hasUrl = p.kind === 'local' || p.kind === 'custom';
  const key = sec[p.id] || '';
  const url = sec[`${p.id}BaseUrl`] || '';
  const configured = providersCache.configured[p.id];
  const fields = `
    ${hasUrl ? `
      <div class="field">
        <label for="pv-url">${escapeHtml(t(p.kind === 'local' ? 'pv.address' : 'set.baseUrl'))}</label>
        <input id="pv-url" type="text" dir="ltr" value="${escapeHtml(url)}" placeholder="${escapeHtml(p.baseUrl || 'https://api.example.com/v1')}" />
        ${p.kind === 'local' ? `<p class="settings-note">${escapeHtml(t('pv.addressHint'))}</p>` : ''}
      </div>` : ''}
    ${needsKey ? `
      <div class="field">
        <label for="pv-key">${escapeHtml(t('set.apiKey'))}${p.optionalKey ? ` <span class="hint">${escapeHtml(t('f.modelOpt'))}</span>` : ''}</label>
        <div class="su-inline">
          <input id="pv-key" type="password" dir="ltr" autocomplete="off" value="${escapeHtml(key)}" placeholder="${escapeHtml(t('set.keyPh'))}" />
          <button class="icon-btn" id="pv-eye" title="${escapeHtml(t('pv.show'))}">${icon('eye')}</button>
        </div>
        <p class="settings-note">${p.keyUrl ? `<a href="${p.keyUrl}" target="_blank">${escapeHtml(t('su.getKey', { name: p.name }))}</a> · ` : ''}${escapeHtml(t(providersCache.encrypted ? 'pv.keyStoredSafe' : 'set.keysNote'))}</p>
      </div>` : ''}
    ${p.kind === 'local' ? `<p class="settings-note">${escapeHtml(t('pv.localHelp.' + p.id))} <a href="${p.site}" target="_blank">${escapeHtml(t('su.download'))}</a></p>` : ''}`;
  const result = pv.result
    ? `<div class="su-verdict ${pv.result.ok ? 'good' : 'bad'}">${icon(pv.result.ok ? 'circle-check' : 'circle-alert')}<span>${escapeHtml(pv.result.text)}</span></div>` : '';
  const models = pv.models && pv.models.length ? `
    <div class="pv-models-head"><h4 class="sub-title">${escapeHtml(t('pv.models', { n: pv.models.length }))}</h4>
      <input id="pv-mfilter" type="search" placeholder="${escapeHtml(t('pv.filterModels'))}" /></div>
    <div class="pv-models" id="pv-models">${renderModelChoices('')}</div>` : '';
  $('#pv-body').innerHTML = `
    <div class="pv-fields">${fields}</div>
    <div class="pv-actions">
      <button class="btn btn-primary" id="pv-save">${icon('check')}${escapeHtml(t('pv.saveTest'))}</button>
      ${configured && needsKey ? `<button class="btn btn-ghost" id="pv-remove">${icon('trash-2')}${escapeHtml(t('pv.removeKey'))}</button>` : ''}
    </div>
    ${pv.testing ? `<div class="su-loading"><span class="spinner"></span>${escapeHtml(t('test.testing'))}</div>` : result}
    ${models}`;
}
function renderModelChoices(filter) {
  const f = filter.toLowerCase();
  const list = pv.models.filter((m) => !f || m.toLowerCase().includes(f)).slice(0, 200);
  return list.map((m) => `
    <div class="pv-model"><span dir="ltr">${escapeHtml(m)}</span>
      <button class="btn btn-ghost btn-sm" data-use="${escapeHtml(m)}">${escapeHtml(t('mdl.useDefault'))}</button></div>`).join('')
    || `<p class="settings-note">${escapeHtml(t('mh.noResults'))}</p>`;
}

// Save what's typed, then test it by asking the provider for its models.
async function saveAndTestProvider() {
  const p = providerInfo(pv.open);
  const patch = {};
  const urlEl = $('#pv-url');
  const keyEl = $('#pv-key');
  if (urlEl) patch[`${p.id}BaseUrl`] = urlEl.value.trim().replace(/\/+$/, '');
  if (keyEl) patch[p.id] = keyEl.value.trim();
  await window.api.saveSecrets(patch);
  await loadProviders(true);
  delete modelListCache[p.id];
  pv.testing = true;
  pv.result = null;
  const sec = await window.api.getSecrets();
  renderProviderPanel(p, sec);
  const r = await window.api.listModels({ provider: p.id });
  pv.testing = false;
  setPvCheck(p.id, r.ok ? 'ok' : (r.status === 401 || r.status === 403 ? 'bad' : null));
  if (r.ok) {
    pv.models = r.models;
    modelListCache[p.id] = r.models;
    pv.result = { ok: true, text: t('pv.ok', { n: r.models.length }) };
  } else {
    pv.models = null;
    pv.result = { ok: false, text: t(r.status === 401 || r.status === 403 ? 'su.badKey' : r.status ? 'pv.httpErr' : (p.kind === 'local' ? 'pv.localDown' : 'pv.unreachable'), { status: r.status, name: p.name }) };
  }
  if (pv.open === p.id) renderProviderPanel(p, sec);
}

$('#pv-body').addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const p = providerInfo(pv.open);
  if (b.id === 'pv-save') saveAndTestProvider();
  else if (b.id === 'pv-eye') { const k = $('#pv-key'); k.type = k.type === 'password' ? 'text' : 'password'; }
  else if (b.id === 'pv-remove') {
    if (!await askConfirm({ title: t('pv.removeTitle', { name: p.name }), ok: t('pv.removeKey'), danger: true })) return;
    await window.api.saveSecrets({ [p.id]: '' });
    setPvCheck(p.id, null);
    await loadProviders(true);
    pv.models = null; pv.result = null;
    renderProviderPanel(p, await window.api.getSecrets());
  } else if (b.dataset.use) {
    await window.api.saveSettings({ provider: p.id, model: b.dataset.use });
    toast(t('pv.defaultSet', { name: providerName(p), model: b.dataset.use }), 'success');
  }
});
$('#pv-body').addEventListener('input', (e) => {
  if (e.target.id === 'pv-mfilter') $('#pv-models').innerHTML = renderModelChoices(e.target.value);
});
$('#pv-body').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.target.id === 'pv-key' || e.target.id === 'pv-url')) saveAndTestProvider();
});
$('#pv-close').addEventListener('click', closeProviderPanel);
$('#pv-modal').addEventListener('click', (e) => { if (e.target.id === 'pv-modal') closeProviderPanel(); });
$('#pv-modal').addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeProviderPanel(); } });

// The "set the key in Providers" notes under provider pickers open the panel.
['#ws-provider-note'].forEach((sel) => {
  const n = $(sel);
  if (n) n.addEventListener('click', () => openProviderPanel(n.dataset.provider));
});

loadProviders();
window.openProviderPanel = openProviderPanel;
window.openSettingsTab = openSettingsTab;
