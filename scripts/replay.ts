// Replays recorded Claude answers (from the browser stress test) through the engine in Node,
// so an engine fix can be checked without new Claude calls.
// npx tsx scripts/replay.ts <resp.txt> <out.pdf> [instruction]
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { readPage, writePdf } from '../src/engine/pdf';
import { runRequest } from '../src/engine/agent';
import { codec, makeLib } from './node-platform';
import { ocrRaster, ocrRegion, closeOcr } from './ocr-node';
import { createCanvas } from '@napi-rs/canvas';
const [respFile, outPdf, instruction = 'replay'] = process.argv.slice(2);
const blocks = (await readFile(respFile, 'utf8')).split('\n=== ').slice(1).map((b) => { const t = b.slice(b.indexOf('\n') + 1); return JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1)); });
const bytes = new Uint8Array(await readFile(process.env.PDF ?? '/home/claude/elin-v2/samples/original.pdf'));
const { image, raster } = await readPage(bytes, codec);
const ocrPath = '/home/claude/elin-v2/work/tests/ocr.json';
const ocr = existsSync(ocrPath) && !process.env.PDF ? JSON.parse(await readFile(ocrPath, 'utf8')) : await ocrRaster(raster);
const lib = await makeLib();
let k = 0;
const encode = async (r: any, box?: any, scale = 1) => { const b = box ?? { x0: 0, y0: 0, x1: r.w, y1: r.h }; const w = Math.max(1, Math.round((b.x1 - b.x0) * scale)), h = Math.max(1, Math.round((b.y1 - b.y0) * scale)); const c = createCanvas(w, h); return { media_type: 'image/jpeg', data: c.toBuffer('image/jpeg').toString('base64') }; };
const res = await runRequest({
  lib, model: 'replay', compact: true,
  claude: async (body: any) => { const tool = body.tools?.[0]; const input = tool.name === 'check_result' && process.env.NOCHECK ? { ok: true } : blocks[k++]; return { content: [{ type: 'tool_use', name: tool.name, input }], usage: {}, stop_reason: 'end_turn' }; },
  encode, ocrRegion: (b) => ocrRegion(raster, b), log: () => {},
}, raster, ocr, { instruction });
await closeOcr();
for (const r of res.applied!.reports) console.log(r.index, r.mode, r.font, JSON.stringify((res.edits[r.index] as any).old ?? ''), '->', JSON.stringify((res.edits[r.index] as any).new ?? ''), r.warnings.join(' '));
await writeFile(outPdf, await writePdf(bytes, image, res.applied!.raster, res.applied!.items, lib, codec));
