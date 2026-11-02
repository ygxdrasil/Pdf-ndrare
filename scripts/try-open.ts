// Open any PDF(s) with the engine and save what it sees: mode, size, and a PNG.
import { readFile, writeFile } from 'node:fs/promises';
import { readPage, writePdf, pageCount } from '../src/engine/pdf';
import { codec, makeLib } from './node-platform';
import { createCanvas } from '@napi-rs/canvas';
const out = process.argv[2];
for (const f of process.argv.slice(3)) {
  const t = Date.now();
  try {
    const bytes = new Uint8Array(await readFile(f));
    const n = await pageCount(bytes);
    const { image, raster } = await readPage(bytes, codec, n > 1 ? 1 : 0);
    const name = f.split('/').pop()!.replace(/\.pdf$/i, '');
    const c = createCanvas(raster.w, raster.h); const id = c.getContext('2d').createImageData(raster.w, raster.h); id.data.set(raster.data); c.getContext('2d').putImageData(id, 0, 0);
    await writeFile(`${out}/${name}.png`, c.toBuffer('image/png'));
    // round trip: write it back unchanged, then open the result again
    const lib = await makeLib();
    const pdf = await writePdf(bytes, image, raster, [], lib, codec);
    await writeFile(`${out}/${name}-rt.pdf`, pdf);
    const again = await readPage(pdf, codec, image.pageIndex);
    console.log(`${name}: pages=${n} mode=${image.mode} ${raster.w}x${raster.h} -> reopen mode=${again.image.mode} ${again.raster.w}x${again.raster.h} (${Date.now() - t} ms)`);
  } catch (e: any) { console.log(`${f}: ERROR ${e.message}`); }
}
