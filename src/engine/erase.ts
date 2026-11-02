// Removes text from the page picture: fills the ink with background that
// continues the surroundings (smooth fill + the paper's own grain).

import { Box, Mask, Raster, clampBox, dilate, dist, px } from './raster';
import type { LineInfo } from './analyze';

/** Fill every masked pixel in `r` (mask coords are image coords offset by mask.box). */
export function inpaint(r: Raster, mask: Mask, guess: (x: number, y: number) => [number, number, number], grainFrom?: (x: number, y: number) => [number, number, number] | null, trust?: (x: number, y: number) => boolean, keep = 0.03, iters = 120) {
  const { w, h, m, box } = mask;
  const idx = (x: number, y: number) => ((box.y0 + y) * r.w + (box.x0 + x)) * 4;
  // 1. start from the background model
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (m[y * w + x]) {
        const g = guess(box.x0 + x, box.y0 + y);
        const i = idx(x, y);
        r.data[i] = g[0]; r.data[i + 1] = g[1]; r.data[i + 2] = g[2];
      }
  // 2. relax towards the real neighbours (harmonic fill), so edges blend
  const list: number[] = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (m[y * w + x]) list.push(y * w + x);
  for (let it = 0; it < iters; it++) {
    for (const k of list) {
      const x = k % w, y = (k / w) | 0;
      const gx = box.x0 + x, gy = box.y0 + y;
      let s0 = 0, s1 = 0, s2 = 0, n = 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const xx = gx + dx, yy = gy + dy;
        if (xx < 0 || yy < 0 || xx >= r.w || yy >= r.h) continue;
        const mx = xx - box.x0, my = yy - box.y0;
        const inside = mx >= 0 && my >= 0 && mx < w && my < h && m[my * w + mx];
        if (!inside && trust && !trust(xx, yy)) continue;
        const j = (yy * r.w + xx) * 4;
        s0 += r.data[j]; s1 += r.data[j + 1]; s2 += r.data[j + 2]; n++;
      }
      if (!n) continue;
      const i = (gy * r.w + gx) * 4;
      // keep part of the model so big holes don't flatten to one colour
      r.data[i] = (s0 / n) * (1 - keep) + r.data[i] * keep;
      r.data[i + 1] = (s1 / n) * (1 - keep) + r.data[i + 1] * keep;
      r.data[i + 2] = (s2 / n) * (1 - keep) + r.data[i + 2] * keep;
    }
  }
  // 3. add the surface grain (paper/kraft texture) so the patch isn't too smooth
  if (grainFrom)
    for (const k of list) {
      const x = k % w, y = (k / w) | 0;
      const g = grainFrom(box.x0 + x, box.y0 + y);
      if (!g) continue;
      const i = idx(x, y);
      r.data[i] += g[0]; r.data[i + 1] += g[1]; r.data[i + 2] += g[2];
    }
}

/** High-pass "grain" of a clean neighbouring band, sampled with an offset. */
function grainSampler(src: Raster, line: LineInfo): ((x: number, y: number) => [number, number, number] | null) | undefined {
  const bh = line.inkBox.y1 - line.inkBox.y0 + 6;
  const offsets = [-bh, bh, -2 * bh, 2 * bh];
  let best: number | null = null, bestScore = Infinity;
  for (const off of offsets) {
    // a band is usable if it's background-coloured (no ink) everywhere
    let bad = 0, n = 0;
    for (let y = line.inkBox.y0; y < line.inkBox.y1; y += 2)
      for (let x = line.inkBox.x0; x < line.inkBox.x1; x += 2) {
        const yy = y + off;
        if (yy < 0 || yy >= src.h) { bad += 1000; continue; }
        n++;
        if (dist(px(src, x, yy), line.bgAt(x, y)) > line.thresh * 0.8) bad++;
      }
    const score = n ? bad / n : Infinity;
    if (score < bestScore) { bestScore = score; best = off; }
  }
  if (best === null || bestScore > 0.03) return undefined;
  const off = best;
  const blurAt = (x: number, y: number) => {
    let s = [0, 0, 0], n = 0;
    for (let dy = -3; dy <= 3; dy++)
      for (let dx = -3; dx <= 3; dx++) {
        const xx = Math.min(src.w - 1, Math.max(0, x + dx)), yy = Math.min(src.h - 1, Math.max(0, y + dy));
        const c = px(src, xx, yy);
        s[0] += c[0]; s[1] += c[1]; s[2] += c[2]; n++;
      }
    return [s[0] / n, s[1] / n, s[2] / n];
  };
  return (x, y) => {
    const yy = y + off;
    if (yy < 0 || yy >= src.h) return null;
    const c = px(src, x, yy), b = blurAt(x, yy);
    // only fine grain: clamp so edges or specks in the sample band never copy over
    const lim = Math.max(3, line.noise * 2.5);
    const cl = (v: number) => Math.max(-lim, Math.min(lim, v));
    return [cl(c[0] - b[0]), cl(c[1] - b[1]), cl(c[2] - b[2])];
  };
}

