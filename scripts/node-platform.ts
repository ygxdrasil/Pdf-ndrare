import { createCanvas, loadImage } from '@napi-rs/canvas';
import { readFile } from 'node:fs/promises';
import { FontLib, Platform } from '../src/engine/fonts';
import { flattenOnWhite, type Codec } from '../src/engine/pdf';
import type { Raster } from '../src/engine/raster';

export const FONT_DIR = new URL('../public/fonts/', import.meta.url).pathname;

export const platform: Platform = {
  createCanvas: (w, h) => createCanvas(Math.max(1, w), Math.max(1, h)) as any,
  loadFile: async (p) => new Uint8Array(await readFile(FONT_DIR + p)),
};

// pdf.js worker with CMYK colours as Acrobat/Chrome show them (same patch as the web build)
let workerReady: Promise<void> | undefined;
async function patchedWorker(): Promise<string> {
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path'); const url = await import('node:url');
  const { createRequire } = await import('node:module');
  const { patchCmyk } = await import('./pdfjs-cmyk.mjs');
  const src = createRequire(import.meta.url).resolve('pdfjs-dist/legacy/build/pdf.worker.mjs');
  const dir = path.join(os.tmpdir(), 'pdfjs-cmyk'); fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, 'pdf.worker.mjs');
  fs.writeFileSync(out, patchCmyk(fs.readFileSync(src, 'utf8')));
  return url.pathToFileURL(out).href;
}

export const codec: Codec = {
  async decodeJpeg(bytes) {
    const img = await loadImage(Buffer.from(bytes));
    const c = createCanvas(img.width, img.height);
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, img.width, img.height);
    return { w: img.width, h: img.height, data: new Uint8ClampedArray(d.data) };
  },
  async renderPage(bytes, pageIndex, scale) {
    const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
    if (!workerReady) workerReady = patchedWorker().then((src) => { pdfjs.GlobalWorkerOptions.workerSrc = src; });
    await workerReady;
    const task = pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, verbosity: 0 });
    const doc = await task.promise;
    const page = await doc.getPage(pageIndex + 1);
    const vp = page.getViewport({ scale, rotation: 0 });
    const w = Math.round(vp.width), h = Math.round(vp.height);
    const c = createCanvas(w, h);
    const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
    await page.render({ canvasContext: g as any, canvas: c as any, viewport: vp }).promise;
    const d = g.getImageData(0, 0, w, h);
    await task.destroy();
    return { w, h, data: new Uint8ClampedArray(d.data) };
  },
  async decodeImage(bytes) {
    const img = await loadImage(Buffer.from(bytes));
    const c = createCanvas(img.width, img.height);
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, img.width, img.height);
    let see = false;
    for (let i = 3; i < d.data.length; i += 4) if (d.data[i] < 255) { see = true; break; }
    if (!see) return { w: img.width, h: img.height, data: new Uint8ClampedArray(d.data) };
    const rgba = new Uint8ClampedArray(d.data);
    return { w: img.width, h: img.height, data: flattenOnWhite(rgba), rgba };
  },
  async encodeJpeg(r: Raster, quality = 0.95) {
    const c = createCanvas(r.w, r.h);
    const g = c.getContext('2d');
    const id = g.createImageData(r.w, r.h);
    id.data.set(r.data);
    for (let i = 3; i < id.data.length; i += 4) id.data[i] = 255;
    g.putImageData(id, 0, 0);
    return new Uint8Array(c.toBuffer('image/jpeg', Math.round(quality * 100)));
  },
  async encodePng(r: Raster, keepAlpha = false) {
    const c = createCanvas(r.w, r.h);
    const g = c.getContext('2d');
    const id = g.createImageData(r.w, r.h);
    id.data.set(r.data);
    if (!keepAlpha) for (let i = 3; i < id.data.length; i += 4) id.data[i] = 255;
    g.putImageData(id, 0, 0);
    return new Uint8Array(c.toBuffer('image/png'));
  },
};

export async function makeLib() {
  const lib = new FontLib(platform);
  await lib.init();
  return lib;
}
