// First-run Setup — gets a newcomer from nothing to a working translator:
//   Welcome → Your PC → Where to translate → Connect → Quick test → Done.
// Opens by itself on a first run with an empty Library, and from Settings
// ("Run setup again"). Uses renderer.js helpers ($, icon, t, toast, …).

const SU_STEPS = ['welcome', 'pc', 'choose', 'connect', 'test', 'done'];
const SU_SAMPLE = 'The rain had not stopped for three days. She stood at the window, counting the boats that had not come home.';

// Online providers offered in Setup (step 5 brings a fuller Providers page).
// Online providers offered in Setup: the cloud ones from the Providers list.
let SU_PROVIDERS = [];
async function loadSuProviders() {
  const { providers } = await loadProviders();
  SU_PROVIDERS = providers.filter((p) => p.kind === 'cloud' || p.kind === 'custom')
    .map((p) => ({ id: p.id, name: providerName(p), keyUrl: p.keyUrl || '' }));
}

const su = {
  step: 0,
  sys: null,
  servers: null,
  mode: null,                 // 'local' | 'online'
  local: { server: null, model: '' },
  online: { provider: 'openai', key: '', baseUrl: '', model: '' },
  thinking: false,
  test: null,                 // { busy } | { ok, text, ms } | { ok:false, key, params }
  langs: { source: 'English', target: 'Arabic' },
  bookCount: 0,
  applyAll: true,
};

async function openSetup() {
  await loadSuProviders();
  const settings = await window.api.getSettings();
  su.langs = { source: settings.sourceLang || 'English', target: settings.targetLang || 'Arabic' };
  su.thinking = !!settings.thinking;
  su.bookCount = (await window.api.listProjects()).length;
  su.step = 0;
  su.test = null;
  $('#setup').hidden = false;
  document.body.classList.add('setup-open');
  renderSetup();
  // Start the PC check early so it's ready by the time the user gets there.
  if (!su.sys) window.api.getSystemInfo().then((s) => { su.sys = s; if (SU_STEPS[su.step] === 'pc' || SU_STEPS[su.step] === 'choose') renderSetup(); });
}

function closeSetup(markDone = true) {
  if (markDone) { try { localStorage.setItem('setupDone', '1'); } catch { /* storage off */ } }
  $('#setup').hidden = true;
  document.body.classList.remove('setup-open');
}

function suGo(delta) {
  su.step = Math.max(0, Math.min(SU_STEPS.length - 1, su.step + delta));
  const name = SU_STEPS[su.step];
  if (name === 'connect' && su.mode === 'local' && !su.servers) suDetect();
  if (name === 'test') suRunTest();
  if (name === 'done') suSave();
  renderSetup();
  $('#su-body').scrollTop = 0;
}

async function suDetect(refreshModels = false) {
  su.servers = null;
  renderSetup();
  const [servers, engines, models] = await Promise.all([
    window.api.detectLocalServers(), window.api.builtinEngines(), getModelFiles(refreshModels),
  ]);
  su.servers = servers;
  su.engines = engines;
  su.builtinModels = models;
  const valid = (id) => (id === 'builtin' ? su.engines.length > 0 : su.servers.some((s) => s.id === id && s.running));
  if (!su.local.server || !valid(su.local.server)) {
    // Prefer the built-in translator when there's a model for it; else a running app.
    const first = su.servers.find((s) => s.running);
    if (su.engines.length && su.builtinModels.length) su.local.server = 'builtin';
    else su.local.server = first ? first.id : (su.engines.length ? 'builtin' : null);
    su.local.model = '';
  }
  if (su.local.server === 'builtin' && !su.builtinModels.some((m) => m.path === su.local.model)) {
    su.local.model = suBestModel();
  } else if (su.local.server !== 'builtin' && !su.local.model) {
    const srv = su.servers.find((s) => s.id === su.local.server);
    su.local.model = srv ? ((srv.models.find((m) => m.loaded) || srv.models[0] || {}).id || '') : '';
  }
  renderSetup();
}

// The largest model that fits the graphics card; else the smallest one.
function suBestModel() {
  const ms = su.builtinModels || [];
  const fits = ms.filter((m) => m.fit === 'fits').sort((a, b) => b.sizeGB - a.sizeGB);
  return (fits[0] || ms.slice().sort((a, b) => a.sizeGB - b.sizeGB)[0] || {}).path || '';
}