/** Letter mask on a photo: each pixel is compared with the lightest pixel near it (the
 * photo under the letter). A pixel is ink (or its soft edge) when it lies on the way from
 * that local background towards the ink colour; shadows and folds of another hue don't. */
function photoInkMask(src: Raster, line: LineInfo): Mask {
  const A = line.area, W = A.x1 - A.x0, H = A.y1 - A.y0;
  const R = Math.max(6, Math.round((line.inkBox.y1 - line.inkBox.y0) * 0.12));
  const lum = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const c = px(src, A.x0 + x, A.y0 + y); lum[y * W + x] = c[0] * 0.3 + c[1] * 0.59 + c[2] * 0.11; }
  // brightest pixel in a (2R+1)² window: separable max that remembers where it was
  const rowI = new Int32Array(W * H), bestI = new Int32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let bi = y * W + x;
    for (let k = Math.max(0, x - R); k <= Math.min(W - 1, x + R); k++) if (lum[y * W + k] > lum[bi]) bi = y * W + k;
    rowI[y * W + x] = bi;
  }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let bi = rowI[y * W + x];
    for (let k = Math.max(0, y - R); k <= Math.min(H - 1, y + R); k++) { const c = rowI[k * W + x]; if (lum[c] > lum[bi]) bi = c; }
    bestI[y * W + x] = bi;
  }
  const ink = line.color, m = new Uint8Array(W * H), soft = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const p = px(src, A.x0 + x, A.y0 + y), bi = bestI[y * W + x];
    const b = px(src, A.x0 + (bi % W), A.y0 + ((bi / W) | 0));
    const v = [ink[0] - b[0], ink[1] - b[1], ink[2] - b[2]], q = [p[0] - b[0], p[1] - b[1], p[2] - b[2]];
    const vv = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
    if (vv < 400) continue; // ink and background too alike here
    const a = (q[0] * v[0] + q[1] * v[1] + q[2] * v[2]) / vv;
    if (a < 0.04) continue;
    const res = Math.hypot(q[0] - a * v[0], q[1] - a * v[1], q[2] - a * v[2]);
    if (res >= 14 + 10 * Math.min(1, a)) continue;
    if (a >= 0.3) m[y * W + x] = 1; // clearly the letter
    else soft[y * W + x] = 1; // maybe its soft edge: kept only right next to a letter
  }
  // soft edge pixels count only within 3 px of a letter pixel (not the photo's own shading)
  const near = dilate({ box: { ...A }, w: W, h: H, m }, 3).m;
  for (let i = 0; i < m.length; i++) if (soft[i] && near[i]) m[i] = 1;
  // only inside this line's own rows/columns (with a little room for the soft edge)
  const ib = line.inkBox;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const gx = A.x0 + x, gy = A.y0 + y;
    if (gx < ib.x0 - 4 || gx > ib.x1 + 4 || gy < ib.y0 - 4 || gy > ib.y1 + 4) m[y * W + x] = 0;
  }
  return { box: { ...A }, w: W, h: H, m };
}

/** Fine texture of the photo (fabric, paper) borrowed from just above or below the
 * line, wherever that spot isn't ink, so the filled letters aren't smoother than the photo. */
