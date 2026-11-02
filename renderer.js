// Renderer — the UI logic. Runs in the page with no Node access; it talks to
// the main process only through window.api (defined in preload.js).

// ---- Tiny helpers -----------------------------------------------------------
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

// Short messages that need no answer. kind: 'info' | 'success' | 'error'.
// They stack in the bottom corner and fade out on their own (errors stay longer).
const TOAST_ICON = { info: 'info', success: 'circle-check', error: 'circle-alert' };
function toast(message, kind = 'info') {
  const box = $('#toasts');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  el.innerHTML = `${icon(TOAST_ICON[kind] || 'info')}<span>${escapeHtml(message)}</span>`;
  box.appendChild(el);
  while (box.children.length > 3) box.firstElementChild.remove();
  requestAnimationFrame(() => el.classList.add('show'));
  const close = () => { el.classList.remove('show'); setTimeout(() => el.remove(), 220); };
  el.addEventListener('click', close);
  setTimeout(close, kind === 'error' ? 6000 : 3200);
}

// In-app yes/no dialog. Resolves true when confirmed. danger = red button.
function askConfirm({ title, body = '', ok, danger = false }) {
  return new Promise((resolve) => {
    const modal = $('#confirm-modal');
    $('#cf-title').textContent = title;
    $('#cf-body').textContent = body;
    $('#cf-body').hidden = !body;
    $('#cf-icon').innerHTML = icon(danger ? 'trash-2' : 'circle-alert');
    $('#cf-icon').classList.toggle('danger', danger);
    const okBtn = $('#cf-ok');
    okBtn.textContent = ok || t('common.ok');
    okBtn.className = `btn ${danger ? 'btn-danger-solid' : 'btn-primary'}`;
    const prevFocus = document.activeElement;
    const done = (val) => {
      modal.classList.remove('open');
      okBtn.onclick = null; $('#cf-cancel').onclick = null; modal.onclick = null;
      document.removeEventListener('keydown', onKey, true);
      if (prevFocus && prevFocus.focus) prevFocus.focus();
      resolve(val);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); done(false); }
      else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); done(true); }
    };
    okBtn.onclick = () => done(true);
    $('#cf-cancel').onclick = () => done(false);
    modal.onclick = (e) => { if (e.target === modal) done(false); };
    document.addEventListener('keydown', onKey, true);
    modal.classList.add('open');
    (danger ? $('#cf-cancel') : okBtn).focus(); // the safe choice has focus for risky actions
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// ---- View navigation --------------------------------------------------------
let currentProjectId = null;

function showView(name) {
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  if (name === 'review') renderReview();
  if (name === 'glossary') renderGlossary();
  if (name === 'settings') renderSettings();
  if (name === 'reader') renderReader();
  if (name === 'hub') renderHub();
  if (name === 'library') renderLibrary();
}

$$('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => showView(btn.dataset.view));
});

// ---- Pop-up menu (⋯) --------------------------------------------------------
// openMenu(anchor, [{ icon, label, action, danger }]) shows a small menu under
// the anchor button, aligned to its end edge. Click outside or Escape closes it.
function openMenu(anchor, items) {
  const menu = $('#menu');
  menu.innerHTML = items.map((it, i) => `
    <button class="menu-item${it.danger ? ' danger' : ''}" role="menuitem" data-i="${i}">
      ${icon(it.icon)}<span>${escapeHtml(it.label)}</span></button>`).join('');
  menu.hidden = false;
  const r = anchor.getBoundingClientRect();
  const m = menu.getBoundingClientRect();
  const rtl = document.documentElement.dir === 'rtl';
  let left = rtl ? r.left : r.right - m.width;
  left = Math.max(8, Math.min(left, window.innerWidth - m.width - 8));
  let top = r.bottom + 6;
  if (top + m.height > window.innerHeight - 8) top = r.top - m.height - 6;
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  menu.onclick = (e) => {
    const b = e.target.closest('.menu-item');
    if (!b) return;
    closeMenu();
    items[+b.dataset.i].action();
  };
  menu.querySelector('.menu-item')?.focus();
  anchor.setAttribute('aria-expanded', 'true');
  openMenu._anchor = anchor;
}
function closeMenu() {
  $('#menu').hidden = true;
  if (openMenu._anchor) openMenu._anchor.setAttribute('aria-expanded', 'false');
}
document.addEventListener('mousedown', (e) => {
  if ($('#menu').hidden || e.target.closest('#menu')) return;
  if (openMenu._anchor && openMenu._anchor.contains(e.target)) return;
  closeMenu();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#menu').hidden) closeMenu(); });
window.addEventListener('resize', closeMenu);
$('.main').addEventListener('scroll', closeMenu, { passive: true });

// ---- Library ----------------------------------------------------------------
// The next step for a book, used by the card's main button and the book page.
function nextStep(c) {
  if (c.translated === 0) return { view: 'workspace', label: t('card.start'), icon: 'play' };
  if (c.translated < c.total) return { view: 'workspace', label: t('card.continue'), icon: 'languages' };
  if (c.reviewed < c.total) return { view: 'review', label: t('card.continueReview'), icon: 'pencil-line' };
  return { view: 'reader', label: t('card.read'), icon: 'book-open-text' };
}

async function renderLibrary() {
  const body = $('#library-body');
  const projects = await window.api.listProjects();
  $('#new-project-btn').hidden = projects.length === 0;
  $('#lib-lede').textContent = projects.length ? t('lib.lede') : t('lib.ledeEmpty');

  if (projects.length === 0) {
    body.innerHTML = `
      <div class="first-run">
        <button class="import-hero" id="empty-new">
          <span class="import-hero-icon">${icon('file-up')}</span>
          <span class="import-hero-title">${t('lib.emptyTitle')}</span>
          <span class="import-hero-body">${t('lib.emptyBody')}</span>
          <span class="btn btn-primary btn-lg">${icon('plus')}${t('lib.emptyBtn')}</span>
        </button>
        <ol class="steps">
          ${[['file-up', 1], ['languages', 2], ['pencil-line', 3], ['book-open-text', 4]].map(([ic, n]) => `
            <li class="step"><span class="step-icon">${icon(ic)}</span>
              <span class="step-text"><strong>${t('lib.step' + n)}</strong><span>${t('lib.step' + n + 'd')}</span></span></li>`).join('')}
        </ol>
      </div>`;
    $('#empty-new').addEventListener('click', openNewProjectModal);
    return;
  }

  body.innerHTML = `<div class="book-grid">${projects.map(cardHtml).join('')}
    <button class="book-add" id="lib-add">
      <span class="book-add-inner"><span class="book-add-icon">${icon('plus')}</span><span>${t('lib.addTile')}</span></span>
    </button></div>`;
  $('#lib-add').addEventListener('click', openNewProjectModal);

  projects.forEach((p) => {
    const card = body.querySelector(`.book-card[data-id="${p.id}"]`);
    card.addEventListener('click', (e) => {
      if (e.target.closest('.js-menu, .js-next')) return;
      openBook(p.id);
    });
    card.addEventListener('keydown', (e) => {
      if (e.target !== card) return;
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openBook(p.id); }
    });
    card.querySelector('.js-next').addEventListener('click', async () => {
      await loadProject(p.id);
      showView(nextStep(p.counts).view);
    });
    card.querySelector('.js-menu').addEventListener('click', (e) => {
      openMenu(e.currentTarget, bookMenuItems(p.id));
    });
  });

  // The list holds summaries only; fetch each book once for its cover image.
  const full = await Promise.all(projects.map((p) => window.api.getProject(p.id).catch(() => null)));
  full.forEach((p) => {
    if (!p || !p.coverUrl) return;
    const el = body.querySelector(`.book-card[data-id="${p.id}"] .book-cover`);
    if (el) el.innerHTML = coverHtml(p);
  });
}

function cardHtml(p) {
  const { total, translated, reviewed } = p.counts;
  const pctT = total ? Math.round((translated / total) * 100) : 0;
  const pctR = total ? Math.round((reviewed / total) * 100) : 0;
  const done = total > 0 && reviewed === total;
  const next = nextStep(p.counts);
  return `
    <article class="book-card" data-id="${p.id}" tabindex="0" aria-label="${escapeHtml(p.name)}">
      <div class="book-cover">${coverHtml(p)}</div>
      ${done ? `<span class="book-badge">${icon('circle-check')}${t('card.done')}</span>` : ''}
      <button class="icon-btn book-menu js-menu" aria-haspopup="menu" aria-label="${t('card.more')}" title="${t('card.more')}">${icon('ellipsis')}</button>
      <div class="book-info">
        <h3 class="book-title" dir="auto">${escapeHtml(p.name)}</h3>
        <div class="book-langs">${escapeHtml(p.sourceLang)} → ${escapeHtml(p.targetLang)}</div>
        <div class="book-progress" title="${escapeHtml(t('stats', { t: translated, n: total, r: reviewed }))}">
          <span class="bp-reviewed" style="width:${pctR}%"></span><span class="bp-translated" style="width:${pctT - pctR}%"></span>
        </div>
        <div class="book-foot">
          <span class="book-pct">${t('card.meta', { pct: pctT, r: reviewed })}</span>
          <button class="btn btn-ghost btn-sm js-next">${icon(next.icon)}${next.label}</button>
        </div>
      </div>
    </article>`;
}

// Rename / cover / delete for any book (from its card or its book page).
function bookMenuItems(id, { withRemoveCover = false } = {}) {
  const withBook = (fn) => async () => {
    const p = (currentProject && currentProject.id === id) ? currentProject : await window.api.getProject(id);
    fn(p);
  };
  const items = [
    { icon: 'pencil', label: t('hub.rename'), action: withBook(openRenameModal) },
    { icon: 'image', label: t('hub.cover'), action: withBook(changeCover) },
  ];
  if (withRemoveCover) items.push({ icon: 'x', label: t('hub.coverRemove'), action: withBook(removeCover) });
  items.push({ icon: 'trash-2', label: t('card.delete'), danger: true, action: withBook(deleteBook) });
  return items;
}

async function deleteBook(p) {
  if (!await askConfirm({ title: t('confirm.deleteTitle', { name: p.name }), body: t('confirm.deleteBody'), ok: t('card.delete'), danger: true })) return;
  await window.api.deleteProject(p.id);
  if (currentProject && currentProject.id === p.id) {
    currentProject = null;
    currentProjectId = null;
    renderBookNav();
    showView('library');
  }
  toast(t('toast.deleted'), 'success');
  renderLibrary();
}

// ---- Workspace / Control Center --------------------------------------------
let currentProject = null; // full project object of the open project
let isRunning = false;

function countStatuses(segments) {
  return segments.reduce(
    (acc, s) => {
      acc.total++;
      if (s.status === 'reviewed') { acc.reviewed++; acc.translated++; }
      else if (s.status === 'translated') acc.translated++;
      return acc;
    },
    { total: 0, translated: 0, reviewed: 0 }
  );
}

function renderProgress(counts) {
  const pct = counts.total ? Math.round((counts.translated / counts.total) * 100) : 0;
  $('#ws-bar').style.width = `${pct}%`;
  if (currentProject && $('#bn-meta')) $('#bn-meta').textContent = t('bn.meta', { pct });
  $('#ws-counter').textContent =
    t('stats', { t: counts.translated, n: counts.total, r: counts.reviewed });
}

// Load a project into memory and populate the workspace fields (no navigation).
async function loadProject(id) {
  const project = await window.api.getProject(id);
  currentProject = project;
  currentProjectId = id;
  readerProjectId = null; // force the Reader to rebuild with fresh content

  // Populate header + settings fields.
  $('#ws-title').textContent = project.name;
  $('#ws-langs').textContent = `${project.sourceLang} → ${project.targetLang}`;
  $('#ws-name').value = project.name;
  $('#ws-source').value = project.sourceLang;
  $('#ws-target').value = project.targetLang;
  $('#ws-url').value = project.apiUrl;
  $('#ws-model').value = project.model || '';
  $('#ws-context').value = project.contextWindow;
  $('#ws-thinking').checked = !!project.thinking;
  $('#ws-style').value = project.styleBrief || '';
  migrateLocalProvider(project);
  await fillProviderSelect('#ws-provider', project.provider || 'builtin');
  applyProviderVisibility(project.provider || 'builtin', '#ws-url-field', '#ws-provider-note');
  if (project.provider === 'builtin') {
    fillModelSelect('#ws-bmodel', project.model, '#ws-bmodel-note').then((chosen) => {
      if (!project.model && chosen && currentProject === project) saveSettings();
    });
  }
  else suggestModels('#ws-model-list', project.provider);

  renderProgress(countStatuses(project.segments));
  clearError();
  updatePrimaryAction();

  $('#workspace-empty').hidden = true;
  $('#workspace-panel').hidden = false;
  renderBookNav();
}

// Clicking a book in the Library lands on its hub page.
async function openBook(id) {
  await loadProject(id);
  renderHub();
  showView('hub');
}
// Open straight into the Workspace (used by the hub's Translate action).
async function openProject(id) {
  if (!currentProject || currentProject.id !== id) await loadProject(id);
  showView('workspace');
}

// ---- Covers -----------------------------------------------------------------
// A book's cover: the real image when there is one, otherwise a generated
// cover (its title set on a tinted background). `mini` = just the initial.
function coverHtml(p, { mini = false } = {}) {
  if (p.coverUrl) return `<img src="${p.coverUrl}" alt="" draggable="false" />`;
  const name = (p.name || '?').trim();
  const bg = coverColor(name);
  if (mini) {
    return `<span class="gen-cover mini" style="--cover:${bg}"><span>${escapeHtml(name[0] || '?')}</span></span>`;
  }
  return `<span class="gen-cover" style="--cover:${bg}">
      <span class="gen-title" dir="auto">${escapeHtml(name)}</span>
      <span class="gen-rule"></span>
      <span class="gen-langs" dir="auto">${escapeHtml(p.sourceLang || '')} → ${escapeHtml(p.targetLang || '')}</span>
    </span>`;
}

// Tooltips for sidebar items: in a narrow window the sidebar shows icons only.
function syncNavTitles() {
  $$('.sidebar .nav-item').forEach((b) => {
    const label = b.querySelector('[data-i18n]') || b.querySelector('.book-chip-title');
    b.title = label ? label.textContent.trim() : '';
  });
}

// ---- Open book in the sidebar ----------------------------------------------
function renderBookNav() {
  const nav = $('#book-nav');
  if (!currentProject) { nav.hidden = true; return; }
  const p = currentProject;
  const c = countStatuses(p.segments);
  const pct = c.total ? Math.round((c.translated / c.total) * 100) : 0;
  $('#bn-cover').innerHTML = coverHtml(p, { mini: true });
  $('#bn-title').textContent = p.name;
  $('#bn-meta').textContent = t('bn.meta', { pct });
  nav.hidden = false;
  syncNavTitles();
}

// ---- Book hub ---------------------------------------------------------------
// Cloth colours for generated covers (deep enough for white text in both themes).
const HUB_COLORS = ['#2F5D5A', '#6B3236', '#2E4366', '#4E3A5F', '#5B5428', '#35533A', '#6A4A2C', '#3C5866'];
function coverColor(name) {
  let h = 0;
  const s = String(name || '');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return HUB_COLORS[h % HUB_COLORS.length];
}
function renderHub() {
  if (!currentProject) return;
  const p = currentProject;
  const c = countStatuses(p.segments);
  const pctT = c.total ? Math.round((c.translated / c.total) * 100) : 0;
  const pctR = c.total ? Math.round((c.reviewed / c.total) * 100) : 0;
  $('#hub-title').textContent = p.name;
  $('#hub-langs').textContent = `${p.sourceLang} → ${p.targetLang}`;
  $('#hub-cover').innerHTML = coverHtml(p);
  $('#hub-bar-reviewed').style.width = `${pctR}%`;
  $('#hub-bar-fill').style.width = `${pctT - pctR}%`;
  $('#hub-count-t').textContent = t('hub.countT', { t: c.translated, n: c.total });
  $('#hub-count-r').textContent = t('hub.countR', { r: c.reviewed, n: c.total });
  $('#hub-st-translate').textContent = c.translated >= c.total ? t('hub.stDone') : t('hub.stPct', { pct: pctT });
  $('#hub-st-review').textContent = c.reviewed >= c.total ? t('hub.stDone') : t('hub.stPct', { pct: pctR });
  const next = nextStep(c);
  $('#hub-next').innerHTML = `${icon(next.icon)}<span>${escapeHtml(next.label)}</span>`;
  $('#hub-next').dataset.go = next.view;
}

// Rename runs through an in-app modal: window.prompt() is not supported in
// Electron renderers (it silently does nothing).
let renameTarget = null;
function openRenameModal(p = currentProject) {
  if (!p) return;
  renameTarget = p;
  $('#rn-input').value = p.name;
  $('#rename-modal').classList.add('open');
  $('#rn-input').focus();
  $('#rn-input').select();
}
function closeRenameModal() { $('#rename-modal').classList.remove('open'); }
async function saveRename() {
  const p = renameTarget;
  if (!p) return;
  const clean = $('#rn-input').value.trim();
  closeRenameModal();
  if (!clean || clean === p.name) return;
  p.name = clean;
  await window.api.saveProject(p);
  if (currentProject && currentProject.id === p.id) {
    currentProject.name = clean;
    $('#ws-name').value = clean;
    $('#ws-title').textContent = clean;
    renderHub();
    renderBookNav();
  }
  renderLibrary();
}

async function changeCover(p = currentProject) {
  if (!p) return;
  const res = await window.api.pickCover(p.id);
  if (!res) return; // user cancelled the picker
  if (res.error) { toast(t('toast.coverError'), 'error'); return; }
  p.coverUrl = res.coverUrl;
  if (currentProject && currentProject.id === p.id) {
    currentProject.coverUrl = res.coverUrl;
    renderHub();
    renderBookNav();
  }
  renderLibrary();
}
async function removeCover(p = currentProject) {
  if (!p) return;
  await window.api.removeCover(p.id);
  p.coverUrl = null;
  if (currentProject && currentProject.id === p.id) {
    currentProject.coverUrl = null;
    renderHub();
    renderBookNav();
  }
  renderLibrary();
}
// Book page: the next-step button and the four step tiles.
$('#view-hub').addEventListener('click', (e) => {
  const go = e.target.closest('[data-go]');
  if (!go) return;
  if (go.dataset.go === 'export') openExportModal();
  else showView(go.dataset.go);
});
$('#hub-menu').addEventListener('click', (e) => {
  if (currentProject) openMenu(e.currentTarget, bookMenuItems(currentProject.id, { withRemoveCover: !!currentProject.coverUrl }));
});
$('#rn-save').addEventListener('click', saveRename);
$('#rn-cancel').addEventListener('click', closeRenameModal);
$('#rn-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') saveRename();
});
$('#rename-modal').addEventListener('click', (e) => {
  if (e.target.id === 'rename-modal') closeRenameModal(); // click backdrop to close
});

