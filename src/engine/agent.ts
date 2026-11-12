// Claude's part: read the page + Elin's request -> an edit plan; pick the font
// that looks most like the original; check the result and correct it.
// The heavy pixel work stays in the engine (fast, predictable).

import type { Box, Raster } from './raster';
import { applyEditsRot } from './rotate';
import { applyEdits, Applied, Edit, OcrLine, TextEdit, rasterizeInto, resolveLine, similar, inkExtent, snapElement, textRows } from './edit';
import type { TextItem } from './pdf';
import { FontLib, drawText } from './fonts';
import { matchFont } from './match';
import { analyzeLine } from './analyze';
import { selfCheck } from './selfcheck';

// Claude sometimes returns the new text as null, a number or a list of lines. Always make it a string.
const asText = (v: unknown): string => v == null ? '' : Array.isArray(v) ? v.map((x) => (x == null ? '' : String(x))).join('\n') : String(v);
const asList = (v: unknown): any[] => Array.isArray(v) ? v : v == null || v === '' ? [] : typeof v === 'object' && !('x0' in (v as any)) && !Array.isArray(v) ? [v] : [v];
const num = (v: unknown): number | undefined => { const n = typeof v === 'string' ? parseFloat(v) : (v as number); return typeof n === 'number' && Number.isFinite(n) ? n : undefined; };
const pick = <T extends string>(v: unknown, ok: readonly T[]): T | undefined => (typeof v === 'string' && (ok as readonly string[]).includes(v) ? (v as T) : undefined);
// A box from Claude: {x0,y0,x1,y1} or [x0,y0,x1,y1]; sorted, finite, at least 1 px. Undefined if unusable.
const asBox = (v: any): Box | undefined => {
  const a = Array.isArray(v) ? v : v && typeof v === 'object' ? [v.x0, v.y0, v.x1, v.y1] : [];
  const [x0, y0, x1, y1] = a.map(num);
  if ([x0, y0, x1, y1].some((n) => n === undefined)) return undefined;
  const b = { x0: Math.min(x0!, x1!), y0: Math.min(y0!, y1!), x1: Math.max(x0!, x1!), y1: Math.max(y0!, y1!) };
  return b.x1 - b.x0 >= 1 && b.y1 - b.y0 >= 1 ? b : undefined;
};


export interface AgentEnv {
  lib: FontLib;
  /** POST a Messages API body, return the parsed response JSON. */
  claude: (body: any) => Promise<any>;
  /** Encode part of a raster as base64 JPEG/PNG. */
  encode: (r: Raster, box?: Box, scale?: number) => Promise<{ media_type: string; data: string }>;
  model: string;
  /** 'low' | 'medium' | 'high' – how hard Claude thinks when planning */
  effort?: string;
  log?: (msg: string) => void;
  save?: (name: string, r: Raster) => Promise<void>;
  /** Re-read a small area of the page (used when Claude points at text by box). */
  ocrRegion?: (box: Box) => Promise<OcrLine[]>;
  /** Send few, combined pictures (collages) instead of many separate ones. */
  compact?: boolean;
  /** low-resolution working picture of a vector page: draw all new text as sharp vector text */
  vectorOnly?: boolean;
  /** allow removing/moving icons and pictures (off by default: on photo backgrounds it can damage codes and text nearby) */
  allowPictures?: boolean;
}

export interface Request {
  instruction: string;
  mark?: Box; // area Elin marked (image px)
  history?: { role: 'user' | 'assistant'; text: string }[];
}

export interface Result {
  applied?: Applied;
  edits: Edit[];
  summary: string;
  question?: string;
  usage: { input: number; output: number; calls: number; ms: number };
  notes: string[];
}

const PICTURES_OFF = `

IMPORTANT – in this version, removing or moving non-text elements (icons, badges, logos, pictures, codes) is switched OFF. Never use "erase" or "moves". Make room for text by shortening or shrinking the text itself, never by moving other elements. If a request can only be done by removing or moving such an element, return no edits and explain in "question" (Swedish) that this must be done in the original design file.`;

const PLAN_TOOL = {
  name: 'edit_plan',
  description: 'The changes to make on the page.',
  input_schema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'Only if the request is truly unclear: one short question in Swedish. Then leave edits empty.' },
      summary: { type: 'string', description: 'Short Swedish summary for Elin of what will change (1-3 sentences).' },
      edits: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            lines: { type: 'array', items: { type: 'integer' }, description: 'OCR line ids that form ONE text block in ONE style (same font, size, colour).' },
            boxes: { type: 'array', items: { type: 'object', properties: { x0: { type: 'number' }, y0: { type: 'number' }, x1: { type: 'number' }, y1: { type: 'number' } }, required: ['x0', 'y0', 'x1', 'y1'] }, description: 'Only if OCR missed the text: tight box per text line, image pixels.' },
            old: { type: 'array', items: { type: 'string' }, description: 'The current text of each line exactly as printed (fix OCR mistakes: å ä ö × ® etc.).' },
            new: { type: 'string', description: 'The new text. Use \\n to keep the same line breaks as the old lines when the line count stays the same. Empty string = remove the text.' },
            align: { type: 'string', enum: ['left', 'center', 'right'] },
            style: { type: 'string', enum: ['serif', 'sans', 'script'] },
            group: { type: 'string', description: 'Style group name. Blocks that look the same on the page (same typeface) share a group, e.g. "rubrik", "brödtext", "etikett".' },
            maxWidth: { type: 'number', description: 'Optional: width in image px available for the new text if it may be wider than the old text (stay inside the panel, clear of other elements).' },
            maxHeight: { type: 'number', description: 'Optional: height in image px available for the new text block (from the first line top), clear of anything below.' },
          },
          required: ['old', 'new', 'style', 'group', 'align'],
        },
      },
      erase: { type: 'array', items: { type: 'object', properties: { x0: { type: 'number' }, y0: { type: 'number' }, x1: { type: 'number' }, y1: { type: 'number' } }, required: ['x0', 'y0', 'x1', 'y1'] }, description: 'Boxes (image px) of non-text things to remove, e.g. a badge. Only if asked.' },
      moves: {
        type: 'array',
        description: 'Move non-text elements (an icon or badge TOGETHER WITH its caption, a logo) as exact pixels. Use to spread out or re-centre a row after removing items, or when asked to move something. The engine lifts all sources first, then places them, so moves may swap or overlap old spots.',
        items: {
          type: 'object',
          properties: {
            box: { type: 'object', properties: { x0: { type: 'number' }, y0: { type: 'number' }, x1: { type: 'number' }, y1: { type: 'number' } }, required: ['x0', 'y0', 'x1', 'y1'], description: 'Tight box (image px) around the element and its caption, a few px of plain surface around it, not touching neighbours.' },
            to: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'], description: 'New top-left of that box. Keep y the same unless asked to move vertically.' },
          },
          required: ['box', 'to'],
        },
      },
    },
    required: ['summary', 'edits'],
  },
};

