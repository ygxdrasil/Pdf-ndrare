import { readFile } from 'node:fs/promises';
import { readImage, readPage } from '../src/engine/pdf';
import { analyzeLine } from '../src/engine/analyze';
import { codec } from './node-platform';
import { ocrRaster, closeOcr } from './ocr-node';
const [f, word] = process.argv.slice(2);
const bytes = new Uint8Array(await readFile(f));
const { raster } = /\.(png|jpe?g)$/i.test(f) ? await readImage(bytes, /png$/i.test(f) ? 'image/png' : 'image/jpeg', codec) : await readPage(bytes, codec, 0);
const ocr = await ocrRaster(raster); await closeOcr();
for (const o of ocr.filter((o: any) => o.text.includes(word))) {
  const i = analyzeLine(raster, o.box);
  console.log(JSON.stringify(o.text), 'box', o.box, 'area', i.area, 'ink', i.inkBox, 'noise', i.noise.toFixed(2), 'grain', i.grain.toFixed(2), 'words', JSON.stringify((o as any).words?.map((w: any) => [w.text, Math.round(w.box.x0), Math.round(w.box.y0), Math.round(w.box.x1), Math.round(w.box.y1)])));
}
