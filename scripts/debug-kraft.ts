import { readFile } from 'node:fs/promises';
import { readPage } from '../src/engine/pdf';
import { analyzeLine } from '../src/engine/analyze';
import { codec } from './node-platform';
const ocr = JSON.parse(await readFile('/home/claude/elin-v2/work/tests/ocr.json', 'utf8'));
const { raster } = await readPage(new Uint8Array(await readFile('/home/claude/elin-v2/samples/original.pdf')), codec);
const l = ocr.find((o: any) => o.id === 95);
console.log(l.words.map((w: any) => [w.text, Object.values(w.box).map((v: any) => Math.round(v))]));
const neigh = ocr.filter((o: any) => Math.abs(o.box.y0 - l.box.y0) < 40 && o.box.x0 < 200).map((o: any) => [o.id, o.text, Object.values(o.box).map((v: any) => Math.round(v))]);
console.log(neigh);
const w = l.words[1];
const info = analyzeLine(raster, { ...w.box, y0: Math.max(w.box.y0, l.box.y0 - 1), y1: Math.min(w.box.y1, l.box.y1 + 1) });
console.log('area', Object.values(info.area), 'inkBox', Object.values(info.inkBox).map(Math.round), 'thresh', info.thresh.toFixed(0), 'noise', info.noise.toFixed(1), 'color', info.color);
let n = 0; for (const v of info.erase.m) n += v; console.log('erase px', n, 'of', info.erase.m.length);
// print erase mask
const A = info.area, W = A.x1 - A.x0;
for (let y = A.y0; y < A.y1; y++) { let s = ''; for (let x = A.x0; x < A.x1; x++) s += info.erase.m[(y - A.y0) * W + x - A.x0] ? (info.ink.m[(y - A.y0) * W + x - A.x0] ? '#' : '+') : '.'; console.log(String(y).padStart(4), s); }
