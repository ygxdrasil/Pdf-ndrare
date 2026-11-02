import { readFile } from 'node:fs/promises';
import { readPage } from '../src/engine/pdf';
import { codec } from './node-platform';
const bytes = new Uint8Array(await readFile('/home/claude/elin-v2/samples/original.pdf'));
const { image, raster } = await readPage(bytes, codec);
const pw = Math.hypot(image.ctm[0], image.ctm[1]);
const ppp = image.w / pw;
const R = await codec.renderPage(bytes, 0, ppp);
// image top in rendered px
const top = (image.pageH - (image.ctm[5] + image.ctm[3])) * ppp;
console.log('render', R.w, R.h, 'img top px', top.toFixed(2));
const g = (r: any, x: number, y: number) => r.data[(y * r.w + x) * 4 + 1];
let e1 = 0, e2 = 0, d = 0, n = 0;
for (let y = 300; y < 900; y++) for (let x = 100; x < 1500; x++) {
  const ry = Math.round(y + top);
  if (ry + 1 >= R.h) continue;
  e1 += Math.abs(g(raster, x + 1, y) - g(raster, x, y)) + Math.abs(g(raster, x, y + 1) - g(raster, x, y));
  e2 += Math.abs(g(R, x + 1, ry) - g(R, x, ry)) + Math.abs(g(R, x, ry + 1) - g(R, x, ry));
  d += Math.abs(g(R, x, ry) - g(raster, x, y)); n++;
}
console.log('sharpness ratio render/original', (e2 / e1).toFixed(3), 'mean diff', (d / n).toFixed(2));
