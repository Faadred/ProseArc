// Folder import and the translation queue (the Library's "Import folder"
// dialog, the queue panel above the shelves, and the queue badge on cards).
// Loaded after renderer.js and uses its helpers ($, t, icon, toast, …).

// ---- Queue state (kept in sync by the main process) -------------------------
let queueState = { state: 'idle', items: [], lastError: null, current: null };
let queueOpen = false; // the list under the panel's summary line

function inQueue(projectId) {
  return queueState.items.some((it) => it.projectId === projectId && (it.status === 'waiting' || it.status === 'running'));
}
function queueBadge(projectId) {
  const it = queueState.items.find((x) => x.projectId === projectId && (x.status === 'waiting' || x.status === 'running'));
  if (!it) return '';
  const running = it.status === 'running';
  return `<span class="book-badge q-badge${running ? ' running' : ''}">${running ? '<span class="spinner"></span>' : icon('list-restart')}${escapeHtml(t('queue.s.' + it.status))}</span>`;
}

async function addToQueue(ids) {
  queueState = await window.api.queueAdd(ids);
  toast(t('queue.added', { n: ids.length }), 'success');
  renderLibrary();
}

const libNames = new Map(); // projectId -> { name, series } for the queue list
async function refreshNames() {
  const list = await window.api.listProjects();
  libNames.clear();
  for (const p of list) libNames.set(p.id, { name: p.name, series: p.series || '', counts: p.counts });
}

async function renderQueuePanel() {
  const box = $('#queue-panel');
  if (!box) return;
  const items = queueState.items;
  if (!items.length) { box.hidden = true; box.innerHTML = ''; return; }
  await refreshNames();
  const waiting = items.filter((x) => x.status === 'waiting').length;
  const done = items.filter((x) => x.status === 'done').length;
  const failed = items.filter((x) => x.status === 'error').length;
  const run = items.find((x) => x.status === 'running');
  const st = queueState.state;
  let line;
  if (st === 'running' && run) {
    const i = items.filter((x) => x.status !== 'error').indexOf(run) + 1;
    line = t('queue.running', { name: (libNames.get(run.projectId) || {}).name || '…', i, n: items.length - failed });
  } else if (waiting) {
    line = queueState.lastError ? t('queue.stoppedBy', { msg: t('err.' + queueState.lastError.key, queueState.lastError.params || {}) }) : t('queue.paused', { n: waiting });
  } else {
    line = t('queue.idleDone', { n: done });
  }
  const pct = items.length ? Math.round(((done + failed) / items.length) * 100) : 0;
  const mainBtn = st === 'running'
    ? `<button class="btn btn-ghost btn-sm" id="q-pause">${icon('pause')}${escapeHtml(t('queue.pause'))}</button>`
    : waiting ? `<button class="btn btn-primary btn-sm" id="q-start">${icon('play')}${escapeHtml(t(done || failed || queueState.lastError ? 'queue.resume' : 'queue.start'))}</button>` : '';
  const rows = items.map((it, k) => {
    const info = libNames.get(it.projectId) || { name: '—', series: '' };
    const ic = { waiting: 'list-restart', running: null, done: 'circle-check', error: 'circle-alert' }[it.status];
    const pc = info.counts && info.counts.total ? Math.round((info.counts.translated / info.counts.total) * 100) : 0;
    const err = it.status === 'error' && it.error ? ` — ${escapeHtml(t('err.' + it.error.key, it.error.params || {}))}` : '';
    return `<li class="q-row q-${it.status}" data-id="${it.id}">
      <span class="q-ic">${ic ? icon(ic) : '<span class="spinner"></span>'}</span>
      <span class="q-text"><strong dir="auto">${escapeHtml(info.name)}</strong>
        <small>${escapeHtml(t('queue.s.' + it.status))}${it.status === 'running' || it.status === 'waiting' ? ` · ${pc}%` : ''}${info.series ? ` · <span dir="auto">${escapeHtml(info.series)}</span>` : ''}${err}</small></span>
      ${it.status === 'error' ? `<button class="icon-btn js-q-retry" title="${escapeHtml(t('queue.retry'))}">${icon('refresh-cw')}</button>` : ''}
      ${it.status === 'waiting' ? `<button class="icon-btn js-q-up" title="${escapeHtml(t('queue.up'))}" ${k === 0 ? 'disabled' : ''}>${icon('chevron-up')}</button>
        <button class="icon-btn js-q-down" title="${escapeHtml(t('queue.down'))}" ${k === items.length - 1 ? 'disabled' : ''}>${icon('chevron-down')}</button>` : ''}
      ${it.status !== 'done' ? `<button class="icon-btn js-q-rm" title="${escapeHtml(t('queue.remove'))}">${icon('x')}</button>` : ''}
    </li>`;
  }).join('');
  box.hidden = false;
  box.innerHTML = `
    <div class="q-head">
      <span class="q-title-ic">${st === 'running' ? '<span class="spinner"></span>' : icon('list-restart')}</span>
      <span class="q-sum"><strong>${escapeHtml(t('queue.title'))}</strong><small class="${queueState.lastError && st !== 'running' ? 'bad' : ''}">${escapeHtml(line)}</small></span>
      <span class="q-bar"><i style="width:${pct}%"></i></span>
      ${mainBtn}
      ${done || failed ? `<button class="btn btn-ghost btn-sm" id="q-clear">${escapeHtml(t('queue.clear'))}</button>` : ''}
      <button class="icon-btn" id="q-toggle" title="${escapeHtml(t(queueOpen ? 'queue.hide' : 'queue.show'))}">${icon(queueOpen ? 'chevron-up' : 'chevron-down')}</button>
    </div>
    ${queueOpen ? `<ol class="q-list">${rows}</ol>` : ''}`;
}

