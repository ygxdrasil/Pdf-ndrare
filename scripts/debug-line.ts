import { readFile } from 'node:fs/promises';
import { createCanvas } from '@napi-rs/canvas';
import { writeFileSync } from 'node:fs';
import { readPage } from '../src/engine/pdf';
import { analyzeLine } from '../src/engine/analyze';
import { codec } from './node-platform';
const ocr = JSON.parse(await readFile('/home/claude/elin-v2/work/out/ocr.json', 'utf8'));
const { raster } = await readPage(new Uint8Array(await readFile('/home/claude/elin-v2/samples/original.pdf')), codec);
const ids = process.argv.slice(2).map(Number);
const S = 4;
const tiles: any[] = [];
for (const id of ids) {
  const l = ocr.find((o: any) => o.id === id);
  const info = analyzeLine(raster, l.box);
  console.log(id, l.text, JSON.stringify(l.box), 'ink', JSON.stringify(info.inkBox), 'thr', info.thresh.toFixed(1), 'noise', info.noise.toFixed(1), 'color', info.color);
  const A = info.area, W = A.x1 - A.x0, H = A.y1 - A.y0;
  const c = createCanvas(W * S, H * 2 * S);
  const g = c.getContext('2d');
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = ((A.y0 + y) * raster.w + A.x0 + x) * 4;
    g.fillStyle = `rgb(${raster.data[i]},${raster.data[i + 1]},${raster.data[i + 2]})`; g.fillRect(x * S, y * S, S, S);
    const v = info.cov[y * W + x];
    g.fillStyle = info.ink.m[y * W + x] ? `rgb(255,${255 - v * 255},0)` : `rgb(${v * 255},${v * 255},${v * 255})`; g.fillRect(x * S, (H + y) * S, S, S);
  }
  g.strokeStyle = 'cyan'; g.strokeRect((info.inkBox.x0 - A.x0) * S, (info.inkBox.y0 - A.y0) * S, (info.inkBox.x1 - info.inkBox.x0) * S, (info.inkBox.y1 - info.inkBox.y0) * S);
  writeFileSync(`/home/claude/elin-v2/work/out/dbg-${id}.png`, c.toBuffer('image/png'));
}
