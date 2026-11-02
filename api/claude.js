// @ts-check
// POST /api/claude – the app's only door to the AI. The provider is chosen with
// AI_PROVIDER=openai|gemini|anthropic (default anthropic); the response always has the
// Claude format. The API key never leaves the server. Only the fields the app needs are passed on, and the model and
// limits are set here, so a leaked login can't be used for anything else.

import { clientIp, isLoggedIn, jsonError } from './_lib/auth.js';
import { take } from './_lib/ratelimit.js';

const PROVIDERS = {
  anthropic: { name: 'Claude', file: './_lib/anthropic.js' },
  openai: { name: 'OpenAI', file: './_lib/openai.js' },
  gemini: { name: 'Gemini', file: './_lib/gemini.js' },
};
/** @type {Record<string, any>} */
const loaded = {};
async function getProvider(/** @type {string} */ id) {
  // Static strings so the bundler can find each file.
  return (loaded[id] ??= await (id === 'openai' ? import('./_lib/openai.js') : id === 'gemini' ? import('./_lib/gemini.js') : import('./_lib/anthropic.js')));
}

export const config = { maxDuration: 300 };

const num = (/** @type {string|undefined} */ v, /** @type {number} */ d) => (v && /^\d+$/.test(v) ? Number(v) : d);
const APP_TOOLS = new Set(['edit_plan', 'pick_fonts', 'check_result']);
const CONTENT_TYPES = new Set(['text', 'image', 'tool_use', 'tool_result']);

/** @param {Request} request */
export async function POST(request) {
  if (!(await isLoggedIn(request))) return jsonError(401, 'Du är utloggad. Ladda om sidan och logga in igen.');
  const providerId = (process.env.AI_PROVIDER || 'anthropic').toLowerCase();
  if (!(providerId in PROVIDERS)) return jsonError(500, 'AI-tjänsten är felaktigt inställd (AI_PROVIDER). Säg till Hamza.');
  const label = /** @type {any} */ (PROVIDERS)[providerId].name;
  /** @type {any} */
  let provider;
  try { provider = await getProvider(providerId); } catch { return jsonError(500, `${label} är inte installerat i den här versionen. Säg till Hamza.`); }
  if (!provider.available()) return jsonError(500, 'AI-tjänsten är inte inställd ännu (API-nyckel saknas). Säg till Hamza.');
  const ip = clientIp(request);
  if (!take(`claude:${ip}`, num(process.env.RATE_LIMIT_PER_10_MIN, 60), 10 * 60_000).ok) return jsonError(429, 'Många ändringar på kort tid. Vänta några minuter och försök igen.');
  if (!take('claude:day', num(process.env.RATE_LIMIT_PER_DAY, 400), 24 * 3600_000).ok) return jsonError(429, 'Dagens gräns för ändringar är nådd. Försök igen i morgon.');
  /** @type {any} */
  let body;
  try { body = await request.json(); } catch { return jsonError(400, 'Felaktig förfrågan.'); }
  if (!Array.isArray(body?.messages) || body.messages.length > 6) return jsonError(400, 'Felaktig förfrågan.');
  if (JSON.stringify(body).length > 12_000_000) return jsonError(413, 'Bilderna är för stora.');
  // Only the app's own three steps may be called: exactly one of its tools, plain user/assistant turns
  // with text and images. This keeps the route from working as a general-purpose Claude API.
  const tools = body.tools;
  if (!Array.isArray(tools) || tools.length !== 1 || !APP_TOOLS.has(tools[0]?.name)) return jsonError(400, 'Felaktig förfrågan.');
  if (body.system !== undefined && (typeof body.system !== 'string' || body.system.length > 20_000 || tools[0].name !== 'edit_plan')) return jsonError(400, 'Felaktig förfrågan.');
  for (const m of body.messages) {
    if (!m || !['user', 'assistant'].includes(m.role)) return jsonError(400, 'Felaktig förfrågan.');
    const parts = typeof m.content === 'string' ? [] : m.content;
    if (!Array.isArray(parts) && typeof m.content !== 'string') return jsonError(400, 'Felaktig förfrågan.');
    if (parts.some((/** @type {any} */ p) => !p || !CONTENT_TYPES.has(p.type))) return jsonError(400, 'Felaktig förfrågan.');
  }
  const effort = ['low', 'medium', 'high'].includes(body?.output_config?.effort) ? body.output_config.effort : undefined;
  const req = {
    max_tokens: Math.min(32000, num(String(body.max_tokens ?? ''), 8000)),
    ...(typeof body.system === 'string' ? { system: body.system } : {}),
    messages: body.messages,
    tools: body.tools,
    ...(body.tool_choice ? { tool_choice: body.tool_choice } : {}),
    ...(effort ? { output_config: { effort } } : {}),
  };
  // The client's model id only says "hard" (opus) or "easy"; each provider maps that to its own model.
  const hard = typeof body.model === 'string' ? body.model.includes('opus') : true;
  try {
    const msg = await provider.complete(req, { hard });
    if (process.env.LOG_USAGE) console.log(`[${providerId}] ${hard ? 'hard' : 'easy'} ${req.tools[0].name} in=${msg.usage?.input_tokens} out=${msg.usage?.output_tokens}`);
    return Response.json(msg, { headers: { 'cache-control': 'no-store' } });
  } catch (e) {
    const status = /** @type {any} */ (e)?.status;
    if (status === 401) return jsonError(500, 'API-nyckeln fungerar inte. Säg till Hamza.');
    if (status === 429 || status === 529) return jsonError(503, `${label} är överbelastad just nu. Vänta en minut och försök igen.`);
    if (status === 400) return jsonError(400, `${label} kunde inte läsa förfrågan. Försök igen eller beskriv ändringen på ett annat sätt.`);
    return jsonError(502, `Kunde inte nå ${label}. Kontrollera internet och försök igen.`);
  }
}