// Auto-save settings whenever a field changes.
async function saveSettings() {
  if (!currentProject) return;
  currentProject.name = $('#ws-name').value.trim() || 'Untitled Project';
  currentProject.sourceLang = $('#ws-source').value.trim() || 'Source';
  currentProject.targetLang = $('#ws-target').value.trim() || 'Target';
  currentProject.apiUrl = $('#ws-url').value.trim();
  currentProject.model = currentProject.provider === 'builtin' || $('#ws-provider').value === 'builtin'
    ? $('#ws-bmodel').value
    : $('#ws-model').value.trim();
  currentProject.contextWindow = Math.max(0, parseInt($('#ws-context').value, 10) || 0);
  currentProject.thinking = $('#ws-thinking').checked;
  currentProject.styleBrief = $('#ws-style').value.trim();
  currentProject.provider = $('#ws-provider').value;

  $('#ws-title').textContent = currentProject.name;
  $('#ws-langs').textContent = `${currentProject.sourceLang} → ${currentProject.targetLang}`;
  renderBookNav();

  await window.api.saveProject(currentProject);
}

// Show the API-URL field only for the local provider; show a key hint for cloud.
function applyProviderVisibility(provider, urlFieldSel, noteSel) {
  const local = provider === 'local';
  const builtinP = provider === 'builtin';
  const urlEl = $(urlFieldSel);
  if (urlEl) urlEl.style.display = local ? '' : 'none';
  if (noteSel) {
    const n = $(noteSel);
    if (n) {
      const pv = providerInfo(provider);
      const needsSetup = pv && (pv.kind === 'cloud' || pv.kind === 'custom') && !(providersCache && providersCache.configured[provider]);
      n.style.display = needsSetup ? '' : 'none';
      n.dataset.provider = provider;
    }
  }
  const pre = urlFieldSel.startsWith('#ws') ? 'ws' : 'set';
  $(`#${pre}-bmodel-field`).hidden = !builtinP;
  $(`#${pre}-model-field`).hidden = builtinP;
}

// ---- Providers: list, selects, model suggestions -----------------------------
let providersCache = null; // { providers, configured, encrypted }
async function loadProviders(refresh = false) {
  if (!providersCache || refresh) providersCache = await window.api.listProviders();
  return providersCache;
}
function providerInfo(id) {
  return providersCache ? providersCache.providers.find((p) => p.id === id) : null;
}
function providerName(p) {
  if (!p) return '';
  if (p.id === 'builtin') return t('prov.builtin');
  if (p.id === 'compatible') return t('prov.compatible');
  return p.name;
}
// Fill a provider <select>. 'local' (a URL from older versions) appears only when in use.
async function fillProviderSelect(sel, value) {
  const { providers } = await loadProviders();
  const opts = providers.map((p) => `<option value="${p.id}">${escapeHtml(providerName(p))}</option>`);
  if (value === 'local') opts.push(`<option value="local">${escapeHtml(t('prov.localLegacy'))}</option>`);
  $(sel).innerHTML = opts.join('');
  $(sel).value = value;
}
// Books from before the Providers page used 'local' + a full URL.
function migrateLocalProvider(project) {
  if (project.provider && project.provider !== 'local') return;
  const u = project.apiUrl || '';
  let next = null;
  if (/:11434\b/.test(u)) next = 'ollama';
  else if (!u || /(localhost|127\.0\.0\.1):1234\b/.test(u)) next = 'lmstudio';
  if (next) { project.provider = next; window.api.saveProject({ ...project }); }
}
// Model-name suggestions from the provider's own list (quietly skipped when not set up).
const modelListCache = {};
async function suggestModels(datalistSel, provider) {
  const dl = $(datalistSel);
  if (!dl) return;
  dl.innerHTML = '';
  const pv = providerInfo(provider) || (await loadProviders(), providerInfo(provider));
  if (!pv || pv.kind === 'builtin' || !(providersCache.configured[provider])) return;
  if (!modelListCache[provider]) {
    const r = await window.api.listModels({ provider });
    if (!r.ok) return;
    modelListCache[provider] = r.models;
  }
  dl.innerHTML = modelListCache[provider].slice(0, 300).map((m) => `<option value="${escapeHtml(m)}"></option>`).join('');
}

// ---- Built-in translator: models ------------------------------------------
let modelFilesCache = null;
async function getModelFiles(refresh = false) {
  if (!modelFilesCache || refresh) modelFilesCache = await window.api.listModelFiles();
  return modelFilesCache;
}
const FIT_ICON = { fits: 'circle-check', partial: 'info', slow: 'info', toobig: 'circle-alert' };
function modelLabel(m) {
  return [m.name, [m.params, m.quant].filter(Boolean).join(' '), `${m.sizeGB} GB`].filter(Boolean).join(' · ');
}
// Fill a <select> with the models found; keep `value` even if it's gone.
async function fillModelSelect(sel, value, noteSel) {
  const el = $(sel);
  const models = await getModelFiles();
  const opts = models.map((m) => `<option value="${escapeHtml(m.path)}">${escapeHtml(modelLabel(m))}${m.fit === 'toobig' ? ' — ' + escapeHtml(t('fit.toobig')) : ''}</option>`);
  if (value && !models.some((m) => m.path === value)) {
    opts.unshift(`<option value="${escapeHtml(value)}">${escapeHtml(value.split(/[\\/]/).pop())} — ${escapeHtml(t('mdl.missing'))}</option>`);
  }
  if (!models.length && !value) opts.unshift(`<option value="">${escapeHtml(t('mdl.none'))}</option>`);
  el.innerHTML = opts.join('');
  // No choice yet: the largest model that fits the graphics card, else the smallest.
  const fits = models.filter((m) => m.fit === 'fits').sort((a, b) => b.sizeGB - a.sizeGB);
  el.value = value || (fits[0] || models.slice().sort((a, b) => a.sizeGB - b.sizeGB)[0] || {}).path || '';
  if (noteSel) {
    const m = models.find((x) => x.path === el.value);
    $(noteSel).innerHTML = !models.length
      ? escapeHtml(t('mdl.noneHint'))
      : m ? `${icon(FIT_ICON[m.fit])}<span>${escapeHtml(t('fit.' + m.fit))}</span>` : '';
    $(noteSel).className = `settings-note fit-note ${m ? 'fit-' + m.fit : ''}`;
  }
  return el.value;
}

['#ws-name', '#ws-source', '#ws-target', '#ws-url', '#ws-model', '#ws-context', '#ws-style', '#ws-provider', '#ws-thinking', '#ws-bmodel']
  .forEach((sel) => $(sel).addEventListener('change', saveSettings));
$('#ws-bmodel').addEventListener('change', () => fillModelSelect('#ws-bmodel', $('#ws-bmodel').value, '#ws-bmodel-note'));
$('#ws-provider').addEventListener('change', async (e) => {
  applyProviderVisibility(e.target.value, '#ws-url-field', '#ws-provider-note');
  if (e.target.value === 'builtin') { await fillModelSelect('#ws-bmodel', '', '#ws-bmodel-note'); saveSettings(); }
  else suggestModels('#ws-model-list', e.target.value);
});

// ---- Activity log -----------------------------------------------------------
function logLine(message, level = 'info') {
  const log = $('#ws-log');
  // Only auto-scroll if the user is already near the bottom (lets them read history).
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
  const line = document.createElement('div');
  line.className = `log-line ${level}`;
  const ts = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  line.innerHTML = `<span class="ts">${ts}</span>${escapeHtml(message)}`;
  log.appendChild(line);
  if (nearBottom) log.scrollTop = log.scrollHeight;
}

function showError(message) {
  clearError();
  const banner = document.createElement('div');
  banner.className = 'error-banner';
  banner.id = 'ws-error';
  banner.innerHTML = `<strong>${t('err.banner')}</strong> ${escapeHtml(message)}`;
  $('#workspace-panel').insertBefore(banner, $('#workspace-panel').children[1]);
}
function clearError() {
  const existing = $('#ws-error');
  if (existing) existing.remove();
}

