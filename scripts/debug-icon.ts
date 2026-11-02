import { readFile, writeFile } from 'node:fs/promises';
import { readPage } from '../src/engine/pdf';
import { applyEdits, snapElement } from '../src/engine/edit';
import { analyzeLine } from '../src/engine/analyze';
import { codec, makeLib } from './node-platform';
import { ocrRaster, ocrRegion, closeOcr } from './ocr-node';
import { createCanvas } from '@napi-rs/canvas';
const { raster } = await readPage(new Uint8Array(await readFile('/home/claude/elin-v2/samples/chat-brownie-2.pdf')), codec);
const ocr = await ocrRaster(raster);
const rough = { x0: 744, y0: 684, x1: 790, y1: 704 };
const reg = await ocrRegion(raster, { x0: rough.x0 - 30, y0: rough.y0 - 30, x1: rough.x1 + 30, y1: rough.y1 + 30 });
console.log('region OCR', reg.map((l) => [l.text, Object.values(l.box).map(Math.round)]));
const sn = snapElement(raster, rough, { text: true }); console.log('snap', sn.box && Object.values(sn.box));
await closeOcr();
const hits = ocr.filter((l) => /17\s*5/.test(l.text));
for (const h of hits) console.log(h.id, JSON.stringify(h.text), Object.values(h.box).map(Math.round));
const icon = hits.find((h) => h.text.replace(/\s/g, '').length <= 7) ?? hits[hits.length - 1];
const info = analyzeLine(raster, icon.box);
console.log('inkBox', Object.values(info.inkBox).map(Math.round), 'area', Object.values(info.area).map(Math.round), 'color', info.color, 'noise', info.noise.toFixed(1));
const res = await applyEdits(raster, ocr, [{ kind: 'text', lines: [], boxes: [sn.box!], old: ['175°C'], new: '180°C', align: 'center' }], await makeLib());
icon.box = rough;
const b = { x0: Math.round(icon.box.x0 - 40), y0: Math.round(icon.box.y0 - 30), x1: Math.round(icon.box.x1 + 40), y1: Math.round(icon.box.y1 + 30) };
const w = b.x1 - b.x0, h = b.y1 - b.y0, S = 6, c = createCanvas(w * S, h * 2 * S + 10), g = c.getContext('2d');
for (const [r, k] of [[raster, 0], [res.raster, 1]] as const) {
  const t = createCanvas(w, h), id = t.getContext('2d').createImageData(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = ((b.y0 + y) * r.w + b.x0 + x) * 4, j = (y * w + x) * 4; for (let q = 0; q < 3; q++) id.data[j + q] = r.data[i + q]; id.data[j + 3] = 255; }
  t.getContext('2d').putImageData(id, 0, 0); g.imageSmoothingEnabled = false; g.drawImage(t as any, 0, k * (h * S + 10), w * S, h * S);
}
await writeFile(process.argv[2], c.toBuffer('image/png'));
console.log(res.reports.map((r) => [r.mode, r.warnings]));
