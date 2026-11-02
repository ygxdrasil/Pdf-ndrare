import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { readPage, writePdf } from '../src/engine/pdf';
import { applyEdits, Edit } from '../src/engine/edit';
import { codec, makeLib } from './node-platform';
import { ocrRaster } from './ocr-node';
const OUT = '/home/claude/elin-v2/work/out';
await mkdir(OUT, { recursive: true });
const bytes = new Uint8Array(await readFile('/home/claude/elin-v2/samples/original.pdf'));
const t0 = Date.now();
const { image, raster } = await readPage(bytes, codec);
console.log('image', image.w, image.h, image.ctm.map((v) => +v.toFixed(3)));
const ocr = await ocrRaster(raster); await (await import("./ocr-node")).closeOcr();
await writeFile(OUT + '/ocr.json', JSON.stringify(ocr, null, 1));
console.log('ocr', ocr.length, Date.now() - t0, 'ms');
const find = (s: string, nearX?: number) => ocr.filter((l) => l.text.includes(s) && (nearX === undefined || Math.abs(l.box.x0 - nearX) < 200));
console.log(find('MARIA'), find('50 x 60'));
const lib = await makeLib();
const maria = ocr.find((l) => l.text === 'MARIA' && l.box.x0 < 640)!, size = ocr.find((l) => l.text.startsWith('50 x 60') && l.box.x0 < 640)!;
const head = ocr.filter((l) => /KVALSTERSKYDD|KUDDE/.test(l.text) && l.box.x0 < 640);
console.log(head);
const edits: Edit[] = [
  { kind: 'text', lines: [maria.id], old: ['MARIA'], new: 'SOFIA', align: 'center' },
  { kind: 'text', lines: [size.id], old: ['50 × 60 cm'], new: '60 × 70 cm', align: 'center' },
  { kind: 'text', lines: head.map((h) => h.id), old: ['KVALSTERSKYDD', 'FÖR KUDDE'], new: 'KLADDIGA\nBROWNIES', align: 'center' },
];
const t1 = Date.now();
const res = await applyEdits(raster, ocr, edits, lib);
console.log('apply', Date.now() - t1, 'ms');
for (const r of res.reports) console.log(r.index, r.font, r.sizePx, r.shrunk, r.warnings, r.match?.ranking.slice(0, 4));
const pdf = await writePdf(bytes, image, res.raster, res.items, lib, codec);
await writeFile(OUT + '/manual.pdf', pdf);
console.log('done', Date.now() - t0, 'ms');