// ---- Run controls -----------------------------------------------------------
function setEngineRunning(on) {
  isRunning = on;
  const btn = $('#ws-run');
  btn.innerHTML = `${icon(on ? 'square' : 'play')}<span>${escapeHtml(t(on ? 'ws.stop' : 'ws.start'))}</span>`;
  btn.classList.toggle('btn-stop', on);
  // Lock settings while a run is in progress.
  ['#ws-name', '#ws-source', '#ws-target', '#ws-url', '#ws-model', '#ws-context', '#ws-style', '#ws-provider', '#ws-thinking']
    .forEach((sel) => { $(sel).disabled = on; });

  // Review controls: disable editing actions; "↻ All" becomes a Stop control.
  ['#rv-retrans-seg', '#rv-prev', '#rv-next', '#rv-save', '#rv-review-all', '#rv-fr']
    .forEach((sel) => { const el = $(sel); if (el) el.disabled = on; });
  const all = $('#rv-retrans-all');
  if (all) {
    all.innerHTML = `${icon(on ? 'square' : 'list-restart')}<span>${escapeHtml(t(on ? 'rv.stop' : 'rv.all'))}</span>`;
    all.classList.toggle('btn-stop', on);
    all.title = t(on ? 'rv.stop' : 'rv.all');
  }
}

async function toggleRun() {
  if (!currentProject) return;
  if (isRunning) {
    $('#ws-run').disabled = true;
    logLine(t('ws.stopping'), 'info');
    await window.api.stopTranslation();
    return;
  }
  clearError();
  setEngineRunning(true);
  await window.api.startTranslation(currentProject.id);
}

$('#ws-run').addEventListener('click', toggleRun);

// ---- Test connection --------------------------------------------------------
async function runConnectionTest(url, out) {
  out.className = 'test-result busy';
  out.textContent = t('test.testing');
  const r = await window.api.testConnection((url || '').trim());
  out.className = 'test-result ' + (r.ok ? 'ok' : 'bad');
  out.innerHTML = `${icon(r.ok ? 'circle-check' : 'circle-alert')}<span>${escapeHtml(t('test.' + r.code, r.params))}</span>`;
}
$('#ws-test').addEventListener('click', () => runConnectionTest($('#ws-url').value, $('#ws-test-result')));

// ---- Export -----------------------------------------------------------------
let exportFormat = localStorage.getItem('exportFormat') || 'pdf';

function openExportModal() {
  if (!currentProject) return;
  const c = countStatuses(currentProject.segments);
  const untranslated = currentProject.segments.filter((s) => !(s.translation && s.translation.trim())).length;
  $('#export-sub').textContent =
    `“${currentProject.name}” · ${currentProject.sourceLang} → ${currentProject.targetLang}`;
  $('#export-status').innerHTML = untranslated > 0
    ? `<span class="warn">${escapeHtml(t('ex.statusWarn', { u: untranslated, n: c.total }))}</span>`
    : escapeHtml(t('ex.statusAll', { n: c.total }));
  selectExportFormat(exportFormat);
  $('#export-modal').classList.add('open');
}
function closeExportModal() { $('#export-modal').classList.remove('open'); }

function selectExportFormat(fmt) {
  exportFormat = fmt;
  $$('#export-formats .format-opt').forEach((b) => b.classList.toggle('active', b.dataset.fmt === fmt));
  $('#export-go').textContent = t('ex.go', { fmt: fmt.toUpperCase() });
}

async function doExport() {
  const fmt = exportFormat;
  localStorage.setItem('exportFormat', fmt);
  closeExportModal();
  const r = await window.api.exportProject(currentProject.id, fmt);
  if (!r || r.canceled) return;
  const F = (r.format || fmt).toUpperCase();
  if (r.untranslated > 0) {
    toast(t('toast.exportedWarn', { fmt: F, u: r.untranslated, n: r.total }), 'info');
    logLine(t('log.exportedWarn', { fmt: F, path: r.path, u: r.untranslated, n: r.total }), 'info');
  } else {
    toast(t('toast.exported', { n: r.total, fmt: F }), 'success');
    logLine(t('log.exported', { fmt: F, path: r.path }), 'success');
  }
}

// The Workspace's secondary button exports the current project.
function updatePrimaryAction() {
  // The Export label is a data-i18n span now; nothing dynamic left here.
}

$('#ws-export').addEventListener('click', openExportModal);
$('#export-formats').addEventListener('click', (e) => {
  const opt = e.target.closest('.format-opt');
  if (opt) selectExportFormat(opt.dataset.fmt);
});
$('#export-go').addEventListener('click', doExport);
$('#export-cancel').addEventListener('click', closeExportModal);
$('#export-modal').addEventListener('click', (e) => { if (e.target.id === 'export-modal') closeExportModal(); });

// Stream of engine events from the main process.
window.api.onEngineEvent(async (ev) => {
  switch (ev.type) {
    case 'started':
      if (ev.mode !== 'single') logLine(t('log.runStarted'), 'info');
      break;
    case 'progress':
      renderProgress(ev.counts);
      break;
    case 'segment':
      applyLiveSegment(ev);
      logLine(t('log.segTranslated', { n: ev.index + 1 }), 'success');
      break;
    case 'log':
      logLine(t('log.' + ev.key, ev.params), ev.level || 'info');
      break;
    case 'error':
      logLine(t('log.runHalted'), 'error');
      showError(t('err.' + ev.key, ev.params));
      setEngineRunning(false);
      $('#ws-run').disabled = false;
      break;
    case 'done':
      if (ev.counts) renderProgress(ev.counts);
      if (ev.reason === 'completed') { logLine(t('log.allTranslated'), 'success'); toast(t('toast.complete'), 'success'); }
      else if (ev.reason === 'stopped') { logLine(t('log.stopped'), 'info'); }
      setEngineRunning(false);
      $('#ws-run').disabled = false;
      // Refresh the in-memory project so Review sees the new text.
      if (currentProjectId) currentProject = await window.api.getProject(currentProjectId);
      refreshReviewIfActive();
      break;
  }
});

// Apply a single freshly-translated segment to the in-memory project + Review UI.
function applyLiveSegment(ev) {
  if (!currentProject) return;
  const seg = currentProject.segments.find((s) => s.id === ev.id) || currentProject.segments[ev.index];
  if (!seg) return;
  seg.translation = ev.translation;
  seg.status = ev.status;
  if ($('#view-review').classList.contains('active')) {
    renderNavWindow();
    const open = currentProject.segments[reviewIndex];
    if (!reviewDirty && open && open.id === seg.id) {
      $('#rv-translation').value = ev.translation;
      updateEditorHead();
    }
  }
}

// ---- New Project modal ------------------------------------------------------
let pickedManuscript = null; // { fileName, text }

async function openNewProjectModal() {
  pickedManuscript = null;
  $('#np-file-label').textContent = t('np.noFile');
  $('#np-file').classList.remove('chosen');
  $('#np-name').value = '';
  // Pre-fill languages from the saved global defaults (Settings).
  const s = await window.api.getSettings();
  $('#np-source').value = s.sourceLang || 'English';
  $('#np-target').value = s.targetLang || 'Arabic';
  $('#np-create').disabled = true;
  $('#new-project-modal').classList.add('open');
}

function closeNewProjectModal() {
  $('#new-project-modal').classList.remove('open');
}

async function pickFile() {
  const result = await window.api.pickManuscript();
  if (!result) return; // cancelled

  if (result.error) {                       // parse failure (corrupt EPUB/DOCX, etc.)
    pickedManuscript = null;
    $('#np-create').disabled = true;
    toast(t('toast.importError'), 'error');
    return;
  }
  if (Array.isArray(result.blocks) && result.blocks.length === 0) {
    pickedManuscript = null;
    $('#np-create').disabled = true;
    toast(t('toast.importEmpty'), 'error');
    return;
  }

  pickedManuscript = result;
  $('#np-file-label').textContent = result.fileName;
  $('#np-file').classList.add('chosen');
  // Pre-fill name from the embedded title (EPUB) or the filename, if empty.
  if (!$('#np-name').value.trim()) {
    $('#np-name').value = (result.title && result.title.trim())
      || result.fileName.replace(/\.[^.]+$/, '');
  }
  $('#np-create').disabled = false;
}

async function createProject() {
  if (!pickedManuscript) return;
  const input = {
    name: $('#np-name').value,
    text: pickedManuscript.text,     // for txt/md
    blocks: pickedManuscript.blocks, // for EPUB/DOCX/PDF (store picks whichever is set)
    cover: pickedManuscript.cover,   // base64 image extracted by the importer, if any
    settings: {
      sourceLang: $('#np-source').value.trim() || 'Source',
      targetLang: $('#np-target').value.trim() || 'Target',
    },
  };
  $('#np-create').disabled = true;
  const project = await window.api.createProject(input);
  closeNewProjectModal();
  toast(t('toast.created', { name: project.name, n: project.segments.length }), 'success');
  await renderLibrary();
  openBook(project.id); // land on the new book's hub
}

// Modal wiring
$('#new-project-btn').addEventListener('click', openNewProjectModal);
$('#np-cancel').addEventListener('click', closeNewProjectModal);
$('#np-pick-btn').addEventListener('click', pickFile);
$('#np-create').addEventListener('click', createProject);
$('#new-project-modal').addEventListener('click', (e) => {
  if (e.target.id === 'new-project-modal') closeNewProjectModal(); // click backdrop to close
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeNewProjectModal(); closeRetransModal(); closeExportModal(); closeFrModal(); closeRenameModal(); closeShortcuts(); }
});

// ============================================================================
//  Review — Split-Screen Editor
// ============================================================================
const RTL_LANGS = ['arabic', 'hebrew', 'persian', 'farsi', 'urdu', 'pashto', 'kurdish', 'yiddish', 'dhivehi'];
function isRtlLang(lang) {
  return RTL_LANGS.includes(String(lang || '').trim().toLowerCase());
}

const ITEM_H = 54; // px per navigator row (fixed height enables virtualization)
let reviewIndex = 0;
let reviewDirty = false;
let reviewProjectId = null;
let navFilter = null; // array of segment indices when filtering, else null (= all)
let navStatusFilter = null; // 'pending' | 'translated' | 'reviewed' | null (= all)

function statusClass(status) {
  return status === 'reviewed' ? 'status-reviewed'
       : status === 'translated' ? 'status-translated'
       : 'status-pending';
}

// Human label for a segment's structural type (heading shows its level).
function segTypeLabel(seg) {
  const type = seg.type || 'paragraph';
  if (type === 'heading') return t('segtype.heading', { level: seg.level || 1 });
  return t('segtype.' + type);
}

// Render only the navigator rows currently in view (virtual scrolling).
function renderNavWindow() {
  if (!currentProject) return;
  const scroll = $('#rv-nav-scroll');
  const spacer = $('#rv-nav-spacer');
  const segs = currentProject.segments;
  const list = navFilter;                       // null = show every segment
  const count = list ? list.length : segs.length;
  spacer.style.height = `${count * ITEM_H}px`;

  const overscan = 6;
  let start = Math.max(0, Math.floor(scroll.scrollTop / ITEM_H) - overscan);
  let end = Math.min(count, Math.ceil((scroll.scrollTop + scroll.clientHeight) / ITEM_H) + overscan);

  spacer.querySelectorAll('.nav-item-row').forEach((r) => r.remove());
  const frag = document.createDocumentFragment();
  for (let k = start; k < end; k++) {
    const idx = list ? list[k] : k;             // actual segment index
    const seg = segs[idx];
    const row = document.createElement('div');
    row.className = 'nav-item-row' + (idx === reviewIndex ? ' active' : '');
    row.style.top = `${k * ITEM_H}px`;
    row.style.height = `${ITEM_H}px`;
    const snippet = seg.type === 'scene-break'
      ? '⁂'
      : escapeHtml((seg.translation || seg.original || '').slice(0, 42));
    const typeTag = seg.type && seg.type !== 'paragraph' && seg.type !== 'scene-break'
      ? `<span class="seg-type">${escapeHtml(segTypeLabel(seg))}</span>` : '';
    row.innerHTML =
      `<span class="num">${idx + 1}</span>` +
      `<span class="dot ${statusClass(seg.status)}"></span>` +
      `<span class="snippet" dir="auto">${typeTag}${snippet}</span>`;
    row.addEventListener('click', () => selectSegment(idx));
    frag.appendChild(row);
  }
  spacer.appendChild(frag);
}

function ensureRowVisible(idx) {
  const scroll = $('#rv-nav-scroll');
  const pos = navFilter ? navFilter.indexOf(idx) : idx; // row position in the visible list
  if (pos < 0) return;                                  // not in current filter
  const top = pos * ITEM_H;
  const bottom = top + ITEM_H;
  if (top < scroll.scrollTop) scroll.scrollTop = top;
  else if (bottom > scroll.scrollTop + scroll.clientHeight) scroll.scrollTop = bottom - scroll.clientHeight;
}

// Filter the navigator by status chip AND/OR search text (combined).
function recomputeNavFilter(resetScroll = false) {
  if (!currentProject) return;
  const q = $('#rv-search').value.trim().toLowerCase();
  const status = navStatusFilter;

  if (!q && !status) {
    navFilter = null;
    $('#rv-nav-title').textContent = t('rv.segments', { n: currentProject.segments.length });
  } else {
    navFilter = [];
    currentProject.segments.forEach((s, i) => {
      if (status && s.status !== status) return;
      if (q && !((s.original && s.original.toLowerCase().includes(q)) ||
                 (s.translation && s.translation.toLowerCase().includes(q)))) return;
      navFilter.push(i);
    });
    $('#rv-nav-title').textContent = t('rv.matches', { n: navFilter.length });
  }
  if (resetScroll) $('#rv-nav-scroll').scrollTop = 0;
  renderNavWindow();
}

