// Plain RGBA raster helpers. Runs the same in the browser and in Node.

export interface Raster {
  w: number;
  h: number;
  data: Uint8ClampedArray; // RGBA
}

export type RGB = [number, number, number];
export type Box = { x0: number; y0: number; x1: number; y1: number }; // x1/y1 exclusive

export function makeRaster(w: number, h: number): Raster {
  return { w, h, data: new Uint8ClampedArray(w * h * 4) };
}

export function cloneRaster(r: Raster): Raster {
  return { w: r.w, h: r.h, data: new Uint8ClampedArray(r.data) };
}

export function clampBox(b: Box, r: { w: number; h: number }): Box {
  return {
    x0: Math.max(0, Math.floor(b.x0)),
    y0: Math.max(0, Math.floor(b.y0)),
    x1: Math.min(r.w, Math.ceil(b.x1)),
    y1: Math.min(r.h, Math.ceil(b.y1)),
  };
}

export function padBox(b: Box, p: number): Box {
  return { x0: b.x0 - p, y0: b.y0 - p, x1: b.x1 + p, y1: b.y1 + p };
}

export function unionBox(boxes: Box[]): Box {
  return {
    x0: Math.min(...boxes.map((b) => b.x0)),
    y0: Math.min(...boxes.map((b) => b.y0)),
    x1: Math.max(...boxes.map((b) => b.x1)),
    y1: Math.max(...boxes.map((b) => b.y1)),
  };
}

export function px(r: Raster, x: number, y: number): RGB {
  const i = (y * r.w + x) * 4;
  return [r.data[i], r.data[i + 1], r.data[i + 2]];
}

export function dist(a: RGB, b: RGB): number {
  const dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
  return Math.sqrt(dr * dr * 0.3 + dg * dg * 0.59 + db * db * 0.11) * 1.73;
}

export function median(v: number[]): number {
  if (!v.length) return 0;
  const s = [...v].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

export function percentile(v: number[], p: number): number {
  if (!v.length) return 0;
  const s = [...v].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * p)))];
}

export function medianColor(cols: RGB[]): RGB {
  return [median(cols.map((c) => c[0])), median(cols.map((c) => c[1])), median(cols.map((c) => c[2]))];
}

export function luminance(c: RGB): number {
  return 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
}

/** Binary mask over a box. */
export interface Mask {
  box: Box;
  w: number;
  h: number;
  m: Uint8Array;
}

export function makeMask(box: Box): Mask {
  const w = box.x1 - box.x0, h = box.y1 - box.y0;
  return { box, w, h, m: new Uint8Array(Math.max(0, w * h)) };
}

export function dilate(mask: Mask, rad: number): Mask {
  const out = makeMask(mask.box);
  const { w, h, m } = mask;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (!m[y * w + x]) continue;
      for (let dy = -rad; dy <= rad; dy++)
        for (let dx = -rad; dx <= rad; dx++) {
          if (dx * dx + dy * dy > rad * rad + rad) continue;
          const xx = x + dx, yy = y + dy;
          if (xx >= 0 && yy >= 0 && xx < w && yy < h) out.m[yy * w + xx] = 1;
        }
    }
  return out;
}

export function maskCount(mask: Mask): number {
  let n = 0;
  for (const v of mask.m) n += v;
  return n;
}

/** Turn a picture a quarter turn clockwise (lossless). */
export function rotateCW(r: Raster): Raster {
  const out = makeRaster(r.h, r.w);
  for (let y = 0; y < r.h; y++)
    for (let x = 0; x < r.w; x++) {
      const i = (y * r.w + x) * 4, j = (x * out.w + (r.h - 1 - y)) * 4;
      out.data[j] = r.data[i]; out.data[j + 1] = r.data[i + 1]; out.data[j + 2] = r.data[i + 2]; out.data[j + 3] = r.data[i + 3];
    }
  return out;
}

/** Turn a picture a quarter turn counter-clockwise (lossless). */
export function rotateCCW(r: Raster): Raster {
  const out = makeRaster(r.h, r.w);
  for (let y = 0; y < r.h; y++)
    for (let x = 0; x < r.w; x++) {
      const i = (y * r.w + x) * 4, j = ((r.w - 1 - x) * out.w + y) * 4;
      out.data[j] = r.data[i]; out.data[j + 1] = r.data[i + 1]; out.data[j + 2] = r.data[i + 2]; out.data[j + 3] = r.data[i + 3];
    }
  return out;
}

/** Copy out a part of a picture. */
export function cropRaster(r: Raster, b: Box): Raster {
  const w = b.x1 - b.x0, h = b.y1 - b.y0, out = makeRaster(w, h);
  for (let y = 0; y < h; y++) out.data.set(r.data.subarray(((b.y0 + y) * r.w + b.x0) * 4, ((b.y0 + y) * r.w + b.x0 + w) * 4), y * w * 4);
  return out;
}

/** Copy a picture into another at (x0, y0). */
export function pasteRaster(dst: Raster, src: Raster, x0: number, y0: number) {
  for (let y = 0; y < src.h; y++) dst.data.set(src.data.subarray(y * src.w * 4, (y + 1) * src.w * 4), ((y0 + y) * dst.w + x0) * 4);
}

/** Shrink a picture by a factor f >= 1 (averaging, so thin lines and small text stay readable). */
export function shrinkRaster(r: Raster, f: number): Raster {
  if (f <= 1) return r;
  const w = Math.max(1, Math.floor(r.w / f)), h = Math.max(1, Math.floor(r.h / f)), out = makeRaster(w, h);
  for (let y = 0; y < h; y++) {
    const sy0 = Math.floor(y * f), sy1 = Math.min(r.h, Math.max(sy0 + 1, Math.floor((y + 1) * f)));
    for (let x = 0; x < w; x++) {
      const sx0 = Math.floor(x * f), sx1 = Math.min(r.w, Math.max(sx0 + 1, Math.floor((x + 1) * f)));
      let a = 0, g = 0, b = 0, n = 0;
      for (let yy = sy0; yy < sy1; yy++) for (let xx = sx0; xx < sx1; xx++) { const i = (yy * r.w + xx) * 4; a += r.data[i]; g += r.data[i + 1]; b += r.data[i + 2]; n++; }
      const j = (y * w + x) * 4;
      out.data[j] = a / n; out.data[j + 1] = g / n; out.data[j + 2] = b / n; out.data[j + 3] = 255;
    }
  }
  return out;
}
