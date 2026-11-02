// Open PDFs/images like the app does and save what it sees: node scripts ... <out-dir> files...
import { readFile, writeFile } from 'node:fs/promises';
import { readPage, readImage, pageCount } from '../src/engine/pdf';
import { codec } from './node-platform';
const out = process.argv[2];
for (const f of process.argv.slice(3)) {
  const t = Date.now();
  try {
    const bytes = new Uint8Array(await readFile(f));
    const isImg = /\.(png|jpe?g)$/i.test(f);
    const n = isImg ? 1 : await pageCount(bytes);
    const { image, raster } = isImg ? await readImage(bytes, /png$/i.test(f) ? 'image/png' : 'image/jpeg', codec) : await readPage(bytes, codec, 0);
    const name = f.split('/').pop()!.slice(0, 12);
    await writeFile(`${out}/${name}.jpg`, await codec.encodeJpeg(raster, 0.8));
    console.log(`${name}: pages=${n} mode=${image.mode} reason=${image.reason ?? '-'} ${raster.w}x${raster.h} ppi=${image.ppi ?? '-'} (${Date.now() - t} ms)`);
  } catch (e: any) { console.log(`${f}: ERROR ${e.message}`); }
}
