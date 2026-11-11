// Engine test as the app uses it: the plan gives `old` (as printed) and `new`; `find` only locates the OCR line.
// npx tsx scripts/try-plan.ts <in.png> <out.png> '<json: [{find, old, new, align?, style?}]>'
import { readFile, writeFile } from 'node:fs/promises';
import { readImage, writeImage } from '../src/engine/pdf';
import { Edit } from '../src/engine/edit';
import { applyEditsRot } from '../src/engine/rotate';
import { renderPreview } from '../src/engine/agent';
import { codec, makeLib } from './node-platform';
import { ocrRaster, closeOcr } from './ocr-node';
const [f, out, spec] = process.argv.slice(2);
const bytes = new Uint8Array(await readFile(f));
const { image, raster } = await readImage(bytes, 'image/png', codec);
const ocr = await ocrRaster(raster); await closeOcr();
console.log('OCR:', ocr.map((o) => `${o.id}:${o.rot ? '↻' : ''}${o.text}`).join(' | '));
const lib = await makeLib();
const edits: Edit[] = [];
for (const e of JSON.parse(spec)) {
  const h = e.box ? [] : ocr.filter((o) => (e.exact ? o.text.trim() === e.find : o.text.includes(e.find)));
  if (!h.length && !e.box) { console.log('NOT FOUND', e.find); continue; }
  if (e.box) { edits.push({ kind: 'text', lines: [], boxes: [e.box], old: [e.old], new: e.new, align: e.align ?? 'left', style: e.style, group: e.group }); continue; }
  for (const x of h) edits.push({ kind: 'text', lines: [x.id], old: [e.old ?? x.text], new: e.new, align: e.align ?? 'left', style: e.style, group: e.group });
}
const res = await applyEditsRot(raster, ocr, edits, lib);
for (const r of res.reports) console.log(r.index, r.mode, r.font, JSON.stringify((edits[r.index] as any).new), r.warnings.join(' '));
await writeFile(out, await writeImage(image, res.raster, res.items, lib, codec, (a) => renderPreview({ lib }, a as any, image.w, image.h)));