$('#queue-panel').addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const row = b.closest('.q-row');
  const id = row && row.dataset.id;
  if (b.id === 'q-toggle') { queueOpen = !queueOpen; renderQueuePanel(); return; }
  if (b.id === 'q-start') {
    const r = await window.api.queueStart();
    if (r && r.busy) toast(t('queue.busyEngine'), 'info');
  } else if (b.id === 'q-pause') await window.api.queuePause();
  else if (b.id === 'q-clear') await window.api.queueClearFinished();
  else if (b.classList.contains('js-q-rm')) await window.api.queueRemove(id);
  else if (b.classList.contains('js-q-up')) await window.api.queueMove(id, -1);
  else if (b.classList.contains('js-q-down')) await window.api.queueMove(id, 1);
  else if (b.classList.contains('js-q-retry')) await window.api.queueRetry(id);
});

const libVisible = () => $('#view-library').classList.contains('active');
let libTimer = null;
function refreshLibrarySoon() {
  if (libTimer) return;
  libTimer = setTimeout(() => { libTimer = null; if (libVisible()) renderLibrary(); }, 1500);
}
window.api.onQueueState((s) => {
  const was = queueState.state;
  queueState = s;
  if (libVisible()) renderLibrary(); else renderQueuePanel();
  if (was === 'running' && s.state === 'idle' && s.items.some((x) => x.status === 'done')) toast(t('queue.idleDone', { n: s.items.filter((x) => x.status === 'done').length }), 'success');
});
// Progress of the book being translated: keep the Library's bars moving.
window.api.onEngineEvent((ev) => { if (ev.type === 'progress' && libVisible()) refreshLibrarySoon(); });
window.api.queueGet().then((s) => { queueState = s; if (libVisible()) renderLibrary(); });

// ---- Import folder ------------------------------------------------------------
let fmTree = null;   // the scanned folder
let fmChecked = new Set(); // file paths ticked for import

async function openFolderModal() {
  fmTree = null;
  fmChecked = new Set();
  $('#fm-folder-label').textContent = t('fm.noFolder');
  $('#fm-folder').classList.remove('chosen');
  $('#fm-tree').hidden = true;
  $('#fm-settings').hidden = true;
  $('#fm-summary').textContent = '';
  $('#fm-progress').hidden = true;
  $('#fm-import').disabled = true;
  $('#fm-import').textContent = t('fm.import');
  const s = await window.api.getSettings();
  $('#fm-source').value = s.sourceLang || 'English';
  $('#fm-target').value = s.targetLang || 'Arabic';
  $('#fm-style').value = '';
  $('#fm-queue').checked = true;
  $('#fm-watch').checked = true;
  await fillProviderSelect('#fm-provider', s.provider || 'builtin');
  await fmProviderChanged(s.model || '');
  $('#folder-modal').classList.add('open');
  fmPick();
}
function closeFolderModal() { $('#folder-modal').classList.remove('open'); }

