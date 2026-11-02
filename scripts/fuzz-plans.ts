// Feeds malformed Claude answers through runRequest to find crashes. No API calls.
import { readFile } from 'node:fs/promises';
import { readPage } from '../src/engine/pdf';
import { runRequest } from '../src/engine/agent';
import { codec, makeLib } from './node-platform';
import { ocrRegion, closeOcr } from './ocr-node';
import { createCanvas } from '@napi-rs/canvas';
const bytes = new Uint8Array(await readFile('/home/claude/elin-v2/samples/original.pdf'));
const { raster } = await readPage(bytes, codec);
const ocr = JSON.parse(await readFile('/home/claude/elin-v2/work/tests/ocr.json', 'utf8'));
const lib = await makeLib();
const encode = async (r: any, box?: any, scale = 1) => { const b = box ?? { x0: 0, y0: 0, x1: r.w, y1: r.h }; const w = Math.max(1, Math.round((b.x1 - b.x0) * Math.min(scale, 1))), h = Math.max(1, Math.round((b.y1 - b.y0) * Math.min(scale, 1))); const c = createCanvas(Math.min(w, 400), Math.min(h, 400)); return { media_type: 'image/jpeg', data: c.toBuffer('image/jpeg').toString('base64') }; };
const L = 0; // "ARTWORK - PROSENSE MARIA KUDDSKYDD"
const goodBox = { x0: 100, y0: 100, x1: 200, y1: 140 };
const plans: [string, any, any?][] = [
  ['new null', { edits: [{ lines: [L], old: ['x'], new: null }] }],
  ['new number', { edits: [{ lines: [L], new: 42 }] }],
  ['new array', { edits: [{ lines: [L], new: ['ARTWORK', 'ELIN'] }] }],
  ['lines string', { edits: [{ lines: String(L), new: 'X' }] }],
  ['lines number', { edits: [{ lines: L, new: 'X' }] }],
  ['lines bad id', { edits: [{ lines: [9999], new: 'X' }] }],
  ['old string', { edits: [{ lines: [L], old: 'MARIA', new: 'ELIN' }] }],
  ['boxes NaN', { edits: [{ boxes: [{ x0: NaN, y0: 1, x1: 2, y1: 3 }], new: 'X' }] }],
  ['boxes inverted', { edits: [{ boxes: [{ x0: 300, y0: 300, x1: 100, y1: 100 }], new: 'X' }] }],
  ['boxes array form', { edits: [{ boxes: [[100, 100, 200, 140]], new: 'X' }] }],
  ['boxes off page', { edits: [{ boxes: [{ x0: -500, y0: -500, x1: 99999, y1: 99999 }], new: 'X' }] }],
  ['erase off page', { erase: [{ x0: -50, y0: -50, x1: 99999, y1: 99999 }] }],
  ['erase inverted', { erase: [{ x0: 300, y0: 300, x1: 100, y1: 100 }] }],
  ['erase zero', { erase: [{ x0: 100, y0: 100, x1: 100, y1: 100 }] }],
  ['erase string', { erase: 'all' }],
  ['moves bad to', { moves: [{ box: goodBox, to: { x: 'abc', y: null } }] }],
  ['moves off page', { moves: [{ box: goodBox, to: { x: 99999, y: -99999 } }] }],
  ['edits null', { edits: null, erase: null, moves: null }],
  ['edits object', { edits: { lines: [L], new: 'X' } }],
  ['align weird', { edits: [{ lines: [L], new: 'X', align: 'diagonal', style: 7, group: 3 }] }],
  ['maxWidth string', { edits: [{ lines: [L], new: 'X', maxWidth: 'wide', maxHeight: -5 }] }],
  ['empty plan', {}],
  ['question + edits', { question: 'Vilken?', edits: [{ lines: [L], new: 'X' }] }],
  ['erase+move then fix new null', { erase: [goodBox], moves: [{ box: { x0: 300, y0: 300, x1: 380, y1: 360 }, to: { x: 250, y: 300 } }], edits: [{ lines: [L], new: 'ARTWORK - PROSENSE ELIN KUDDSKYDD' }] },
    { ok: false, problems: ['x'], fixes: [{ edit: 2, new: null }, { edit: 0, new: 'Y' }, { edit: 1, align: 'left' }] }],
  ['fix index out of range', { edits: [{ lines: [L], new: 'X' }] }, { ok: false, fixes: [{ edit: 99, new: 'Y' }, { edit: -1 }, { edit: '0', new: ['A'] }] }],
  ['fix addLines string', { edits: [{ lines: [L], new: 'X' }] }, { ok: false, fixes: [{ edit: 0, addLines: '3', weight: 'heavier', size: 'bigger' }] }],
  ['fix addLines bad ids', { edits: [{ lines: [L], new: 'X' }] }, { ok: false, fixes: [{ edit: 0, addLines: [9999, null] }] }],
  ['check problems not array', { edits: [{ lines: [L], new: 'X' }] }, { ok: false, problems: 'bad', fixes: 'none' }],
  ['check fixes not array', { edits: [{ lines: [L], new: 'X' }] }, { ok: false, fixes: { edit: 0 } }],
];
let fails = 0;
for (const [name, plan, check] of plans) {
  try {
    const res = await runRequest({
      lib, model: 'fuzz', compact: true,
      claude: async (body: any) => { const tool = body.tools?.[0]; const input = tool.name === 'edit_plan' ? plan : tool.name === 'check_result' ? (check ?? { ok: true }) : { picks: [] }; return { content: [{ type: 'tool_use', name: tool.name, input }], usage: {}, stop_reason: 'end_turn' }; },
      encode, ocrRegion: (b: any) => ocrRegion(raster, b), log: () => {},
    } as any, raster, ocr, { instruction: 'fuzz' } as any);
    console.log('OK  ', name, res.question ? '(question)' : `${res.applied?.reports?.length ?? 0} reports`);
  } catch (e: any) {
    fails++; console.log('FAIL', name, '->', String(e?.message ?? e).slice(0, 160));
  }
}
await closeOcr();
console.log(`\n${fails} failures of ${plans.length}`);