function photoGrain(src: Raster, line: LineInfo): (x: number, y: number) => [number, number, number] | null {
  const bh = line.inkBox.y1 - line.inkBox.y0 + 8;
  const lim = Math.max(3, Math.min(12, line.noise * 1.2));
  const isInk = (x: number, y: number) => dist(px(src, x, y), line.color) < line.thresh * 1.5;
  const blur = (x: number, y: number) => {
    const s = [0, 0, 0]; let n = 0;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const c = px(src, Math.min(src.w - 1, Math.max(0, x + dx)), Math.min(src.h - 1, Math.max(0, y + dy)));
      s[0] += c[0]; s[1] += c[1]; s[2] += c[2]; n++;
    }
    return [s[0] / n, s[1] / n, s[2] / n];
  };
  return (x, y) => {
    for (const off of [bh, -bh, 2 * bh, -2 * bh]) {
      const yy = y + off;
      if (yy < 2 || yy >= src.h - 2) continue;
      let clean = true;
      for (let dy = -3; dy <= 3 && clean; dy += 3) for (let dx = -3; dx <= 3 && clean; dx += 3) if (isInk(x + dx, yy + dy)) clean = false;
      if (!clean) continue;
      const c = px(src, x, yy), b = blur(x, yy);
      const cl = (v: number) => Math.max(-lim, Math.min(lim, v));
      return [cl(c[0] - b[0]), cl(c[1] - b[1]), cl(c[2] - b[2])];
    }
    return null;
  };
}

/** Solve a 3×3 system (row-major A) for x; null when it is (nearly) singular. */
function solve3(A: number[], b: number[]): number[] | null {
  const [a, b1, c, d, e, f, g, h, i] = A;
  const det = a * (e * i - f * h) - b1 * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-9) return null;
  const x = (b[0] * (e * i - f * h) - b1 * (b[1] * i - f * b[2]) + c * (b[1] * h - e * b[2])) / det;
  const y = (a * (b[1] * i - f * b[2]) - b[0] * (d * i - f * g) + c * (d * b[2] - b[1] * g)) / det;
  const z = (a * (e * b[2] - b[1] * h) - b1 * (d * b[2] - b[1] * g) + b[0] * (d * h - e * g)) / det;
  return [x, y, z];
}

/** Cover each masked blob (a letter and its edge) with a shifted copy of the photo next
 * to it: the shift whose surroundings match the blob's own surroundings best wins. The
 * copy's edge is feathered into the smooth fill already in `r`. */
