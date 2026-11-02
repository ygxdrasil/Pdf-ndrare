// npx tsx scripts/debug-box.ts file.pdf x0 y0 x1 y1
import { readFile } from 'node:fs/promises';
import { readPage, readImage } from '../src/engine/pdf';
import { analyzeLine } from '../src/engine/analyze';
import { codec } from './node-platform';
const [f, a, b, c, d] = process.argv.slice(2);
const bytes = new Uint8Array(await readFile(f));
const { raster } = /\.(png|jpe?g)$/i.test(f) ? await readImage(bytes, /png$/i.test(f) ? 'image/png' : 'image/jpeg', codec) : await readPage(bytes, codec, 0);
const i = analyzeLine(raster, { x0: +a, y0: +b, x1: +c, y1: +d });
let n = 0; for (const v of i.ink.m) n += v; let e = 0; for (const v of i.erase.m) e += v;
console.log('box', i.box, 'area', i.area, 'ink', i.inkBox, 'inkpx', n, 'erasepx', e, 'noise', i.noise.toFixed(1), 'grain', i.grain.toFixed(1), 'color', i.color);
