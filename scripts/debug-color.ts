// Print the ink colour the engine measures for lines matching a word: npx tsx scripts/debug-color.ts file.pdf WORD
import { readFile } from 'node:fs/promises';
import { readPage } from '../src/engine/pdf';
import { analyzeLine } from '../src/engine/analyze';
import { codec } from './node-platform';
import { ocrRaster, closeOcr } from './ocr-node';
const [f, word] = process.argv.slice(2);
const { raster } = await readPage(new Uint8Array(await readFile(f)), codec, 0);
const ocr = await ocrRaster(raster);
await closeOcr();
for (const o of ocr.filter((o: any) => o.text.includes(word))) {
  const info = analyzeLine(raster, o.box ?? o);
  let mn = 999; const b = info.inkBox;
  for (let y = Math.round(b.y0); y < b.y1; y++) for (let x = Math.round(b.x0); x < b.x1; x++) { const i = (y * raster.w + x) * 4; mn = Math.min(mn, raster.data[i] + raster.data[i + 1] + raster.data[i + 2]); }
  console.log(o.text, 'color', info.color, 'h', Math.round(b.y1 - b.y0), 'minLumSum', mn);
}
