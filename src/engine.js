// Translation engine — runs in the main process.
//
// Walks a project's `pending` segments one at a time, calls the local
// OpenAI-compatible server, and after each segment re-reads the project from
// disk and saves atomically. Each request has a timeout and auto-retries a few
// times so one stalled call can't freeze a long overnight run.
//
// Events are emitted as semantic { key, params } (not finished prose) so the
// renderer can render them in the user's chosen UI language.

const { buildMessages } = require('./prompt');

const REQUEST_TIMEOUT_MS = 120000; // give up on a single request after 2 min
const MAX_RETRIES = 2;             // ...then retry up to twice
const RETRY_BACKOFF_MS = 1500;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Reasoning ("thinking") models may put their reasoning inline before the
// answer. Keep only the answer: drop <think>…</think> / <thinking>…</thinking>
// blocks, and anything before a lone closing tag (opening tag cut off).
function stripThinking(text) {
  if (!text) return text;
  let s = String(text).replace(/<(think|thinking)>[\s\S]*?<\/\1>/gi, '');
  const lone = s.search(/<\/(think|thinking)>/i);
  if (lone !== -1) s = s.slice(s.indexOf('>', lone) + 1);
  return s.trim();
}

function createEngine({ store, builtin }) {
  let running = false;
  let aborted = false;
  let controller = null;   // AbortController for the in-flight request
  let emit = () => {};
  let activeSecrets = {};   // cloud API keys, loaded once per run
  // Local servers that rejected the "no thinking" switch; we stop sending it there.
  const noReasoningParam = new Set();

  // Turn a project + messages into a provider-specific HTTP request.
  // Most providers speak the OpenAI chat-completions shape; Anthropic is native.
  function resolveRequest(project, messages) {
    const provider = project.provider || 'local';
    const model = (project.model || '').trim();
    const s = activeSecrets || {};

    if (provider === 'anthropic') {
      const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
      const rest = messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role, content: m.content }));
      return {
        url: 'https://api.anthropic.com/v1/messages',
        headers: { 'Content-Type': 'application/json', 'x-api-key': s.anthropic || '', 'anthropic-version': '2023-06-01' },
        body: { model: model || 'claude-3-5-sonnet-latest', max_tokens: 4096, temperature: 0.3, ...(system ? { system } : {}), messages: rest },
        shape: 'anthropic',
        missingKey: !s.anthropic,
      };
    }

    const headers = { 'Content-Type': 'application/json' };
    let url;
    let missingKey = false;
    if (provider === 'openai') { url = 'https://api.openai.com/v1/chat/completions'; headers.Authorization = `Bearer ${s.openai || ''}`; missingKey = !s.openai; }
    else if (provider === 'openrouter') { url = 'https://openrouter.ai/api/v1/chat/completions'; headers.Authorization = `Bearer ${s.openrouter || ''}`; missingKey = !s.openrouter; }
    else if (provider === 'gemini') { url = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'; headers.Authorization = `Bearer ${s.gemini || ''}`; missingKey = !s.gemini; }
    else if (provider === 'compatible') { url = `${(s.compatibleBaseUrl || '').replace(/\/+$/, '')}/chat/completions`; if (s.compatible) headers.Authorization = `Bearer ${s.compatible}`; missingKey = !s.compatibleBaseUrl; }
    else if (provider === 'builtin') { url = builtin ? builtin.url() : ''; } // ProseArc's own llama-server
    else { url = project.apiUrl; } // local

    const body = { model: model || 'local-model', messages, temperature: 0.3, stream: false };
    // Thinking models spend most of their time reasoning before each passage,
    // which plain translation rarely needs. Off by default for local models
    // (LM Studio honours reasoning_effort "none"); the project can turn it on.
    if (provider === 'local' && !project.thinking && !noReasoningParam.has(url)) body.reasoning_effort = 'none';

    return {
      url,
      headers,
      body,
      shape: 'openai',
      missingKey,
    };
  }

  /** One translation request. Throws tagged errors for the retry/friendly layers. */
  async function translateOne(project, index, signal, globalGlossary) {
    const messages = buildMessages(project, index, globalGlossary);
    const req = resolveRequest(project, messages);
    if (req.missingKey) {
      const err = new Error('no api key'); err.noKey = true; throw err;
    }

    let res = await fetch(req.url, {
      method: 'POST',
      headers: req.headers,
      body: JSON.stringify(req.body),
      signal,
    });
    // A server that doesn't know the "no thinking" switch may answer 400:
    // retry once without it, and don't send it to that server again.
    if (res.status === 400 && req.body.reasoning_effort) {
      noReasoningParam.add(req.url);
      delete req.body.reasoning_effort;
      res = await fetch(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(req.body), signal });
    }

    if (!res.ok) {
      let detail = '';
      try { detail = (await res.text()).slice(0, 300); } catch { /* ignore */ }
      const err = new Error(`HTTP ${res.status}`);
      err.httpStatus = res.status;
      err.detail = detail;
      throw err;
    }

    const json = await res.json();
    const raw = req.shape === 'anthropic'
      ? (Array.isArray(json?.content) ? json.content.filter((b) => b.type === 'text').map((b) => b.text).join('') : '')
      : json?.choices?.[0]?.message?.content;
    const content = stripThinking(raw);
    if (!content || !content.trim()) {
      const err = new Error('empty');
      err.empty = true;
      throw err;
    }
    return content.trim();
  }

  function isRetryable(err) {
    if (err.noKey) return false; // config problem, not transient
    if (err.timeout) return true;
    if (err.httpStatus) return err.httpStatus >= 500 || err.httpStatus === 429;
    return true; // network-level (server warming up, transient blip)
  }
  function reasonOf(err) {
    if (err.timeout) return 'timeout';
    if (err.httpStatus) return `HTTP ${err.httpStatus}`;
    return 'no-connection';
  }

  /** Run one segment with timeout + retries. Honors user stop via `aborted`. */
  async function translateWithRetry(project, index, globalGlossary) {
    let lastErr;
    for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
      if (aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }

      const ac = new AbortController();
      controller = ac;                 // so stop() aborts this attempt
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; ac.abort(); }, REQUEST_TIMEOUT_MS);

      try {
        const translation = await translateOne(project, index, ac.signal, globalGlossary);
        clearTimeout(timer);
        return translation;
      } catch (err) {
        clearTimeout(timer);
        if (aborted && !timedOut) throw err;            // genuine user stop
        if (timedOut) err = Object.assign(new Error('timeout'), { timeout: true });
        lastErr = err;
        if (attempt <= MAX_RETRIES && isRetryable(err)) {
          emit({ type: 'log', level: 'info', key: 'retry', params: { n: index + 1, attempt, reason: reasonOf(err) } });
          await delay(RETRY_BACKOFF_MS * attempt);
          continue;
        }
        throw err;
      }
    }
    throw lastErr;
  }

  /** Map a raw error to a { key, params } the renderer can translate. */
  function friendlyError(err) {
    const code = err && err.cause && err.cause.code;
    if (err.noKey) return { key: 'noKey', params: {} };
    if (err.builtin) return { key: `builtin.${err.builtin}`, params: {} };
    if (err.timeout) return { key: 'timeout', params: { sec: Math.round(REQUEST_TIMEOUT_MS / 1000) } };
    if (code === 'ECONNREFUSED' || /fetch failed/i.test(err.message)) return { key: 'unreachable', params: {} };
    if (err.httpStatus === 404) return { key: 'http404', params: {} };
    if (err.httpStatus) return { key: 'http', params: { status: err.httpStatus, detail: err.detail || '' } };
    if (err.empty) return { key: 'empty', params: {} };
    return { key: 'generic', params: { msg: err.message } };
  }

  const counts = (project) => store.countStatuses(project.segments);

  // The built-in translator runs as its own program; start it (or switch its
  // model) before the first request. Other providers need nothing here.
  async function prepare(project, log = emit) {
    if ((project.provider || 'local') !== 'builtin') return;
    if (!builtin) { const e = new Error('no builtin'); e.builtin = 'noEngine'; throw e; }
    const st = builtin.status();
    if (!(st.status === 'ready' && st.model === project.model)) {
      const name = String(project.model || '').split(/[\\/]/).pop();
      log({ type: 'log', level: 'info', key: 'builtinStarting', params: { model: name } });
    }
    const t0 = Date.now();
    await builtin.ensure({ model: project.model, thinking: !!project.thinking });
    if (Date.now() - t0 > 500) log({ type: 'log', level: 'success', key: 'builtinReady', params: { sec: Math.round((Date.now() - t0) / 1000) } });
  }

  async function start(projectId, sender) {
    if (running) return;
    running = true;
    aborted = false;
    emit = (payload) => { try { sender.send('engine:event', payload); } catch { /* gone */ } };

    let project;
    try { project = await store.getProject(projectId); }
    catch { emit({ type: 'error', key: 'projectOpen', params: {} }); running = false; return; }

    const total = project.segments.length;
    const globalGlossary = await store.getGlobalGlossary();
    activeSecrets = await store.getSecrets();
    emit({ type: 'started' });
    emit({ type: 'progress', counts: counts(project) });
    try { await prepare(project); }
    catch (err) { emit({ type: 'error', ...friendlyError(err) }); running = false; return; }

    // Large games have tens of thousands of segments, so we work on one
    // in-memory copy and persist in batches rather than re-reading/writing the
    // whole file every segment.
    const SAVE_EVERY = 25;
    let sinceSave = 0;
    const persist = async () => {
      if (sinceSave === 0) return;
      // Merge our translations onto the on-disk project, but never overwrite a
      // segment the user changed in Review (only fill ones still pending there).
      const disk = await store.getProject(projectId);
      for (const s of project.segments) {
        if (s.status === 'pending') continue;
        const d = disk.segments[s.id];
        if (d && d.status === 'pending') { d.translation = s.translation; d.status = s.status; }
      }
      await store.saveProject(disk);
      sinceSave = 0;
    };

    while (!aborted) {
      const index = project.segments.findIndex((s) => s.status === 'pending');
      if (index === -1) { await persist(); emit({ type: 'done', reason: 'completed', counts: counts(project) }); break; }

      emit({ type: 'log', level: 'info', key: 'translating', params: { n: index + 1, total } });

      let translation;
      try {
        translation = await translateWithRetry(project, index, globalGlossary);
      } catch (err) {
        await persist();
        if (aborted || err.name === 'AbortError') { emit({ type: 'done', reason: 'stopped', counts: counts(project) }); break; }
        emit({ type: 'error', ...friendlyError(err) });
        break;
      }
      if (aborted) { await persist(); emit({ type: 'done', reason: 'stopped', counts: counts(project) }); break; }

      // Apply to this segment AND every identical still-pending one (dedup).
      const src = project.segments[index].original;
      for (const seg of project.segments) {
        if (seg.status === 'pending' && seg.original === src) {
          seg.translation = translation;
          seg.status = 'translated';
        }
      }
      emit({ type: 'segment', id: project.segments[index].id, index, translation, status: 'translated' });
      emit({ type: 'progress', counts: counts(project) });
      sinceSave += 1;
      if (sinceSave >= SAVE_EVERY) await persist();
    }

    running = false;
    controller = null;
  }

  async function retranslateSegment(projectId, segmentId, sender) {
    if (running) return;
    running = true;
    aborted = false;
    emit = (payload) => { try { sender.send('engine:event', payload); } catch { /* gone */ } };

    let project;
    try { project = await store.getProject(projectId); }
    catch { emit({ type: 'error', key: 'projectOpen', params: {} }); running = false; return; }

    const index = project.segments.findIndex((s) => s.id === segmentId);
    if (index === -1) { emit({ type: 'error', key: 'segNotFound', params: {} }); running = false; return; }

    const globalGlossary = await store.getGlobalGlossary();
    activeSecrets = await store.getSecrets();
    emit({ type: 'started', mode: 'single' });
    try { await prepare(project); }
    catch (err) { emit({ type: 'error', ...friendlyError(err) }); running = false; return; }
    emit({ type: 'log', level: 'info', key: 'retranslating', params: { n: index + 1 } });

    let translation;
    try {
      translation = await translateWithRetry(project, index, globalGlossary);
    } catch (err) {
      if (aborted || err.name === 'AbortError') emit({ type: 'done', reason: 'stopped', counts: counts(project) });
      else emit({ type: 'error', ...friendlyError(err) });
      running = false; controller = null; return;
    }

    const fresh = await store.getProject(projectId);
    if (fresh.segments[index]) {
      fresh.segments[index].translation = translation;
      fresh.segments[index].status = 'translated';
      await store.saveProject(fresh);
      emit({ type: 'segment', id: segmentId, index, translation, status: 'translated' });
    }
    emit({ type: 'progress', counts: counts(fresh) });
    emit({ type: 'done', reason: 'completed', counts: counts(fresh) });
    running = false; controller = null;
  }

  function stop() {
    if (!running) return;
    aborted = true;
    if (controller) controller.abort();
  }

  /** Quick reachability check against the OpenAI-compatible /v1/models endpoint. */
  async function testConnection(apiUrl) {
    const url = (apiUrl || '').trim();
    if (!url) return { ok: false, code: 'noUrl', params: {} };
    const modelsUrl = url.replace(/\/chat\/completions\/?$/, '/models');
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 8000);
    try {
      const res = await fetch(modelsUrl, { signal: ac.signal });
      clearTimeout(timer);
      if (!res.ok) return { ok: false, code: 'http', params: { status: res.status } };
      const json = await res.json().catch(() => null);
      const ids = json && Array.isArray(json.data) ? json.data.map((m) => m.id) : [];
      if (ids.length === 0) return { ok: true, code: 'noModel', params: {}, models: [] };
      const list = ids.slice(0, 3).join(', ') + (ids.length > 3 ? '…' : '');
      return { ok: true, code: 'connected', params: { count: ids.length, list }, models: ids };
    } catch (err) {
      clearTimeout(timer);
      const code = err && err.cause && err.cause.code;
      if (code === 'ECONNREFUSED' || /abort/i.test(err.name || '') || /fetch failed/i.test(err.message || '')) {
        return { ok: false, code: 'unreachable', params: {} };
      }
      return { ok: false, code: 'failed', params: { msg: err.message } };
    }
  }

  /**
   * Translate one sample sentence with the given settings (Setup's quick test).
   * cfg: { provider, apiUrl, model, thinking, sourceLang, targetLang, text }
   * → { ok: true, text, ms } or { ok: false, key, params }
   */
  async function sampleTranslate(cfg) {
    activeSecrets = await store.getSecrets();
    const project = {
      provider: cfg.provider || 'local', apiUrl: cfg.apiUrl, model: cfg.model || '', thinking: !!cfg.thinking,
      sourceLang: cfg.sourceLang || 'English', targetLang: cfg.targetLang || 'Arabic',
      contextWindow: 0, glossary: [],
      segments: [{ id: 0, type: 'paragraph', original: cfg.text, translation: '', status: 'pending' }],
    };
    try { await prepare(project, () => {}); }
    catch (err) { return { ok: false, ...friendlyError(err) }; }
    const ac = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ac.abort(); }, REQUEST_TIMEOUT_MS);
    const t0 = Date.now();
    try {
      const text = await translateOne(project, 0, ac.signal, []);
      return { ok: true, text, ms: Date.now() - t0 };
    } catch (err) {
      if (timedOut) err.timeout = true;
      return { ok: false, ...friendlyError(err) };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * List a cloud provider's models with the given key (for suggestions in Setup).
   * cfg: { provider, key, baseUrl } → { ok: true, models: [ids] } or { ok: false, status }
   */
  async function listModels(cfg) {
    const key = (cfg.key || '').trim();
    const urls = {
      openai: 'https://api.openai.com/v1/models',
      openrouter: 'https://openrouter.ai/api/v1/models',
      gemini: 'https://generativelanguage.googleapis.com/v1beta/openai/models',
      anthropic: 'https://api.anthropic.com/v1/models?limit=100',
      compatible: `${(cfg.baseUrl || '').replace(/\/+$/, '')}/models`,
    };
    const url = urls[cfg.provider];
    if (!url || (cfg.provider === 'compatible' && !cfg.baseUrl)) return { ok: false, status: 0 };
    const headers = cfg.provider === 'anthropic'
      ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
      : (key ? { Authorization: `Bearer ${key}` } : {});
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 10000);
    try {
      const res = await fetch(url, { headers, signal: ac.signal });
      if (!res.ok) return { ok: false, status: res.status };
      const json = await res.json();
      const ids = (Array.isArray(json.data) ? json.data : []).map((m) => String(m.id || '').replace(/^models\//, '')).filter(Boolean);
      return { ok: true, models: ids };
    } catch {
      return { ok: false, status: 0 };
    } finally {
      clearTimeout(timer);
    }
  }

  return { start, stop, retranslateSegment, testConnection, sampleTranslate, listModels, isRunning: () => running };
}

module.exports = { createEngine };
