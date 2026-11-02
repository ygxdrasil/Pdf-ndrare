// Looks at one line of text in the page picture: the background behind it,
// which pixels are ink, the ink colour and the exact ink box.

import { Box, Mask, Raster, RGB, clampBox, dilate, dist, makeMask, medianColor, padBox, percentile, px } from './raster';

export interface LineInfo {
  box: Box; // OCR box (clamped)
  area: Box; // padded working area
  bgAt: (x: number, y: number) => RGB; // estimated clean background
  noise: number;
  grain: number; // pixel-to-pixel background variation (texture), see analyzeLine
  thresh: number;
  ink: Mask; // over `area`
  erase: Mask; // what to remove: ink plus its faint halo (antialiasing, JPEG ringing)
  cov: Float32Array; // soft ink coverage 0..1 over `area`
  mass: number; // total ink (linear in darkness, so blur doesn't change it), in px
  inkBox: Box; // tight ink box (image px)
  color: RGB; // ink colour
}

const BAND = 3;

/** Estimate background with a Coons-style blend of the four sides of the ring around `inner`. */
function backgroundModel(r: Raster, area: Box) {
  const w = area.x1 - area.x0, h = area.y1 - area.y0;
  const top: RGB[] = [], bot: RGB[] = [], left: RGB[] = [], right: RGB[] = [];
  const colMed = (x: number, y0: number, y1: number) => {
    const c: RGB[] = [];
    for (let xx = Math.max(area.x0, x - 2); xx <= Math.min(area.x1 - 1, x + 2); xx++)
      for (let y = y0; y < y1; y++) c.push(px(r, xx, y));
    return medianColor(c);
  };
  const rowMed = (y: number, x0: number, x1: number) => {
    const c: RGB[] = [];
    for (let yy = Math.max(area.y0, y - 2); yy <= Math.min(area.y1 - 1, y + 2); yy++)
      for (let x = x0; x < x1; x++) c.push(px(r, x, yy));
    return medianColor(c);
  };
  for (let i = 0; i < w; i++) {
    const x = area.x0 + i;
    top.push(colMed(x, area.y0, Math.min(area.y1, area.y0 + BAND)));
    bot.push(colMed(x, Math.max(area.y0, area.y1 - BAND), area.y1));
  }
  for (let j = 0; j < h; j++) {
    const y = area.y0 + j;
    left.push(rowMed(y, area.x0, Math.min(area.x1, area.x0 + BAND)));
    right.push(rowMed(y, Math.max(area.x0, area.x1 - BAND), area.x1));
  }
  // Smooth each side so bits of neighbouring letters in the ring don't leak in.
  const smooth = (side: RGB[]) => {
    const R = 6;
    const out = side.map((_, i) => medianColor(side.slice(Math.max(0, i - R), i + R + 1)));
    side.splice(0, side.length, ...out);
  };
  smooth(top); smooth(bot); smooth(left); smooth(right);
  const ring: RGB[] = [...top, ...bot, ...left, ...right];
  const flat = medianColor(ring);
  // Use the four-sided blend only if the sides really differ (a gradient);
  // otherwise one flat colour is steadier.
  const spread = percentile(ring.map((c) => dist(c, flat)), 0.8);
  const bgAt = (x: number, y: number): RGB => {
    if (spread < 12) return flat;
    const u = (x - area.x0) / Math.max(1, w - 1), v = (y - area.y0) / Math.max(1, h - 1);
    const i = Math.min(w - 1, Math.max(0, x - area.x0)), j = Math.min(h - 1, Math.max(0, y - area.y0));
    const out: RGB = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      const vert = top[i][k] * (1 - v) + bot[i][k] * v;
      const hor = left[j][k] * (1 - u) + right[j][k] * u;
      out[k] = (vert + hor) / 2;
    }
    return out;
  };
  const noise = percentile(ring.map((c) => dist(c, flat)), 0.5);
  return { bgAt, noise: spread < 12 ? noise : noise / 2, flat };
}