const PICK_TOOL = {
  name: 'pick_fonts',
  description: 'Which candidate looks most like the original lettering, per group.',
  input_schema: {
    type: 'object',
    properties: { picks: { type: 'array', items: { type: 'object', properties: { group: { type: 'string' }, letter: { type: 'string' } }, required: ['group', 'letter'] } } },
    required: ['picks'],
  },
};

const CHECK_TOOL = {
  name: 'check_result',
  description: 'Verdict on the edited page and any corrections.',
  input_schema: {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      problems: { type: 'array', items: { type: 'string' }, description: 'Short Swedish descriptions of what still looks wrong.' },
      fixes: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            edit: { type: 'integer', description: 'Index of the edit to change.' },
            new: { type: 'string' },
            align: { type: 'string', enum: ['left', 'center', 'right'] },
            maxWidth: { type: 'number' },
            maxHeight: { type: 'number' },
            addLines: { type: 'array', items: { type: 'integer' }, description: 'OCR line ids that should also be erased/replaced in this block (old text still visible).' },
            weight: { type: 'string', enum: ['lighter', 'heavier'], description: 'If the new text looks bolder or thinner than the original/neighbouring text.' },
            size: { type: 'string', enum: ['smaller', 'larger'], description: 'If the new text is clearly bigger or smaller than it should be.' },
          },
          required: ['edit'],
        },
      },
    },
    required: ['ok'],
  },
};

