import { createWorker } from 'tesseract.js';
import { createCanvas } from '@napi-rs/canvas';
import type { Raster, Box } from '../src/engine/raster';
import type { OcrLine } from '../src/engine/edit';
import { mergeOcr } from '../src/engine/ocr-merge';
import { ocrRotated } from '../src/engine/rotate';

let worker: any = null;
async function getWorker() {
  if (!worker) {
    worker = await createWorker(['swe', 'eng'], 1, { langPath: new URL('../tessdata', import.meta.url).pathname, cacheMethod: 'none', gzip: true } as any);
    await worker.setParameters({ tessedit_pageseg_mode: '11' as any, preserve_interword_spaces: '1' });
  }
  return worker;
}
export async function closeOcr() { if (worker) { await worker.terminate(); worker = null; } }

/** OCR one pass over (part of) the picture, scaled 2x, optionally inverted (light text on dark). */
async function pass(r: Raster, region: Box, invert: boolean, minConf = 30): Promise<OcrLine[]> {
  // small pictures are enlarged for OCR; big (high-resolution) ones are not
  const rw = region.x1 - region.x0, rh = region.y1 - region.y0;
  const small = rw * rh < 0.25 * r.w * r.h; // a close-up: enlarge more, tiny text needs it
  const S = Math.min(small ? 4 : 2, Math.max(1, 3400 / Math.max(rw, rh)));
  const w = Math.round(region.x1 - region.x0), h = Math.round(region.y1 - region.y0);
  const src = createCanvas(w, h);
  const id = src.getContext('2d').createImageData(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = ((Math.round(region.y0) + y) * r.w + Math.round(region.x0) + x) * 4, j = (y * w + x) * 4;
    for (let c = 0; c < 3; c++) id.data[j + c] = invert ? 255 - r.data[i + c] : r.data[i + c];
    id.data[j + 3] = 255;
  }
  src.getContext('2d').putImageData(id, 0, 0);
  const c = createCanvas(Math.round(w * S), Math.round(h * S));
  const g = c.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(src as any, 0, 0, Math.round(w * S), Math.round(h * S));
  const wk = await getWorker();
  const res = await wk.recognize(c.toBuffer('image/png'), {}, { blocks: true });
  const lines: OcrLine[] = [];
  const tb = (b: any): Box => ({ x0: region.x0 + b.x0 / S, y0: region.y0 + b.y0 / S, x1: region.x0 + b.x1 / S, y1: region.y0 + b.y1 / S });
  for (const b of res.data.blocks ?? []) for (const p of b.paragraphs) for (const l of p.lines) {
    const t = l.text.trim();
    if (!t || l.confidence < minConf) continue;
    const words = (l.words ?? []).filter((w: any) => w.text.trim()).map((w: any) => ({ text: w.text.trim(), box: tb(w.bbox) }));
    lines.push({ id: 0, text: t, box: tb(l.bbox), words, conf: l.confidence });
  }
  return lines;
}

export async function ocrRaster(r: Raster): Promise<OcrLine[]> {
  const all = { x0: 0, y0: 0, x1: r.w, y1: r.h };
  const a = await pass(r, all, false);
  const b = await pass(r, all, true);
  // small print is missed on a whole-page pass: read the page again in overlapping tiles, enlarged (a big, high-resolution render already has the detail)
  const t = Math.max(r.w, r.h) > 2600 && !process.env.OCRTILES ? [] : await tilePasses(r);
  // vertical text (dimension lines): read the page turned each way
  const v = await ocrRotated(r, pass);
  return mergeOcr(a, b, t, v);
}

/** Overlapping tiles (about 1/4 of the longest side), each read enlarged; the slow part is capped at 12 tiles. */
export async function tilePasses(r: Raster): Promise<OcrLine[]> {
  const side = Math.max(400, Math.ceil(Math.max(r.w, r.h) / 3.2));
  const step = Math.round(side * 0.82);
  const xs: number[] = [], ys: number[] = [];
  for (let x = 0; x < Math.max(1, r.w - side * 0.2); x += step) xs.push(Math.min(x, Math.max(0, r.w - side)));
  for (let y = 0; y < Math.max(1, r.h - side * 0.2); y += step) ys.push(Math.min(y, Math.max(0, r.h - side)));
  const boxes: Box[] = [];
  for (const y of ys) for (const x of xs) if (boxes.length < 12) boxes.push({ x0: x, y0: y, x1: Math.min(r.w, x + side), y1: Math.min(r.h, y + side) });
  const out: OcrLine[] = [];
  const wk = await getWorker();
  try {
    // sparse text (11) finds loose labels; block mode (6) finds small lines inside boxes and tables
    for (const mode of ['11', '6']) {
      await wk.setParameters({ tessedit_pageseg_mode: mode as any });
      for (const box of boxes) out.push(...(await pass(r, box, false, 30)));
    }
  } finally { await wk.setParameters({ tessedit_pageseg_mode: '11' as any }); }
  return out;
}

/** Re-read a small area (when Claude points at text OCR missed). */
export async function ocrRegion(r: Raster, box: Box): Promise<OcrLine[]> {
  const a = await pass(r, box, false);
  const b = await pass(r, box, true);
  return mergeOcr(a, b);
}
