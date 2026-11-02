// Engine-only test on a real file, saved the way the app saves it.
// npx tsx scripts/try-file.ts <file.pdf|png|jpg> <out> '<json edits: [{find, new, align?, style?, nth?}]>' [pageIndex]
import { readFile, writeFile } from 'node:fs/promises';
import { readPage, readImage, writePdf, writeImage } from '../src/engine/pdf';
import { applyEdits, Edit } from '../src/engine/edit';
import { renderPreview } from '../src/engine/agent';
import { codec, makeLib } from './node-platform';
import { ocrRaster, closeOcr } from './ocr-node';
const [f, out, spec, pg = '0'] = process.argv.slice(2);
const bytes = new Uint8Array(await readFile(f));
const isImg = /\.(png|jpe?g)$/i.test(f);
const { image, raster } = isImg ? await readImage(bytes, /png$/i.test(f) ? 'image/png' : 'image/jpeg', codec) : await readPage(bytes, codec, +pg);
const ocr = await ocrRaster(raster); await closeOcr();
const lib = await makeLib();
const edits: Edit[] = [];
for (const e of JSON.parse(spec)) {
  const hits = ocr.filter((o: any) => o.text.includes(e.find));
  if (!hits.length) { console.log('NOT FOUND', e.find, ocr.map((o: any) => o.text).join(' | ').slice(0, 2000)); process.exit(1); }
  for (const h of e.nth === undefined ? hits : [hits[e.nth]]) edits.push({ kind: 'text', lines: [h.id], old: [h.text], new: h.text.replace(e.find, e.new), align: e.align ?? 'left', style: e.style });
}
const vectorOnly = image.mode === 'render' && (image.ppi ?? 300) < 200;
const res = await applyEdits(raster, ocr, edits, lib, undefined, { vectorOnly });
for (const r of res.reports) console.log(r.index, r.mode, r.font, JSON.stringify((edits[r.index] as any).new), r.warnings.join(' '));
const o = image.mode === 'image'
  ? await writeImage(image, res.raster, res.items, lib, codec, (a) => renderPreview({ lib }, a as any, image.w, image.h))
  : await writePdf(bytes, image, res.raster, res.items, lib, codec, raster);
await writeFile(out, o);
console.log('mode', image.mode, 'ppi', image.ppi, 'vectorOnly', vectorOnly);