// The AI settings the user picked, in project/settings shape.
function suAiConfig() {
  if (su.mode === 'local' && su.local.server === 'builtin') {
    return { provider: 'builtin', model: su.local.model || '', thinking: su.thinking };
  }
  if (su.mode === 'local') {
    const srv = (su.servers || []).find((s) => s.id === su.local.server);
    return { provider: srv ? srv.id : 'lmstudio', model: su.local.model || '', thinking: su.thinking };
  }
  return { provider: su.online.provider, model: su.online.model.trim(), thinking: false };
}

async function suSaveSecrets() {
  if (su.mode !== 'online') return;
  const patch = { [su.online.provider]: su.online.key.trim() };
  if (su.online.provider === 'compatible') patch.compatibleBaseUrl = su.online.baseUrl.trim();
  await window.api.saveSecrets(patch); // merges with the other providers' keys
  await loadProviders(true);
}

async function suRunTest() {
  su.test = { busy: true };
  renderSetup();
  await suSaveSecrets(); // the engine reads keys from disk
  const ai = suAiConfig();
  su.test = await window.api.sampleTranslate({ ...ai, sourceLang: 'English', targetLang: su.langs.target, text: SU_SAMPLE });
  if (SU_STEPS[su.step] === 'test') renderSetup();
}

async function suSave() {
  const ai = suAiConfig();
  await suSaveSecrets();
  await window.api.saveSettings(ai);
  try { localStorage.setItem('setupDone', '1'); } catch { /* storage off */ }
}

async function suFinish(action) {
  if (su.bookCount > 0 && su.applyAll) {
    const n = await window.api.applyAiToAllProjects(suAiConfig());
    if (currentProject) { const fresh = await window.api.getProject(currentProject.id); currentProject.provider = fresh.provider; currentProject.apiUrl = fresh.apiUrl; currentProject.model = fresh.model; currentProject.thinking = fresh.thinking; }
    toast(t('su.appliedAll', { n }), 'success');
  } else {
    toast(t('su.saved'), 'success');
  }
  closeSetup(true);
  showView('library');
  if (action === 'import') openNewProjectModal();
}

// ---- Rendering --------------------------------------------------------------
function suCanNext() {
  const name = SU_STEPS[su.step];
  if (name === 'pc') return !!su.sys;
  if (name === 'choose') return !!su.mode;
  if (name === 'connect') {
    if (su.mode === 'local') return su.local.server === 'builtin' ? !!su.local.model : !!su.local.server;
    const o = su.online;
    if (o.provider === 'compatible') return !!o.baseUrl.trim() && !!o.model.trim();
    return !!o.key.trim() && !!o.model.trim();
  }
  if (name === 'test') return su.test && su.test.ok;
  return true;
}

function renderSetup() {
  const name = SU_STEPS[su.step];
  // Step dots (Welcome … Done)
  $('#su-steps').innerHTML = SU_STEPS.map((s, i) =>
    `<li class="${i < su.step ? 'done' : i === su.step ? 'current' : ''}"><span>${escapeHtml(t('su.step.' + s))}</span></li>`).join('');
  const body = $('#su-body');
  body.innerHTML = ({ welcome: suWelcome, pc: suPc, choose: suChoose, connect: suConnect, test: suTest, done: suDone })[name]();
  body.dataset.step = name;
  mountIcons(body);

  // Footer
  $('#su-back').hidden = su.step === 0 || name === 'done';
  $('#su-skip').hidden = name === 'done';
  document.querySelector('.setup-foot').hidden = name === 'done';
  const next = $('#su-next');
  next.hidden = name === 'done';
  next.disabled = !suCanNext();
  next.innerHTML = name === 'welcome'
    ? `<span>${escapeHtml(t('su.start'))}</span>`
    : `<span>${escapeHtml(t('su.next'))}</span>`;
  wireSetupBody(name);
}

function suWelcome() {
  return `
    <div class="su-hero">
      <img class="su-logo" src="assets/mark-gold.svg" alt="" />
      <h2 id="su-title">${t('su.welcomeTitle')}</h2>
      <p class="su-lede">${t('su.welcomeBody')}</p>
      <div class="su-lang">
        <span>${t('set.language')}</span>
        <div class="segmented" id="su-lang">
          <button data-value="en" class="${getLang() === 'en' ? 'active' : ''}">English</button>
          <button data-value="ar" lang="ar" class="${getLang() === 'ar' ? 'active' : ''}">العربية</button>
        </div>
      </div>
    </div>`;
}