function copyFill(r: Raster, src: Raster, mask: Mask) {
  const { w, h, m, box } = mask;
  const lab = new Int32Array(w * h).fill(-1);
  const comps: number[][] = [];
  const st: number[] = [];
  for (let s0 = 0; s0 < w * h; s0++) {
    if (!m[s0] || lab[s0] >= 0) continue;
    const id = comps.length, list: number[] = [];
    lab[s0] = id; st.push(s0);
    while (st.length) {
      const q = st.pop()!; list.push(q);
      const x = q % w, y = (q - x) / w;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const k = yy * w + xx;
        if (m[k] && lab[k] < 0) { lab[k] = id; st.push(k); }
      }
    }
    comps.push(list);
  }
  const inMask = (gx: number, gy: number) => { const x = gx - box.x0, y = gy - box.y0; return x >= 0 && y >= 0 && x < w && y < h && !!m[y * w + x]; };
  for (const list of comps) {
    if (list.length < 6) continue;
    let x0 = w, y0 = h, x1 = 0, y1 = 0;
    for (const q of list) { const x = q % w, y = (q - x) / w; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    // ring: unmasked pixels 2–4 px outside the blob (sampled)
    const ring: [number, number][] = [];
    for (const q of list) {
      const x = q % w, y = (q - x) / w;
      for (const [dx, dy] of [[3, 0], [-3, 0], [0, 3], [0, -3]]) {
        const gx = box.x0 + x + dx, gy = box.y0 + y + dy;
        if (gx < 0 || gy < 0 || gx >= src.w || gy >= src.h || inMask(gx, gy)) continue;
        if (((gx + gy) & 1) === 0) ring.push([gx, gy]);
      }
    }
    if (ring.length < 8) continue;
    const size = Math.max(x1 - x0, y1 - y0) + 1;
    const R = Math.max(12, Math.round(size * 0.9)), step = Math.max(1, Math.round(R / 24));
    const sample = list.filter((_, i) => i % Math.max(1, Math.round(list.length / 300)) === 0);
    let best: [number, number] | null = null, bestS = Infinity;
    for (let dy = -R; dy <= R; dy += step) for (let dx = -R; dx <= R; dx += step) {
      if (Math.abs(dx) < 2 && Math.abs(dy) < 2) continue;
      // the source spot must be clean photo (not masked) and on the page
      let ok = true;
      for (const q of sample) {
        const gx = box.x0 + (q % w) + dx, gy = box.y0 + ((q / w) | 0) + dy;
        if (gx < 0 || gy < 0 || gx >= src.w || gy >= src.h || inMask(gx, gy)) { ok = false; break; }
      }
      if (!ok) continue;
      let sum = 0;
      for (const [gx, gy] of ring) {
        const sx = gx + dx, sy = gy + dy;
        if (sx < 0 || sy < 0 || sx >= src.w || sy >= src.h) { sum += 3 * 65025; continue; }
        const i = (gy * src.w + gx) * 4, j = (sy * src.w + sx) * 4;
        const a = src.data[i] - src.data[j], b = src.data[i + 1] - src.data[j + 1], c = src.data[i + 2] - src.data[j + 2];
        sum += a * a + b * b + c * c;
      }
      const sc = sum / ring.length + 0.02 * (dx * dx + dy * dy); // prefer near spots
      if (sc < bestS) { bestS = sc; best = [dx, dy]; }
    }
    if (!best || bestS > 900) continue; // nothing similar enough: keep the smooth fill
    // level the copy: a plane through the ring's differences (target − source), so a
    // brighter or darker source spot, or a soft gradient, doesn't show as a letter shape
    const A = [0, 0, 0, 0, 0, 0, 0, 0, 0], B = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    const cx = box.x0 + (x0 + x1) / 2, cy = box.y0 + (y0 + y1) / 2;
    for (const [gx, gy] of ring) {
      const sx = gx + best[0], sy = gy + best[1];
      if (sx < 0 || sy < 0 || sx >= src.w || sy >= src.h) continue;
      const i = (gy * src.w + gx) * 4, j = (sy * src.w + sx) * 4, u = gx - cx, v = gy - cy;
      const f = [1, u, v];
      for (let a = 0; a < 3; a++) { for (let b = 0; b < 3; b++) A[a * 3 + b] += f[a] * f[b]; for (let c = 0; c < 3; c++) B[c][a] += f[a] * (src.data[i + c] - src.data[j + c]); }
    }
    const plane = B.map((bb) => solve3(A, bb));

    // feather: pixels deep inside take the copy fully, the outer 2 px mix with the fill
    for (const q of list) {
      const x = q % w, y = (q - x) / w, gx = box.x0 + x, gy = box.y0 + y;
      let edge = 3;
      for (let d = 1; d <= 2 && edge === 3; d++) for (const [dx, dy] of [[d, 0], [-d, 0], [0, d], [0, -d]]) if (!inMask(gx + dx, gy + dy)) { edge = d; break; }
      const t = edge >= 3 ? 1 : edge === 2 ? 0.66 : 0.33;
      const i = (gy * r.w + gx) * 4, j = ((gy + best[1]) * src.w + gx + best[0]) * 4, u = gx - cx, v = gy - cy;
      for (let c = 0; c < 3; c++) {
        const pl = plane[c], corr = pl ? pl[0] + pl[1] * u + pl[2] * v : 0;
        r.data[i + c] = r.data[i + c] * (1 - t) + (src.data[j + c] + corr) * t;
      }
    }
  }
}