async function fmProviderChanged(model = '') {
  const prov = $('#fm-provider').value;
  const builtinP = prov === 'builtin';
  $('#fm-bmodel-field').hidden = !builtinP;
  $('#fm-model-field').hidden = builtinP;
  $('#fm-bmodel-note').textContent = '';
  if (builtinP) await fillModelSelect('#fm-bmodel', model, '#fm-bmodel-note');
  else { $('#fm-model').value = model && !/[\\/]/.test(model) ? model : ''; suggestModels('#fm-model-list', prov); }
}
$('#fm-provider').addEventListener('change', () => fmProviderChanged(''));

async function fmPick() {
  const root = await window.api.pickFolder();
  if (!root) return;
  $('#fm-folder-label').textContent = root;
  $('#fm-folder').classList.add('chosen');
  $('#fm-tree').hidden = false;
  $('#fm-tree').innerHTML = `<div class="su-loading"><span class="spinner"></span>${escapeHtml(t('fm.scanning'))}</div>`;
  const r = await window.api.scanFolder(root);
  if (!r.ok) { $('#fm-tree').innerHTML = `<p class="settings-note">${escapeHtml(r.error)}</p>`; return; }
  fmTree = r.tree;
  fmChecked = new Set();
  (function tick(n) { n.files.forEach((f) => { if (!f.imported) fmChecked.add(f.path); }); n.folders.forEach(tick); })(fmTree);
  renderFmTree();
  $('#fm-settings').hidden = false;
}
$('#fm-pick').addEventListener('click', fmPick);