function suPc() {
  if (!su.sys) {
    return `<h2 id="su-title">${t('su.pcTitle')}</h2><div class="su-loading"><span class="spinner"></span>${t('su.pcChecking')}</div>`;
  }
  const s = su.sys;
  const g = s.gpu;
  const tier = s.tier.key;
  const good = tier === 'large' || tier === 'medium';
  return `
    <h2 id="su-title">${t('su.pcTitle')}</h2>
    <p class="su-lede">${t('su.pcLede')}</p>
    <div class="su-specs">
      <div class="su-spec"><span class="su-spec-icon"><i data-icon="monitor"></i></span>
        <span><small>${t('su.gpu')}</small><strong>${g ? escapeHtml(g.name) : t('su.noGpu')}</strong>
        <em>${g ? t('su.vram', { gb: g.vramGB }) : t('su.noGpuHint')}</em></span></div>
      <div class="su-spec"><span class="su-spec-icon"><i data-icon="sliders-horizontal"></i></span>
        <span><small>${t('su.ram')}</small><strong>${t('su.gb', { gb: s.ramGB })}</strong><em>${t('su.ramHint')}</em></span></div>
      <div class="su-spec"><span class="su-spec-icon"><i data-icon="cpu"></i></span>
        <span><small>${t('su.cpu')}</small><strong>${escapeHtml(s.cpu || '—')}</strong><em>${t('su.cores', { n: s.cores })}</em></span></div>
    </div>
    <div class="su-verdict ${good ? 'good' : 'meh'}">
      ${icon(good ? 'circle-check' : 'info')}
      <span>${t('su.tier.' + tier, { maxB: s.tier.maxB })}</span>
    </div>`;
}

function suChoose() {
  const rec = su.sys && (su.sys.tier.key === 'large' || su.sys.tier.key === 'medium') ? 'local' : 'online';
  const card = (mode, ic, n) => `
    <button class="su-choice ${su.mode === mode ? 'selected' : ''}" data-mode="${mode}" aria-pressed="${su.mode === mode}">
      <span class="su-choice-icon"><i data-icon="${ic}"></i></span>
      <strong>${t('su.' + mode + 'Title')}</strong>
      <ul>${[1, 2, 3].map((k) => `<li>${t('su.' + mode + n + k)}</li>`).join('')}</ul>
    </button>`;
  return `
    <h2 id="su-title">${t('su.chooseTitle')}</h2>
    <p class="su-lede">${t('su.chooseLede')}</p>
    <div class="su-choices">${card('local', 'monitor', 'P')}${card('online', 'globe', 'P')}</div>`;
}

function suConnect() {
  return su.mode === 'local' ? suConnectLocal() : suConnectOnline();
}