function toolInput(resp: any, name: string): any {
  for (const b of resp.content ?? []) if (b.type === 'tool_use' && b.name === name) return b.input;
  // fallback: JSON in text
  const text = (resp.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n');
  const m = text.match(/\{[\s\S]*\}/);
  if (m) try { return JSON.parse(m[0]); } catch { /* ignore */ }
  throw new Error('AI:n svarade inte med en plan.');
}

const SYSTEM_PLAN = `You edit text on flattened print artwork (the whole page is one picture). You do NOT draw: a precise engine erases old lettering and sets new vector text in a matched font, size, colour, spacing and alignment. It can also remove non-text elements ("erase") and move existing elements such as icons with their captions ("moves", exact pixel copies). It cannot draw new pictures or change an icon's drawing, but text INSIDE an icon or badge (e.g. a temperature in a symbol) is text and can be changed: give its box. Your job is to decide WHAT changes, as a plan.

Rules:
- Change only what the request asks. Everything else stays exactly as it is. Never fix spelling, dashes or other typos you notice elsewhere on the page, and never "correct" a word because OCR misread it (e.g. OCR "Yttervagg" is printed correctly); no edit may have the same old and new text.
- One edit = one block of text in ONE style (same typeface, size, colour), e.g. a headline, a paragraph, a caption. Lines in different styles are separate edits.
- Use the OCR line ids. OCR text can be wrong; write "old" exactly as printed on the page (look at the picture). OCR lines sometimes merge two columns into one line; then use "boxes" for each part instead of the line id.
- If the new text has the same number of lines as the old block, keep the same line breaks with \\n. If it needs more room, give maxWidth/maxHeight (image px) so it stays inside its panel and clear of other elements; the engine wraps and shrinks to fit.
- "group": blocks that clearly use the same typeface AND look (same weight, similar size) share one group name. The same word in a headline and in body text are DIFFERENT groups. A 3D mockup's copy of a headline uses the SAME group as the flat headline (it is the same artwork, just smaller).
- "align": how the old text sits in its panel (centred headline/caption = center, paragraph = left). Lines that belong together (a two-line headline) go in ONE edit.
- Write new text in the language of the page (Swedish unless told otherwise), matching the tone and length of what it replaces. Keep capitalisation style (ALL CAPS stays caps).
- Elin may have marked an area: focus on it, but update repeated copies elsewhere (e.g. a 3D mockup of the same panel) only if she asks for "everywhere"/"alla ställen" or the request obviously means all copies.
- Skip text on strongly angled or curved surfaces, e.g. the narrow side panel or a small badge on the side of a 3D box mockup: the engine sets text straight, so it would look wrong. The mockup's front face (nearly flat) is fine. If you skip something, say so in the summary.
- Spreading out a row (e.g. after removing two of five icons): compute the row's left and right limits from the original first and last items, then place the remaining items so the gaps between them are equal, same y. Give each move's "to" as the new top-left of its box.
- Always set "style" (sans, serif or script) by LOOKING at the lettering in the picture; labels and numbers on drawings and plans are almost always sans. Give the same "group" to labels that look alike (e.g. all room areas).
- When the request says all/every/alla/överallt: go through the WHOLE OCR table, including legends, tables, title blocks and small print, and make one edit for EVERY matching place. Before you answer, count the matches in the table and check you have that many edits. Do not stop at the obvious ones.
- OCR can garble or miss small text (e.g. "2,1 m²" read as "21 ny"). Look at the picture too: for any matching text that the OCR table lacks or garbles, give its box in "boxes" (with "old" exactly as printed) instead of line ids.
- Product codes, barcodes, legal marks: leave them unless asked.
- Ask a question only if you really cannot proceed.
Call the edit_plan tool.`;

/** Keep earlier vector text that this request didn't touch. */
async function mergePrior(env: AgentEnv, prior: TextItem[] | undefined, a: Applied): Promise<Applied> {
  if (!prior?.length) return a;
  // earlier text that overlaps this turn's edits was baked into the base picture before applying,
  // so everything still in 'prior' is untouched by this turn and is kept as it is
  return { ...a, items: [...prior, ...a.items] };
}


/** Browser only: keep the latest run's capture and show a small "Spara felsökning" button that downloads it. */
function publishDump(d: any) {
  try {
    (globalThis as any).__pdfDump = d;
    if (typeof document === 'undefined' || document.getElementById('pdf-dump-btn')) return;
    const b = document.createElement('button');
    b.id = 'pdf-dump-btn';
    b.textContent = 'Spara felsökning';
    Object.assign(b.style, { position: 'fixed', left: '8px', bottom: '8px', zIndex: '99999', padding: '6px 10px', fontSize: '12px', opacity: '0.85', cursor: 'pointer' });
    b.onclick = () => {
      const blob = new Blob([JSON.stringify((globalThis as any).__pdfDump)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = 'felsokning.json'; a.click();
    };
    document.body.appendChild(b);
  } catch { /* not in a browser */ }
}

export async function runRequest(env: AgentEnv, page: Raster, ocr: OcrLine[], req: Request, base?: Raster, prior?: TextItem[]): Promise<Result> {
  const t0 = Date.now();
  const usage = { input: 0, output: 0, calls: 0, ms: 0 };
  const notes: string[] = [];
  const log = env.log ?? (() => {});
  // Bug-report capture: everything needed to replay this run (the AI's answers, the OCR table, the page size)
  const dump: any = { instruction: req.instruction, mark: req.mark, page: [page.w, page.h], ocr: ocr.map((l) => ({ id: l.id, box: l.box, text: l.text, words: l.words, rot: l.rot, conf: l.conf })), responses: [] as any[] };
  publishDump(dump);
  const call = async (body: any) => {
    const tc = Date.now();
    const r = await env.claude({ model: env.model, max_tokens: 8000, ...body });
    dump.responses.push((r?.content ?? []).filter((b: any) => b.type === 'tool_use').map((b: any) => ({ name: b.name, input: b.input })));
    log(`  (AI ${((Date.now() - tc) / 1000).toFixed(1)} s, ${r.usage?.output_tokens ?? '?'} tokens ut)`);
    if (r.stop_reason === 'max_tokens') log('(svaret blev avkortat)');
    usage.calls++; usage.input += r.usage?.input_tokens ?? 0; usage.output += r.usage?.output_tokens ?? 0;
    return r;
  };

  // ---------- 1. plan ----------
  log('AI läser sidan …');
  // Claude sees the page at scale SC; all coordinates we exchange are in that space.
  const SC = Math.min(1, 1568 / Math.max(page.w, page.h), env.compact ? Math.sqrt(1.15e6 / (page.w * page.h)) : 1);
  const toC = (v: number) => Math.round(v * SC);
  const fromC = (b: Box): Box => ({ x0: b.x0 / SC, y0: b.y0 / SC, x1: b.x1 / SC, y1: b.y1 / SC });
  const pageImg = await env.encode(page, undefined, SC);
  const ocrTable = ocr.map((l) => `${l.id}\t${toC(l.box.x0)},${toC(l.box.y0)},${toC(l.box.x1)},${toC(l.box.y1)}\t${l.text}`).join('\n');
  const content: any[] = [
    { type: 'text', text: `Page picture: ${toC(page.w)}×${toC(page.h)} px. All coordinates are pixels of THIS picture, origin top-left.` },
    { type: 'image', source: { type: 'base64', ...pageImg } },
  ];
  if (req.mark) {
    const m = req.mark;
    content.push({ type: 'text', text: `Elin marked this area: x0=${toC(m.x0)} y0=${toC(m.y0)} x1=${toC(m.x1)} y1=${toC(m.y1)}. Close-up:` });
    content.push({ type: 'image', source: { type: 'base64', ...(await env.encode(page, m, 2)) } });
  }
  content.push({ type: 'text', text: `OCR lines (id, box x0,y0,x1,y1, text):\n${ocrTable}` });
  if (req.history?.length) content.push({ type: 'text', text: `Earlier in this conversation:\n${req.history.map((h) => `${h.role === 'user' ? 'Elin' : 'Du'}: ${h.text}`).join('\n')}` });
  content.push({ type: 'text', text: `Elin's request:\n<request>${req.instruction}</request>` });
  const planBody = (msgs: any[]) => ({ max_tokens: 32000, ...(env.effort ? { output_config: { effort: env.effort } } : {}), system: env.allowPictures ? SYSTEM_PLAN : SYSTEM_PLAN + PICTURES_OFF, tools: [PLAN_TOOL], tool_choice: { type: 'auto' }, messages: msgs });
  let planResp = await call(planBody([{ role: 'user', content }]));
  if (planResp.stop_reason === 'max_tokens') throw new Error('Planen blev för lång – försök dela upp ändringen i mindre delar.');
  const textOf = (r: any) => (r?.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n').trim();
  let plan: any;
  try { plan = toolInput(planResp, 'edit_plan'); } catch {
    // Claude answered in words instead of the plan tool: ask once more, firmly; if it still talks, show its words as a question
    const said = textOf(planResp);
    log('AI läser sidan igen …');
    planResp = await call(planBody([{ role: 'user', content }, ...(said ? [{ role: 'assistant', content: said }] : []), { role: 'user', content: [{ type: 'text', text: 'Answer ONLY by calling the edit_plan tool. If something is unclear, put the question in its "question" field (in Swedish) and leave edits empty.' }] }]));
    try { plan = toolInput(planResp, 'edit_plan'); } catch {
      const q = textOf(planResp) || said;
      usage.ms = Date.now() - t0;
      if (q) return { edits: [], summary: '', question: q.slice(0, 1500), usage, notes };
      throw new Error('AI:n kunde inte göra en plan av det här. Försök skriva ändringen på ett annat sätt, eller markera området med en ruta.');
    }
  }
  if (!plan || typeof plan !== 'object') plan = {};
  // For bug reports: the plan, the page size and the OCR table can be copied from the browser console (F12)
  try { console.log('[PDF-ändraren plan]', JSON.stringify({ instruction: req.instruction, page: [page.w, page.h], SC, plan, ocr: ocr.map((l) => [l.id, Math.round(l.box.x0), Math.round(l.box.y0), Math.round(l.box.x1), Math.round(l.box.y1), l.text, l.rot ?? 0]) })); } catch { /* ignore */ }
  if (plan.question && !asList(plan.edits).length && !asList(plan.erase).length && !asList(plan.moves).length) {
    usage.ms = Date.now() - t0;
    return { edits: [], summary: '', question: asText(plan.question), usage, notes };
  }
  const groups: string[] = [];
  let edits: (Edit & { group?: string })[] = [];
  const clampBox = (b: Box): Box | undefined => { const c = { x0: Math.max(0, b.x0), y0: Math.max(0, b.y0), x1: Math.min(page.w, b.x1), y1: Math.min(page.h, b.y1) }; return c.x1 - c.x0 >= 1 && c.y1 - c.y0 >= 1 ? c : undefined; };
  const pageBox = (v: any): Box | undefined => { const b = asBox(v); return b ? clampBox(fromC(b)) : undefined; };
  const knownIds = new Set(ocr.map((o) => o.id));
  for (const e of asList(plan.edits)) {
    if (!e || typeof e !== 'object' || e.new == null) continue; // no new text given = nothing to change
    // keep only line ids that exist (and their old text in step); unknown ids are dropped, not fatal
    const rawLines = asList(e.lines).map((x) => num(x)), rawOld = asList(e.old).map((x) => asText(x));
    const lines: number[] = [], old: string[] = [];
    rawLines.forEach((id, k) => { if (id !== undefined && knownIds.has(id)) { lines.push(id); old.push(rawOld[k] || (ocr.find((o) => o.id === id)?.text ?? '')); } });
    const boxes = asList(e.boxes).map(pageBox).filter((b): b is Box => !!b);
    const mw = num(e.maxWidth), mh = num(e.maxHeight);
    const te: TextEdit = { kind: 'text', lines, boxes: boxes.length ? boxes : undefined, old: boxes.length ? rawOld : old, new: asText(e.new), align: pick(e.align, ['left', 'center', 'right'] as const), style: pick(e.style, ['serif', 'sans', 'script'] as const), maxWidth: mw && mw > 0 ? mw / SC : undefined, maxHeight: mh && mh > 0 ? mh / SC : undefined, group: typeof e.group === 'string' ? e.group : e.group != null ? String(e.group) : undefined };
    if (!te.lines.length && !te.boxes?.length) continue;
    edits.push(te);
    if (te.group && !groups.includes(te.group)) groups.push(te.group);
  }
  for (const b of asList(plan.erase)) { const box = pageBox(b); if (box) edits.push({ kind: 'erase', box }); }
  for (const m of asList(plan.moves)) {
    const box = pageBox(m?.box), x = num(m?.to?.x), y = num(m?.to?.y);
    if (box && x !== undefined && y !== undefined) edits.push({ kind: 'move', box, to: { x: x / SC, y: y / SC } });
  }
  // Removing/moving icons and pictures is switched off unless allowed: on photo backgrounds it can't be
  // filled in cleanly and can damage barcodes/QR codes nearby. Do nothing rather than half the request.
  if (!env.allowPictures && edits.some((e) => e.kind !== 'text')) {
    const realText = edits.some((e) => e.kind === 'text' && e.new.trim() !== '');
    if (!realText) {
      usage.ms = Date.now() - t0;
      return { edits: [], summary: '', question: 'Att ta bort eller flytta ikoner och bilder är avstängt i den här versionen, eftersom det kan skada annat på sidan, till exempel streckkoder och QR-koder. Gör den ändringen i originalfilen i ditt designprogram. Text kan jag ändra som vanligt: skriv vad som ska stå, så fixar jag det.', usage, notes };
    }
    // keep the text changes, leave icons/pictures where they are
    edits = edits.filter((e) => e.kind === 'text');
    notes.push('Att titta på: Ikoner och bilder flyttas eller tas inte bort i den här versionen, bara texten ändrades.');
  }
  // A marked area limits the edits to that area (the AI sometimes points at the wrong place, especially
  // the small/fast models). Not applied when nothing is marked, or when the request says "all/everywhere".
  if (req.mark && !/(^|[^\p{L}])(alla|allt|samtliga|överallt|varje|everywhere|all)(?![\p{L}])/iu.test(req.instruction)) {
    const m = req.mark, pad = 12;
    const inMark = (b: Box) => b.x0 < m.x1 + pad && b.x1 > m.x0 - pad && b.y0 < m.y1 + pad && b.y1 > m.y0 - pad;
    const regionsOf = (e: Edit): Box[] => e.kind === 'text'
      ? [...e.lines.map((id) => ocr.find((o) => o.id === id)?.box).filter((b): b is Box => !!b), ...(e.boxes ?? [])]
      : [e.box];
    const before = edits.length;
    edits = edits.filter((e) => regionsOf(e).some(inMark));
    if (edits.length < before) notes.push(`Att titta på: ${before - edits.length} ändring(ar) utanför den markerade rutan hoppades över. Skriv "alla" i beskrivningen om du vill ändra överallt.`);
    if (!edits.length) {
      usage.ms = Date.now() - t0;
      return { edits: [], summary: '', question: 'Jag hittade ingen text att ändra inuti rutan du markerade. Markera rutan lite större runt texten, eller skriv "alla" om ändringen ska göras överallt.', usage, notes };
    }
  }
  if (!edits.length) {
    usage.ms = Date.now() - t0;
    return { edits: [], summary: '', question: asText(plan.summary) || asText(plan.question) || 'Jag hittade inget att ändra. Beskriv ändringen lite mer exakt, eller dra en ruta runt det du menar.', usage, notes };
  }
  // OCR can break one line into pieces (justified text with wide gaps). When Claude
  // lists more line ids than old lines and the pieces sit on that many rows, each row
  // becomes one box around its pieces.
  for (const e of edits) {
    if (e.kind !== 'text' || e.boxes?.length || e.lines.length <= e.old.length || !e.old.length) continue;
    const ls = e.lines.map((id) => ocr.find((o) => o.id === id)).filter(Boolean) as OcrLine[];
    if (ls.length !== e.lines.length) continue;
    const rows: OcrLine[][] = [];
    for (const l of [...ls].sort((a, b) => (a.box.y0 + a.box.y1) - (b.box.y0 + b.box.y1))) {
      const r = rows.find((g) => { const u = g[0].box, h = Math.min(u.y1 - u.y0, l.box.y1 - l.box.y0); return Math.abs((u.y0 + u.y1) / 2 - (l.box.y0 + l.box.y1) / 2) < h * 0.5; });
      if (r) r.push(l); else rows.push([l]);
    }
    if (rows.length !== e.old.length) continue;
    e.boxes = rows.map((g) => g.map((l) => l.box).reduce((a, b) => ({ x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) })));
    e.lines = [];
  }
  // Line ids that already read as the old text beat Claude's hand-drawn boxes
  // (boxes are rough and can cut the letters, leaving bits of the old text).
  for (const e of edits) {
    if (e.kind !== 'text' || !e.boxes?.length || !e.lines.length || e.lines.length !== e.old.length) continue;
    const ok = e.lines.every((id, k) => { const l = ocr.find((o) => o.id === id); const cut = l && resolveLine(ocr, l, e.old[k] ?? ''); return !!cut && similar(cut.text, e.old[k] ?? '') >= 0.75; });
    if (ok) e.boxes = undefined;
  }
  // Boxes that sit on an OCR line with the same text are that line (enables word-level swaps).
  for (const e of edits) {
    if (e.kind !== 'text' || !e.boxes?.length || e.boxes.length !== e.old.length) continue;
    const ids: number[] = [];
    for (let k = 0; k < e.boxes.length; k++) {
      const b = e.boxes[k];
      let best: OcrLine | undefined, bs = 0;
      for (const l of ocr) {
        const ix = Math.min(b.x1, l.box.x1) - Math.max(b.x0, l.box.x0), iy = Math.min(b.y1, l.box.y1) - Math.max(b.y0, l.box.y0);
        if (ix <= 0 || iy <= 0) continue;
        const cut = resolveLine(ocr, l, e.old[k]); // the box may cover only part of the line
        const sc = Math.max(similar(l.text, e.old[k]), cut ? similar(cut.text, e.old[k]) : 0);
        if (sc > bs) { bs = sc; best = l; }
      }
      if (best && bs >= 0.75) ids.push(best.id); else break;
    }
    if (ids.length === e.boxes.length) { e.lines = ids; e.boxes = undefined; }
  }
  // Claude's boxes are approximate: snap them to the real text with a local OCR pass.
  if (env.ocrRegion)
    for (const e of edits) {
      if (e.kind !== 'text' || !e.boxes?.length) continue;
      // one box around several old lines: find each line inside it
      if (e.boxes.length < e.old.length) {
        const u = e.boxes.reduce((a, b) => ({ x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) }));
        const pad = Math.max(12, (u.y1 - u.y0) * 0.4);
        const found = await env.ocrRegion({ x0: Math.max(0, u.x0 - pad), y0: Math.max(0, u.y0 - pad), x1: Math.min(page.w, u.x1 + pad), y1: Math.min(page.h, u.y1 + pad) });
        const picks = e.old.map((t) => { let bl: OcrLine | undefined, bs = 0; for (const l of found) { const sc = similar(l.text, t); if (sc > bs) { bs = sc; bl = l; } } return bs >= 0.5 ? bl!.box : null; });
        if (picks.every(Boolean)) e.boxes = picks as Box[];
        else { // split the box into equal rows, one per old line
          const n = e.old.length, h = (u.y1 - u.y0) / n;
          e.boxes = e.old.map((_, k) => ({ x0: u.x0, x1: u.x1, y0: u.y0 + k * h, y1: u.y0 + (k + 1) * h }));
        }
        continue;
      }
      const snapped: Box[] = [];
      for (const b of e.boxes) {
        const pad = Math.max(25, (b.y1 - b.y0) * 1.5);
        const reg = { x0: Math.max(0, b.x0 - pad), y0: Math.max(0, b.y0 - pad), x1: Math.min(page.w, b.x1 + pad), y1: Math.min(page.h, b.y1 + pad) };
        const found = await env.ocrRegion(reg);
        const want = e.old[snapped.length] ?? '';
        // only trust OCR here if it actually read the same words
        let pick: Box = b, score = 0;
        for (const l of found) {
          const cut = resolveLine(found, l, want);
          const sc = cut ? similar(cut.text, want) : 0;
          const near = Math.hypot((l.box.x0 + l.box.x1) / 2 - (b.x0 + b.x1) / 2, (l.box.y0 + l.box.y1) / 2 - (b.y0 + b.y1) / 2);
          if (cut && sc >= 0.5 && sc - near / 1000 > score) { score = sc - near / 1000; pick = cut.box; }
        }
        // The AI's box can sit far from the text (small models point loosely): widen the search
        // step by step and take the nearest line that reads the same words.
        if (pick === b && want.trim()) {
          const bh0 = Math.max(1, b.y1 - b.y0);
          for (const k of [3, 6]) {
            const p2 = Math.min(500, Math.max(pad * k, bh0 * 4 * k / 3));
            const reg2 = { x0: Math.max(0, b.x0 - p2), y0: Math.max(0, b.y0 - p2), x1: Math.min(page.w, b.x1 + p2), y1: Math.min(page.h, b.y1 + p2) };
            const found2 = await env.ocrRegion(reg2);
            let best = 0;
            for (const l of found2) {
              const cut = resolveLine(found2, l, want);
              const sc = cut ? similar(cut.text, want) : 0;
              if (!cut || sc < 0.6) continue;
              const near = Math.hypot((cut.box.x0 + cut.box.x1) / 2 - (b.x0 + b.x1) / 2, (cut.box.y0 + cut.box.y1) / 2 - (b.y0 + b.y1) / 2);
              const val = sc - near / 1500;
              if (val > best) { best = val; pick = cut.box; }
            }
            if (pick !== b) break;
          }
        }
        // OCR couldn't read it (tiny text in an icon, odd colours): use the
        // letters' own pixels inside Claude's box instead
        if (pick === b) {
          const sn = snapElement(page, b, { text: true });
          const bh = b.y1 - b.y0;
          if (!sn.box) (e as any).dead = true; // nothing there at all: the AI pointed at empty paper
          if (sn.box && sn.box.y1 - sn.box.y0 >= bh * 0.3 && sn.box.y1 - sn.box.y0 <= bh * 1.8 && sn.box.x1 - sn.box.x0 <= (b.x1 - b.x0) * 1.8) {
            pick = sn.box;
            if (true) {
            // the box may hold more text rows than this edit's lines: take the row
            // whose shape (width : height) best fits the old text
            // rows OCR could read belong to other (line) edits; this box is for the unreadable text
            const ov = (a: Box, b: Box) => { const ix = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)), iy = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0)); return (ix * iy) / Math.max(1, (a.x1 - a.x0) * (a.y1 - a.y0)); };
            const allRows = textRows(sn.parts);
            const unread = allRows.filter((r) => !ocr.some((l) => ov(r, l.box) > 0.5));
            const rows = unread.length ? unread : allRows;
            const need = e.boxes.length;
            if (rows.length > need && need === 1) {
              const ref = env.lib.entries.find((x) => x.weight === 400) ?? env.lib.entries[0];
              const f = await env.lib.load(ref.key);
              const ext = inkExtent(f, want, 100, 0);
              const ratio = (ext.maxX - ext.minX) / 72; // ~cap height at size 100
              let bestR = rows[0], bd = Infinity;
              for (const r of rows) { const d = Math.abs(Math.log(((r.x1 - r.x0) / Math.max(1, r.y1 - r.y0)) / ratio)); if (d < bd) { bd = d; bestR = r; } }
              pick = bestR;
            } else if (rows.length === need && need > 1) pick = rows[snapped.length];
            else if (rows.length === 1) pick = rows[0];
            }
          }
        }
        snapped.push(pick);
      }
      e.boxes = snapped;
    }
  {
    const n0 = edits.length;
    edits = edits.filter((e) => !(e as any).dead);
    if (edits.length < n0) notes.push(`Att titta på: ${n0 - edits.length} ändring(ar) hoppades över eftersom jag inte hittade texten där AI:n pekade. Markera området runt texten och försök igen.`);
    if (!edits.length) {
      usage.ms = Date.now() - t0;
      return { edits: [], summary: '', question: 'Jag hittade inte texten du vill ändra. Markera en ruta runt den och försök igen.', usage, notes };
    }
  }

  // Two edits must never rewrite the same text (e.g. a box that snapped onto a
  // line another edit already covers): keep the first, drop the duplicate.
  {
    const boxesOf = (e: TextEdit): Box[] => e.boxes?.length ? e.boxes : e.lines.map((id, k) => resolveLine(ocr, ocr.find((o) => o.id === id), e.old[k] ?? '')?.box).filter(Boolean) as Box[];
    const iou = (a: Box, b: Box) => { const ix = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)), iy = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0)); const i = ix * iy; return i / Math.max(1, Math.min((a.x1 - a.x0) * (a.y1 - a.y0), (b.x1 - b.x0) * (b.y1 - b.y0))); };
    const seen: Box[] = [];
    // line-based edits first (they are the surer ones)
    const order = edits.map((e, i) => i).filter((i) => edits[i].kind === 'text').sort((a, b) => Number(!!(edits[a] as TextEdit).boxes?.length) - Number(!!(edits[b] as TextEdit).boxes?.length));
    const drop = new Set<number>();
    for (const i of order) {
      const bs = boxesOf(edits[i] as TextEdit);
      if (bs.some((b) => seen.some((q) => iou(b, q) > 0.5))) { drop.add(i); continue; }
      seen.push(...bs);
    }
    if (drop.size) edits = edits.filter((_, i) => !drop.has(i));
  }

  // A group must be one typeface at one size: split groups whose members differ
  // a lot in style or text height (e.g. a headline name and the same name in body text).
  {
    const heightOf = (e: TextEdit) => {
      const b = e.boxes?.[0] ?? resolveLine(ocr, ocr.find((o) => o.id === e.lines[0]), e.old[0] ?? '')?.box;
      return b ? b.y1 - b.y0 : 0;
    };
    for (const g of [...groups]) {
      const members = edits.filter((e): e is TextEdit => e.kind === 'text' && e.group === g);
      const byStyle = new Map<string, TextEdit[]>();
      for (const e of members) byStyle.set(e.style ?? 'any', [...(byStyle.get(e.style ?? 'any') ?? []), e]);
      let k = 0;
      for (const list of byStyle.values()) {
        list.sort((a, b) => heightOf(a) - heightOf(b));
        let base = 0;
        for (const e of list) {
          const h = heightOf(e);
          if (!base || (h && h > base * 1.45)) { base = h || base || 1; k++; }
          e.group = k === 1 ? g : `${g}#${k}`;
          if (!groups.includes(e.group)) groups.push(e.group);
        }
      }
    }
  }

  // ---------- 2. fonts: engine ranks, Claude picks by eye ----------
  log('Matchar typsnitt …');
  const chosen = new Map<string, string>(); // group -> font family
  const contest: any[] = [];
  const letters = 'ABCD';
  for (const g of groups) {
    const members = edits.filter((e): e is TextEdit & { group?: string } => e.kind === 'text' && (e as any).group === g && e.new.trim() !== '');
    if (!members.length) continue;
    const pairs: { info: any; text: string }[] = [];
    for (const e of members) {
      const boxes = e.boxes?.length ? e.boxes : e.lines.map((id, k) => resolveLine(ocr, ocr.find((o) => o.id === id), e.old[k] ?? '')?.box).filter(Boolean) as Box[];
      boxes.forEach((b, k) => { const t = e.old[k] ?? ''; if (t.trim()) pairs.push({ info: analyzeLine(page, b), text: t }); });
    }
    if (!pairs.length) continue;
    // largest lines say the most about the typeface
    pairs.sort((a, b) => (b.info.inkBox.y1 - b.info.inkBox.y0) * (b.info.inkBox.x1 - b.info.inkBox.x0) - (a.info.inkBox.y1 - a.info.inkBox.y0) * (a.info.inkBox.x1 - a.info.inkBox.x0));
    const sample = pairs.slice(0, 3);
    const style = (members[0] as TextEdit).style;
    // candidates: Claude's style guess can be wrong, so mix the best of that
    // style with the best of any style (the original row decides)
    const m = await matchFont(env.lib, sample, { style: style ?? 'any' });
    const anyM = style && style !== 'any' ? await matchFont(env.lib, sample, {}) : m;
    const fams: { key: string; family: string }[] = [];
    const add = (rk: { key: string }[], max: number) => { for (const r of rk) { if (fams.length >= max) break; const e = env.lib.entry(r.key); if (!fams.find((f) => f.family === e.family)) fams.push({ key: r.key, family: e.family }); } };
    add(m.ranking, 2); add(anyM.ranking, 4); add(m.ranking, 4);
    if (fams.length === 1) { chosen.set(g, fams[0].family); continue; }
    // contest image: original + candidates, drawn the same way the engine
    // will draw them (same size, colour and softness)
    const s0 = sample[0];
    const bx = s0.info.inkBox;
    const pad = 6, w = bx.x1 - bx.x0 + pad * 2, h = bx.y1 - bx.y0 + pad * 2;
    const rows = 1 + fams.length, LW = 40;
    const cr: Raster = { w: w + LW, h: rows * h, data: new Uint8ClampedArray((w + LW) * rows * h * 4).fill(255) };
    const bgc = s0.info.bgAt((bx.x0 + bx.x1) / 2, bx.y0 - 2).map(Math.round);
    for (let y = 0; y < rows * h; y++) for (let x = 0; x < w; x++) {
      const j = (y * cr.w + LW + x) * 4;
      if (y < h) {
        const sx = Math.min(page.w - 1, Math.max(0, bx.x0 - pad + x)), sy = Math.min(page.h - 1, Math.max(0, bx.y0 - pad + y));
        const i = (sy * page.w + sx) * 4;
        cr.data[j] = page.data[i]; cr.data[j + 1] = page.data[i + 1]; cr.data[j + 2] = page.data[i + 2];
      } else { cr.data[j] = bgc[0]; cr.data[j + 1] = bgc[1]; cr.data[j + 2] = bgc[2]; }
    }
    for (let k = 0; k < fams.length; k++) {
      const mm = await matchFont(env.lib, [s0], { families: [fams[k].family] });
      const fit = mm.lines[0];
      await rasterizeInto(cr, { text: s0.text.trim(), key: mm.key, size: fit.size, tracking: fit.tracking, hs: fit.hs, bold: fit.bold, x: LW + fit.penX - (bx.x0 - pad), baseline: (k + 1) * h + fit.baseline - (bx.y0 - pad), color: s0.info.color }, env.lib, s0.info);
    }
    // row labels
    const lab = env.lib.platform.createCanvas(LW, rows * h);
    const lctx = lab.getContext('2d');
    lctx.fillStyle = '#fff'; lctx.fillRect(0, 0, LW, rows * h);
    lctx.fillStyle = '#000'; lctx.font = `${Math.min(16, h * 0.6)}px sans-serif`;
    ['0', ...letters.slice(0, fams.length)].forEach((t, k) => lctx.fillText(t, 10, k * h + h / 2 + 5));
    const ld = lctx.getImageData(0, 0, LW, rows * h).data;
    for (let y = 0; y < rows * h; y++) for (let x = 0; x < LW; x++) for (let c = 0; c < 3; c++) cr.data[(y * cr.w + x) * 4 + c] = ld[(y * LW + x) * 4 + c];
    await env.save?.(`contest-${g}`, cr);
    const img = await env.encode(cr, undefined, Math.max(1, Math.min(3, 300 / h)));
    contest.push({ g, fams, img, raster: env.compact ? cropScale(env, cr, { x0: 0, y0: 0, x1: cr.w, y1: cr.h }, Math.max(1, Math.min(3, 160 / h))) : cr });
  }
  if (contest.length) {
    const c: any[] = [{ type: 'text', text: 'For each group: row 0 is the ORIGINAL lettering cut from the page; rows A-D are the same words in candidate fonts. Pick the candidate that looks most like the original: letter shapes first (serifs, stroke contrast, shape of a, e, g, R, S, G, numbers), then stroke weight (as dark/heavy as the original, not heavier) and width. Ignore tiny position differences.' }];
    if (env.compact) {
      const pics = collage(env, contest.map((x) => ({ r: x.raster, caption: `Group "${x.g}"` })));
      c.push({ type: 'text', text: `Groups in the pictures, in order: ${contest.map((x) => `"${x.g}"`).join(', ')}.` });
      for (const p of pics) c.push({ type: 'image', source: { type: 'base64', ...(await env.encode(p)) } });
    } else for (const x of contest) { c.push({ type: 'text', text: `Group "${x.g}":` }); c.push({ type: 'image', source: { type: 'base64', ...x.img } }); }
    let picks: any[] = [];
    try { picks = asList(toolInput(await call({ output_config: { effort: 'low' }, tools: [PICK_TOOL], tool_choice: { type: 'auto' }, messages: [{ role: 'user', content: c }] }), 'pick_fonts').picks); } catch { /* fall back to engine order */ }
    for (const x of contest) {
      const p = picks.find((q: any) => q && q.group === x.g);
      const k = p ? letters.indexOf(String(p.letter).trim().toUpperCase()) : 0;
      chosen.set(x.g, x.fams[k >= 0 && k < x.fams.length ? k : 0].family);
      log(`  ${x.g}: ${x.fams.map((f: any, i: number) => `${letters[i]}=${f.family}`).join(' ')} -> ${p?.letter ?? '?'}`);
    }
  }
  for (const e of edits) if (e.kind === 'text' && (e as any).group && chosen.has((e as any).group)) e.font = chosen.get((e as any).group);
  notes.push(...[...chosen].map(([g, f]) => `${g}: ${f}`));

  // ---------- 3. apply ----------
  log('Byter text …');
  // Earlier versions' sharp text that lies where this turn works is baked into the picture first,
  // so a partial change (one word, a move across it) can't make the rest of it disappear.
  if (prior?.length && base) {
    const PAD = 12;
    const regions: Box[] = [];
    for (const e of edits) {
      if (e.kind === 'text') { for (const id of e.lines) { const o = ocr.find((x) => x.id === id); if (o) regions.push(o.box); } for (const b of e.boxes ?? []) regions.push(b); }
      else if (e.kind === 'erase') regions.push(e.box);
      else if (e.kind === 'move') { const w = e.box.x1 - e.box.x0, h = e.box.y1 - e.box.y0; regions.push(e.box, { x0: e.to.x, y0: e.to.y, x1: e.to.x + w, y1: e.to.y + h }); }
    }
    const bake: TextItem[] = [], keep: TextItem[] = [];
    for (const it of prior) {
      const font = await env.lib.load(it.key);
      const ext = inkExtent(font, it.text, it.size, it.tracking, it.hs ?? 1);
      const b = { x0: it.x + ext.minX, x1: it.x + ext.maxX, y0: it.baseline - it.size * 0.8, y1: it.baseline + it.size * 0.2 };
      const hit = regions.some((r) => b.x0 < r.x1 + PAD && b.x1 > r.x0 - PAD && b.y0 < r.y1 + PAD && b.y1 > r.y0 - PAD);
      (hit ? bake : keep).push(it);
    }
    if (bake.length) { base = await renderPreview(env, { raster: base, items: bake } as any, base.w, base.h); prior = keep; }
  }
  let applied = await mergePrior(env, prior, await applyEditsRot(page, ocr, edits, env.lib, base, { vectorOnly: env.vectorOnly }));
  const firstApplied = applied;

  // ---------- 4. check once, fix once ----------
  log('AI kontrollerar resultatet …');
  const check = async (applied: Applied, effort: string) => {
  const preview = await renderPreview(env, applied, page.w, page.h);
  const cc: any[] = [{ type: 'text', text: `The request was: <request>${req.instruction}</request>\nPlan summary (anything it says was skipped on purpose is NOT a problem): ${plan.summary ?? ''}\nThe plan (edit index: old -> new):\n${edits.map((e, i) => e.kind === 'text' ? `${i}: ${JSON.stringify(e.old)} -> ${JSON.stringify(e.new)}` : e.kind === 'move' ? `${i}: move element` : `${i}: erase box`).join('\n')}\nBelow: for each changed area, BEFORE then AFTER (close-up). Then the whole page AFTER. Judge as a print designer: is any old text still visible, overlapping, cut off, misaligned, wrong size vs. its surroundings, or not what was asked? Only flag real problems. Give fixes using the edit index.` }];
  const tiles: { r: Raster; caption: string }[] = [];
  for (let i = 0; i < applied.reports.length && i < (env.compact ? 30 : 12); i++) {
    const b = applied.reports[i].box;
    const bb = { x0: Math.max(0, b.x0 - 20), y0: Math.max(0, b.y0 - 15), x1: Math.min(page.w, b.x1 + 20), y1: Math.min(page.h, b.y1 + 15) };
    const sc = Math.max(1, Math.min(3, 500 / Math.max(1, bb.x1 - bb.x0)));
    if (env.compact) {
      tiles.push({ r: sideBySide(env, cropScale(env, page, bb, sc), cropScale(env, preview, bb, sc)), caption: `Edit ${applied.reports[i].index}: BEFORE (left) / AFTER (right)` });
      continue;
    }
    cc.push({ type: 'text', text: `Edit ${applied.reports[i].index} BEFORE / AFTER:` });
    cc.push({ type: 'image', source: { type: 'base64', ...(await env.encode(page, bb, sc)) } });
    cc.push({ type: 'image', source: { type: 'base64', ...(await env.encode(preview, bb, sc)) } });
  }
  if (tiles.length) for (const p of collage(env, tiles)) cc.push({ type: 'image', source: { type: 'base64', ...(await env.encode(p)) } });
  cc.push({ type: 'image', source: { type: 'base64', ...(await env.encode(preview, undefined, SC)) } });
  return toolInput(await call({ output_config: { effort }, tools: [CHECK_TOOL], tool_choice: { type: 'auto' }, messages: [{ role: 'user', content: cc }] }), 'check_result');
  };
  // normalise the check answer: lists may come back as a single item or a string
  const normCheck = (c: any) => ({ ...c, ok: c?.ok === true || c?.ok === 'true', problems: asList(c?.problems).map(asText).filter(Boolean), fixes: asList(c?.fixes).filter((f: any) => f && typeof f === 'object').map((f: any) => ({ ...f, edit: num(f.edit) ?? -1, addLines: asList(f.addLines).map(num).filter((n: any): n is number => n !== undefined && knownIds.has(n)) })) });
  // The result is already made: if checking or fixing fails (Claude busy, odd answer), keep it and say so.
  try {
    const ck = await check(applied, env.effort ?? 'medium');
    Object.assign(ck, normCheck(ck));
    const fixes: any[] = ck.fixes;
    if (!ck.ok && fixes.length) {
      log('Rättar …');
      for (const f of fixes) {
        const e = edits[f.edit];
        if (!e || e.kind !== 'text') continue;
        if (typeof f.new === 'string' || Array.isArray(f.new)) e.new = asText(f.new);
        if (pick(f.align, ['left', 'center', 'right'] as const)) e.align = f.align;
        if ((num(f.maxWidth) ?? 0) > 0) e.maxWidth = num(f.maxWidth)! / SC;
        if ((num(f.maxHeight) ?? 0) > 0) e.maxHeight = num(f.maxHeight)! / SC;
        const rep = applied.reports.find((r) => r.index === f.edit);
        if (f.weight && rep?.match) {
          const fam = env.lib.entries.filter((x) => x.family === rep.match!.family).map((x) => x.weight).sort((a, b) => a - b);
          const cur = rep.match.weight, idx = fam.indexOf(cur);
          const next = f.weight === 'lighter' ? fam[Math.max(0, idx - 1)] : fam[Math.min(fam.length - 1, idx + 1)];
          e.font = rep.match.family; e.weight = next;
        }
        if (f.size) (e as any).sizeScale = ((e as any).sizeScale ?? 1) * (f.size === 'smaller' ? 0.93 : 1.07);
        if (f.addLines?.length) for (const id of f.addLines) if (!e.lines.includes(id)) { e.lines.push(id); e.old.push(ocr.find((o) => o.id === id)?.text ?? ''); }
      }
      applied = await mergePrior(env, prior, await applyEditsRot(page, ocr, edits, env.lib, base, { vectorOnly: env.vectorOnly }));
      const n = fixes.filter((f: any) => edits[f.edit]?.kind === 'text').length;
      // look once more: only claim it's fixed when it really is, otherwise tell Elin what to check
      log('AI kontrollerar rättelsen …');
      const ck2 = n ? normCheck(await check(applied, 'low')) : ck;
      if (n && ck2.ok) notes.push(`Rättat efter kontrollen: ${n === 1 ? 'en sak' : `${n} saker`} (t.ex. ${String(ck.problems?.[0] ?? '').replace(/^Edit \d+:\s*/i, '').slice(0, 120)}).`);
      else notes.push(...(ck2.problems?.length ? ck2.problems : ck.problems ?? []).map((p: string) => `Att titta på: ${p.replace(/^Edit \d+:\s*/i, '')}`));
    } else if (ck.problems?.length) notes.push(...ck.problems.map((p: string) => `Att titta på: ${p.replace(/^Edit \d+:\s*/i, '')}`));
  } catch (err: any) {
    log(`  kontroll misslyckades: ${err?.stack ?? err}`);
    applied = firstApplied;
    notes.push('Att titta på: Den automatiska kontrollen kunde inte köras den här gången. Titta extra noga på resultatet.');
  }
  for (const r of applied.reports) notes.push(...r.warnings);
  try { const sc = selfCheck(page, applied, edits, ocr); if (sc.length) log(`  självkontroll: ${sc.join(' | ')}`); notes.push(...sc); } catch (err: any) { log(`  självkontroll misslyckades: ${err?.message ?? err}`); }
  usage.ms = Date.now() - t0;
  return { applied, edits, summary: asText(plan.summary), usage, notes };
}

