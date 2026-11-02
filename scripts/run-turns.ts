// Multi-turn real run like the app: npx tsx scripts/run-turns.ts <pdf> <outdir> "<instr 1>" "<instr 2>" ...
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { createCanvas } from '@napi-rs/canvas';
import { readPage, writePdf } from '../src/engine/pdf';
import { runRequest, renderPreview } from '../src/engine/agent';
import type { Raster, Box } from '../src/engine/raster';
import { codec, makeLib } from './node-platform';
import { ocrRaster, ocrRegion, closeOcr } from './ocr-node';
for (const line of readFileSync('/home/claude/elin-v2/.env', 'utf8').split('\n')) { const m = line.match(/^(\w+)=(.*)$/); if (m) process.env[m[1]] = m[2]; }
function encodeFn(r: Raster, box?: Box, scale = 1) {
  const b = box ?? { x0: 0, y0: 0, x1: r.w, y1: r.h };
  const w = Math.round(b.x1 - b.x0), h = Math.round(b.y1 - b.y0);
  const src = createCanvas(w, h);
  const id = src.getContext('2d').createImageData(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = ((Math.round(b.y0) + y) * r.w + Math.round(b.x0) + x) * 4, j = (y * w + x) * 4;
    id.data[j] = r.data[i]; id.data[j + 1] = r.data[i + 1]; id.data[j + 2] = r.data[i + 2]; id.data[j + 3] = 255;
  }
  src.getContext('2d').putImageData(id, 0, 0);
  let out: any = src;
  // keep images within Claude's sweet spot (~1600 px long side)
  const s = Math.min(scale, 1600 / Math.max(w, h));
  if (Math.abs(s - 1) > 0.01) {
    out = createCanvas(Math.round(w * s), Math.round(h * s));
    const g = out.getContext('2d'); g.imageSmoothingQuality = 'high';
    g.drawImage(src as any, 0, 0, Math.round(w * s), Math.round(h * s));
  }
  return { media_type: 'image/jpeg', data: out.toBuffer('image/jpeg', 92).toString('base64') };
}


const [pdfPath, OUT, ...instr] = process.argv.slice(2);
await mkdir(OUT, { recursive: true });
const model = process.env.MODEL ?? 'claude-opus-5-5';
const bytes = new Uint8Array(await readFile(pdfPath));
const { image, raster } = await readPage(bytes, codec);
console.log('page', raster.w, 'x', raster.h, 'mode', (image as any).mode, 'ppi', (image as any).ppi, 'reason', (image as any).reason);
const lib = await makeLib();
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
let clean: Raster = raster, items: any[] = [], preview: Raster = raster;
const history: { role: 'user' | 'assistant'; text: string }[] = [];
let total = 0;
for (let t = 0; t < instr.length; t++) {
  const instruction = instr[t];
  console.log(`\n=== turn ${t + 1}: ${instruction}`);
  const ocr = await ocrRaster(preview);
  try {
    const res = await runRequest({ lib, model, effort: 'medium', compact: true, vectorOnly: (image as any).mode === 'render' && ((image as any).ppi ?? 300) < 200,
      claude: async (body: any) => (await client.messages.stream({ ...body, model }).finalMessage()) as any,
      encode: async (r: any, box?: any, scale?: number) => encodeFn(r, box, scale), log: (m: string) => { if (!m.startsWith('  ') || m.includes('misslyckades')) console.log('  ·', m); },
      ocrRegion: (b: any) => ocrRegion(preview, b) } as any, preview, ocr, { instruction, history: history.slice(-6) } as any, clean, items);
    const cost = (res.usage.input * 5 + res.usage.output * 25) / 1e6 * 10.8; total += cost;
    console.log(`  ${(res.usage.ms / 1000).toFixed(0)} s, ≈${cost.toFixed(1)} kr`);
    history.push({ role: 'user', text: instruction });
    if (res.question) { console.log('  QUESTION:', res.question); history.push({ role: 'assistant', text: res.question }); continue; }
    for (const r of res.applied!.reports) console.log('  edit', r.index, r.mode, JSON.stringify((res.edits[r.index] as any).old ?? ''), '->', JSON.stringify((res.edits[r.index] as any).new ?? ''), r.warnings.join(' '));
    console.log('  summary:', res.summary); console.log('  notes:', res.notes.filter((n) => /Att titta|Rättat|krympt/.test(n)));
    clean = res.applied!.raster; items = res.applied!.items;
    preview = await renderPreview({ lib }, res.applied!, clean.w, clean.h);
    await writeFile(`${OUT}/turn${t + 1}.png`, await codec.encodePng(preview));
    history.push({ role: 'assistant', text: res.summary + (res.notes.length ? '\n' + res.notes.filter((n) => /Att titta/.test(n)).join('\n') : '') });
  } catch (e: any) { console.log('  ERROR:', e?.message); console.log(e?.stack?.split('\n').slice(1, 4).join('\n')); }
}
await writeFile(`${OUT}/final.pdf`, await writePdf(bytes, image, clean, items, lib, codec));
console.log(`\ntotal ≈${total.toFixed(1)} kr`);
await closeOcr();