function suConnectLocal() {
  const head = `<div class="su-title-row"><h2 id="su-title">${t('su.localTitle')}</h2>
      <button class="btn btn-ghost btn-sm su-switch" data-mode="online">${icon('globe')}${t('su.useOnline')}</button></div>
    <p class="su-lede">${t('su.localLede')}</p>`;
  if (!su.servers) return `${head}<div class="su-loading"><span class="spinner"></span>${t('su.looking')}</div>`;
  const bSel = su.local.server === 'builtin';
  const bModels = su.builtinModels || [];
  const bm = bModels.find((m) => m.path === su.local.model);
  const builtIn = !su.engines.length ? `
    <div class="su-server disabled">
      <span class="su-server-icon"><i data-icon="sparkles"></i></span>
      <span class="su-server-text"><strong>${t('su.builtIn')}</strong><span>${t('mdl.noEngine')}</span></span>
    </div>` : `
    <div class="su-server ${bSel ? 'selected' : ''}" data-server="builtin" role="button" tabindex="0" id="su-builtin">
      <span class="su-server-icon"><i data-icon="sparkles"></i></span>
      <span class="su-server-text"><strong>${t('su.builtIn')}</strong>
        <span>${bModels.length ? t('su.builtInFound', { n: bModels.length }) : t('su.builtInNoModels')}</span></span>
      ${bSel ? `
        <div class="field su-model">
          ${bModels.length ? `
            <label for="su-bmodel">${t('f.bmodel')}</label>
            <select id="su-bmodel">${bModels.map((m) => `<option value="${escapeHtml(m.path)}" ${m.path === su.local.model ? 'selected' : ''}>${escapeHtml(modelLabel(m))}</option>`).join('')}</select>
            ${bm ? `<p class="settings-note fit-note fit-${bm.fit}">${icon(FIT_ICON[bm.fit])}<span>${t('fit.' + bm.fit)}</span></p>` : ''}` : ''}
          <div class="su-drop" id="su-drop">${icon('folder-plus')}<span>${t('su.dropFolder')}</span>
            <button class="btn btn-ghost btn-sm" id="su-addfolder">${t('mdl.addFolder')}</button>
            <button class="btn btn-ghost btn-sm" id="su-findmodel">${icon('search')}${t('mh.findOnline')}</button></div>
        </div>` : ''}
    </div>`;
  const rows = su.servers.map((s) => {
    const sel = su.local.server === s.id;
    const loaded = s.models.filter((m) => m.loaded);
    const status = s.running
      ? `<span class="su-status ok">${icon('circle-check')}${loaded.length ? t('su.runningLoaded', { model: escapeHtml(loaded[0].id) }) : t('su.runningNoModel')}</span>`
      : `<span class="su-status off">${t('su.notRunning')}</span>`;
    const models = sel && s.running ? `
      <div class="field su-model">
        <label for="su-model">${t('f.model')}</label>
        <select id="su-model">${s.models.map((m) => `<option value="${escapeHtml(m.id)}" ${m.id === su.local.model ? 'selected' : ''}>${escapeHtml(m.id)}${m.loaded ? ' · ' + t('su.loaded') : ''}</option>`).join('')}</select>
        ${s.id === 'lmstudio' ? `<p class="settings-note">${t('su.lmJit')}</p>` : ''}
      </div>` : '';
    return `
      <div class="su-server ${sel ? 'selected' : ''} ${s.running ? '' : 'off'}" data-server="${s.id}" ${s.running ? 'role="button" tabindex="0"' : ''}>
        <span class="su-server-icon">${s.running ? icon('check') : icon('circle-alert')}</span>
        <span class="su-server-text"><strong>${s.name}</strong>${status}
          ${s.running ? '' : `<span class="su-help">${t('su.' + s.id + 'Help')} <a href="${s.site}" target="_blank">${t('su.download')}</a></span>`}</span>
        ${models}
      </div>`;
  }).join('');
  const none = su.servers.every((s) => !s.running);
  return `${head}${builtIn}${rows}
    <div class="su-row">
      <button class="btn btn-ghost btn-sm" id="su-recheck">${icon('refresh-cw')}${t('su.checkAgain')}</button>
      ${none ? `<span class="su-note">${t('su.noneRunning')}</span>` : ''}
    </div>
    <details class="fold"><summary>${t('adv.title')}</summary>
      <label class="check"><input type="checkbox" id="su-thinking" ${su.thinking ? 'checked' : ''}/> <span>${t('f.thinking')}</span></label>
      <p class="settings-note">${t('f.thinkingHint')}</p>
    </details>`;
}

function suConnectOnline() {
  const o = su.online;
  const p = SU_PROVIDERS.find((x) => x.id === o.provider);
  return `
    <div class="su-title-row"><h2 id="su-title">${t('su.onlineTitle')}</h2>
      <button class="btn btn-ghost btn-sm su-switch" data-mode="local">${icon('monitor')}${t('su.useLocal')}</button></div>
    <p class="su-lede">${t('su.onlineLede')}</p>
    <div class="su-providers">${SU_PROVIDERS.map((x) => `
      <button class="su-provider ${x.id === o.provider ? 'selected' : ''}" data-provider="${x.id}">${escapeHtml(x.id === 'compatible' ? t('prov.compatible') : x.name)}</button>`).join('')}
    </div>
    ${o.provider === 'compatible' ? `
      <div class="field"><label for="su-base">${t('set.baseUrl')}</label>
        <input id="su-base" type="text" placeholder="https://api.example.com/v1" value="${escapeHtml(o.baseUrl)}" /></div>` : ''}
    <div class="field">
      <label for="su-key">${t('set.apiKey')}${o.provider === 'compatible' ? ` <span class="hint">${t('f.modelOpt')}</span>` : ''}</label>
      <input id="su-key" type="password" autocomplete="off" placeholder="${escapeHtml(t('set.keyPh'))}" value="${escapeHtml(o.key)}" />
      ${p && p.keyUrl ? `<p class="settings-note"><a href="${p.keyUrl}" target="_blank">${t('su.getKey', { name: escapeHtml(p.name) })}</a> · ${t('set.keysNote')}</p>` : `<p class="settings-note">${t('set.keysNote')}</p>`}
    </div>
    <div class="field">
      <label for="su-omodel">${t('f.model')}</label>
      <div class="su-inline">
        <input id="su-omodel" type="text" list="su-models" placeholder="${escapeHtml(t('su.modelPh'))}" value="${escapeHtml(o.model)}" />
        <button class="btn btn-ghost btn-sm" id="su-list">${icon('list')}${t('su.listModels')}</button>
      </div>
      <datalist id="su-models"></datalist>
      <p class="settings-note" id="su-list-note">${t('su.modelHint')}</p>
    </div>`;
}

