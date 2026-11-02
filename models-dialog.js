// "Find models" window: search Hugging Face for GGUF models, pick a file
// (rated for this PC, the recommended one preselected), download it checked
// into the download folder. Uses renderer.js helpers ($, icon, t, toast, …).

const MH_CHIPS = [
  ['', 'mh.popular'], ['translategemma', null], ['gemma-4', null], ['qwen3.8', null], ['mistral', null],
];

const mh = {
  query: '',
  results: null,      // [] | null while loading
  error: null,
  repo: null,         // selected repo id
  files: null,        // files of the selected repo
  filesError: null,
  pick: null,         // selected file path
  progress: null,     // { repo, file, done, total, speed, phase }
  done: null,         // { repo, file, path } after a finished download
  onDownloaded: null, // callback(path) set by the opener (Setup)
  searchSeq: 0,
};

const fmtNum = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
// Sizes: MB under 1 GB, else GB with one decimal. Kept left-to-right so Arabic doesn't flip number and unit.
const fmtGB = (bytes) => (bytes < 1024 ** 3 ? `${Math.round(bytes / 1024 ** 2)} MB` : `${(bytes / 1024 ** 3).toFixed(1)} GB`);

async function openModelHub({ onDownloaded = null, query = '' } = {}) {
  mh.onDownloaded = onDownloaded;
  $('#mh-modal').classList.add('open');
  $('#mh-dest').textContent = await window.api.hubFolder();
  mh.progress = await window.api.hubState().then((s) => (s && s.progress ? { repo: s.repo, file: s.file, ...s.progress } : null));
  if (mh.progress && !mh.repo) { mh.repo = mh.progress.repo; loadRepoFiles(mh.repo); }
  $('#mh-q').value = query;
  renderChips();
  if (!mh.results || query) runSearch(query); else renderResults();
  renderDetail();
  $('#mh-q').focus();
}
function closeModelHub() { $('#mh-modal').classList.remove('open'); }

function renderChips() {
  $('#mh-chips').innerHTML = MH_CHIPS.map(([q, key]) =>
    `<button class="su-provider ${mh.query === q ? 'selected' : ''}" data-q="${escapeHtml(q)}">${escapeHtml(key ? t(key) : q)}</button>`).join('');
}

async function runSearch(q) {
  mh.query = q;
  mh.results = null;
  mh.error = null;
  renderChips();
  renderResults();
  const seq = ++mh.searchSeq;
  const r = await window.api.hubSearch(q);
  if (seq !== mh.searchSeq) return; // a newer search started
  if (r.ok) mh.results = r.results; else { mh.results = []; mh.error = r.error; }
  renderResults();
}

function renderResults() {
  const box = $('#mh-results');
  if (mh.results === null) { box.innerHTML = `<div class="su-loading"><span class="spinner"></span>${escapeHtml(t('mh.searching'))}</div>`; return; }
  if (mh.error) { box.innerHTML = `<p class="mh-empty">${escapeHtml(t('mh.offline'))}</p>`; return; }
  if (!mh.results.length) { box.innerHTML = `<p class="mh-empty">${escapeHtml(t('mh.noResults'))}</p>`; return; }
  box.innerHTML = mh.results.map((r) => `
    <button class="mh-result ${mh.repo === r.id ? 'selected' : ''}" data-repo="${escapeHtml(r.id)}">
      <strong dir="ltr">${escapeHtml(r.name)}</strong>
      <small dir="ltr">${escapeHtml(r.author)}</small>
      <span class="mh-stats">${icon('download')}${fmtNum(r.downloads)} <span class="mh-dot">·</span> ${icon('star')}${fmtNum(r.likes)}</span>
    </button>`).join('');
}

async function loadRepoFiles(repo) {
  mh.repo = repo;
  mh.files = null;
  mh.filesError = null;
  mh.done = null;
  renderResults();
  renderDetail();
  const r = await window.api.hubFiles(repo);
  if (mh.repo !== repo) return;
  if (r.ok) {
    mh.files = r.files;
    const rec = r.files.find((f) => f.recommended);
    mh.pick = (mh.progress && mh.progress.repo === repo) ? mh.progress.file : (rec ? rec.path : (r.files[0] || {}).path);
  } else { mh.files = []; mh.filesError = r.error; }
  renderDetail();
}

