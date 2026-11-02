// Find AI apps already running on this PC that ProseArc can use: LM Studio and
// Ollama. Both speak the OpenAI chat-completions API on localhost. Each probe
// is quick (short timeout) so the Setup screen never hangs on a closed app.

const PROBE_MS = 2500;

async function getJson(url) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), PROBE_MS);
  try {
    const res = await fetch(url, { signal: ac.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Embedding and speech models can't translate; leave them out of the list.
const NOT_CHAT = /embed|whisper|tts|rerank|clip/i;

async function probeLmStudio() {
  const base = 'http://localhost:1234';
  const server = { id: 'lmstudio', name: 'LM Studio', url: `${base}/v1/chat/completions`, site: 'https://lmstudio.ai', running: false, models: [] };
  // LM Studio's own API says which models are loaded; fall back to the OpenAI list.
  const v0 = await getJson(`${base}/api/v0/models`);
  if (v0 && Array.isArray(v0.data)) {
    server.running = true;
    server.models = v0.data
      .filter((m) => (m.type === 'llm' || m.type === 'vlm') && !NOT_CHAT.test(m.id))
      .map((m) => ({ id: m.id, loaded: m.state === 'loaded' }));
  } else {
    const v1 = await getJson(`${base}/v1/models`);
    if (v1 && Array.isArray(v1.data)) {
      server.running = true;
      server.models = v1.data.filter((m) => !NOT_CHAT.test(m.id)).map((m) => ({ id: m.id, loaded: false }));
    }
  }
  return server;
}

async function probeOllama() {
  const base = 'http://localhost:11434';
  const server = { id: 'ollama', name: 'Ollama', url: `${base}/v1/chat/completions`, site: 'https://ollama.com', running: false, models: [] };
  const tags = await getJson(`${base}/api/tags`);
  if (tags && Array.isArray(tags.models)) {
    server.running = true;
    const ps = await getJson(`${base}/api/ps`);
    const loaded = new Set(((ps && ps.models) || []).map((m) => m.name));
    server.models = tags.models
      .filter((m) => !NOT_CHAT.test(m.name))
      .map((m) => ({ id: m.name, loaded: loaded.has(m.name) }));
  }
  return server;
}

/** [{ id, name, url, site, running, models: [{ id, loaded }] }] */
async function detectLocalServers() {
  return Promise.all([probeLmStudio(), probeOllama()]);
}

module.exports = { detectLocalServers };