function suTest() {
  const tst = su.test;
  const rtl = isRtlLang(su.langs.target);
  let out;
  if (!tst || tst.busy) out = `<div class="su-loading"><span class="spinner"></span>${t(suAiConfig().provider === 'builtin' ? 'su.testingBuiltin' : 'su.testing')}</div>`;
  else if (tst.ok) out = `
      <div class="su-result" dir="${rtl ? 'rtl' : 'auto'}">${escapeHtml(tst.text)}</div>
      <div class="su-verdict good">${icon('circle-check')}<span>${t('su.testOk', { sec: (tst.ms / 1000).toFixed(1) })}</span></div>`;
  else out = `
      <div class="su-verdict bad">${icon('circle-alert')}<span>${escapeHtml(t('err.' + tst.key, tst.params))}</span></div>
      <button class="btn btn-ghost btn-sm" id="su-retry">${icon('refresh-cw')}${t('su.tryAgain')}</button>`;
  return `
    <h2 id="su-title">${t('su.testTitle')}</h2>
    <p class="su-lede">${t('su.testLede', { src: 'English', tgt: escapeHtml(su.langs.target) })}</p>
    <div class="su-source" dir="ltr">${escapeHtml(SU_SAMPLE)}</div>
    ${out}
    ${tst && tst.ok ? `<button class="btn btn-ghost btn-sm" id="su-retry">${icon('refresh-cw')}${t('su.tryAgain')}</button>` : ''}`;
}

function suDone() {
  const ai = suAiConfig();
  const where = ai.provider === 'builtin'
    ? `${t('su.builtIn')} · ${((su.builtinModels || []).find((m) => m.path === ai.model) || {}).name || ''}`
    : ai.provider === 'local'
    ? `${((su.servers || []).find((s) => s.id === su.local.server) || {}).name || ''}${ai.model ? ' · ' + ai.model : ''}`
    : `${(SU_PROVIDERS.find((p) => p.id === ai.provider) || {}).name || ''}${ai.model ? ' · ' + ai.model : ''}`;
  return `
    <div class="su-hero">
      <span class="su-done-icon">${icon('circle-check')}</span>
      <h2 id="su-title">${t('su.doneTitle')}</h2>
      <p class="su-lede">${t('su.doneBody')}</p>
      <div class="su-summary">${icon('sparkles')}<span>${escapeHtml(where)}</span></div>
      ${su.bookCount > 0 ? `<label class="check"><input type="checkbox" id="su-apply" ${su.applyAll ? 'checked' : ''}/> <span>${t('su.applyAll', { n: su.bookCount })}</span></label>` : ''}
      <div class="su-done-actions">
        ${su.bookCount === 0
          ? `<button class="btn btn-primary btn-lg" id="su-import">${icon('file-up')}${t('lib.emptyBtn')}</button>`
          : `<button class="btn btn-primary btn-lg" id="su-finish">${icon('library')}${t('su.toLibrary')}</button>`}
      </div>
    </div>`;
}