// Update the per-status counts shown on the filter chips.
function updateFilterCounts() {
  if (!currentProject) return;
  let p = 0, tr = 0, rv = 0;
  for (const s of currentProject.segments) {
    if (s.status === 'reviewed') rv += 1;
    else if (s.status === 'translated') tr += 1;
    else p += 1;
  }
  $('#fc-all').textContent = currentProject.segments.length;
  $('#fc-pending').textContent = p;
  $('#fc-translated').textContent = tr;
  $('#fc-reviewed').textContent = rv;
}

// Click a status chip to filter (clicking the active one clears it back to All).
function setStatusFilter(status) {
  navStatusFilter = status === 'all' ? null : status;
  $$('#rv-filters .nav-filter').forEach((b) =>
    b.classList.toggle('active', b.dataset.status === (navStatusFilter || 'all')));
  recomputeNavFilter(true);
}

function updateEditorHead() {
  const seg = currentProject.segments[reviewIndex];
  const pos = t('ed.position', { n: reviewIndex + 1, m: currentProject.segments.length });
  const type = seg.type || 'paragraph';
  $('#rv-position').textContent = type === 'paragraph' ? pos : `${segTypeLabel(seg)} · ${pos}`;
  const st = $('#rv-status');
  st.textContent = t('status.' + seg.status);
  st.className = `ed-status ${seg.status}`;
}

// Persist the current segment. markReviewed=true sets status to 'reviewed'.
async function persistCurrent(markReviewed) {
  if (!currentProject) return;
  const seg = currentProject.segments[reviewIndex];
  const text = $('#rv-translation').value;
  const fields = { translation: text };
  if (markReviewed) fields.status = 'reviewed';
  else if (seg.status === 'pending' && text.trim()) fields.status = 'translated';

  Object.assign(seg, fields); // update in-memory copy
  reviewDirty = false;
  await window.api.updateSegment(currentProject.id, seg.id, fields);
  updateEditorHead();
  updateFilterCounts();
  renderNavWindow();
}

async function selectSegment(i) {
  if (reviewDirty) await persistCurrent(false); // keep unsaved text, don't mark reviewed
  reviewIndex = Math.max(0, Math.min(currentProject.segments.length - 1, i));
  const seg = currentProject.segments[reviewIndex];

  const original = $('#rv-original');
  const ta = $('#rv-translation');
  const isDivider = seg.type === 'scene-break';
  const q = $('#rv-search').value.trim();
  if (isDivider) original.textContent = '⁂   scene break   ⁂';
  else original.innerHTML = markHtml(seg.original, q); // highlight search matches
  ta.value = isDivider ? '' : (seg.translation || '');
  ta.disabled = isDivider;          // scene breaks aren't translated
  ta.placeholder = isDivider ? t('ed.dividerPh') : '';
  original.dir = isRtlLang(currentProject.sourceLang) ? 'rtl' : 'ltr';
  ta.dir = isRtlLang(currentProject.targetLang) ? 'rtl' : 'auto';

  // If searching, jump the caret to the first match in the translation so it's
  // selected and ready to edit (only when navigating, not while typing search).
  if (q && !isDivider && seg.translation) {
    const idx = seg.translation.toLowerCase().indexOf(q.toLowerCase());
    if (idx >= 0) { ta.focus(); ta.setSelectionRange(idx, idx + q.length); }
  }

  reviewDirty = false;
  updateEditorHead();
  renderNavWindow();
  ensureRowVisible(reviewIndex);
}

// Escape HTML, then wrap occurrences of `query` in <mark> for the original pane.
function markHtml(text, query) {
  if (!query) return escapeHtml(text);
  const re = new RegExp('(' + escapeRegExp(query) + ')', 'gi');
  return String(text).split(re)
    .map((part, i) => (i % 2 === 1 ? `<mark>${escapeHtml(part)}</mark>` : escapeHtml(part)))
    .join('');
}

// Re-highlight the current original pane as the search text changes (no focus change).
function highlightOriginal() {
  if (!currentProject) return;
  const seg = currentProject.segments[reviewIndex];
  if (!seg || seg.type === 'scene-break') return;
  $('#rv-original').innerHTML = markHtml(seg.original, $('#rv-search').value.trim());
}

async function saveAndReview() {
  await persistCurrent(true);
  const tag = $('#rv-saved');
  tag.textContent = t('ed.saved');
  tag.classList.add('show');
  clearTimeout(saveAndReview._t);
  saveAndReview._t = setTimeout(() => tag.classList.remove('show'), 1600);
}

function renderReview() {
  if (!currentProject) {
    $('#review-empty').hidden = false;
    $('#review-panel').hidden = true;
    return;
  }
  $('#review-empty').hidden = true;
  $('#review-panel').hidden = false;

  $('#rv-source-label').textContent = t('pane.original', { lang: currentProject.sourceLang });
  $('#rv-target-label').textContent = t('pane.translation', { lang: currentProject.targetLang });
  $('#rv-search').value = '';
  navFilter = null;
  navStatusFilter = null;
  $$('#rv-filters .nav-filter').forEach((b) => b.classList.toggle('active', b.dataset.status === 'all'));
  updateFilterCounts();
  $('#rv-nav-title').textContent = t('rv.segments', { n: currentProject.segments.length });

  // When opening a different project, jump to the first segment needing attention.
  if (reviewProjectId !== currentProject.id) {
    reviewProjectId = currentProject.id;
    const firstUnreviewed = currentProject.segments.findIndex((s) => s.status !== 'reviewed');
    reviewIndex = firstUnreviewed === -1 ? 0 : firstUnreviewed;
  }
  renderNavWindow();
  selectSegment(reviewIndex);
}

// Refresh Review in place after a background run finishes (keeps position).
function refreshReviewIfActive() {
  if (!$('#view-review').classList.contains('active') || !currentProject) return;
  updateFilterCounts();
  if (navStatusFilter || navFilter) recomputeNavFilter(false); // membership may have changed
  else renderNavWindow();
  if (!reviewDirty) {
    const seg = currentProject.segments[reviewIndex];
    if (seg) { $('#rv-translation').value = seg.translation || ''; updateEditorHead(); }
  }
}

// Wiring
$('#rv-nav-scroll').addEventListener('scroll', renderNavWindow);
$('#rv-search').addEventListener('input', () => { recomputeNavFilter(true); highlightOriginal(); });
$('#rv-filters').addEventListener('click', (e) => {
  const btn = e.target.closest('.nav-filter');
  if (btn) setStatusFilter(btn.dataset.status);
});

// ---- Find & replace across translations -------------------------------------
function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function frRegex() {
  const term = $('#fr-find').value;
  if (!term) return null;
  return new RegExp(escapeRegExp(term), $('#fr-case').checked ? 'g' : 'gi');
}

// Live preview: how many matches across how many segments' translations.
function frUpdateCount() {
  const out = $('#fr-count');
  const re = frRegex();
  if (!re || !currentProject) { out.textContent = ''; $('#fr-go').disabled = true; return; }
  let matches = 0, segs = 0;
  for (const s of currentProject.segments) {
    if (!s.translation) continue;
    const m = s.translation.match(re);
    if (m && m.length) { matches += m.length; segs += 1; }
  }
  out.textContent = matches ? t('fr.count', { n: matches, m: segs }) : t('fr.none');
  $('#fr-go').disabled = matches === 0;
}

function openFrModal() {
  if (!currentProject || isRunning) return;
  $('#fr-find').value = $('#rv-search').value || '';
  $('#fr-replace').value = '';
  $('#fr-case').checked = false;
  frUpdateCount();
  $('#fr-modal').classList.add('open');
  $('#fr-find').focus();
}
function closeFrModal() { $('#fr-modal').classList.remove('open'); }

async function frReplaceAll() {
  const re = frRegex();
  if (!re || !currentProject) return;
  const repl = $('#fr-replace').value;
  let totalMatches = 0, changedSegs = 0;
  for (const s of currentProject.segments) {
    if (!s.translation) continue;
    const m = s.translation.match(re);
    if (!m || !m.length) continue;
    s.translation = s.translation.replace(re, () => repl); // fn form: repl is literal
    totalMatches += m.length;
    changedSegs += 1;
  }
  if (changedSegs === 0) { closeFrModal(); return; }
  $('#fr-go').disabled = true;
  await window.api.saveProject(currentProject); // one atomic write of the whole project
  closeFrModal();
  toast(t('fr.done', { n: totalMatches, m: changedSegs }), 'success');
  updateFilterCounts();
  selectSegment(reviewIndex); // refresh editor + navigator snippets
}

$('#rv-fr').addEventListener('click', openFrModal);
$('#fr-find').addEventListener('input', frUpdateCount);
$('#fr-case').addEventListener('change', frUpdateCount);
$('#fr-go').addEventListener('click', frReplaceAll);
$('#fr-cancel').addEventListener('click', closeFrModal);
$('#fr-modal').addEventListener('click', (e) => { if (e.target.id === 'fr-modal') closeFrModal(); });
['#fr-find', '#fr-replace'].forEach((sel) => $(sel).addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !$('#fr-go').disabled) frReplaceAll();
}));
$('#rv-translation').addEventListener('input', () => { reviewDirty = true; });
$('#rv-save').addEventListener('click', saveAndReview);
$('#rv-prev').addEventListener('click', () => selectSegment(reviewIndex - 1));
$('#rv-next').addEventListener('click', () => selectSegment(reviewIndex + 1));

document.addEventListener('keydown', (e) => {
  const inReview = $('#view-review').classList.contains('active');
  if (!inReview || !currentProject) return;
  // Ctrl/Cmd+S → save & mark reviewed
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    saveAndReview();
  }
  // Alt+Up / Alt+Down → move between segments
  if (e.altKey && e.key === 'ArrowUp') { e.preventDefault(); selectSegment(reviewIndex - 1); }
  if (e.altKey && e.key === 'ArrowDown') { e.preventDefault(); selectSegment(reviewIndex + 1); }
});

// ---- Retranslate ------------------------------------------------------------
async function retranslateCurrent() {
  if (!currentProject || isRunning) return;
  const seg = currentProject.segments[reviewIndex];
  if (seg.status === 'reviewed' && !await askConfirm({ title: t('confirm.retransTitle'), body: t('confirm.retransReviewed'), ok: t('confirm.retransOk') })) return;
  if (reviewDirty) await persistCurrent(false);
  setEngineRunning(true);
  await window.api.retranslateSegment(currentProject.id, seg.id);
}

// "Retranslate all" opens a choice dialog so reviewed work is never redone by
// accident — but you CAN force a full rerun when you want to.
function openRetransModal() {
  if (!currentProject || isRunning) return;
  const c = countStatuses(currentProject.segments);
  const unreviewed = c.total - c.reviewed;
  $('#retrans-sub').textContent = t('rt.sub', { total: c.total, reviewed: c.reviewed, unreviewed });
  const ub = $('#retrans-unreviewed');
  ub.textContent = t('rt.unreviewed', { unreviewed });
  ub.disabled = unreviewed === 0;
  $('#retrans-all').textContent = c.reviewed > 0
    ? t('rt.allOverwrite', { total: c.total, reviewed: c.reviewed })
    : t('rt.all', { total: c.total });
  $('#retrans-modal').classList.add('open');
}
function closeRetransModal() { $('#retrans-modal').classList.remove('open'); }

async function doRetranslate(includeReviewed) {
  closeRetransModal();
  if (reviewDirty) await persistCurrent(false);
  await window.api.resetForRetranslate(currentProject.id, includeReviewed);
  currentProject = await window.api.getProject(currentProject.id);
  renderNavWindow();
  updateEditorHead();
  setEngineRunning(true);
  await window.api.startTranslation(currentProject.id);
}

// Approve every translated segment at once.
async function markAllReviewed() {
  if (!currentProject || isRunning) return;
  const n = currentProject.segments.filter(
    (s) => s.translation && s.translation.trim() && s.status !== 'reviewed'
  ).length;
  if (n === 0) { toast(t('toast.nothingMark')); return; }
  if (!await askConfirm({ title: t('confirm.markAllTitle'), body: t('confirm.markAll', { n }), ok: t('rv.reviewAll') })) return;
  if (reviewDirty) await persistCurrent(false);
  await window.api.markAllReviewed(currentProject.id);
  currentProject = await window.api.getProject(currentProject.id);
  renderNavWindow();
  updateEditorHead();
  toast(t('toast.allReviewed'), 'success');
}

$('#rv-retrans-seg').addEventListener('click', retranslateCurrent);
$('#rv-retrans-all').addEventListener('click', () => {
  if (isRunning) { window.api.stopTranslation(); return; }
  openRetransModal();
});
$('#rv-review-all').addEventListener('click', markAllReviewed);
$('#retrans-unreviewed').addEventListener('click', () => doRetranslate(false));
$('#retrans-all').addEventListener('click', () => doRetranslate(true));
$('#retrans-cancel').addEventListener('click', closeRetransModal);
$('#retrans-modal').addEventListener('click', (e) => {
  if (e.target.id === 'retrans-modal') closeRetransModal();
});

