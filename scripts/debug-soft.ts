import { readFile } from 'node:fs/promises';
import { readPage } from '../src/engine/pdf';
import { analyzeLine } from '../src/engine/analyze';
import { codec } from './node-platform';
const ocr = JSON.parse(await readFile('/home/claude/elin-v2/work/tests/ocr.json', 'utf8'));
const { raster } = await readPage(new Uint8Array(await readFile('/home/claude/elin-v2/samples/original.pdf')), codec);
for (const id of [95, 82, 68, 15, 36]) {
  const l = ocr.find((o: any) => o.id === id); const info = analyzeLine(raster, l.box);
  const s = (lo: number) => { let e = 0, t = 0; for (const c of info.cov) { if (c > lo) t++; if (c > lo && c < 0.8) e++; } return (e / t).toFixed(2); };
  let peak = 0; for (const c of info.cov) peak = Math.max(peak, c);
  console.log(id, l.text.slice(0, 20), 'soft.12', s(0.12), 'soft.25', s(0.25), 'peak', peak.toFixed(2), 'noise', info.noise.toFixed(1), 'h', (info.inkBox.y1 - info.inkBox.y0).toFixed(0), 'color', info.color);
}
