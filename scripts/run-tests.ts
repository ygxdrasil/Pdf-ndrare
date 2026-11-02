// Runs real requests end to end with Claude: npx tsx scripts/run-tests.ts <model> <test ...>
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { createCanvas } from '@napi-rs/canvas';
import { readPage, writePdf } from '../src/engine/pdf';
import { runRequest, renderPreview } from '../src/engine/agent';
import type { Raster, Box } from '../src/engine/raster';
import { codec, makeLib } from './node-platform';
import { ocrRaster, ocrRegion, closeOcr } from './ocr-node';

for (const line of readFileSync('/home/claude/elin-v2/.env', 'utf8').split('\n')) {
  const m = line.match(/^(\w+)=(.*)$/);
  if (m) process.env[m[1]] = m[2];
}

const TESTS: Record<string, { instruction: string; mark?: Box; history?: any[] }> = {
  brownie: { instruction: 'change the texts to brownie cooking instructions. change nothing else. this is gon get printed out so make sure its clear. ask questions if u got any' },
  brownie2: {
    instruction: 'Kör på dina förslag: svenska, alla produkttexter blir brownies (rubriker, sidornas texter, baksidans steg, material/tvättråd blir ingredienser/bakråd, viktigt-rutan, gröna bandet). Behåll ProSense-loggan, adress, webbadress, streckkod/koder, ARTWORK-raden och måtten/materialet längst till höger. Hitta på ett vanligt recept (ca 175 °C, 25 min).',
    history: [
      { role: 'user', text: 'change the texts to brownie cooking instructions. change nothing else. this is gon get printed out so make sure its clear. ask questions if u got any' },
      { role: 'assistant', text: 'Ska alla produkttexter bli brownie-instruktioner? Svenska? Har du ett recept?' },
    ],
  } as any,
  sofia: { instruction: 'Byt namnet MARIA till SOFIA överallt.' },
  size: { instruction: 'Ändra storleken 50 × 60 cm till 60 × 70 cm överallt.' },
  badges: { instruction: 'Ta bort OEKO-TEX- och ECARF-märkena på framsidan och fotnoten om dem längst ner.' },
};

const PRICES: Record<string, [number, number]> = { 'claude-opus-5-5': [5, 25], 'claude-sonnet-5-5': [2, 10] }; // $/M tokens (estimate)

export function encodeFn(r: Raster, box?: Box, scale = 1) {
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

const model = process.argv[2] ?? 'claude-sonnet-5-5';
const effort = process.env.EFFORT || undefined;
const tests = process.argv.slice(3);
const OUT = `/home/claude/elin-v2/work/tests/${model}${effort ? '-' + effort : ''}`;
await mkdir(OUT, { recursive: true });
const bytes = new Uint8Array(await readFile('/home/claude/elin-v2/samples/original.pdf'));
const { image, raster } = await readPage(bytes, codec);
const ocrPath = '/home/claude/elin-v2/work/tests/ocr.json';
let ocr;
if (existsSync(ocrPath)) ocr = JSON.parse(await readFile(ocrPath, 'utf8'));
else { const t = Date.now(); ocr = await ocrRaster(raster); console.log('OCR', Date.now() - t, 'ms'); await writeFile(ocrPath, JSON.stringify(ocr)); }
const lib = await makeLib();
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
for (const name of tests) {
  const t = TESTS[name];
  console.log(`\n=== ${name} (${model}) ===`);
  const res = await runRequest({
    lib, model, effort,
    claude: async (body) => (await client.messages.stream(body).finalMessage()) as any,
    encode: async (r, box, scale) => encodeFn(r, box, scale),
    log: (m) => console.log('  ·', m),
    ocrRegion: (b) => ocrRegion(raster, b),
    save: async (n, r) => { await writeFile(`${OUT}/${name}-${n}.jpg`, Buffer.from(encodeFn(r, undefined, 2).data, 'base64')); },
  }, raster, ocr, t);
  const [pi, po] = PRICES[model] ?? [3, 15];
  const cost = (res.usage.input * pi + res.usage.output * po) / 1e6;
  console.log('  summary:', res.summary, '| question:', res.question ?? '-');
  console.log('  notes:', res.notes);
  console.log(`  time ${(res.usage.ms / 1000).toFixed(1)} s, calls ${res.usage.calls}, tokens in ${res.usage.input} out ${res.usage.output}, ≈ $${cost.toFixed(3)} (${(cost * 10.8).toFixed(1)} kr)`);
  if (!res.applied) continue;
  for (const r of res.applied.reports) console.log('  edit', r.index, r.mode, r.font, r.sizePx, r.shrunk, r.warnings.join(' '), JSON.stringify((res.edits[r.index] as any).old), '->', JSON.stringify((res.edits[r.index] as any).new));
  const pdf = await writePdf(bytes, image, res.applied.raster, res.applied.items, lib, codec);
  await writeFile(`${OUT}/${name}.pdf`, pdf);
  await writeFile(`${OUT}/${name}.json`, JSON.stringify({ edits: res.edits, summary: res.summary, notes: res.notes, usage: res.usage, cost }, null, 1));
  const prev = await renderPreview({ lib }, res.applied, raster.w, raster.h);
  await writeFile(`${OUT}/${name}-preview.png`, await codec.encodePng(prev));
}
await closeOcr();
