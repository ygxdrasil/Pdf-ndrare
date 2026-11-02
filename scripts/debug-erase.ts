import { readFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { createCanvas } from '@napi-rs/canvas';
import { readPage } from '../src/engine/pdf';
import { analyzeLine } from '../src/engine/analyze';
import { eraseLine } from '../src/engine/erase';
import { cloneRaster } from '../src/engine/raster';
import { codec } from './node-platform';
const ocr = JSON.parse(await readFile('/home/claude/elin-v2/work/out/ocr.json', 'utf8'));
const { raster } = await readPage(new Uint8Array(await readFile('/home/claude/elin-v2/samples/original.pdf')), codec);
const ids = process.argv.slice(2, -4).map(Number);
const [X0, Y0, X1, Y1] = process.argv.slice(-4).map(Number);
const out = cloneRaster(raster);
const infos = ids.map((id) => analyzeLine(raster, ocr.find((o: any) => o.id === id).box));
for (const i of infos) eraseLine(out, raster, i);
const S = 3, W = X1 - X0, H = Y1 - Y0;
const c = createCanvas(W * S, H * 2 * S); const g = c.getContext('2d');
for (const [r, oy] of [[raster, 0], [out, H]] as const)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = ((Y0 + y) * r.w + X0 + x) * 4;
    g.fillStyle = `rgb(${r.data[i]},${r.data[i + 1]},${r.data[i + 2]})`; g.fillRect(x * S, (y + oy) * S, S, S);
  }
writeFileSync('/home/claude/elin-v2/work/out/erase.png', c.toBuffer('image/png'));