// ---- Highlight-to-glossary --------------------------------------------------
let glossPopSource = '';
let glossPopPos = null; // remembered position once the user drags it somewhere

function hideGlossPop() {
  $('#gloss-pop').hidden = true;
  glossPopSource = '';
}

function maybeShowGlossPop() {
  if (!currentProject || !$('#view-review').classList.contains('active')) return;
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return;
  const text = sel.toString().trim();
  const original = $('#rv-original');
  if (!text || text.length > 80 || !original.contains(sel.anchorNode)) return;

  const pop = $('#gloss-pop');
  $('#gloss-pop-src').textContent = text;
  const tgt = $('#gloss-pop-tgt');
  tgt.value = '';
  tgt.dir = isRtlLang(currentProject.targetLang) ? 'rtl' : 'auto';
  glossPopSource = text;

  pop.hidden = false;
  if (glossPopPos) {
    // Reuse wherever the user last parked it.
    pop.style.left = `${glossPopPos.left}px`;
    pop.style.top = `${glossPopPos.top}px`;
  } else {
    // First time: open just below the selection, nudged right so it doesn't
    // sit on top of the highlighted word.
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    const pw = 260;
    const ph = pop.offsetHeight || 150;
    let left = Math.min(rect.right + 12, window.innerWidth - pw - 12);
    let top = rect.bottom + 8;
    if (top + ph > window.innerHeight - 12) top = Math.max(12, rect.top - ph - 8);
    pop.style.left = `${Math.max(12, left)}px`;
    pop.style.top = `${Math.max(12, top)}px`;
  }
  tgt.focus();
}

// Drag the popup by its header; remember the position for next time.
(function makeGlossPopDraggable() {
  const pop = $('#gloss-pop');
  const head = $('#gloss-pop-head');
  let dragging = false, startX = 0, startY = 0, originX = 0, originY = 0;

  head.addEventListener('mousedown', (e) => {
    if (e.target.closest('.gp-close')) return;
    dragging = true;
    const r = pop.getBoundingClientRect();
    startX = e.clientX; startY = e.clientY; originX = r.left; originY = r.top;
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    let left = originX + (e.clientX - startX);
    let top = originY + (e.clientY - startY);
    left = Math.max(8, Math.min(left, window.innerWidth - pop.offsetWidth - 8));
    top = Math.max(8, Math.min(top, window.innerHeight - pop.offsetHeight - 8));
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
    glossPopPos = { left, top };
  });
  document.addEventListener('mouseup', () => { dragging = false; });
})();

async function addSelectionToGlossary(scope) {
  const source = glossPopSource.trim();
  const target = $('#gloss-pop-tgt').value.trim();
  if (!source || !target) { $('#gloss-pop-tgt').focus(); return; }

  if (scope === 'global') {
    const g = await window.api.getGlobalGlossary();
    g.push({ id: crypto.randomUUID(), source, target });
    await window.api.saveGlobalGlossary(g);
    globalGlossary = g;
    toast(t('gloss.addedShared', { src: source }), 'success');
  } else {
    if (!Array.isArray(currentProject.glossary)) currentProject.glossary = [];
    currentProject.glossary.push({ id: crypto.randomUUID(), source, target });
    await window.api.saveGlossary(currentProject.id, currentProject.glossary);
    toast(t('gloss.addedProject', { src: source }), 'success');
  }
  hideGlossPop();
}

$('#gloss-pop-shared').addEventListener('click', () => addSelectionToGlossary('global'));
$('#gloss-pop-project').addEventListener('click', () => addSelectionToGlossary('project'));
$('#gloss-pop-close').addEventListener('click', hideGlossPop);
$('#gloss-pop-tgt').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addSelectionToGlossary('global');
  if (e.key === 'Escape') hideGlossPop();
});
$('#rv-original').addEventListener('mouseup', () => setTimeout(maybeShowGlossPop, 0));
// Click well away from both the popup and the text dismisses it.
document.addEventListener('mousedown', (e) => {
  const pop = $('#gloss-pop');
  if (!pop.hidden && !pop.contains(e.target) && !$('#rv-original').contains(e.target)) hideGlossPop();
});

// ============================================================================
//  Glossary — Term Manager (shared dictionary + project-only terms)
// ============================================================================
let globalGlossary = [];

// A "scope" bundles everything that differs between the two sections, so the
// add/edit/delete/render logic can be written once.
function scopeOf(name) {
  if (name === 'global') {
    return {
      terms: () => globalGlossary,
      setTerms: (t) => { globalGlossary = t; },
      save: () => window.api.saveGlobalGlossary(globalGlossary),
      listSel: '#gl-global-list',
      srcSel: '#gl-global-source',
      tgtSel: '#gl-global-target',
      emptyKey: 'gloss.emptyShared',
    };
  }
  return {
    terms: () => currentProject.glossary,
    setTerms: (t) => { currentProject.glossary = t; },
    save: () => window.api.saveGlossary(currentProject.id, currentProject.glossary),
    listSel: '#gl-project-list',
    srcSel: '#gl-project-source',
    tgtSel: '#gl-project-target',
    emptyKey: 'gloss.emptyProject',
  };
}

function rtlForTarget() {
  // Use the open project's target language; fall back to auto-detection.
  return currentProject && isRtlLang(currentProject.targetLang);
}

function renderTermList(name) {
  const s = scopeOf(name);
  const rtl = rtlForTarget();
  $(s.tgtSel).dir = rtl ? 'rtl' : 'auto';
  const list = $(s.listSel);
  const terms = s.terms();

  if (terms.length === 0) {
    list.innerHTML = `<div class="glossary-empty-hint">${escapeHtml(t(s.emptyKey))}</div>`;
    return;
  }

  list.innerHTML = '';
  terms.forEach((term) => {
    const row = document.createElement('div');
    row.className = 'glossary-row';
    row.innerHTML =
      `<input class="js-src" type="text" value="${escapeHtml(term.source)}" />` +
      `<span class="arrow">→</span>` +
      `<input class="js-tgt" type="text" value="${escapeHtml(term.target)}" />` +
      `<button class="js-del" title="${escapeHtml(t('common.delete'))}">${icon('trash-2')}</button>`;
    row.querySelector('.js-tgt').dir = rtl ? 'rtl' : 'auto';
    row.querySelector('.js-src').addEventListener('change', (e) => editTerm(name, term.id, 'source', e.target.value));
    row.querySelector('.js-tgt').addEventListener('change', (e) => editTerm(name, term.id, 'target', e.target.value));
    row.querySelector('.js-del').addEventListener('click', () => deleteTerm(name, term.id));
    list.appendChild(row);
  });
}

async function renderGlossary() {
  // Shared dictionary is always available, even with no project open.
  globalGlossary = await window.api.getGlobalGlossary();
  renderTermList('global');

  // Project-only section appears only when a project is open.
  if (currentProject) {
    if (!Array.isArray(currentProject.glossary)) currentProject.glossary = [];
    $('#gl-project-area').hidden = false;
    $('#gl-project-hint').hidden = true;
    $('#gl-project-scope').textContent = t('gloss.scopeName', { name: currentProject.name });
    renderTermList('project');
  } else {
    $('#gl-project-area').hidden = true;
    $('#gl-project-hint').hidden = false;
    $('#gl-project-scope').textContent = t('gloss.scopeNo');
  }

  if (currentProject && suggestProjectId !== currentProject.id) {
    dismissedSuggestions = new Set(); // fresh dismissals per book
    suggestProjectId = currentProject.id;
  }
  renderSuggestions();
}

// ---- Glossary auto-suggest: recurring proper nouns in the open book ----------
let dismissedSuggestions = new Set();
let suggestProjectId = null;

// Common words that are capitalized at sentence starts but aren't names.
const SUGGEST_STOP = new Set(
  ('The A An And But Or Nor So Yet For Of To In On At By With From As If When While Then ' +
   'There Here Now Yes No Not He She It They We You I His Her Hers Their My Your Our Its ' +
   'This That These Those What Who Whom Whose Which Why How Where Was Were Is Are Be Been ' +
   'Had Has Have Did Do Does Will Would Could Should May Might Must Can Oh Ah Well Once ' +
   'Soon Still Just Even Only Perhaps Maybe Indeed Chapter Mr Mrs Ms Miss Dr St Sir Madam')
    .split(/\s+/)
);

// Scan the source text for frequent capitalized terms not already in a glossary.
function suggestTerms() {
  if (!currentProject) return [];
  const existing = new Set();
  for (const g of (currentProject.glossary || [])) if (g.source) existing.add(g.source.toLowerCase());
  for (const g of (globalGlossary || [])) if (g.source) existing.add(g.source.toLowerCase());

  const counts = new Map();
  const re = /[A-Z][a-zà-öø-ÿ'’\-]+(?:\s+[A-Z][a-zà-öø-ÿ'’\-]+)*/g;
  for (const s of currentProject.segments) {
    const text = s.original;
    if (!text) continue;
    let m;
    while ((m = re.exec(text)) !== null) {
      // Is this match at the start of a sentence (likely a false positive)?
      let j = m.index - 1;
      while (j >= 0 && /\s/.test(text[j])) j--;
      const prev = j >= 0 ? text[j] : '';
      const sentenceInitial = j < 0 || '.!?:;"“”—–('.includes(prev);

      let words = m[0].split(/\s+/);
      while (words.length && SUGGEST_STOP.has(words[0])) words.shift();      // drop leading "The", etc.
      while (words.length && SUGGEST_STOP.has(words[words.length - 1])) words.pop();
      if (!words.length) continue;
      const cand = words.join(' ');
      if (cand.length < 3) continue;

      const rec = counts.get(cand) || { text: cand, count: 0, mid: 0 };
      rec.count += 1;
      if (!sentenceInitial) rec.mid += 1; // appears mid-sentence ⇒ confidently a name
      counts.set(cand, rec);
    }
  }

  const out = [];
  for (const rec of counts.values()) {
    if (existing.has(rec.text.toLowerCase())) continue;
    if (dismissedSuggestions.has(rec.text.toLowerCase())) continue;
    if (rec.mid >= 1 || rec.count >= 3) out.push(rec); // keep confident or frequent ones
  }
  out.sort((a, b) => b.count - a.count || a.text.localeCompare(b.text));
  return out.slice(0, 25);
}

function renderSuggestions() {
  const head = $('#gl-suggest-head');
  const list = $('#gl-suggest-list');
  const items = currentProject ? suggestTerms() : [];
  if (items.length === 0) { head.hidden = true; list.hidden = true; list.innerHTML = ''; return; }

  head.hidden = false; list.hidden = false;
  const rtl = rtlForTarget();
  list.innerHTML = '';
  for (const it of items) {
    const row = document.createElement('div');
    row.className = 'suggest-row';
    row.innerHTML =
      `<span class="suggest-term">${escapeHtml(it.text)}</span>` +
      `<span class="suggest-count">${it.count}×</span>` +
      `<span class="arrow">→</span>` +
      `<input class="js-stgt" type="text" placeholder="${escapeHtml(t('gloss.suggestTgtPh'))}" />` +
      `<button class="btn btn-primary btn-sm js-add-book">${escapeHtml(t('gloss.addBook'))}</button>` +
      `<button class="btn btn-ghost btn-sm js-add-shared">${escapeHtml(t('gloss.addShared'))}</button>` +
      `<button class="js-dismiss" title="${escapeHtml(t('gloss.dismiss'))}">${icon('x')}</button>`;
    const tgt = row.querySelector('.js-stgt');
    tgt.dir = rtl ? 'rtl' : 'auto';
    row.querySelector('.js-add-book').addEventListener('click', () => addSuggestion('project', it.text, tgt.value));
    row.querySelector('.js-add-shared').addEventListener('click', () => addSuggestion('global', it.text, tgt.value));
    row.querySelector('.js-dismiss').addEventListener('click', () => {
      dismissedSuggestions.add(it.text.toLowerCase());
      renderSuggestions();
    });
    tgt.addEventListener('keydown', (e) => { if (e.key === 'Enter') addSuggestion('project', it.text, tgt.value); });
    list.appendChild(row);
  }
}

async function addSuggestion(scopeName, source, target) {
  target = (target || '').trim();
  if (!target) { toast(t('gloss.needTarget')); return; }
  const s = scopeOf(scopeName);
  if (scopeName === 'project' && !Array.isArray(currentProject.glossary)) currentProject.glossary = [];
  s.terms().push({ id: crypto.randomUUID(), source, target });
  await s.save();
  renderTermList(scopeName);
  renderSuggestions(); // the newly added term is now excluded
  toast(t('gloss.added', { term: source }), 'success');
}

async function addTerm(name) {
  const s = scopeOf(name);
  const source = $(s.srcSel).value.trim();
  const target = $(s.tgtSel).value.trim();
  if (!source || !target) return;
  s.terms().push({ id: crypto.randomUUID(), source, target });
  await s.save();
  $(s.srcSel).value = '';
  $(s.tgtSel).value = '';
  $(s.srcSel).focus();
  renderTermList(name);
}

async function editTerm(name, id, field, value) {
  const term = scopeOf(name).terms().find((t) => t.id === id);
  if (!term) return;
  term[field] = value.trim();
  await scopeOf(name).save();
}

async function deleteTerm(name, id) {
  const s = scopeOf(name);
  s.setTerms(s.terms().filter((t) => t.id !== id));
  await s.save();
  renderTermList(name);
}

