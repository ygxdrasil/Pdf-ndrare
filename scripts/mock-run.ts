// End-to-end through the real agent pipeline with a MOCK planner (no AI call): the plan is built from a try-plan style spec
// (line edits only), so plan -> edit conversion, the engine's own checks, read-back and the notes can be tried together.
// npx tsx scripts/mock-run.ts <in.pdf> <out.pdf> '<json spec>'   (OCRCACHE / OCRNAME / OCRTILES as in try-plan.ts)
import { readFile, writeFile } from 'node:fs/promises';
import { readPage, writePdf } from '../src/engine/pdf';
import { runRequest } from '../src/engine/agent';
import { codec, makeLib } from './node-platform';
import { ocrRaster, ocrRegion, readText, closeOcr } from './ocr-node';
import { createCanvas } from '@napi-rs/canvas';
const [f, out, specJson] = process.argv.slice(2);
const bytes = new Uint8Array(await readFile(f));
const { image, raster } = await readPage(bytes, codec, +(process.env.PAGE ?? 0));
let ocr: any = null;
const cacheF = process.env.OCRCACHE ? process.env.OCRCACHE + '/' + (process.env.OCRNAME ?? f.split('/').pop()) + (+(process.env.PAGE ?? 0) ? '.p' + process.env.PAGE : '') + '.json' : '';
try { if (cacheF) ocr = JSON.parse(await readFile(cacheF, 'utf8')); } catch { /* not cached */ }
if (!ocr) { ocr = await ocrRaster(raster); }
let n = 0; for (const l of ocr) l.id = l.id || n++ ; // ids as in the cache
const ocrIds = ocr.map((l: any, i: number) => ({ ...l, id: l.id ?? i }));
const spec = JSON.parse(specJson);
const edits = spec.filter((e: any) => e.find || e.id !== undefined).map((e: any) => {
  const hit = ocrIds.find((o: any) => (e.id !== undefined ? o.id === e.id : e.exact ? o.text.trim() === e.find : o.text.includes(e.find)));
  return hit ? { lines: [hit.id], old: [e.old ?? hit.text], new: e.new, style: e.style ?? 'sans', group: 'g', align: e.align ?? 'left' } : null;
}).filter(Boolean);
const lib = await makeLib();
const encode = async (r: any, box?: any, scale = 1) => { const b = box ?? { x0: 0, y0: 0, x1: r.w, y1: r.h }; const c = createCanvas(Math.max(1, Math.round((b.x1 - b.x0) * scale)), Math.max(1, Math.round((b.y1 - b.y0) * scale))); return { media_type: 'image/jpeg', data: c.toBuffer('image/jpeg').toString('base64') }; };
const res = await runRequest({
  lib, model: 'mock', compact: true, readBack: readText,
  claude: async (body: any) => { const tool = body.tools?.[0]; const input = tool.name === 'check_result' ? { ok: true } : { summary: 'mock', edits }; return { content: [{ type: 'tool_use', name: tool.name, input }], usage: {}, stop_reason: 'end_turn' }; },
  encode, ocrRegion: (b: any) => ocrRegion(raster, b), log: () => {},
}, raster, ocrIds, { instruction: 'mock' });
await closeOcr();
console.log('NOTES', JSON.stringify(res.notes));
for (const r of res.applied!.reports) console.log(r.index, r.mode, r.font, r.warnings.join(' '));
await writeFile(out, await writePdf(bytes, image, res.applied!.raster, res.applied!.items, lib, codec, raster));
