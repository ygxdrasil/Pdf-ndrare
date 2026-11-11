// Replays a "felsokning.json" saved from the app (button "Spara felsökning") through the engine in Node.
// npx tsx scripts/replay-dump.ts <felsokning.json> <in.pdf> <out.pdf>
import { readFile, writeFile } from 'node:fs/promises';
import { createCanvas } from '@napi-rs/canvas';
import { readPage, writePdf } from '../src/engine/pdf';
import { runRequest } from '../src/engine/agent';
import { codec, makeLib } from './node-platform';
import { ocrRegion, closeOcr } from './ocr-node';
const [dumpPath, pdfPath, out] = process.argv.slice(2);
const dump = JSON.parse(await readFile(dumpPath, 'utf8'));
const bytes = new Uint8Array(await readFile(pdfPath));
const { image, raster } = await readPage(bytes, codec, 0);
console.log('page', raster.w, raster.h, 'dump page', dump.page, 'ppi', (image as any).ppi);
const ocr = dump.ocr;
const queue: any[] = dump.responses.map((r: any[]) => r);
const lib = await makeLib();
const res = await runRequest({
  lib, model: 'replay', compact: true, effort: 'medium',
  claude: async (body: any) => { const t = body.tools?.[0]; const r = queue.shift() ?? []; const hit = r.find((x: any) => x.name === t?.name) ?? r[0]; return { content: hit ? [{ type: 'tool_use', name: hit.name, input: hit.input }] : [], stop_reason: 'tool_use', usage: {} }; },
  encode: async () => ({ media_type: 'image/jpeg', data: createCanvas(8, 8).toBuffer('image/jpeg').toString('base64') }),
  ocrRegion: (b: any) => ocrRegion(raster, b), log: (m: string) => console.log(m),
} as any, raster, ocr, { instruction: dump.instruction, mark: dump.mark } as any);
console.log('notes', res.notes, 'question', res.question);
for (const r of res.applied?.reports ?? []) console.log(r.index, r.mode, r.font, JSON.stringify((res.edits[r.index] as any)?.new), r.warnings.join(' '));
if (res.applied) await writeFile(out, await writePdf(bytes, image, res.applied.raster, res.applied.items, lib, codec, raster));
await closeOcr();
