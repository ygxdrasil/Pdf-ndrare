// @ts-check
// Leverantör: Google Gemini. Översätter appens Claude-format till generateContent (med funktionsanrop)
// och tillbaka till { content:[{type:'tool_use',name,input}], stop_reason, usage }.
// Nyckeln skickas i headern x-goog-api-key och lämnar aldrig servern.

export const available = () => !!process.env.GEMINI_API_KEY;

const MODEL_HARD = () => process.env.GEMINI_MODEL_HARD || 'gemini-3.1-pro-preview';
const MODEL_EASY = () => process.env.GEMINI_MODEL_EASY || 'gemini-3.8-flash';

/** Gemini 3 kräver en tanke-signatur på funktionsanrop i historiken; det här är det dokumenterade värdet för anrop som inte kom från modellen. */
const SKIP_SIGNATURE = 'skip_thought_signature_validator';

/** @param {any} p */
function convertPart(p) {
  if (p.type === 'text') return { text: String(p.text ?? '') };
  if (p.type === 'image') return { inlineData: { mimeType: String(p.source?.media_type ?? 'image/jpeg'), data: String(p.source?.data ?? '') } };
  return null;
}

/** App-meddelanden -> Gemini-innehåll. */
function convertContents(/** @type {any[]} */ messages) {
  /** @type {any[]} */
  const out = [];
  /** @type {Record<string, string>} */
  const callNames = {};
  for (const m of messages) {
    const role = m.role === 'assistant' ? 'model' : 'user';
    if (typeof m.content === 'string') { out.push({ role, parts: [{ text: m.content }] }); continue; }
    /** @type {any[]} */
    const parts = [];
    for (const p of m.content) {
      if (p.type === 'tool_use') {
        callNames[p.id] = p.name;
        parts.push({ functionCall: { name: p.name, args: p.input ?? {} }, thoughtSignature: SKIP_SIGNATURE });
      } else if (p.type === 'tool_result') {
        const text = typeof p.content === 'string' ? p.content : JSON.stringify(p.content ?? '');
        parts.push({ functionResponse: { name: callNames[p.tool_use_id] ?? 'tool', response: { result: text } } });
      } else { const c = convertPart(p); if (c) parts.push(c); }
    }
    if (parts.length) out.push({ role: m.role === 'assistant' ? 'model' : 'user', parts });
  }
  return out;
}

/** @param {any} tc */
function convertToolConfig(tc, /** @type {string} */ toolName) {
  if (tc && (tc.type === 'any' || tc.type === 'tool')) return { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [tc.name || toolName] } };
  return { functionCallingConfig: { mode: 'AUTO' } };
}

/** @param {any} req  @param {{hard:boolean}} opts */
export async function complete(req, opts) {
  const tool = req.tools?.[0];
  const model = opts.hard ? MODEL_HARD() : MODEL_EASY();
  const effort = req.output_config?.effort;
  const body = {
    ...(req.system ? { systemInstruction: { parts: [{ text: req.system }] } } : {}),
    contents: convertContents(req.messages),
    // parametersJsonSchema tar emot appens JSON-schema som den är (utan att den görs om till Googles egen schema-dialekt).
    tools: [{ functionDeclarations: [{ name: tool.name, description: tool.description, parametersJsonSchema: tool.input_schema }] }],
    toolConfig: convertToolConfig(req.tool_choice, tool.name),
    generationConfig: {
      maxOutputTokens: req.max_tokens,
      ...(effort && process.env.GEMINI_THINKING !== 'off' ? { thinkingConfig: { thinkingLevel: effort === 'low' ? 'low' : 'high' } } : {}),
    },
  };
  let res;
  for (let attempt = 0; ; attempt++) {
    res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': String(process.env.GEMINI_API_KEY) },
      body: JSON.stringify(body),
    });
    if (res.ok || attempt >= 2 || ![500, 502, 503, 529].includes(res.status)) break;
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    console.error(`[gemini] ${res.status} ${detail.slice(0, 500)}`);
    // Google svarar 400 (inte 401) på en ogiltig nyckel och 403 på en nyckel utan behörighet
    const badKey = res.status === 403 || (res.status === 400 && /API key|API_KEY/i.test(detail));
    throw Object.assign(new Error('Gemini-fel'), { status: badKey ? 401 : res.status === 503 ? 529 : res.status });
  }
  /** @type {any} */
  const j = await res.json();
  if (j.promptFeedback?.blockReason) throw Object.assign(new Error('Blockerad'), { status: 400 });
  const cand = j.candidates?.[0];
  /** @type {any[]} */
  const content = [];
  let n = 0;
  for (const p of cand?.content?.parts ?? []) {
    if (p.thought) continue; // modellens egna tankar visas inte
    if (typeof p.text === 'string' && p.text) content.push({ type: 'text', text: p.text });
    else if (p.functionCall) content.push({ type: 'tool_use', id: `call_${Date.now().toString(36)}_${n++}`, name: p.functionCall.name, input: p.functionCall.args ?? {} });
  }
  const fr = cand?.finishReason;
  return {
    id: j.responseId ?? `gemini_${Date.now().toString(36)}`, type: 'message', role: 'assistant', model: j.modelVersion ?? model, content,
    stop_reason: fr === 'MAX_TOKENS' ? 'max_tokens' : content.some((c) => c.type === 'tool_use') ? 'tool_use' : 'end_turn',
    usage: { input_tokens: j.usageMetadata?.promptTokenCount ?? 0, output_tokens: (j.usageMetadata?.candidatesTokenCount ?? 0) + (j.usageMetadata?.thoughtsTokenCount ?? 0) },
  };
}