/** Erase the ink of one analysed line (in place). `src` is the untouched original for grain. */
export function eraseLine(r: Raster, src: Raster, line: LineInfo, extra = 2) {
  let mask = dilate(line.erase, extra);
  if (line.noise > 4.2 && line.grain > 3) {
    // textured surface (kraft, fabric): the letter mask is unreliable, so clear
    // the whole word area and refill it with the surface's own grain
    const A = line.area, W = A.x1 - A.x0;
    const b = { x0: Math.min(line.inkBox.x0, line.box.x0), y0: Math.min(line.inkBox.y0, line.box.y0), x1: Math.max(line.inkBox.x1, line.box.x1), y1: Math.max(line.inkBox.y1, line.box.y1) };
    mask = { ...mask, m: new Uint8Array(mask.m.length) };
    for (let y = Math.max(A.y0, Math.floor(b.y0) - 1); y < Math.min(A.y1, Math.ceil(b.y1) + 1); y++)
      for (let x = Math.max(A.x0, Math.floor(b.x0) - extra); x < Math.min(A.x1, Math.ceil(b.x1) + extra); x++) mask.m[(y - A.y0) * W + (x - A.x0)] = 1;
  }
  // smooth photo behind the text (shading and folds, no fine grain): the ring model can't
  // follow the folds, so take a wider halo and let the fill follow the real surroundings
  // smooth photo behind the text (shading and folds, no fine grain): a letter mask built
  // against the photo itself, a smooth fill, then a matching copy of the photo next to it
  if (line.noise > 5 && line.grain < 1) {
    mask = dilate(photoInkMask(src, line), extra + 2);
    inpaint(r, mask, line.bgAt, photoGrain(src, line), undefined, 0, 400);
    copyFill(r, src, mask);
    return;
  }
  // neighbouring artwork (a frame, a rule, another word) must not bleed into the fill
  const tol = Math.max(45, line.thresh * 1.6); // only clear artwork, not shading or grain
  inpaint(r, mask, line.bgAt, grainSampler(src, line), (x, y) => dist(px(src, x, y), line.bgAt(x, y)) < tol);
}

/** Erase an arbitrary box (no text analysis): fills the whole box from its surroundings. */
export function eraseBox(r: Raster, src: Raster, b: Box, line: LineInfo) {
  const box = clampBox(b, r);
  const mask = { box, w: box.x1 - box.x0, h: box.y1 - box.y0, m: new Uint8Array((box.x1 - box.x0) * (box.y1 - box.y0)).fill(1) };
  // The surface to continue is the most common colour around the box; borders
  // or other artwork touching the box must not bleed in.
  const ring: [number, number, number][] = [];
  for (let x = box.x0; x < box.x1; x += 2) for (const y of [box.y0 - 2, box.y1 + 1]) if (y >= 0 && y < r.h) ring.push(px(src, x, y));
  for (let y = box.y0; y < box.y1; y += 2) for (const x of [box.x0 - 2, box.x1 + 1]) if (x >= 0 && x < r.w) ring.push(px(src, x, y));
  // mode: the ring colour with most close neighbours
  let mode = ring[0] ?? [255, 255, 255], bestN = -1;
  for (let i = 0; i < ring.length; i += 3) {
    let n = 0;
    for (const c of ring) if (dist(c, ring[i]) < 18) n++;
    if (n > bestN) { bestN = n; mode = ring[i]; }
  }
  const tol = Math.max(18, line.noise * 4 + 12);
  const trust = (x: number, y: number) => dist(px(src, x, y), mode) < tol;
  inpaint(r, mask, () => mode, grainSampler(src, line), trust);
}

/**
 * Background under a box, from the plain surface around it (a Coons patch of
 * the four edges). Edge pixels that belong to other artwork (borders, bands,
 * neighbouring icons) are ignored, so they can't bleed in.
 */