async function renderDetail() {
  const box = $('#mh-detail');
  if (!mh.repo) { box.innerHTML = `<div class="mh-placeholder">${icon('search')}<p>${escapeHtml(t('mh.pickRepo'))}</p></div>`; return; }
  const head = `
    <div class="mh-detail-head">
      <div><h3 dir="ltr">${escapeHtml(mh.repo.split('/').slice(1).join('/'))}</h3>
        <small dir="ltr">${escapeHtml(mh.repo.split('/')[0])}</small></div>
      <a class="btn btn-ghost btn-sm" href="https://huggingface.co/${escapeHtml(mh.repo)}" target="_blank">${icon('globe')}${escapeHtml(t('mh.openPage'))}</a>
    </div>`;
  if (mh.files === null) { box.innerHTML = head + `<div class="su-loading"><span class="spinner"></span>${escapeHtml(t('mh.loadingFiles'))}</div>`; return; }
  if (!mh.files.length) { box.innerHTML = head + `<p class="mh-empty">${escapeHtml(t(mh.filesError ? 'mh.offline' : 'mh.noFiles'))}</p>`; return; }

  const have = new Set((await getModelFiles()).map((m) => m.file.toLowerCase()));
  const busy = !!mh.progress;
  const rows = mh.files.map((f) => `
    <label class="mh-file ${mh.pick === f.path ? 'selected' : ''}">
      <input type="radio" name="mh-file" value="${escapeHtml(f.path)}" ${mh.pick === f.path ? 'checked' : ''} ${busy ? 'disabled' : ''} />
      <span class="mh-quant">${escapeHtml(f.quant || f.file)}</span>
      ${f.recommended ? `<span class="mh-rec">${escapeHtml(t('mh.recommended'))}</span>` : ''}
      ${have.has(f.file.toLowerCase()) ? `<span class="mh-have">${icon('check')}${escapeHtml(t('mh.have'))}</span>` : ''}
      <span class="mh-size" dir="ltr">${fmtGB(f.size)}</span>
      <span class="fit-badge fit-${f.fit}">${icon(FIT_ICON[f.fit])}${escapeHtml(t('fit.' + f.fit + 'Short'))}</span>
    </label>`).join('');

  const f = mh.files.find((x) => x.path === mh.pick);
  let action = '';
  const p = mh.progress;
  if (p && p.phase !== 'idle') {
    const pct = p.total ? Math.floor((p.done / p.total) * 100) : 0;
    const eta = p.speed > 0 ? Math.ceil((p.total - p.done) / p.speed / 60) : null;
    const line = p.phase === 'verify'
      ? t('mh.verifying')
      : t('mh.progress', { pct, done: fmtGB(p.done), total: fmtGB(p.total), speed: (p.speed / 1048576).toFixed(1), eta: eta == null ? '…' : eta });
    action = `
      <div class="mh-progress">
        <span class="dl-bar"><span style="width:${pct}%"></span></span>
        <span class="mh-progress-row"><small>${escapeHtml(p.repo === mh.repo ? line : t('mh.busyOther', { file: p.file }))}</small>
          <button class="btn btn-ghost btn-sm" id="mh-cancel">${escapeHtml(t('np.cancel'))}</button></span>
      </div>`;
  } else if (mh.done && mh.done.repo === mh.repo) {
    action = `
      <div class="mh-done">${icon('circle-check')}<span>${escapeHtml(t('mh.downloaded'))}</span>
        <button class="btn btn-primary btn-sm" id="mh-use" data-path="${escapeHtml(mh.done.path)}">${escapeHtml(t('mdl.useDefault'))}</button></div>`;
  } else if (f) {
    action = `
      <button class="btn btn-primary" id="mh-download" ${f.fit === 'toobig' ? 'disabled' : ''}>${icon('download')}
        ${escapeHtml(t('mh.download', { quant: f.quant || f.file, size: fmtGB(f.size) }))}</button>
      ${f.fit !== 'fits' ? `<p class="settings-note fit-note fit-${f.fit}">${icon(FIT_ICON[f.fit])}<span>${escapeHtml(t('fit.' + f.fit))}</span></p>` : ''}`;
  }
  box.innerHTML = `${head}<div class="mh-files">${rows}</div><div class="mh-action">${action}</div>`;
}

async function startHubDownload() {
  const f = mh.files && mh.files.find((x) => x.path === mh.pick);
  if (!f) return;
  const repo = mh.repo;
  mh.progress = { repo, file: f.path, done: 0, total: f.size, speed: 0, phase: 'download' };
  renderDetail();
  const r = await window.api.hubDownload(repo, f);
  mh.progress = null;
  if (r.ok) {
    mh.done = { repo, file: f.path, path: r.path };
    modelFilesCache = null;
    toast(t('mh.doneToast', { file: f.file }), 'success');
    if ($('#view-settings').classList.contains('active')) renderModelsPanel(true);
    if (mh.onDownloaded) mh.onDownloaded(r.path);
  } else if (r.error === 'noSpace') {
    toast(t('mh.noSpace', { gb: r.needGB }), 'error');
  } else if (r.error === 'checksum') {
    toast(t('mh.badChecksum'), 'error');
  } else if (r.error !== 'aborted') {
    toast(t('mh.failed', { msg: r.message || r.error }), 'error');
  }
  renderDetail();
}

// ---- Wiring -----------------------------------------------------------------
let mhTimer;
$('#mh-q').addEventListener('input', (e) => {
  clearTimeout(mhTimer);
  mhTimer = setTimeout(() => runSearch(e.target.value.trim()), 350);
});
$('#mh-chips').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-q]');
  if (b) { $('#mh-q').value = b.dataset.q; runSearch(b.dataset.q); }
});
$('#mh-results').addEventListener('click', (e) => {
  const b = e.target.closest('.mh-result');
  if (b && b.dataset.repo !== mh.repo) loadRepoFiles(b.dataset.repo);
});
$('#mh-detail').addEventListener('change', (e) => {
  if (e.target.name === 'mh-file') { mh.pick = e.target.value; renderDetail(); }
});
$('#mh-detail').addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.id === 'mh-download') startHubDownload();
  else if (b.id === 'mh-cancel') window.api.hubCancel();
  else if (b.id === 'mh-use') {
    await window.api.saveSettings({ provider: 'builtin', model: b.dataset.path });
    toast(t('mdl.defaultSet'), 'success');
    closeModelHub();
    if ($('#view-settings').classList.contains('active')) renderSettings();
  }
});
$('#mh-dest-change').addEventListener('click', async () => {
  const dir = await window.api.hubChooseFolder();
  if (dir) $('#mh-dest').textContent = dir;
});
$('#mh-close').addEventListener('click', closeModelHub);
$('#mh-modal').addEventListener('click', (e) => { if (e.target.id === 'mh-modal') closeModelHub(); });
$('#mh-modal').addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeModelHub(); } });
window.api.onHubProgress((p) => {
  mh.progress = p.phase === 'idle' ? null : p;
  if ($('#mh-modal').classList.contains('open')) renderDetail();
});
$('#models-find').addEventListener('click', () => openModelHub());

window.openModelHub = openModelHub;
