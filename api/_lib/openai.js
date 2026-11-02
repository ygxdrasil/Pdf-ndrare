// @ts-check
// Leverantör: OpenAI. Översätter appens Claude-format till Chat Completions (med verktygsanrop)
// och tillbaka till { content:[{type:'tool_use',name,input}], stop_reason, usage }.

export const available = () => !!process.env.OPENAI_API_KEY;

const MODEL_HARD = () => process.env.OPENAI_MODEL_HARD || 'gpt-5.5';
const MODEL_EASY = () => process.env.OPENAI_MODEL_EASY || 'gpt-5.5-mini';

/** @param {any} p */
function convertPart(p) {
  if (p.type === 'text') return { type: 'text', text: String(p.text ?? '') };
  if (p.type === 'image') return { type: 'image_url', image_url: { url: `data:${p.source?.media_type};base64,${p.source?.data}` } };
  return null;
}

/** App-meddelanden -> OpenAI-meddelanden. */
function convertMessages(/** @type {any[]} */ messages, /** @type {string|undefined} */ system) {
  /** @type {any[]} */
  const out = [];
  if (system) out.push({ role: 'system', content: system });
  for (const m of messages) {
    if (typeof m.content === 'string') { out.push({ role: m.role, content: m.content }); continue; }
    const text = [], calls = [];
    for (const p of m.content) {
      if (p.type === 'tool_use') calls.push({ id: p.id, type: 'function', function: { name: p.name, arguments: JSON.stringify(p.input ?? {}) } });
      else if (p.type === 'tool_result') out.push({ role: 'tool', tool_call_id: p.tool_use_id, content: typeof p.content === 'string' ? p.content : JSON.stringify(p.content ?? '') });
      else { const c = convertPart(p); if (c) text.push(c); }
    }
    if (m.role === 'assistant') out.push({ role: 'assistant', content: text.filter((t) => t.type === 'text').map((t) => t.text).join('\n') || null, ...(calls.length ? { tool_calls: calls } : {}) });
    else if (text.length) out.push({ role: 'user', content: text });
  }
  return out;
}

/** @param {any} tc */
function convertToolChoice(tc, /** @type {string} */ toolName) {
  if (!tc || tc.type === 'auto') return 'auto';
  if (tc.type === 'any' || tc.type === 'tool') return { type: 'function', function: { name: tc.name || toolName } };
  return 'auto';
}

/** @param {any} req  @param {{hard:boolean}} opts */
export async function complete(req, opts) {
  const tool = req.tools?.[0];
  const body = {
    model: opts.hard ? MODEL_HARD() : MODEL_EASY(),
    max_completion_tokens: req.max_tokens,
    messages: convertMessages(req.messages, req.system),
    tools: [{ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.input_schema } }],
    tool_choice: convertToolChoice(req.tool_choice, tool.name),
    ...(req.output_config?.effort && process.env.OPENAI_REASONING !== 'off' ? { reasoning_effort: req.output_config.effort } : {}),
  };
  let res;
  for (let attempt = 0; ; attempt++) {
    res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify(body),
    });
    if (res.ok || attempt >= 2 || ![500, 502, 503, 529].includes(res.status)) break;
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    console.error(`[openai] ${res.status} ${detail.slice(0, 500)}`);
    throw Object.assign(new Error('OpenAI-fel'), { status: res.status });
  }
  /** @type {any} */
  const j = await res.json();
  const choice = j.choices?.[0];
  /** @type {any[]} */
  const content = [];
  if (choice?.message?.content) content.push({ type: 'text', text: choice.message.content });
  for (const c of choice?.message?.tool_calls ?? []) {
    let input = {};
    try { input = JSON.parse(c.function.arguments || '{}'); } catch { throw Object.assign(new Error('Ogiltigt verktygssvar'), { status: 502 }); }
    content.push({ type: 'tool_use', id: c.id, name: c.function.name, input });
  }
  const fr = choice?.finish_reason;
  return {
    id: j.id, type: 'message', role: 'assistant', model: j.model, content,
    stop_reason: fr === 'length' ? 'max_tokens' : content.some((c) => c.type === 'tool_use') ? 'tool_use' : 'end_turn',
    usage: { input_tokens: j.usage?.prompt_tokens ?? 0, output_tokens: j.usage?.completion_tokens ?? 0 },
  };
}