$('#gl-global-add').addEventListener('click', () => addTerm('global'));
$('#gl-project-add').addEventListener('click', () => addTerm('project'));
['#gl-global-source', '#gl-global-target'].forEach((sel) =>
  $(sel).addEventListener('keydown', (e) => { if (e.key === 'Enter') addTerm('global'); }));
['#gl-project-source', '#gl-project-target'].forEach((sel) =>
  $(sel).addEventListener('keydown', (e) => { if (e.key === 'Enter') addTerm('project'); }));

// ============================================================================
//  Theme (dark default, light optional) — persisted
// ============================================================================
function currentTheme() { return document.documentElement.getAttribute('data-theme') || 'dark'; }
function updateThemeLabel() {
  const light = currentTheme() === 'light';
  $('#theme-toggle').innerHTML = icon(light ? 'sun' : 'moon');
}
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('theme', theme);
  updateThemeLabel();
  if (typeof syncSegmented === 'function') syncSegmented();
}
$('#theme-toggle').addEventListener('click', () => {
  applyTheme(currentTheme() === 'light' ? 'dark' : 'light');
});

// ============================================================================
//  Language (English default, Arabic optional) — persisted, full RTL
// ============================================================================
function updateLangLabel() {
  // Shows the language you would switch TO.
  const en = getLang() === 'en';
  $('#lang-lbl').textContent = en ? 'ع' : 'EN';
  $('#lang-toggle').classList.toggle('en', !en);
}
$('#lang-toggle').addEventListener('click', () => {
  setLang(getLang() === 'en' ? 'ar' : 'en');
});

// When the language flips, re-apply everything that's rendered dynamically.
window.addEventListener('langchange', () => {
  updateThemeLabel();
  updateLangLabel();
  renderLibrary(); // re-render cards in the new language
  updatePrimaryAction();
  if (currentProject) renderProgress(countStatuses(currentProject.segments));
  if ($('#view-review').classList.contains('active')) renderReview();
  if ($('#view-glossary').classList.contains('active')) renderGlossary();
  if ($('#view-settings').classList.contains('active')) renderSettings();
  if ($('#view-hub').classList.contains('active')) renderHub();
  renderBookNav();
  syncNavTitles();
  if (isRunning) setEngineRunning(true); // fix dynamic button labels after applyI18n reset
});

// ============================================================================
//  Settings — app-wide defaults for new projects + appearance
// ============================================================================
// ---- App updates (Settings → General → Updates) ------------------------------
async function renderAppUpdate(st) {
  const row = $('#upd-row');
  if (!row) return;
  const u = st ? { ...(await window.api.appUpdateInfo()), ...st } : await window.api.appUpdateInfo();
  $('#upd-version').textContent = t('upd.version', { v: u.version });
  const checkBtn = (busy) => `<button class="btn btn-ghost btn-sm" id="upd-check" ${busy ? 'disabled' : ''}>${icon('refresh-cw')}${escapeHtml(t('upd.check'))}</button>`;
  if (!u.canSelfUpdate) {
    row.innerHTML = `<span class="eng-note">${escapeHtml(t('upd.manual'))}</span>
      <button class="btn btn-ghost btn-sm" id="upd-open">${icon('globe')}${escapeHtml(t('upd.open'))}</button>`;
    return;
  }
  let note = '';
  if (u.state === 'checking') note = `<span class="eng-note"><span class="spinner"></span>${escapeHtml(t('upd.checking'))}</span>`;
  else if (u.state === 'none') note = `<span class="eng-note ok">${icon('circle-check')}${escapeHtml(t('upd.none'))}</span>`;
  else if (u.state === 'error') note = `<span class="eng-note bad">${escapeHtml(t('upd.failed'))}</span>`;
  else if (u.state === 'downloading') note = `<span class="eng-note">${escapeHtml(t('upd.downloading', { v: u.version || '', pct: u.pct || 0 }))}</span>`;
  if (u.state === 'ready') {
    row.innerHTML = `<span class="eng-note ok">${icon('circle-check')}${escapeHtml(t('upd.ready', { v: u.version }))}</span>
      <button class="btn btn-primary btn-sm" id="upd-install">${icon('refresh-cw')}${escapeHtml(t('upd.restart'))}</button>`;
    return;
  }
  row.innerHTML = checkBtn(u.state === 'checking' || u.state === 'downloading') + note;
}
document.addEventListener('click', async (e) => {
  const b = e.target.closest('#upd-check, #upd-install, #upd-open');
  if (!b) return;
  if (b.id === 'upd-check') { b.disabled = true; await window.api.appCheckUpdate(); renderAppUpdate(); }
  else if (b.id === 'upd-install') window.api.appInstallUpdate();
  else if (b.id === 'upd-open') window.api.appOpenReleases();
});
window.api.onAppUpdate((st) => {
  if (st.state === 'ready') toast(t('upd.readyToast', { v: st.version }), 'success');
  if ($('#view-settings').classList.contains('active')) renderAppUpdate(st);
});

async function renderSettings() {
  const s = await window.api.getSettings();
  await fillProviderSelect('#set-provider', s.provider || 'builtin');
  $('#set-source').value = s.sourceLang || 'English';
  $('#set-target').value = s.targetLang || 'Arabic';
  $('#set-url').value = s.apiUrl || 'http://localhost:1234/v1/chat/completions';
  $('#set-model').value = s.model || '';
  $('#set-context').value = s.contextWindow ?? 2;
  $('#set-thinking').checked = !!s.thinking;
  $('#set-target').dir = isRtlLang($('#set-target').value) ? 'rtl' : 'auto';
  $('#set-test-result').textContent = '';
  $('#set-test-result').className = 'test-result';
  const prov = s.provider || 'builtin';
  applyProviderVisibility(prov, '#set-url-field', null);
  if (prov === 'builtin') {
    const chosen = await fillModelSelect('#set-bmodel', s.model, '#set-bmodel-note');
    if (!s.model && chosen) saveSettingsForm(); // keep the shown choice, so new books get a model
  }
  else suggestModels('#set-model-list', prov);
  renderAppUpdate();
  renderModelsPanel();
  // Appearance reflects the current device state.
  syncSegmented();
  // The open tab's own content (providers grid / built-in panel).
  renderSettingsTab();
}

async function saveSettingsForm() {
  await window.api.saveSettings({
    provider: $('#set-provider').value,
    sourceLang: $('#set-source').value.trim() || 'English',
    targetLang: $('#set-target').value.trim() || 'Arabic',
    apiUrl: $('#set-url').value.trim(),
    model: $('#set-provider').value === 'builtin' ? $('#set-bmodel').value : $('#set-model').value.trim(),
    contextWindow: Math.max(0, parseInt($('#set-context').value, 10) || 0),
    thinking: $('#set-thinking').checked,
  });
}

['#set-source', '#set-target', '#set-url', '#set-model', '#set-context', '#set-provider', '#set-thinking']
  .forEach((sel) => $(sel).addEventListener('change', saveSettingsForm));
$('#set-provider').addEventListener('change', async (e) => {
  applyProviderVisibility(e.target.value, '#set-url-field', null);
  if (e.target.value === 'builtin') { await fillModelSelect('#set-bmodel', '', '#set-bmodel-note'); saveSettingsForm(); }
  else suggestModels('#set-model-list', e.target.value);
});
$('#set-bmodel').addEventListener('change', () => { fillModelSelect('#set-bmodel', $('#set-bmodel').value, '#set-bmodel-note'); saveSettingsForm(); });
$('#set-test').addEventListener('click', () => runConnectionTest($('#set-url').value, $('#set-test-result')));
// Two-option toggles for theme and language.
function syncSegmented() {
  const mark = (sel, val) => $$(`${sel} button`).forEach((b) => {
    const on = b.dataset.value === val;
    b.classList.toggle('active', on);
    b.setAttribute('aria-checked', on ? 'true' : 'false');
  });
  mark('#set-theme', currentTheme());
  mark('#set-lang', getLang());
}
$('#set-theme').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-value]');
  if (b) { applyTheme(b.dataset.value); syncSegmented(); }
});
$('#set-lang').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-value]');
  if (b && b.dataset.value !== getLang()) setLang(b.dataset.value);
});

// Language fields use a <datalist>, which Chromium filters by the current value.
// Clear on focus so the whole list shows; restore the previous value if the user
// clicks away without choosing one.
['#np-source', '#np-target', '#ws-source', '#ws-target', '#set-source', '#set-target']
  .forEach((sel) => {
    const el = $(sel);
    if (!el) return;
    let prevLang = '';
    el.addEventListener('focus', () => { prevLang = el.value; el.value = ''; });
    el.addEventListener('blur', () => { if (!el.value.trim()) el.value = prevLang; });
  });

// ============================================================================
//  Reader — read the finished translation as a book
// ============================================================================
const RD_FONTS = { serif: 'var(--font-serif)', amiri: "'Amiri', serif", sans: 'var(--font-ui)' };
const RD_WIDTHS = { narrow: '620px', medium: '760px', wide: '920px' };
let readerProjectId = null;
let rdOffsets = []; // [{ id, top }] sorted by top, for fast position lookup

// Render inline Markdown emphasis to HTML (escaped first).
function inlineMd(text) {
  let s = escapeHtml(text);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/__([^_]+)__/g, '<strong>$1</strong>');
  s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>').replace(/_([^_]+)_/g, '<em>$1</em>');
  return s;
}
const stripMd = (t) => String(t).replace(/[*_]/g, '');

// Build the book HTML from the project's segments (translation, original as fallback).
function buildReaderHtml(project) {
  const parts = [];
  let listOpen = null;
  const closeList = () => { if (listOpen) { parts.push(`</${listOpen}>`); listOpen = null; } };
  // Passages not translated yet show the original, in its own direction.
  const srcDir = isRtlLang(project.sourceLang) ? 'rtl' : 'ltr';

  for (const s of project.segments) {
    const id = s.id;
    const type = s.type || 'paragraph';
    if (type === 'scene-break') { closeList(); parts.push(`<div class="rd-scene" id="rd-seg-${id}" data-seg="${id}">⁂</div>`); continue; }
    const done = !!(s.translation && s.translation.trim());
    const txt = done ? s.translation.trim() : s.original;
    if (!txt) continue;
    const html = inlineMd(txt);
    const at = `id="rd-seg-${id}" data-seg="${id}"` + (done ? '' : ` dir="${srcDir}"`);
    const un = done ? '' : ' rd-untranslated';
    if (type === 'list-item') {
      const want = s.ordered ? 'ol' : 'ul';
      if (listOpen !== want) { closeList(); parts.push(`<${want}>`); listOpen = want; }
      parts.push(`<li ${at} class="${un.trim()}">${html}</li>`);
      continue;
    }
    closeList();
    if (type === 'heading') {
      const lvl = Math.min(Math.max(s.level || 2, 1), 6);
      parts.push(`<h${lvl} class="rd-h${un}" ${at}>${html}</h${lvl}>`);
    } else if (type === 'blockquote') {
      parts.push(`<blockquote ${at} class="${un.trim()}">${html}</blockquote>`);
    } else if (type === 'verse') {
      parts.push(`<p class="rd-verse${un}" ${at}>${html.replace(/\n/g, '<br/>')}</p>`);
    } else {
      parts.push(`<p ${at} class="${un.trim()}">${html}</p>`);
    }
  }
  closeList();
  return parts.join('');
}

function buildToc(project) {
  const toc = $('#rd-toc');
  const headings = project.segments.filter((s) => (s.type || '') === 'heading' && (s.original || '').trim());
  if (headings.length === 0) { toc.innerHTML = ''; toc.hidden = true; $('#rd-toc-btn').style.display = 'none'; return; }
  $('#rd-toc-btn').style.display = '';
  toc.innerHTML = headings.map((h) => {
    const text = (h.translation && h.translation.trim()) ? h.translation.trim() : h.original;
    return `<button class="rd-toc-item lvl-${Math.min(h.level || 1, 3)}" data-go="${h.id}">${escapeHtml(stripMd(text)).slice(0, 90)}</button>`;
  }).join('');
}

function readerPrefs() {
  let p = {};
  try { p = JSON.parse(localStorage.getItem('reader-prefs')) || {}; } catch { /* ignore */ }
  return { font: 'serif', size: 18, width: 'medium', theme: 'dark', bilingual: false, ...p };
}
function saveReaderPrefs(p) { localStorage.setItem('reader-prefs', JSON.stringify(p)); }

function applyReaderPrefs() {
  const p = readerPrefs();
  const content = $('#rd-content');
  content.style.fontFamily = RD_FONTS[p.font] || RD_FONTS.serif;
  content.style.fontSize = `${p.size}px`;
  content.style.maxWidth = RD_WIDTHS[p.width] || RD_WIDTHS.medium;
  content.classList.toggle('rd-bilingual', !!p.bilingual);
  const scroll = $('#rd-scroll');
  scroll.classList.remove('rd-dark', 'rd-sepia', 'rd-light');
  scroll.classList.add(`rd-${p.theme}`);
  $('#rd-font').value = p.font; $('#rd-width').value = p.width; $('#rd-theme').value = p.theme;
  $('#rd-bilingual').classList.toggle('active', !!p.bilingual);
}