export function surfaceModel(src: Raster, b: Box) {
  const box = clampBox(b, src);
  const ring: [number, number, number][] = [];
  for (let x = box.x0; x < box.x1; x += 2) for (const y of [box.y0 - 2, box.y1 + 1]) if (y >= 0 && y < src.h) ring.push(px(src, x, y));
  for (let y = box.y0; y < box.y1; y += 2) for (const x of [box.x0 - 2, box.x1 + 1]) if (x >= 0 && x < src.w) ring.push(px(src, x, y));
  let mode: [number, number, number] = ring[0] ?? [255, 255, 255], bestN = -1;
  for (let i = 0; i < ring.length; i += 3) {
    let n = 0;
    for (const c of ring) if (dist(c, ring[i]) < 14) n++;
    if (n > bestN) { bestN = n; mode = ring[i]; }
  }
  const TOL = 26;
  const ok = (c: [number, number, number]) => dist(c, mode) < TOL;
  // one sample per edge position: median of 3 px just outside the box, or null if not plain surface
  const sample = (pts: [number, number][]) => {
    const cs = pts.filter(([x, y]) => x >= 0 && y >= 0 && x < src.w && y < src.h).map(([x, y]) => px(src, x, y)).filter(ok);
    if (!cs.length) return null;
    return [0, 1, 2].map((c) => cs.map((v) => v[c]).sort((a, b) => a - b)[cs.length >> 1]) as [number, number, number];
  };
  const fill = (arr: ([number, number, number] | null)[]) => {
    // fill gaps by linear interpolation between known samples (mode if none)
    const known = arr.map((v, i) => (v ? i : -1)).filter((i) => i >= 0);
    if (!known.length) return arr.map(() => mode);
    return arr.map((v, i) => {
      if (v) return v;
      let a = -1, b = -1;
      for (const k of known) { if (k < i) a = k; if (k > i && b < 0) b = k; }
      if (a < 0) return arr[b]!;
      if (b < 0) return arr[a]!;
      const t = (i - a) / (b - a);
      return [0, 1, 2].map((c) => arr[a]![c] * (1 - t) + arr[b]![c] * t) as [number, number, number];
    });
  };
  const W = box.x1 - box.x0, H = box.y1 - box.y0;
  const top = fill(Array.from({ length: W }, (_, i) => sample([[box.x0 + i, box.y0 - 1], [box.x0 + i, box.y0 - 2], [box.x0 + i, box.y0 - 3]])));
  const bot = fill(Array.from({ length: W }, (_, i) => sample([[box.x0 + i, box.y1], [box.x0 + i, box.y1 + 1], [box.x0 + i, box.y1 + 2]])));
  const lef = fill(Array.from({ length: H }, (_, j) => sample([[box.x0 - 1, box.y0 + j], [box.x0 - 2, box.y0 + j], [box.x0 - 3, box.y0 + j]])));
  const rig = fill(Array.from({ length: H }, (_, j) => sample([[box.x1, box.y0 + j], [box.x1 + 1, box.y0 + j], [box.x1 + 2, box.y0 + j]])));
  const c00 = top[0], c10 = top[W - 1], c01 = bot[0], c11 = bot[W - 1];
  const at = (x: number, y: number): [number, number, number] => {
    const i = Math.min(W - 1, Math.max(0, Math.round(x - box.x0))), j = Math.min(H - 1, Math.max(0, Math.round(y - box.y0)));
    const u = W > 1 ? i / (W - 1) : 0, v = H > 1 ? j / (H - 1) : 0;
    return [0, 1, 2].map((c) =>
      (1 - v) * top[i][c] + v * bot[i][c] + (1 - u) * lef[j][c] + u * rig[j][c]
      - ((1 - u) * (1 - v) * c00[c] + u * (1 - v) * c10[c] + (1 - u) * v * c01[c] + u * v * c11[c])) as [number, number, number];
  };
  return { box, at, mode, trust: (x: number, y: number) => ok(px(src, x, y)) };
}

/** Erase a whole box following the surface's own gradient (used where an element was lifted away). */
export function eraseArea(r: Raster, src: Raster, b: Box) {
  const S = surfaceModel(src, b);
  const box = S.box;
  const mask = { box, w: box.x1 - box.x0, h: box.y1 - box.y0, m: new Uint8Array((box.x1 - box.x0) * (box.y1 - box.y0)).fill(1) };
  inpaint(r, mask, S.at, undefined, S.trust);
}
