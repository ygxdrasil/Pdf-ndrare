// Swap a picture on the page: clear the marked box, then draw the new picture into it.
// No AI involved. Runs the same in the browser and in Node.

import type { Raster, Box } from './raster';
import { cloneRaster, clampBox, padBox } from './raster';
import { eraseArea } from './erase';
import type { FontLib } from './fonts';

export type PictureFit = 'cover' | 'contain';

export interface PictureResult {
  raster: Raster;
  /** where the new picture was drawn (picture pixels) */
  box: Box;
  /** the new picture was blown up a lot: it will look soft */
  soft: boolean;
}

/** Scale `img` (RGBA, may be transparent) into a w x h canvas: 'cover' fills it (cropping the edges), 'contain' fits it whole, centred. */
async function fitted(lib: FontLib, img: Raster, w: number, h: number, fit: PictureFit): Promise<{ raster: Raster; dx: number; dy: number; dw: number; dh: number }> {
  const sc = fit === 'cover' ? Math.max(w / img.w, h / img.h) : Math.min(w / img.w, h / img.h);
  const dw = Math.max(1, Math.round(img.w * sc)), dh = Math.max(1, Math.round(img.h * sc));
  const dx = Math.round((w - dw) / 2), dy = Math.round((h - dh) / 2);
  // shrink in halving steps so a big photo stays sharp in a small box
  let cur: any = lib.platform.createCanvas(img.w, img.h);
  const g0 = cur.getContext('2d');
  const id = g0.createImageData(img.w, img.h); id.data.set(img.data); g0.putImageData(id, 0, 0);
  let cw = img.w, ch = img.h;
  while (cw / 2 >= dw && ch / 2 >= dh && cw > 2 && ch > 2) {
    const nw = Math.max(1, Math.round(cw / 2)), nh = Math.max(1, Math.round(ch / 2));
    const next: any = lib.platform.createCanvas(nw, nh), g = next.getContext('2d');
    (g as any).imageSmoothingQuality = 'high';
    g.drawImage(cur, 0, 0, nw, nh);
    cur = next; cw = nw; ch = nh;
  }
  const out: any = lib.platform.createCanvas(w, h), go = out.getContext('2d');
  (go as any).imageSmoothingQuality = 'high';
  go.drawImage(cur, dx, dy, dw, dh);
  const d = go.getImageData(0, 0, w, h);
  return { raster: { w, h, data: new Uint8ClampedArray(d.data) }, dx, dy, dw, dh };
}

/**
 * `page` is the page picture as it is now. `box` is the marked area (picture pixels), `img` the new picture
 * (with its own transparency). Returns a new raster; `page` is not changed.
 */
export async function replacePicture(lib: FontLib, page: Raster, box: Box, img: Raster, fit: PictureFit = 'cover'): Promise<PictureResult> {
  // a few pixels wider than the marking: a hand-drawn box rarely sits exactly on the old picture's edge
  const b = clampBox(padBox(box, 2), page);
  const w = b.x1 - b.x0, h = b.y1 - b.y0;
  if (w < 4 || h < 4) throw new Error('Markeringen är för liten. Dra en ruta runt hela bilden som ska bytas.');
  if (img.w < 2 || img.h < 2) throw new Error('Den nya bilden är för liten.');
  const out = cloneRaster(page);
  const f = await fitted(lib, img, w, h, fit);
  // clear the old picture first, unless the new one covers the whole box with solid pixels (then there is nothing left of the old one)
  let solid = true;
  for (let i = 3; i < f.raster.data.length; i += 4) if (f.raster.data[i] < 255) { solid = false; break; }
  if (!solid) eraseArea(out, page, b);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const si = (y * w + x) * 4, a = f.raster.data[si + 3];
    if (!a) continue;
    const di = ((b.y0 + y) * out.w + (b.x0 + x)) * 4;
    if (a === 255) { out.data[di] = f.raster.data[si]; out.data[di + 1] = f.raster.data[si + 1]; out.data[di + 2] = f.raster.data[si + 2]; out.data[di + 3] = 255; continue; }
    const k = a / 255;
    for (let c = 0; c < 3; c++) out.data[di + c] = f.raster.data[si + c] * k + out.data[di + c] * (1 - k);
    out.data[di + 3] = 255;
  }
  const soft = f.dw > img.w * 2.5 || f.dh > img.h * 2.5; // blown up more than 2.5 times
  return { raster: out, box: b, soft };
}
