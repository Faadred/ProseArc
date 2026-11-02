// Providers ProseArc can translate with — one list used by the engine (where
// to send requests) and the UI (cards, panels, pickers). AI models only:
// classic translators (DeepL, Google Translate…) can't follow the glossary,
// style brief or story context.
//
// kind: 'builtin' (ProseArc's own llama.cpp), 'local' (an app on this PC),
// 'cloud' (needs an API key). Settings for each live in the encrypted secrets
// file: `<id>` = API key, `<id>BaseUrl` = address (local apps, custom).

const PROVIDERS = [
  { id: 'builtin', name: 'ProseArc built-in', kind: 'builtin', icon: 'sparkles' },
  { id: 'lmstudio', name: 'LM Studio', kind: 'local', baseUrl: 'http://localhost:1234/v1', site: 'https://lmstudio.ai', noKey: true },
  { id: 'ollama', name: 'Ollama', kind: 'local', baseUrl: 'http://localhost:11434/v1', site: 'https://ollama.com', noKey: true },
  { id: 'openai', name: 'OpenAI', kind: 'cloud', letters: 'AI', baseUrl: 'https://api.openai.com/v1', keyUrl: 'https://platform.openai.com/api-keys' },
  { id: 'anthropic', name: 'Claude (Anthropic)', kind: 'cloud', baseUrl: 'https://api.anthropic.com/v1', keyUrl: 'https://console.anthropic.com/settings/keys', native: 'anthropic' },
  { id: 'gemini', name: 'Google Gemini', kind: 'cloud', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', keyUrl: 'https://aistudio.google.com/apikey' },
  { id: 'openrouter', name: 'OpenRouter', kind: 'cloud', baseUrl: 'https://openrouter.ai/api/v1', keyUrl: 'https://openrouter.ai/keys' },
  { id: 'groq', name: 'Groq', kind: 'cloud', letters: 'Gq', baseUrl: 'https://api.groq.com/openai/v1', keyUrl: 'https://console.groq.com/keys' },
  { id: 'deepseek', name: 'DeepSeek', kind: 'cloud', baseUrl: 'https://api.deepseek.com/v1', keyUrl: 'https://platform.deepseek.com/api_keys' },
  { id: 'huggingface', name: 'Hugging Face', kind: 'cloud', baseUrl: 'https://router.huggingface.co/v1', keyUrl: 'https://huggingface.co/settings/tokens' },
  { id: 'compatible', name: 'Custom (OpenAI-compatible)', kind: 'custom', icon: 'sliders-horizontal', optionalKey: true },
];

const byId = Object.fromEntries(PROVIDERS.map((p) => [p.id, p]));

// Every secrets-file key the providers use (API keys + addresses).
const SECRET_FIELDS = [
  ...PROVIDERS.filter((p) => p.kind === 'cloud' || p.kind === 'custom').map((p) => p.id),
  ...PROVIDERS.filter((p) => p.kind === 'local' || p.kind === 'custom').map((p) => `${p.id}BaseUrl`),
];

/** Base URL for a provider (user's address for local apps/custom, else the fixed one). */
function baseUrlFor(id, secrets = {}) {
  const p = byId[id];
  if (!p) return '';
  const own = (secrets[`${id}BaseUrl`] || '').trim();
  return (own || p.baseUrl || '').replace(/\/+$/, '');
}

/** Is the provider set up (enough to try translating)? Local apps: an address is enough. */
function isConfigured(id, secrets = {}) {
  const p = byId[id];
  if (!p) return false;
  if (p.kind === 'cloud') return !!(secrets[id] || '').trim();
  if (p.kind === 'custom') return !!(secrets.compatibleBaseUrl || '').trim();
  return true;
}

module.exports = { PROVIDERS, byId, SECRET_FIELDS, baseUrlFor, isConfigured };