const fmFiles = (node) => [...node.files, ...node.folders.flatMap(fmFiles)];
const fmSize = (b) => (b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

function renderFmTree() {
  const all = fmFiles(fmTree);
  if (!all.length) { $('#fm-tree').innerHTML = `<p class="settings-note">${escapeHtml(t('fm.empty'))}</p>`; fmSummary(); return; }
  const folderRow = (node, depth) => {
    const files = fmFiles(node).filter((f) => !f.imported);
    const on = files.filter((f) => fmChecked.has(f.path)).length;
    const state = on === 0 ? '' : on === files.length ? 'checked' : 'data-mixed="1"';
    return `<li class="fm-folder" style="--d:${depth}">
        <label class="fm-line"><input type="checkbox" class="js-fm-dir" data-rel="${escapeHtml(node.rel)}" ${state} ${files.length ? '' : 'disabled'} />
          <span class="fm-ic">${icon('folder')}</span><strong dir="auto">${escapeHtml(node.name)}</strong>
          <small>${escapeHtml(fmFiles(node).length === 1 ? t('fm.oneBook') : t('fm.nBooks', { n: fmFiles(node).length }))}</small></label>
        <ul>${node.files.map((f) => fileRow(f, depth + 1)).join('')}${node.folders.map((sub) => folderRow(sub, depth + 1)).join('')}</ul>
      </li>`;
  };
  const fileRow = (f, depth) => `<li class="fm-file${f.imported ? ' imported' : ''}" style="--d:${depth}">
      <label class="fm-line"><input type="checkbox" class="js-fm-file" data-path="${escapeHtml(f.path)}" ${fmChecked.has(f.path) ? 'checked' : ''} ${f.imported ? 'disabled' : ''} />
        <span class="fm-ic">${icon('book-open')}</span><span class="fm-name" dir="auto">${escapeHtml(f.name)}</span>
        <small>${f.imported ? escapeHtml(t('fm.already')) : fmSize(f.size)}</small></label></li>`;
  $('#fm-tree').innerHTML = `<ul class="fm-root">${folderRow(fmTree, 0)}</ul>`;
  $$('#fm-tree input[data-mixed]').forEach((el) => { el.indeterminate = true; });
  fmSummary();
}

function fmSummary() {
  const books = window.fmSelected();
  const series = new Set(books.map((b) => b.series)).size;
  const skipped = fmTree ? fmFiles(fmTree).filter((f) => f.imported).length : 0;
  $('#fm-summary').textContent = books.length
    ? (books.length === 1 ? t('fm.summary1') : t('fm.summary', { n: books.length, s: series })) + (skipped ? ` ${t('fm.alreadyN', { n: skipped })}` : '')
    : (fmTree && fmFiles(fmTree).length ? t('fm.summaryNone') : '');
  $('#fm-import').disabled = books.length === 0;
  $('#fm-import').textContent = books.length ? t('fm.importN', { n: books.length }) : t('fm.import');
}

// Ticked books in reading order, each with its series (the folder below the root).
window.fmSelected = function fmSelected() {
  if (!fmTree) return [];
  const out = [];
  (function visit(node, trail) {
    const series = trail.length ? trail.join(' / ') : fmTree.name;
    for (const f of node.files) if (fmChecked.has(f.path) && !f.imported) out.push({ path: f.path, size: f.size, mtimeMs: f.mtimeMs, series });
    for (const sub of node.folders) visit(sub, [...trail, sub.name]);
  })(fmTree, []);
  return out;
};

$('#fm-tree').addEventListener('change', (e) => {
  const el = e.target;
  if (el.classList.contains('js-fm-file')) {
    if (el.checked) fmChecked.add(el.dataset.path); else fmChecked.delete(el.dataset.path);
  } else if (el.classList.contains('js-fm-dir')) {
    const find = (n) => (n.rel === el.dataset.rel ? n : n.folders.map(find).find(Boolean));
    const node = find(fmTree);
    for (const f of fmFiles(node)) if (!f.imported) { if (el.checked) fmChecked.add(f.path); else fmChecked.delete(f.path); }
  }
  renderFmTree();
});

async function fmImport() {
  const books = window.fmSelected();
  if (!books.length) return;
  const provider = $('#fm-provider').value;
  const settings = {
    sourceLang: $('#fm-source').value.trim() || 'Source',
    targetLang: $('#fm-target').value.trim() || 'Target',
    provider,
    model: provider === 'builtin' ? $('#fm-bmodel').value : $('#fm-model').value.trim(),
  };
  const brief = $('#fm-style').value.trim();
  if (brief) settings.styleBrief = brief; // stored on each new book
  const wantQueue = $('#fm-queue').checked;
  const wantWatch = $('#fm-watch').checked;
  const root = fmTree.path;
  $('#fm-import').disabled = true;
  $('#fm-progress').hidden = false;
  const off = window.api.onFolderProgress((p) => {
    $('#fm-progress-text').textContent = p.name ? t('fm.importing', { i: p.done + 1, n: p.total, name: p.name }) : '';
  });
  const r = await window.api.importFolder({ books, settings, queue: false });
  off();
  if (wantWatch) { await window.api.watchAdd({ path: root, settings, autoTranslate: false }); renderWatchButton(); }
  closeFolderModal();
  if (r.created.length) toast(t('fm.done', { n: r.created.length }), 'success');
  if (r.failed.length) toast(t('fm.failed', { n: r.failed.length, names: r.failed.map((f) => f.name).slice(0, 3).join(document.documentElement.lang === 'ar' ? '، ' : ', ') }), 'error');
  if (wantQueue && r.created.length) {
    // Online providers charge by use: say how much will be sent before starting.
    const pv = providerInfo(provider);
    let go = true;
    if (pv && (pv.kind === 'cloud' || pv.kind === 'custom')) {
      const words = r.created.reduce((n, c) => n + c.words, 0);
      go = await askConfirm({
        title: t('fm.costTitle', { n: r.created.length, provider: providerName(pv) }),
        body: t('fm.costBody', { words: words.toLocaleString(), provider: providerName(pv) }),
        ok: t('fm.costOk'),
      });
    }
    queueState = await window.api.queueAdd(r.created.map((c) => c.id));
    if (go) {
      const s = await window.api.queueStart();
      if (s && s.busy) toast(t('queue.busyEngine'), 'info');
    }
  }
  queueOpen = true;
  renderLibrary();
}

$('#import-folder-btn').addEventListener('click', openFolderModal);
$('#fm-cancel').addEventListener('click', closeFolderModal);
$('#fm-import').addEventListener('click', fmImport);
$('#folder-modal').addEventListener('click', (e) => { if (e.target.id === 'folder-modal') closeFolderModal(); });

// ---- Watched folders (Settings → General, and "Check folders" in the Library) --
function whenText(ms) {
  if (!ms) return '—';
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 45) return t('wf.justNow');
  const rtf = new Intl.RelativeTimeFormat(document.documentElement.lang || 'en', { numeric: 'auto' });
  if (s < 3600) return rtf.format(-Math.round(s / 60), 'minute');
  if (s < 86400) return rtf.format(-Math.round(s / 3600), 'hour');
  return rtf.format(-Math.round(s / 86400), 'day');
}

