// Plan with loose boxes (like a small model gives): do they snap onto the real text?
// npx tsx scripts/try-snap.ts <in.pdf> <out.pdf> <dx> <dy>   (dx,dy: how far off the AI's boxes are, in 1/1190 page widths)
import { readFile, writeFile } from 'node:fs/promises';
import { createCanvas } from '@napi-rs/canvas';
import { readPage, writePdf } from '../src/engine/pdf';
import { runRequest } from '../src/engine/agent';
import { codec, makeLib } from './node-platform';
import { ocrRaster, ocrRegion, closeOcr } from './ocr-node';
const [f, out, dxS = '0', dyS = '0'] = process.argv.slice(2);
const bytes = new Uint8Array(await readFile(f));
const { image, raster } = await readPage(bytes, codec, 0);
const ocr = await ocrRaster(raster);
const lib = await makeLib();
const k = raster.w / 1190.55; // px per pt
const SC = Math.min(1, 1568 / Math.max(raster.w, raster.h));
const dx = +dxS * k, dy = +dyS * k;
const bx = (cx: number, base: number, w: number) => ({ x0: Math.round((cx - w / 2) * k + dx) * SC, x1: Math.round((cx + w / 2) * k + dx) * SC, y0: Math.round((842 - base - 11) * k + dy) * SC, y1: Math.round((842 - base + 3) * k + dy) * SC });
const edits: any[] = [];
for (const l of ocr) if (/^\d+,\d m²$/.test(l.text.trim())) edits.push({ lines: [l.id], old: [l.text.trim()], new: l.text.trim().replace('m²', 'cm²'), style: 'sans', group: 'a' });
edits.push({ lines: [], boxes: [bx(281.25, 650.25 - 0, 44)], old: ['11,9 m²'], new: '11,9 cm²', style: 'sans', group: 'a' });
edits.push({ lines: [], boxes: [bx(622.5, 324, 36)], old: ['9,4 m²'], new: '9,4 cm²', style: 'sans', group: 'a' });
console.log('edits', edits.length);
const res = await runRequest({
  lib, model: 'fake',
  claude: async (body: any) => { const t = body.tools?.[0]; const input = t.name === 'edit_plan' ? { summary: 'x', edits } : t.name === 'check_result' ? { ok: true } : { picks: [] }; return { content: [{ type: 'tool_use', name: t.name, input }], stop_reason: 'tool_use', usage: {} }; },
  encode: async (r: any, box?: any) => ({ media_type: 'image/jpeg', data: createCanvas(8, 8).toBuffer('image/jpeg').toString('base64') }),
  ocrRegion: (b: any) => ocrRegion(raster, b), log: () => {},
} as any, raster, ocr, { instruction: 'Ändra alla m² till cm²' } as any);
console.log('notes', res.notes, 'question', res.question);
for (const r of res.applied?.reports ?? []) console.log(r.index, r.mode, JSON.stringify((res.edits[r.index] as any)?.new), r.warnings.join(' '));
if (res.applied) await writeFile(out, await writePdf(bytes, image, res.applied.raster, res.applied.items, lib, codec, raster));
await closeOcr();