/** Least-squares plane c = a + b*u + c*v per channel over background pixels. */
function fitPlane(r: Raster, area: Box, d: Float32Array, lim: number): ((x: number, y: number) => RGB) | null {
  const W = area.x1 - area.x0;
  // normal equations for [1, u, v]
  const A = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  const B = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  let n = 0;
  const cx = (area.x0 + area.x1) / 2, cy = (area.y0 + area.y1) / 2;
  for (let y = area.y0; y < area.y1; y++)
    for (let x = area.x0; x < area.x1; x++) {
      if (d[(y - area.y0) * W + (x - area.x0)] > lim) continue;
      const u = (x - cx) / 100, v = (y - cy) / 100, f = [1, u, v];
      const c = px(r, x, y);
      for (let i = 0; i < 3; i++) { for (let j = 0; j < 3; j++) A[i * 3 + j] += f[i] * f[j]; for (let k = 0; k < 3; k++) B[i][k] += f[i] * c[k]; }
      n++;
    }
  if (n < 30) return null;
  // solve 3x3 for each channel (Cramer's rule)
  const det3 = (m: number[]) => m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
  const D = det3(A);
  if (Math.abs(D) < 1e-9) return null;
  const coef: number[][] = [];
  for (let k = 0; k < 3; k++) {
    const b = [B[0][k], B[1][k], B[2][k]];
    const sol: number[] = [];
    for (let col = 0; col < 3; col++) {
      const m = [...A];
      for (let row = 0; row < 3; row++) m[row * 3 + col] = b[row];
      sol.push(det3(m) / D);
    }
    coef.push(sol);
  }
  return (x, y) => {
    const u = (x - cx) / 100, v = (y - cy) / 100;
    return [coef[0][0] + coef[0][1] * u + coef[0][2] * v, coef[1][0] + coef[1][1] * u + coef[1][2] * v, coef[2][0] + coef[2][1] * u + coef[2][2] * v] as RGB;
  };
}

/**
 * Pull the working area back where the padding runs into a different surface
 * (a photo or a colour band right under the text). Otherwise the background
 * model blends the two and the erased patch shows as a grey box.
 */
function trimArea(r: Raster, box0: Box, area: Box): { area: Box; box: Box } {
  // whole pixels only (OCR boxes can be fractional; masks need integer areas)
  const box = { x0: Math.floor(box0.x0), y0: Math.floor(box0.y0), x1: Math.ceil(box0.x1), y1: Math.ceil(box0.y1) };
  const a = { ...area }, bx = { ...box0 };
  const LIM = 20;
  // background colour: the median over the box's rows (text is sparse along a row)
  const all: RGB[] = [];
  for (let y = box.y0; y < box.y1; y += 2) for (let x = box.x0; x < box.x1; x += 3) all.push(px(r, x, y));
  const ref = medianColor(all);
  // A row is another surface when, beside the text (left and right of the box), almost
  // none of it is background. Only the margins count: a row of dense bold letters is
  // not a surface. With no margins (box at the area edge), the whole row is used.
  const rowOther = (y: number) => {
    const frac = (x0: number, x1: number) => { let n = 0, k = 0; for (let x = x0; x < x1; x++) { k++; if (dist(px(r, x, y), ref) < LIM) n++; } return k ? n / k : -1; };
    const m = frac(Math.max(area.x0, box.x0 - 12), box.x0) , m2 = frac(box.x1, Math.min(area.x1, box.x1 + 12));
    const margins = [m, m2].filter((v) => v >= 0);
    // both the margins and the row as a whole must be (almost) all another colour
    return (!margins.length || margins.every((v) => v < 0.2)) && frac(area.x0, area.x1) < 0.2;
  };
  // Inside the box only rows that run on to the box edge count (an OCR box that
  // reaches into a photo below); a dense row of letters in the middle does not.
  const mid = Math.round((box.y0 + box.y1) / 2);
  let c = box.y1; while (c - 1 > mid && rowOther(c - 1)) c--;
  if (c < box.y1) a.y1 = c; else for (let y = box.y1; y < area.y1; y++) if (rowOther(y)) { a.y1 = y; break; }
  c = box.y0; while (c < mid && rowOther(c)) c++;
  if (c > box.y0) a.y0 = c; else for (let y = box.y0 - 1; y >= area.y0; y--) if (rowOther(y)) { a.y0 = y + 1; break; }
  // the background model reads a few rows at each edge of the area: if the new edge
  // runs right along the letters (no clean rows left), keep the old edge instead
  const clean = (y: number) => { let n = 0, k = 0; for (let x = area.x0; x < area.x1; x += 2) { k++; if (dist(px(r, x, y), ref) < LIM) n++; } return n >= k * 0.85; };
  if (a.y1 !== area.y1 && ![1, 2, 3].every((d) => clean(a.y1 - d))) a.y1 = area.y1;
  if (a.y0 !== area.y0 && ![0, 1, 2].every((d) => clean(a.y0 + d))) a.y0 = area.y0;
  // keep a thin ring for the background model
  bx.y1 = Math.max(bx.y0 + 2, Math.min(bx.y1, a.y1 - 2)); bx.y0 = Math.min(bx.y1 - 2, Math.max(bx.y0, a.y0 + 2));
  if (a.y1 - a.y0 < 6) return { area, box: box0 };
  return { area: { x0: Math.round(a.x0), y0: Math.round(a.y0), x1: Math.round(a.x1), y1: Math.round(a.y1) }, box: bx };
}

