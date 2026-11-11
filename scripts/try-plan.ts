// Engine test as the app uses it: the plan gives `old` (as printed) and `new`; `find` only locates the OCR line.
// npx tsx scripts/try-plan.ts <in.png|in.pdf> <out.png|out.pdf> '<json: [{find, old, new, align?, style?}]>'
import { readFile, writeFile } from 'node:fs/promises';
import { readImage, readPage, writeImage, writePdf } from '../src/engine/pdf';
import { Edit } from '../src/engine/edit';
import { applyEditsRot } from '../src/engine/rotate';
import { renderPreview } from '../src/engine/agent';
import { codec, makeLib } from './node-platform';
import { ocrRaster, closeOcr } from './ocr-node';
const [f, out, spec] = process.argv.slice(2);
const bytes = new Uint8Array(await readFile(f));
const isPdf = /\.pdf$/i.test(f);
const { image, raster } = isPdf ? await readPage(bytes, codec, 0) : await readImage(bytes, 'image/png', codec);
const ocr = await ocrRaster(raster); await closeOcr();
if (process.env.SHRINK) for (const l of ocr) { const w = l.words; if (w && w.length >= 2) { const b = w[w.length - 1].box; b.x0 += (b.x1 - b.x0) * +process.env.SHRINK; } } // test: word boxes that miss part of the letters
console.log('OCR:', ocr.map((o) => `${o.id}:${o.rot ? '↻' : ''}${o.text}`).join(' | '));
const lib = await makeLib();
const edits: Edit[] = [];
for (const e of JSON.parse(spec)) {
  const h = e.box ? [] : ocr.filter((o) => (e.exact ? o.text.trim() === e.find : o.text.includes(e.find)));
  if (!h.length && !e.box) { console.log('NOT FOUND', e.find); continue; }
  if (e.box) { const k = e.refW ? raster.w / e.refW : 1; /* box given for a picture e.refW wide */ const bx = { x0: e.box.x0 * k, y0: e.box.y0 * k, x1: e.box.x1 * k, y1: e.box.y1 * k }; edits.push({ kind: 'text', lines: [], boxes: [bx], old: [e.old], new: e.new, align: e.align ?? 'left', style: e.style, group: e.group }); continue; }
  for (const x of h) edits.push({ kind: 'text', lines: [x.id], old: [e.old ?? x.text], new: e.new, align: e.align ?? 'left', style: e.style, group: e.group });
}
const vectorOnly = image.mode === 'render' && (image.ppi ?? 300) < 200;
console.log('mode', image.mode, 'ppi', image.ppi, 'vectorOnly', vectorOnly);
const res = await applyEditsRot(raster, ocr, edits, lib, undefined, { vectorOnly });
for (const r of res.reports) console.log(r.index, r.mode, r.font, JSON.stringify((edits[r.index] as any).new), r.warnings.join(' '));
const outBytes = isPdf
  ? await writePdf(bytes, image, res.raster, res.items, lib, codec, raster)
  : await writeImage(image, res.raster, res.items, lib, codec, (a) => renderPreview({ lib }, a as any, image.w, image.h));
await writeFile(out, outBytes);