/** Crop + scale part of a raster. */
function cropScale(env: { lib: FontLib }, r: Raster, b: Box, sc: number): Raster {
  const w = Math.max(1, Math.round(b.x1 - b.x0)), h = Math.max(1, Math.round(b.y1 - b.y0));
  const src = env.lib.platform.createCanvas(w, h);
  const sctx = src.getContext('2d');
  const id = sctx.createImageData(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const sx = Math.min(r.w - 1, Math.max(0, Math.round(b.x0) + x)), sy = Math.min(r.h - 1, Math.max(0, Math.round(b.y0) + y));
    const i = (sy * r.w + sx) * 4, j = (y * w + x) * 4;
    id.data[j] = r.data[i]; id.data[j + 1] = r.data[i + 1]; id.data[j + 2] = r.data[i + 2]; id.data[j + 3] = 255;
  }
  sctx.putImageData(id, 0, 0);
  const W = Math.max(1, Math.round(w * sc)), H = Math.max(1, Math.round(h * sc));
  const out = env.lib.platform.createCanvas(W, H);
  const octx = out.getContext('2d');
  octx.imageSmoothingQuality = 'high';
  octx.drawImage(src, 0, 0, W, H);
  return canvasToRaster(octx, W, H);
}

/** Stack captioned tiles into as few pictures as possible (each ≤ maxPx pixels). */
function collage(env: { lib: FontLib }, tiles: { r: Raster; caption: string }[], W = 1150, maxPx = 1.1e6): Raster[] {
  const CAP = 24, GAP = 8;
  const pages: { r: Raster; caption: string; s: number }[][] = [[]];
  let hNow = 0;
  for (const t of tiles) {
    const s = Math.min(1, W / t.r.w);
    const th = Math.round(t.r.h * s) + CAP + GAP;
    if (hNow + th > maxPx / W && pages[pages.length - 1].length) { pages.push([]); hNow = 0; }
    pages[pages.length - 1].push({ ...t, s }); hNow += th;
  }
  return pages.map((pg) => {
    const H = pg.reduce((a, t) => a + Math.round(t.r.h * t.s) + CAP + GAP, 0);
    const cv = env.lib.platform.createCanvas(W, Math.max(1, H));
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
    let y = 0;
    for (const t of pg) {
      ctx.fillStyle = '#c0392b'; ctx.font = 'bold 18px sans-serif'; ctx.fillText(t.caption, 4, y + 18);
      y += CAP;
      const tw = Math.round(t.r.w * t.s), th = Math.round(t.r.h * t.s);
      const tc = env.lib.platform.createCanvas(t.r.w, t.r.h);
      const tctx = tc.getContext('2d');
      const id = tctx.createImageData(t.r.w, t.r.h); id.data.set(t.r.data); tctx.putImageData(id, 0, 0);
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(tc, 0, y, tw, th);
      y += th + GAP;
    }
    return canvasToRaster(ctx, W, H);
  });
}