async function renderWatchButton() {
  const list = await window.api.watchList();
  $('#watch-check-btn').hidden = list.length === 0;
  return list;
}

async function renderWatchPanel() {
  const box = $('#wf-list');
  if (!box) return;
  const list = await renderWatchButton();
  $('#wf-check').hidden = list.length === 0;
  if (!list.length) { box.innerHTML = `<li class="wf-empty">${escapeHtml(t('wf.empty'))}</li>`; return; }
  box.innerHTML = list.map((f, i) => `
    <li class="wf-row${f.missing ? ' missing' : ''}" data-i="${i}">
      <span class="folder-icon">${icon('folder')}</span>
      <span class="wf-text"><strong dir="ltr">${escapeHtml(f.path)}</strong>
        <small>${escapeHtml(f.missing ? t('wf.missing') : f.lastAdded ? t('wf.metaAdded', { when: whenText(f.lastChecked), n: f.lastAdded }) : t('wf.meta', { when: whenText(f.lastChecked) }))}</small>
        <label class="check wf-auto"><input type="checkbox" class="js-wf-auto" ${f.autoTranslate ? 'checked' : ''} /> <span>${escapeHtml(t('wf.auto'))}</span></label></span>
      <button class="icon-btn js-wf-rm" title="${escapeHtml(t('wf.remove'))}">${icon('x')}</button>
    </li>`).join('');
  box._list = list;
}

$('#wf-list').addEventListener('change', async (e) => {
  if (!e.target.classList.contains('js-wf-auto')) return;
  const f = $('#wf-list')._list[e.target.closest('.wf-row').dataset.i];
  await window.api.watchUpdate(f.path, { autoTranslate: e.target.checked });
});
$('#wf-list').addEventListener('click', async (e) => {
  const b = e.target.closest('.js-wf-rm');
  if (!b) return;
  const f = $('#wf-list')._list[b.closest('.wf-row').dataset.i];
  await window.api.watchRemove(f.path);
  toast(t('wf.removed', { path: f.path }), 'info');
  renderWatchPanel();
});

let manualCheck = false;
async function checkWatched(btn) {
  manualCheck = true;
  btn.disabled = true;
  const label = btn.querySelector('span');
  const was = label.textContent;
  label.textContent = t('wf.checking');
  try { await window.api.watchCheck(); } finally {
    btn.disabled = false;
    label.textContent = was;
  }
}
$('#wf-check').addEventListener('click', (e) => checkWatched(e.currentTarget));
$('#watch-check-btn').addEventListener('click', (e) => checkWatched(e.currentTarget));

window.api.onWatchResult((r) => {
  const n = r.added.length;
  if (n) toast(n === 1 ? t('wf.found1') : t('wf.found', { n }), 'success');
  else if (manualCheck && !r.missing.length) toast(t('wf.none'), 'info');
  if (manualCheck) for (const m of r.missing) toast(t('wf.missingToast', { path: m }), 'error');
  if (r.failed.length) toast(t('fm.failed', { n: r.failed.length, names: r.failed.map((f) => f.name).slice(0, 3).join(document.documentElement.lang === 'ar' ? '، ' : ', ') }), 'error');
  manualCheck = false;
  if (n && libVisible()) renderLibrary();
  if ($('#view-settings').classList.contains('active')) renderWatchPanel();
});
renderWatchButton();