function wireSetupBody(name) {
  const body = $('#su-body');
  const on = (sel, ev, fn) => { const el = body.querySelector(sel); if (el) el.addEventListener(ev, fn); };
  if (name === 'welcome') {
    on('#su-lang', 'click', (e) => {
      const b = e.target.closest('button[data-value]');
      if (b && b.dataset.value !== getLang()) { setLang(b.dataset.value); renderSetup(); }
    });
  }
  if (name === 'choose') {
    body.querySelectorAll('.su-choice').forEach((b) => b.addEventListener('click', () => {
      su.mode = b.dataset.mode; su.test = null; renderSetup();
    }));
  }
  if (name === 'connect' && su.mode === 'local') {
    body.querySelectorAll('.su-server[data-server]').forEach((row) => {
      const pick = (e) => {
        if (e.target.closest('select, a')) return;
        if (e.target.closest('button, .su-drop')) return;
        if (row.dataset.server === 'builtin') {
          if (su.local.server === 'builtin') return;
          su.local.server = 'builtin';
          su.local.model = suBestModel();
          su.test = null;
          renderSetup();
          return;
        }
        const srv = su.servers.find((s) => s.id === row.dataset.server);
        if (!srv || !srv.running || su.local.server === srv.id) return;
        su.local.server = srv.id;
        su.local.model = (srv.models.find((m) => m.loaded) || srv.models[0] || {}).id || '';
        su.test = null;
        renderSetup();
      };
      row.addEventListener('click', pick);
      row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(e); } });
    });
    on('#su-model', 'change', (e) => { su.local.model = e.target.value; su.test = null; });
    on('#su-bmodel', 'change', (e) => { su.local.model = e.target.value; su.test = null; renderSetup(); });
    on('#su-addfolder', 'click', async (e) => { e.stopPropagation(); await addModelFolder(); await suDetect(true); });
    on('#su-findmodel', 'click', (e) => {
      e.stopPropagation();
      openModelHub({ onDownloaded: async (p) => { su.local.model = p; await suDetect(true); su.local.model = p; renderSetup(); } });
    });
    const drop = body.querySelector('#su-builtin');
    if (drop) wireFolderDrop(drop, () => suDetect(true));
    on('#su-recheck', 'click', suDetect);
    on('#su-thinking', 'change', (e) => { su.thinking = e.target.checked; su.test = null; });
  }
  if (name === 'connect' && su.mode === 'online') {
    body.querySelectorAll('.su-provider').forEach((b) => b.addEventListener('click', () => {
      su.online.provider = b.dataset.provider; su.online.model = ''; su.test = null; renderSetup();
    }));
    const sync = () => {
      su.online.key = (body.querySelector('#su-key') || {}).value || '';
      su.online.baseUrl = (body.querySelector('#su-base') || {}).value || '';
      su.online.model = (body.querySelector('#su-omodel') || {}).value || '';
      su.test = null;
      $('#su-next').disabled = !suCanNext();
    };
    body.querySelectorAll('input').forEach((i) => i.addEventListener('input', sync));
    on('#su-list', 'click', async () => {
      sync();
      const note = $('#su-list-note');
      note.textContent = t('su.listing');
      const r = await window.api.listModels({ provider: su.online.provider, key: su.online.key, baseUrl: su.online.baseUrl });
      if (r.ok && r.models.length) {
        $('#su-models').innerHTML = r.models.map((m) => `<option value="${escapeHtml(m)}"></option>`).join('');
        note.textContent = t('su.listed', { n: r.models.length });
        $('#su-omodel').focus();
      } else {
        note.textContent = r.status === 401 || r.status === 403 ? t('su.badKey') : t('su.listFailed');
      }
    });
  }
  if (name === 'connect') {
    const sw = body.querySelector('.su-switch');
    if (sw) sw.addEventListener('click', () => {
      su.mode = sw.dataset.mode; su.test = null;
      if (su.mode === 'local' && !su.servers) suDetect(); else renderSetup();
    });
  }
  if (name === 'test') on('#su-retry', 'click', suRunTest);
  if (name === 'done') {
    on('#su-apply', 'change', (e) => { su.applyAll = e.target.checked; });
    on('#su-import', 'click', () => suFinish('import'));
    on('#su-finish', 'click', () => suFinish('library'));
  }
}

$('#su-next').addEventListener('click', () => { if (suCanNext()) suGo(1); });
$('#su-back').addEventListener('click', () => suGo(-1));
$('#su-close').addEventListener('click', () => closeSetup(true));
$('#su-skip').addEventListener('click', () => closeSetup(true));
$('#setup').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.stopPropagation(); closeSetup(true); }
});
$('#set-setup').addEventListener('click', openSetup);

// First run: no books yet and Setup never finished or skipped → open it.
(async () => {
  let done = false;
  try { done = localStorage.getItem('setupDone') === '1'; } catch { /* storage off */ }
  if (done) return;
  const books = await window.api.listProjects();
  if (books.length === 0) openSetup();
})();

window.openSetup = openSetup;