/** Two rasters side by side with a gap. */
function sideBySide(env: { lib: FontLib }, a: Raster, b: Raster): Raster {
  const G = 12, W = a.w + b.w + G, H = Math.max(a.h, b.h);
  const out: Raster = { w: W, h: H, data: new Uint8ClampedArray(W * H * 4).fill(255) };
  for (const [r, ox] of [[a, 0], [b, a.w + G]] as const)
    for (let y = 0; y < r.h; y++) out.data.set(r.data.subarray(y * r.w * 4, (y + 1) * r.w * 4), (y * W + ox) * 4);
  void env;
  return out;
}

function canvasToRaster(ctx: any, w: number, h: number): Raster {
  const d = ctx.getImageData(0, 0, w, h);
  return { w, h, data: new Uint8ClampedArray(d.data) };
}

/** Page picture with the new text drawn on top (for Claude's check and the preview). */
export async function renderPreview(env: { lib: FontLib }, a: Applied, w: number, h: number): Promise<Raster> {
  const cv = env.lib.platform.createCanvas(w, h);
  const ctx = cv.getContext('2d');
  const id = ctx.createImageData(w, h);
  id.data.set(a.raster.data);
  ctx.putImageData(id, 0, 0);
  for (const it of a.items) {
    const font = await env.lib.load(it.key);
    drawText(ctx, font, it.text, it.x, it.baseline, it.size, it.tracking, `rgb(${it.color.map(Math.round).join(',')})`, it.hs ?? 1, it.bold ?? 0, it.slant ?? 0);
  }
  return canvasToRaster(ctx, w, h);
}