function indexReaderOffsets() {
  rdOffsets = Array.from($('#rd-flow').querySelectorAll('[data-seg]'))
    .map((el) => ({ id: el.dataset.seg, top: el.offsetTop }));
}
function topmostSeg() {
  if (!rdOffsets.length) return null;
  const y = $('#rd-scroll').scrollTop + 12;
  let lo = 0, hi = rdOffsets.length - 1, ans = rdOffsets[0].id;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (rdOffsets[m].top <= y) { ans = rdOffsets[m].id; lo = m + 1; } else hi = m - 1; }
  return ans;
}
function updateReadProgress() {
  const s = $('#rd-scroll');
  const max = s.scrollHeight - s.clientHeight;
  const pct = max > 0 ? Math.min(100, Math.round((s.scrollTop / max) * 100)) : 0;
  $('#rd-progress-fill').style.width = `${pct}%`;
  // Estimated pages by screen-height (shifts with font size / window — that's expected).
  const per = Math.max(1, s.clientHeight - 40);
  const pages = Math.max(1, Math.ceil(s.scrollHeight / per));
  const page = Math.min(pages, Math.floor(s.scrollTop / per) + 1);
  $('#rd-pageind').textContent = t('reader.pageInd', { pct, page, pages });
}

function renderReader() {
  if (!currentProject) {
    $('#reader-empty').hidden = false;
    $('#reader-panel').hidden = true;
    return;
  }
  $('#reader-empty').hidden = true;
  $('#reader-panel').hidden = false;
  $('#rd-title').textContent = currentProject.name;

  const flow = $('#rd-flow');
  const rebuild = readerProjectId !== currentProject.id || !flow.hasChildNodes();
  if (rebuild) {
    flow.innerHTML = buildReaderHtml(currentProject);
    $('#rd-content').dir = isRtlLang(currentProject.targetLang) ? 'rtl' : 'ltr';
    buildToc(currentProject);
    markAnnotated();
    $('#rd-toc').hidden = true;
    $('#rd-marks').hidden = true;
    $('#rd-gutter').hidden = true;
    $('#rd-note-pop').hidden = true;
    $('#rd-pageind').hidden = false;
    readerProjectId = currentProject.id;
  }
  applyReaderPrefs();
  requestAnimationFrame(() => {
    indexReaderOffsets();
    if (rebuild) {
      const pos = localStorage.getItem(`reader-pos:${currentProject.id}`);
      const found = pos && rdOffsets.find((o) => o.id === String(pos));
      $('#rd-scroll').scrollTop = found ? found.top : 0;
    }
    updateReadProgress();
  });
}

// Change a typography pref while keeping the reader's place (re-anchor on the
// segment that was at the top before the reflow).
function setReaderPref(key, value, reflow) {
  const p = readerPrefs();
  p[key] = value;
  saveReaderPrefs(p);
  if (!reflow) { applyReaderPrefs(); return; }
  const seg = topmostSeg();
  applyReaderPrefs();
  requestAnimationFrame(() => {
    indexReaderOffsets();
    const o = seg && rdOffsets.find((x) => x.id === String(seg));
    if (o) $('#rd-scroll').scrollTop = o.top;
    updateReadProgress();
  });
}
function bumpReaderSize(delta) {
  const p = readerPrefs();
  setReaderPref('size', Math.min(32, Math.max(12, p.size + delta)), true);
}

// Wiring
$('#rd-font').addEventListener('change', (e) => setReaderPref('font', e.target.value, true));
$('#rd-width').addEventListener('change', (e) => setReaderPref('width', e.target.value, true));
$('#rd-theme').addEventListener('change', (e) => setReaderPref('theme', e.target.value, false));
$('#rd-bigger').addEventListener('click', () => bumpReaderSize(1));
$('#rd-smaller').addEventListener('click', () => bumpReaderSize(-1));
// Side panels: Contents and Bookmarks share the left column, one at a time.
function togglePanel(which) {
  const toc = $('#rd-toc');
  const marks = $('#rd-marks');
  if (which === 'toc') { toc.hidden = !toc.hidden; marks.hidden = true; }
  else { marks.hidden = !marks.hidden; toc.hidden = true; if (!marks.hidden) renderBookmarks(); }
}
function jumpToSeg(segId) {
  const el = document.getElementById(`rd-seg-${segId}`);
  if (el) el.scrollIntoView({ block: 'start' });
}
$('#rd-toc-btn').addEventListener('click', () => togglePanel('toc'));
$('#rd-marks-btn').addEventListener('click', () => togglePanel('marks'));
$('#rd-toc').addEventListener('click', (e) => {
  const b = e.target.closest('[data-go]');
  if (b) jumpToSeg(b.dataset.go);
});

// ---- Bookmarks (per project, stored on this device) -------------------------
function getBookmarks(pid) {
  try { return JSON.parse(localStorage.getItem(`reader-marks:${pid}`)) || []; } catch { return []; }
}
function saveBookmarks(pid, arr) { localStorage.setItem(`reader-marks:${pid}`, JSON.stringify(arr)); }

function segSnippet(segId) {
  const s = currentProject && currentProject.segments[Number(segId)];
  if (!s) return `#${segId}`;
  const txt = (s.translation && s.translation.trim()) ? s.translation.trim() : (s.original || '');
  return stripMd(txt).slice(0, 60) || `#${segId}`;
}
function addBookmarkHere() {
  if (!currentProject) return;
  const seg = topmostSeg();
  if (seg == null) return;
  const pid = currentProject.id;
  const arr = getBookmarks(pid);
  if (arr.some((b) => String(b.seg) === String(seg))) { toast(t('reader.markExists')); return; }
  arr.push({ seg: String(seg) });
  saveBookmarks(pid, arr);
  renderBookmarks();
  markAnnotated();
  toast(t('reader.marked'), 'success');
}
function renderBookmarks() {
  const wrap = $('#rd-marks');
  const pid = currentProject ? currentProject.id : null;
  const arr = (pid ? getBookmarks(pid) : []).slice().sort((a, b) => Number(a.seg) - Number(b.seg));
  let html = `<div class="rd-marks-head"><span>${escapeHtml(t('reader.bookmarks'))}</span>` +
    `<button class="btn btn-ghost btn-sm" id="rd-mark-add">${icon('plus')}${escapeHtml(t('reader.addMark'))}</button></div>`;
  if (arr.length === 0) {
    html += `<div class="rd-marks-empty">${escapeHtml(t('reader.noMarks'))}</div>`;
  } else {
    html += arr.map((b) => {
      const label = b.note ? `“${b.note}”` : segSnippet(b.seg);
      const noteIcon = b.note ? icon('sticky-note') : '';
      return `<div class="rd-mark-row" data-go="${b.seg}"><span class="rd-mark-label">${noteIcon}${escapeHtml(label)}</span>` +
        `<button class="rd-mark-del" data-del="${b.seg}" title="${escapeHtml(t('reader.removeMark'))}">${icon('x')}</button></div>`;
    }).join('');
  }
  wrap.innerHTML = html;
}
$('#rd-marks').addEventListener('click', (e) => {
  if (e.target.closest('#rd-mark-add')) { addBookmarkHere(); return; }
  const del = e.target.closest('[data-del]');
  if (del) {
    const pid = currentProject.id;
    saveBookmarks(pid, getBookmarks(pid).filter((b) => String(b.seg) !== String(del.dataset.del)));
    renderBookmarks();
    markAnnotated();
    return;
  }
  const row = e.target.closest('[data-go]');
  if (row) jumpToSeg(row.dataset.go);
});

// ---- Bilingual: tap a paragraph to reveal its original ----------------------
$('#rd-bilingual').addEventListener('click', () => {
  const p = readerPrefs();
  p.bilingual = !p.bilingual;
  saveReaderPrefs(p);
  applyReaderPrefs();
  if (!p.bilingual) {
    $$('#rd-content .rd-orig').forEach((n) => n.remove());
    indexReaderOffsets();
  } else {
    toast(t('reader.bilingualHint'));
  }
});
$('#rd-content').addEventListener('click', (e) => {
  if (!readerPrefs().bilingual) return;
  if (!window.getSelection().isCollapsed) return; // don't fire while selecting text
  const el = e.target.closest('[data-seg]');
  if (!el || !currentProject) return;
  const seg = currentProject.segments[Number(el.dataset.seg)];
  if (!seg || seg.type === 'scene-break' || !seg.original) return;
  const next = el.nextElementSibling;
  if (next && next.classList.contains('rd-orig')) {
    next.remove();
  } else {
    const div = document.createElement('div');
    div.className = 'rd-orig';
    div.dir = isRtlLang(currentProject.sourceLang) ? 'rtl' : 'ltr';
    div.innerHTML = inlineMd(seg.original);
    el.insertAdjacentElement('afterend', div);
  }
  indexReaderOffsets();
});

// ---- Margin annotations: per-paragraph bookmark + note ----------------------
function annoEntry(seg) {
  if (!currentProject || seg == null) return null;
  return getBookmarks(currentProject.id).find((b) => String(b.seg) === String(seg)) || null;
}
function setMark(seg, on) {
  if (!currentProject) return;
  const pid = currentProject.id;
  const arr = getBookmarks(pid);
  const i = arr.findIndex((b) => String(b.seg) === String(seg));
  if (on) { if (i < 0) arr.push({ seg: String(seg) }); }
  else if (i >= 0) arr.splice(i, 1);
  saveBookmarks(pid, arr);
  markAnnotated();
}
function setNote(seg, text) {
  if (!currentProject) return;
  const pid = currentProject.id;
  const arr = getBookmarks(pid);
  const i = arr.findIndex((b) => String(b.seg) === String(seg));
  const note = (text || '').trim();
  if (i >= 0) { if (note) arr[i].note = note; else delete arr[i].note; }
  else if (note) arr.push({ seg: String(seg), note });
  saveBookmarks(pid, arr);
  markAnnotated();
}
function markAnnotated() {
  const flow = $('#rd-flow');
  flow.querySelectorAll('.rd-annotated').forEach((el) => el.classList.remove('rd-annotated', 'rd-has-note'));
  if (!currentProject) return;
  for (const b of getBookmarks(currentProject.id)) {
    const el = document.getElementById(`rd-seg-${b.seg}`);
    if (el) { el.classList.add('rd-annotated'); if (b.note) el.classList.add('rd-has-note'); }
  }
}

let gutterSeg = null;
let gutterHideTimer = null;
function refreshGutterState() {
  const e = annoEntry(gutterSeg);
  $('#rd-g-mark').classList.toggle('on', !!e);
  $('#rd-g-note').classList.toggle('on', !!(e && e.note));
}
$('#rd-content').addEventListener('mouseover', (e) => {
  clearTimeout(gutterHideTimer);
  if (e.target.closest('#rd-gutter') || e.target.closest('#rd-note-pop')) return;
  const el = e.target.closest('[data-seg]');
  if (!el || !currentProject) return;
  const seg = currentProject.segments[Number(el.dataset.seg)];
  if (!seg || seg.type === 'scene-break') return;
  gutterSeg = el.dataset.seg;
  const g = $('#rd-gutter');
  g.style.top = `${el.offsetTop}px`;
  g.hidden = false;
  refreshGutterState();
});
// Hide after a short grace period so moving onto the control never loses it.
$('#rd-content').addEventListener('mouseleave', () => {
  gutterHideTimer = setTimeout(() => { if ($('#rd-note-pop').hidden) $('#rd-gutter').hidden = true; }, 260);
});
$('#rd-gutter').addEventListener('mouseenter', () => clearTimeout(gutterHideTimer));
$('#rd-g-mark').addEventListener('click', () => {
  if (gutterSeg == null) return;
  setMark(gutterSeg, !annoEntry(gutterSeg));
  refreshGutterState();
  if (!$('#rd-marks').hidden) renderBookmarks();
});
$('#rd-g-note').addEventListener('click', () => openNotePop(gutterSeg));

// Note editor popover
let notePopSeg = null;
function openNotePop(seg) {
  if (seg == null) return;
  notePopSeg = seg;
  const e = annoEntry(seg);
  $('#rd-note-text').value = (e && e.note) || '';
  const el = document.getElementById(`rd-seg-${seg}`);
  if (el) $('#rd-note-pop').style.top = `${el.offsetTop}px`;
  $('#rd-note-pop').hidden = false;
  $('#rd-note-text').focus();
}
function closeNotePop() { $('#rd-note-pop').hidden = true; notePopSeg = null; }
$('#rd-note-save').addEventListener('click', () => {
  if (notePopSeg != null) setNote(notePopSeg, $('#rd-note-text').value);
  closeNotePop();
  if (!$('#rd-marks').hidden) renderBookmarks();
});
$('#rd-note-del').addEventListener('click', () => {
  if (notePopSeg != null) setNote(notePopSeg, '');
  closeNotePop();
  if (!$('#rd-marks').hidden) renderBookmarks();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#rd-note-pop').hidden) closeNotePop();
});

let rdPosTimer;
$('#rd-scroll').addEventListener('scroll', () => {
  updateReadProgress();
  clearTimeout(rdPosTimer);
  rdPosTimer = setTimeout(() => {
    if (!currentProject) return;
    const seg = topmostSeg();
    if (seg != null) localStorage.setItem(`reader-pos:${currentProject.id}`, seg);
  }, 400);
});

