// Swap a picture on a page (no AI): npx tsx scripts/try-picture.ts <in.pdf|png> <out> <new image> <x0,y0,x1,y1> [cover|contain]
import { readFile, writeFile } from 'node:fs/promises';
import { readImage, readPage, writeImage, writePdf } from '../src/engine/pdf';
import { replacePicture } from '../src/engine/picture';
import { renderPreview } from '../src/engine/agent';
import { codec, makeLib } from './node-platform';
const [f, out, newImg, boxS, fit] = process.argv.slice(2);
const bytes = new Uint8Array(await readFile(f));
const isPdf = /\.pdf$/i.test(f);
const { image, raster } = isPdf ? await readPage(bytes, codec, 0) : await readImage(bytes, 'image/png', codec);
const lib = await makeLib();
const nb = new Uint8Array(await readFile(newImg));
const dec: any = await codec.decodeImage(nb, /\.png$/i.test(newImg) ? 'image/png' : 'image/jpeg');
const pic = dec.rgba ? { w: dec.w, h: dec.h, data: dec.rgba } : dec;
const [x0, y0, x1, y1] = boxS.split(',').map(Number);
const t0 = Date.now();
const res = await replacePicture(lib, raster, { x0, y0, x1, y1 }, pic, (fit as any) || 'cover');
console.log('picture', res.box, 'soft', res.soft, Date.now() - t0, 'ms');
const outBytes = isPdf
  ? await writePdf(bytes, image, res.raster, [], lib, codec, raster)
  : await writeImage(image, res.raster, [], lib, codec, (a) => renderPreview({ lib }, a as any, image.w, image.h));
await writeFile(out, outBytes);
