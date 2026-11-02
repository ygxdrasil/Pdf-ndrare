// Manual test of erase + move: remove two badges and spread the other three icons.
import { readFile, writeFile } from 'node:fs/promises';
import { readPage } from '../src/engine/pdf';
import { applyEdits, Edit } from '../src/engine/edit';
import { codec, makeLib } from './node-platform';
import { ocrRaster, closeOcr } from './ocr-node';
import { createCanvas } from '@napi-rs/canvas';
const OUT = process.argv[2];
const bytes = new Uint8Array(await readFile('/home/claude/elin-v2/samples/original.pdf'));
const { raster } = await readPage(bytes, codec);
const ocr = await ocrRaster(raster); await closeOcr();
const cap = (re: RegExp) => ocr.find((l) => re.test(l.text) && l.box.x0 < 640 && l.box.y0 > 600)!;
const merged = cap(/Kvalster/);
const wb = (re: RegExp) => ({ text: re.source, box: merged.words!.find((w) => re.test(w.text))!.box });
const items = [wb(/Kvalster/), wb(/Ventil/), wb(/Evolon/), cap(/OEKO/), cap(/ECARF/)];
console.log(items.map((l) => [l.text, Math.round(l.box.x0), Math.round(l.box.y0), Math.round(l.box.x1), Math.round(l.box.y1)]));
const iconTop = items[0].box.y0 - 48, rowBottom = Math.max(...ocr.filter((l) => l.box.y0 > items[0].box.y0 - 2 && l.box.y0 < items[0].box.y0 + 40 && l.box.x0 < 640).map((l) => l.box.y1)) + 3;
// item boxes: centred on caption, width = max(caption, icon ~44px)
const boxes = items.map((l) => { const cx = (l.box.x0 + l.box.x1) / 2, hw = Math.max((l.box.x1 - l.box.x0) / 2, 24) + 3; return { x0: cx - hw, x1: cx + hw, y0: iconTop, y1: rowBottom }; });
if (process.env.SHORT) boxes[2].y1 = items[2].box.y1 + 2;
const left = (boxes[0].x0 + boxes[0].x1) / 2, right = (boxes[4].x0 + boxes[4].x1) / 2;
const edits: Edit[] = [
  { kind: 'erase', box: boxes[3] }, { kind: 'erase', box: boxes[4] },
  ...[0, 1, 2].map((k) => { const cx = left + ((right - left) * k) / 2, b = boxes[k]; return { kind: 'move' as const, box: b, to: { x: cx - (b.x1 - b.x0) / 2, y: b.y0 } }; }),
];
const res = await applyEdits(raster, ocr, edits, await makeLib());
const bb = { x0: Math.round(boxes[0].x0 - 30), y0: Math.round(iconTop - 20), x1: Math.round(boxes[4].x1 + 30), y1: Math.round(rowBottom + 30) };
const w = bb.x1 - bb.x0, h = bb.y1 - bb.y0, S = 3;
const c = createCanvas(w * S, (h * 2 + 6) * S), g = c.getContext('2d');
for (const [r, oy] of [[raster, 0], [res.raster, h + 6]] as const) {
  const t = createCanvas(w, h), id = t.getContext('2d').createImageData(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = ((bb.y0 + y) * r.w + bb.x0 + x) * 4, j = (y * w + x) * 4; id.data[j] = r.data[i]; id.data[j + 1] = r.data[i + 1]; id.data[j + 2] = r.data[i + 2]; id.data[j + 3] = 255; }
  t.getContext('2d').putImageData(id, 0, 0);
  g.drawImage(t as any, 0, oy * S, w * S, h * S);
}
await writeFile(OUT, c.toBuffer('image/png'));
console.log('ok');