export function analyzeLine(r: Raster, ocrBox: Box): LineInfo {
  const box0 = clampBox(ocrBox, r);
  const pad = Math.max(4, Math.round((box0.y1 - box0.y0) * 0.35));
  const { area, box } = trimArea(r, box0, clampBox(padBox(box0, pad), r));
  const h = box.y1 - box.y0;
  const first = backgroundModel(r, area);
  const noise = first.noise;
  const thresh = Math.max(26, noise * 4 + 10);
  const ink = makeMask(area);
  const d = new Float32Array(ink.w * ink.h);
  for (let y = area.y0; y < area.y1; y++)
    for (let x = area.x0; x < area.x1; x++) d[(y - area.y0) * ink.w + (x - area.x0)] = dist(px(r, x, y), first.bgAt(x, y));
  // Refine: fit a smooth plane (per colour channel) through the pixels that are
  // clearly background, so neighbouring text in the ring can't skew it.
  const bgAt = fitPlane(r, area, d, Math.max(8, thresh * 0.4)) ?? first.bgAt;
  for (let y = area.y0; y < area.y1; y++)
    for (let x = area.x0; x < area.x1; x++) d[(y - area.y0) * ink.w + (x - area.x0)] = dist(px(r, x, y), bgAt(x, y));
  // Ink only counts inside the OCR box grown a little (ascenders/descenders can poke out).
  const grow = Math.max(2, Math.round(h * 0.2));
  const inner = clampBox(padBox(box, grow), r);
  const strong: number[] = [];
  for (let y = inner.y0; y < inner.y1; y++)
    for (let x = inner.x0; x < inner.x1; x++) {
      const i = (y - area.y0) * ink.w + (x - area.x0);
      if (d[i] > thresh) { ink.m[i] = 1; strong.push(d[i]); }
    }
  const dRaw = new Float32Array(d);
  // Drop ink that belongs to neighbouring lines: keep a connected piece only
  // if most of it lies inside the OCR box.
  {
    const W = ink.w, H = ink.h, lab = new Int32Array(W * H).fill(-1);
    const bx0 = box.x0 - area.x0, by0 = box.y0 - area.y0, bx1 = box.x1 - area.x0, by1 = box.y1 - area.y0;
    const stack: number[] = [];
    let label = 0;
    for (let s0 = 0; s0 < W * H; s0++) {
      if (!ink.m[s0] || lab[s0] >= 0) continue;
      const members: number[] = [];
      let inside = 0;
      stack.push(s0); lab[s0] = label;
      while (stack.length) {
        const k = stack.pop()!;
        members.push(k);
        const x = k % W, y = (k / W) | 0;
        if (x >= bx0 && x < bx1 && y >= by0 && y < by1) inside++;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx, yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
            const j = yy * W + xx;
            if (ink.m[j] && lab[j] < 0) { lab[j] = label; stack.push(j); }
          }
      }
      // keep a piece only if most of it, and its centre, lie inside the box
      let sx = 0, sy = 0;
      for (const k of members) { sx += k % W; sy += (k / W) | 0; }
      const mcx = sx / members.length, mcy = sy / members.length;
      const centred = mcx >= bx0 - 1 && mcx <= bx1 + 1 && mcy >= by0 - h * 0.6 && mcy <= by1 + h * 0.6;
      if (inside < members.length * 0.4 || !centred) for (const k of members) { ink.m[k] = 0; d[k] = 0; }
      label++;
    }
  }
  const core = Math.max(thresh * 1.5, percentile(strong, 0.85));
  const cov = new Float32Array(ink.w * ink.h);
  for (let i = 0; i < cov.length; i++) cov[i] = ink.m[i] || d[i] < thresh ? Math.max(0, Math.min(1, (d[i] - thresh * 0.5) / (core - thresh * 0.5))) : 0;
  // Ink box from the solid part of the letters (not the JPEG halo around them)
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let y = 0; y < ink.h; y++)
    for (let x = 0; x < ink.w; x++)
      if (ink.m[y * ink.w + x] && cov[y * ink.w + x] >= 0.5) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  // never let the ink box grow far beyond the text line itself (drawings or
  // lines touching the box would otherwise make the text look huge)
  const lim = Math.max(2, h * 0.35);
  const inkBox = isFinite(x0)
    ? {
        x0: Math.max(box.x0 - lim, area.x0 + x0), y0: Math.max(box.y0 - lim, area.y0 + y0),
        x1: Math.min(box.x1 + lim, area.x0 + x1 + 1), y1: Math.min(box.y1 + lim, area.y0 + y1 + 1),
      }
    : box;
  // Ink colour: the most "inky" pixels.
  const cut = percentile(strong, 0.85); // the darkest cores: small text never reaches its true colour elsewhere
  const cols: RGB[] = [];
  for (let y = area.y0; y < area.y1; y++)
    for (let x = area.x0; x < area.x1; x++) {
      const i = (y - area.y0) * ink.w + (x - area.x0);
      if (ink.m[i] && d[i] >= cut) cols.push(px(r, x, y));
    }
  const color = cols.length ? medianColor(cols) : ([0, 0, 0] as RGB);
  // Erase mask: the ink, plus faint pixels right around it that still differ
  // from the background (otherwise a ghost of the old word stays visible).
  const near = dilate(ink, Math.max(2, Math.round(h * 0.12)));
  const erase = makeMask(area);
  const eThresh = Math.max(7, noise * 2 + 4);
  for (let i = 0; i < erase.m.length; i++) if (ink.m[i] || (near.m[i] && dRaw[i] > eThresh)) erase.m[i] = 1;
  // Ink mass: sum of darkness relative to the full ink colour. Blur spreads
  // ink out but keeps this sum, so it tells the true stroke weight.
  // Signed: only the part of each pixel that goes from background towards the
  // ink colour counts (JPEG ringing that makes pixels lighter doesn't).
  let mass = 0;
  for (let y = area.y0; y < area.y1; y++)
    for (let x = area.x0; x < area.x1; x++) {
      const i = (y - area.y0) * ink.w + (x - area.x0);
      if (!erase.m[i]) continue;
      const b = bgAt(x, y), p = px(r, x, y);
      const vx = color[0] - b[0], vy = color[1] - b[1], vz = color[2] - b[2];
      const len2 = vx * vx + vy * vy + vz * vz;
      if (len2 < 1) continue;
      const t = ((p[0] - b[0]) * vx + (p[1] - b[1]) * vy + (p[2] - b[2]) * vz) / len2;
      mass += Math.max(0, Math.min(1, t));
    }
  // Grain: how much neighbouring background pixels differ (kraft, fabric, print
  // screen). Unlike `noise` this ignores smooth shading such as a photo's folds.
  const gd: number[] = [];
  for (let y = area.y0; y < area.y1; y += 2)
    for (let x = area.x0; x < area.x1 - 1; x++) {
      const i = (y - area.y0) * ink.w + (x - area.x0);
      if (near.m[i] || near.m[i + 1]) continue;
      gd.push(dist(px(r, x, y), px(r, x + 1, y)));
    }
  const grain = gd.length > 20 ? percentile(gd, 0.5) : noise;
  return { box, area, bgAt, noise, grain, thresh, ink, erase, cov, mass, inkBox, color };
}