// ---- Settings: Built-in translator panel ------------------------------------
let builtinState = { status: 'stopped' };
async function renderEngineLine() {
  const line = $('#engine-line');
  if (!line) return;
  const info = await window.api.engineInfo();
  const st = builtinState;
  const eng = info.engines.find((x) => x.id === info.active);
  const engText = eng ? t('mdl.engine', { flavour: t('eng.' + eng.flavour), build: eng.build }) : t('mdl.noEngine');
  let stText = t('bi.' + st.status);
  if (st.status === 'ready' || st.status === 'starting') stText = t('bi.' + st.status + 'Model', { model: String(st.model || '').split(/[\\/]/).pop() });
  if (st.status === 'error') stText = t('err.builtin.' + (st.reason || 'crash'));
  line.innerHTML = `
    <span class="engine-dot ${st.status}"></span>
    <span class="engine-text"><strong>${escapeHtml(stText)}</strong><small>${escapeHtml(engText)}</small></span>
    ${st.status === 'ready' || st.status === 'starting' ? `<button class="btn btn-ghost btn-sm" id="engine-stop">${icon('square')}${escapeHtml(t('bi.stop'))}</button>` : ''}`;
  const stopBtn = $('#engine-stop');
  if (stopBtn) stopBtn.addEventListener('click', () => window.api.builtinStop());
}
// Engine builds: NVIDIA download, choice, updates, Undo.
let engineProgress = null;  // { flavour, phase, done, total }
let engineUpdate = null;    // result of the last "Check for updates"
const MB = 1024 * 1024;
async function renderEngineActions() {
  const box = $('#engine-actions');
  if (!box) return;
  const [info, sys] = await Promise.all([window.api.engineInfo(), window.api.getSystemInfo()]);
  const has = (f) => info.engines.some((e) => e.flavour === f);
  const nvidia = sys.gpu && sys.gpu.vendor === 'nvidia';
  const parts = [];

  if (engineProgress && engineProgress.phase !== 'idle') {
    const p = engineProgress;
    const pct = p.total ? Math.floor((p.done / p.total) * 100) : 0;
    parts.push(`
      <div class="engine-card">
        <span class="su-spec-icon">${icon('hard-drive-download')}</span>
        <span class="engine-card-text"><strong>${escapeHtml(t(p.phase === 'install' ? 'eng.installing' : 'eng.downloading', { name: t('eng.' + p.flavour) }))}</strong>
          <span class="dl-bar"><span style="width:${pct}%"></span></span>
          <small>${escapeHtml(t('eng.progress', { pct, done: Math.round(p.done / MB), total: Math.round(p.total / MB) }))}</small></span>
        ${p.phase === 'download' ? `<button class="btn btn-ghost btn-sm" id="eng-cancel">${escapeHtml(t('np.cancel'))}</button>` : ''}
      </div>`);
  } else if (nvidia && !has('cuda12')) {
    const size = engineUpdate && engineUpdate.sizes && engineUpdate.sizes.cuda12;
    parts.push(`
      <div class="engine-card">
        <span class="su-spec-icon">${icon('sparkles')}</span>
        <span class="engine-card-text"><strong>${escapeHtml(t('eng.nvidiaTitle'))}</strong>
          <small>${escapeHtml(t('eng.nvidiaBody', { size: size ? Math.round(size / MB) : '~640' }))}</small></span>
        <button class="btn btn-primary btn-sm" id="eng-get-cuda">${icon('download')}${escapeHtml(t('eng.download'))}</button>
      </div>`);
  }

  // Which build runs, when there's a choice.
  if (has('cuda12') && has('vulkan')) {
    const cur = info.flavour === 'vulkan' ? 'vulkan' : 'cuda12';
    parts.push(`
      <div class="field engine-choice">
        <label>${escapeHtml(t('eng.use'))}</label>
        <div class="segmented" id="eng-flavour">
          <button data-value="cuda12" class="${cur === 'cuda12' ? 'active' : ''}">${escapeHtml(t('eng.cuda12'))}</button>
          <button data-value="vulkan" class="${cur === 'vulkan' ? 'active' : ''}">${escapeHtml(t('eng.vulkan'))}</button>
        </div>
      </div>`);
  }

  // Updates + Undo.
  const active = info.engines.find((e) => e.id === info.active);
  const sameFlavour = active ? info.engines.filter((e) => e.flavour === active.flavour).sort((a, b) => b.version - a.version) : [];
  let upd = '';
  if (engineUpdate && engineUpdate.ok && active) {
    upd = engineUpdate.version > active.version
      ? `<span class="eng-note">${escapeHtml(t('eng.updateAvail', { build: engineUpdate.build, stable: engineUpdate.stable }))}</span>
         <button class="btn btn-primary btn-sm" id="eng-update">${icon('download')}${escapeHtml(t('eng.update'))}</button>`
      : `<span class="eng-note ok">${icon('circle-check')}${escapeHtml(t('eng.upToDate', { build: active.build, stable: engineUpdate.stable }))}</span>`;
  } else if (engineUpdate && !engineUpdate.ok) {
    upd = `<span class="eng-note bad">${escapeHtml(t('eng.checkFailed'))}</span>`;
  }
  let undo = '';
  if (info.pinned) {
    undo = `<span class="eng-note">${escapeHtml(t('eng.pinned', { build: (active || {}).build || '' }))}</span>
            <button class="btn btn-ghost btn-sm" id="eng-unpin">${escapeHtml(t('eng.useNewest'))}</button>`;
  } else if (sameFlavour.length > 1 && active && active.id === sameFlavour[0].id) {
    undo = `<button class="btn btn-ghost btn-sm" id="eng-undo" data-id="${escapeHtml(sameFlavour[1].id)}">${icon('arrow-left-right')}${escapeHtml(t('eng.undo', { build: sameFlavour[1].build }))}</button>`;
  }
  parts.push(`<div class="engine-row">
      <button class="btn btn-ghost btn-sm" id="eng-check">${icon('refresh-cw')}${escapeHtml(t('eng.check'))}</button>${upd}${undo}</div>`);
  box.innerHTML = parts.join('');
}

async function engineDownload(flavour) {
  engineProgress = { flavour, phase: 'download', done: 0, total: 0 };
  renderEngineActions();
  const r = await window.api.engineDownload(flavour);
  engineProgress = null;
  if (r.ok) toast(t('eng.installed', { name: t('eng.' + flavour) }), 'success');
  else if (r.error !== 'cancelled') toast(t('eng.failed', { msg: r.error }), 'error');
  renderEngineLine();
  renderEngineActions();
}
$('#engine-actions').addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.id === 'eng-get-cuda') engineDownload('cuda12');
  else if (b.id === 'eng-cancel') window.api.engineCancel();
  else if (b.id === 'eng-check') {
    b.disabled = true;
    engineUpdate = await window.api.engineCheckUpdate();
    renderEngineActions();
  } else if (b.id === 'eng-update') {
    const info = await window.api.engineInfo();
    const active = info.engines.find((x) => x.id === info.active);
    engineDownload(active && active.flavour === 'cuda12' ? 'cuda12' : 'vulkan');
  } else if (b.id === 'eng-undo') {
    await window.api.engineUse({ pin: b.dataset.id });
    toast(t('eng.undone'), 'success');
    renderEngineLine(); renderEngineActions();
  } else if (b.id === 'eng-unpin') {
    await window.api.engineUse({ pin: null });
    renderEngineLine(); renderEngineActions();
  } else if (b.closest('#eng-flavour') && b.dataset.value) {
    await window.api.engineUse({ flavour: b.dataset.value });
    renderEngineLine(); renderEngineActions();
  }
});
window.api.onEngineProgress((p) => {
  engineProgress = p.phase === 'idle' ? null : p;
  if ($('#view-settings').classList.contains('active')) renderEngineActions();
});

async function renderModelsPanel(refresh = false) {
  if (!$('#models-panel')) return;
  renderEngineLine();
  renderEngineActions();
  const folders = await window.api.getModelFolders();
  $('#folder-list').innerHTML = folders.map((f) => `
    <li><span class="folder-icon">${icon('folder')}</span><span class="folder-path" dir="ltr">${escapeHtml(f)}</span>
      <button class="icon-btn js-rmfolder" data-folder="${escapeHtml(f)}" title="${escapeHtml(t('mdl.removeFolder'))}">${icon('x')}</button></li>`).join('');
  const list = $('#model-list');
  if (!folders.length) { list.innerHTML = `<p class="settings-note">${escapeHtml(t('mdl.noFolders'))}</p>`; return; }
  list.innerHTML = `<div class="su-loading"><span class="spinner"></span>${escapeHtml(t('mdl.scanning'))}</div>`;
  const models = await getModelFiles(refresh);
  const s = await window.api.getSettings();
  list.innerHTML = models.length ? models.map((m) => `
    <div class="model-row">
      <span class="model-text"><strong dir="auto">${escapeHtml(m.name)}</strong>
        <small>${escapeHtml([m.params, m.quant, m.sizeGB + ' GB'].filter(Boolean).join(' · '))} · <span dir="ltr">${escapeHtml(m.folder)}</span></small></span>
      <span class="fit-badge fit-${m.fit}">${icon(FIT_ICON[m.fit])}${escapeHtml(t('fit.' + m.fit + 'Short'))}</span>
      ${s.provider === 'builtin' && s.model === m.path
        ? `<span class="model-default">${icon('check')}${escapeHtml(t('mdl.isDefault'))}</span>`
        : `<button class="btn btn-ghost btn-sm js-usemodel" data-path="${escapeHtml(m.path)}">${escapeHtml(t('mdl.useDefault'))}</button>`}
    </div>`).join('') : `<p class="settings-note">${escapeHtml(t('mdl.noneInFolders'))}</p>`;
}
async function addModelFolder(dir) {
  const r = await window.api.addModelFolder(dir);
  if (!r) return; // cancelled
  if (r.error) { toast(t('mdl.notFolder'), 'error'); return; }
  modelFilesCache = null;
  await renderModelsPanel(true);
  const n = (await getModelFiles()).length;
  toast(t('mdl.added', { n }), 'success');
}
$('#folder-add').addEventListener('click', () => addModelFolder());
$('#models-rescan').addEventListener('click', () => { modelFilesCache = null; renderModelsPanel(true); });
$('#models-panel').addEventListener('click', async (e) => {
  const rm = e.target.closest('.js-rmfolder');
  if (rm) { await window.api.removeModelFolder(rm.dataset.folder); modelFilesCache = null; renderModelsPanel(true); return; }
  const use = e.target.closest('.js-usemodel');
  if (use) {
    await window.api.saveSettings({ provider: 'builtin', model: use.dataset.path });
    toast(t('mdl.defaultSet'), 'success');
    renderSettings();
  }
});
// Drop a folder (or a .gguf inside one) onto the panel, or onto Setup.
function wireFolderDrop(el, after) {
  el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('drag'); });
  el.addEventListener('dragleave', () => el.classList.remove('drag'));
  el.addEventListener('drop', async (e) => {
    e.preventDefault();
    el.classList.remove('drag');
    for (const f of Array.from(e.dataTransfer.files || [])) {
      let p = window.api.pathForFile(f);
      if (/\.gguf$/i.test(p)) p = p.replace(/[\\/][^\\/]+$/, ''); // a model file: use its folder
      if (p) await addModelFolder(p);
    }
    if (after) after();
  });
}
wireFolderDrop($('#folder-drop'));
// Stop the window from opening files dropped anywhere else.
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());
window.api.onBuiltinStatus((st) => {
  builtinState = st;
  if ($('#view-settings').classList.contains('active')) renderEngineLine();
});
window.api.builtinStatus().then((st) => { builtinState = st; });

// ---- Keyboard shortcuts -----------------------------------------------------
// [keys, label key, where]. The help window (F1) is built from this list.
const SHORTCUTS = [
  ['F1', 'kb.help', 'kb.anywhere'],
  ['Ctrl+O', 'kb.import', 'kb.anywhere'],
  ['Ctrl+,', 'kb.settings', 'kb.anywhere'],
  ['Ctrl+L', 'kb.library', 'kb.anywhere'],
  ['Ctrl+S', 'kb.save', 'kb.inReview'],
  ['Alt+↑', 'kb.prev', 'kb.inReview'],
  ['Alt+↓', 'kb.next', 'kb.inReview'],
  ['Esc', 'kb.close', 'kb.anywhere'],
];
function openShortcuts() {
  $('#kb-list').innerHTML = `<table class="kb-table">${SHORTCUTS.map(([k, label, where]) => `
    <tr><td>${k.split('+').map((p) => `<kbd>${escapeHtml(p)}</kbd>`).join('<span class="kb-plus">+</span>')}</td>
      <td>${escapeHtml(t(label))}</td><td class="kb-where">${escapeHtml(t(where))}</td></tr>`).join('')}</table>`;
  $('#kb-modal').classList.add('open');
  $('#kb-close').focus();
}
function closeShortcuts() { $('#kb-modal').classList.remove('open'); }
$('#kb-close').addEventListener('click', closeShortcuts);
$('#kb-modal').addEventListener('click', (e) => { if (e.target.id === 'kb-modal') closeShortcuts(); });
$('#set-shortcuts').addEventListener('click', openShortcuts);

document.addEventListener('keydown', (e) => {
  // Not while a dialog or Setup is open: they own the keyboard.
  const busy = document.querySelector('.modal-backdrop.open') || !$('#setup').hidden;
  if (e.key === 'F1') { e.preventDefault(); if (!busy) openShortcuts(); return; }
  if (busy || !(e.ctrlKey || e.metaKey) || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === 'o') { e.preventDefault(); openNewProjectModal(); }
  else if (k === ',') { e.preventDefault(); showView('settings'); }
  else if (k === 'l') { e.preventDefault(); showView('library'); }
});

// ---- Boot -------------------------------------------------------------------
mountIcons();
setLang(localStorage.getItem('lang') || 'en');   // applies static i18n + fires langchange → renderLibrary
applyTheme(localStorage.getItem('theme') || 'dark');
updateLangLabel();
renderLibrary();
