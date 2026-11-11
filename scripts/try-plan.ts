// Engine test as the app uses it: the plan gives `old` (as printed) and `new`; `find` only locates the OCR line.
// npx tsx scripts/try-plan.ts <in.png|in.pdf> <out.png|out.pdf> '<json: [{find, old, new, align?, style?}]>'
import { readFile, writeFile } from 'node:fs/promises';
import { readImage, readPage, writeImage, writePdf } from '../src/engine/pdf';
import { Edit } from '../src/engine/edit';
import { applyEditsRot } from '../src/engine/rotate';
import { renderPreview } from '../src/engine/agent';
import { selfCheck } from '../src/engine/selfcheck';
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
  if (e.sub) { // regex substitution on every OCR line it matches: sub = [pattern, replacement]
    const re = new RegExp(e.sub[0], 'g'); let n = 0;
    for (const x of ocr) { if (!re.test(x.text)) { re.lastIndex = 0; continue; } re.lastIndex = 0; const nt = x.text.replace(re, e.sub[1]); if (nt !== x.text) { edits.push({ kind: 'text', lines: [x.id], old: [x.text], new: nt, align: e.align ?? 'left', style: e.style, group: e.group }); n++; } }
    console.log('SUB', e.sub[0], '->', n, 'lines'); continue;
  }
  if (e.finds) { // a paragraph over several OCR lines: finds = start of each line, old = the lines' text
    const ids = e.finds.map((f: string) => ocr.find((o) => o.text.includes(f))?.id);
    if (ids.some((x: any) => x === undefined)) { console.log('NOT FOUND', e.finds.join(' / ')); continue; }
    edits.push({ kind: 'text', lines: ids, old: e.old, new: e.new, align: e.align ?? 'left', style: e.style, group: e.group }); continue;
  }
  const h = e.box ? [] : ocr.filter((o) => (e.exact ? o.text.trim() === e.find : o.text.includes(e.find)));
  if (!h.length && !e.box) { console.log('NOT FOUND', e.find); continue; }
  if (e.box) { const k = e.refW ? raster.w / e.refW : 1; /* box given for a picture e.refW wide */ const bx = { x0: e.box.x0 * k, y0: e.box.y0 * k, x1: e.box.x1 * k, y1: e.box.y1 * k }; edits.push({ kind: 'text', lines: [], boxes: [bx], old: [e.old], new: e.new, align: e.align ?? 'left', style: e.style, group: e.group }); continue; }
  for (const x of h) edits.push({ kind: 'text', lines: [x.id], old: [e.old ?? x.text], new: e.new, align: e.align ?? 'left', style: e.style, group: e.group });
}
const vectorOnly = image.mode === 'render' && (image.ppi ?? 300) < 200;
console.log('mode', image.mode, 'ppi', image.ppi, 'vectorOnly', vectorOnly);
const res = await applyEditsRot(raster, ocr, edits, lib, undefined, { vectorOnly });
if (process.env.STRAY) for (let y = 40; y < 90; y++) for (let x = 40; x < 90; x++) { const i = (y * res.raster.w + x) * 4; res.raster.data[i] = 255; res.raster.data[i + 1] = 255; res.raster.data[i + 2] = 255; } // test: damage outside every edit
console.log('SELFCHECK', JSON.stringify(selfCheck(raster, res, edits)));
for (const r of res.reports) console.log(r.index, r.mode, r.font, JSON.stringify((edits[r.index] as any).new), r.warnings.join(' '));
if (process.env.DUMPR) await writeFile(process.env.DUMPR, await codec.encodePng(res.raster)); // debug: the engine's own picture
const outBytes = isPdf
  ? await writePdf(bytes, image, res.raster, res.items, lib, codec, raster)
  : await writeImage(image, res.raster, res.items, lib, codec, (a) => renderPreview({ lib }, a as any, image.w, image.h));
await writeFile(out, outBytes);
