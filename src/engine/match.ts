// Finds the font, size, letter spacing and baseline of a line of lettering in
// the page picture by drawing the same words in every candidate font and
// comparing the shapes pixel by pixel.

import { FontLib, FontEntry, Platform, drawText, missingChars, FEATURES } from './fonts';
import type { LineInfo } from './analyze';
import type { Box } from './raster';

export interface LineFit {
  key: string; // font key
  size: number; // px (image pixels)
  tracking: number; // px between glyphs
  hs: number; // horizontal scale of the letters (1 = as designed)
  bold: number; // synthetic emboldening, px of outline width (0 = none)
  baseline: number; // image y
  penX: number; // image x of the pen start
  inkX0: number; // where the ink starts
  inkW: number;
  score: number;
}

export interface MatchResult {
  key: string;
  family: string;
  weight: number;
  score: number;
  lines: LineFit[];
  ranking: { key: string; score: number }[];
}

function runBox(font: any, text: string) {
  const run = font.layout(text, FEATURES);
  const b = run.bbox; // font units, y up
  return { minX: b.minX, minY: b.minY, maxX: b.maxX, maxY: b.maxY, n: run.glyphs.length, adv: run.advanceWidth };
}

/** A smaller copy of an analysed line (for a quick first comparison). */
function shrinkLine(l: LineInfo, targetH: number): LineInfo {
  const inkH = l.inkBox.y1 - l.inkBox.y0;
  const q = Math.min(1, targetH / Math.max(1, inkH));
  if (q >= 0.999) return l;
  const A = l.area, W = A.x1 - A.x0, H = A.y1 - A.y0;
  const w = Math.max(1, Math.round(W * q)), h = Math.max(1, Math.round(H * q));
  const cov = new Float32Array(w * h), cnt = new Float32Array(w * h);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = Math.min(h - 1, Math.floor(y * q)) * w + Math.min(w - 1, Math.floor(x * q));
    cov[i] += l.cov[y * W + x]; cnt[i]++;
  }
  for (let i = 0; i < cov.length; i++) cov[i] = cnt[i] ? cov[i] / cnt[i] : 0;
  const sb = (b: Box) => ({ x0: A.x0 * q + (b.x0 - A.x0) * q, y0: A.y0 * q + (b.y0 - A.y0) * q, x1: A.x0 * q + (b.x1 - A.x0) * q, y1: A.y0 * q + (b.y1 - A.y0) * q });
  const area = { x0: Math.round(A.x0 * q), y0: Math.round(A.y0 * q), x1: Math.round(A.x0 * q) + w, y1: Math.round(A.y0 * q) + h };
  return { ...l, area, box: sb(l.box), inkBox: sb(l.inkBox), cov, mass: l.mass * q * q };
}

/** Fit one candidate font to one line, also trying a horizontally stretched or
 * squeezed version when the letters only fit with odd letter spacing
 * (packaging artwork often scales type horizontally). */
function fitLine(platform: Platform, font: any, key: string, line: LineInfo, text: string, cache: Map<string, any>): LineFit | null {
  const t = text.trim();
  if (!t) return null;
  const rb = runBox(font, t);
  const upm = font.unitsPerEm;
  const inkH = line.inkBox.y1 - line.inkBox.y0, inkW = line.inkBox.x1 - line.inkBox.x0;
  const hUnits = rb.maxY - rb.minY;
  if (hUnits <= 0) return null;
  const size = inkH / (hUnits / upm);
  const natW = (rb.maxX - rb.minX) * (size / upm);
  const free = rb.n > 1 ? (inkW - natW) / (rb.n - 1) : 0;
  const scales = [1];
  // width only explained by unusual spacing (or a single glyph of the wrong width): try scaling
  if (natW > 0 && (rb.n === 1 || Math.abs(free / size) > 0.035)) {
    const h0 = Math.max(0.7, Math.min(1.4, inkW / natW));
    if (Math.abs(Math.log(h0)) > 0.04) scales.push(h0, Math.sqrt(h0));
  }
  let best: LineFit | null = null;
  for (const hs of scales) {
    const f = fitScaled(platform, font, key, line, t, cache, rb, size, hs);
    if (f && (!best || f.score > best.score)) best = f;
  }
  return best;
}

function fitScaled(platform: Platform, font: any, key: string, line: LineInfo, t: string, cache: Map<string, any>, rb: ReturnType<typeof runBox>, size: number, hs: number): LineFit | null {
  const upm = font.unitsPerEm;
  const inkW = line.inkBox.x1 - line.inkBox.x0;
  const s = size / upm, sx = s * hs;
  const natW = (rb.maxX - rb.minX) * sx;
  let tracking = rb.n > 1 ? (inkW - natW) / (rb.n - 1) : 0;
  tracking = Math.max(-0.06 * size, Math.min(0.15 * size, tracking));
  const penX = line.inkBox.x0 - rb.minX * sx;
  const baseline = line.inkBox.y1 + rb.minY * s; // minY <= 0 for descenders
  // Render into the line's working area and compare with the soft ink coverage.
  const A = line.area, W = A.x1 - A.x0, H = A.y1 - A.y0;
  let cv = cache.get(`${W}x${H}`);
  if (!cv) { cv = platform.createCanvas(W, H); cache.set(`${W}x${H}`, cv); }
  const ctx = cv.getContext('2d');
  const render = (b: number) => { ctx.clearRect(0, 0, W, H); drawText(ctx, font, t, penX - A.x0, baseline - A.y0, size, tracking, '#000', hs, b); return ctx.getImageData(0, 0, W, H).data; };
  const massOf = (d: Uint8ClampedArray) => { let m = 0; for (let i = 3; i < d.length; i += 4) m += d[i] / 255; return m; };
  let img = render(0), bold = 0;
  // too light, and no in-between weight: thicken the strokes until the ink matches
  const m0 = massOf(img);
  if (line.mass > 0 && m0 > 0 && m0 < line.mass * 0.9) {
    const b0 = Math.max(0.6, size * 0.04), img1 = render(b0), m1 = massOf(img1);
    if (m1 > m0) {
      bold = Math.min(size * 0.08, b0 * (line.mass - m0) / (m1 - m0));
      img = Math.abs(bold - b0) < 0.05 ? img1 : render(bold);
    }
  }
  // light blur of the rendering to mimic the picture's softness
  const a = new Float32Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      let sum = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
          const wgt = dx === 0 && dy === 0 ? 4 : dx === 0 || dy === 0 ? 2 : 1;
          sum += (img[(yy * W + xx) * 4 + 3] / 255) * wgt; n += wgt;
        }
      a[y * W + x] = sum / n;
    }
  // Compare glyph by glyph, letting each glyph slide a few pixels sideways, so
  // small width differences don't add up along the line and hide a good match.
  const run = font.layout(t, FEATURES);
  const xs: number[] = [];
  let pen = 0;
  run.positions.forEach((p: any, i: number) => { xs.push(penX - A.x0 + pen * sx + tracking * i); pen += p.xAdvance; });
  xs.push(penX - A.x0 + pen * sx + tracking * run.glyphs.length);
  const slide = Math.max(2, Math.round(size * 0.08));
  let mn = 0, mx = 0;
  const yTop = Math.max(0, Math.floor(line.inkBox.y0 - A.y0 - 2)), yBot = Math.min(H, Math.ceil(line.inkBox.y1 - A.y0 + 2));
  for (let gi = 0; gi < run.glyphs.length; gi++) {
    const gx0 = Math.max(0, Math.floor(xs[gi])), gx1 = Math.min(W, Math.ceil(xs[gi + 1]));
    if (gx1 <= gx0) continue;
    let bMn = 0, bMx = 1, bRatio = -1;
    for (let dx = -slide; dx <= slide; dx++) {
      let m1 = 0, m2 = 0;
      for (let y = yTop; y < yBot; y++)
        for (let x = gx0; x < gx1; x++) {
          const xo = x + dx;
          const o = xo >= 0 && xo < W ? line.cov[y * W + xo] : 0;
          const rr = a[y * W + x];
          m1 += Math.min(o, rr); m2 += Math.max(o, rr);
        }
      const ratio = m2 > 0 ? m1 / m2 : 0;
      if (ratio > bRatio) { bRatio = ratio; bMn = m1; bMx = m2; }
    }
    mn += bMn; mx += bMx;
  }
  let score = mx > 0 ? mn / mx : 0;
  // stroke weight: compare total ink with the original (blur-proof)
  let massR = 0;
  for (let i = 0; i < img.length; i += 4) massR += img[i + 3] / 255;
  if (line.mass > 0 && massR > 0) score -= 0.9 * Math.abs(Math.log(massR / line.mass));
  score -= 0.15 * Math.abs(tracking / size); // prefer natural spacing
  score -= 0.25 * Math.abs(Math.log(hs)); // and natural letter widths
  score -= 0.6 * (bold / size); // and real weights
  return { key, size, tracking, hs, bold, baseline, penX, inkX0: line.inkBox.x0, inkW, score };
}

export async function matchFont(
  lib: FontLib,
  lines: { info: LineInfo; text: string }[],
  opts: { style?: 'sans' | 'serif' | 'script' | 'any'; families?: string[]; prefer?: string; preferTol?: number } = {},
): Promise<MatchResult> {
  if (!lines.length) throw new Error('Hittade ingen text att matcha typsnittet mot. Markera texten med en ruta och försök igen.');
  let cands: FontEntry[] = lib.entries;
  if (opts.families?.length) {
    const fams = opts.families.map((f) => f.toLowerCase());
    const sub = cands.filter((e) => fams.includes(e.family.toLowerCase()));
    if (sub.length) cands = sub;
  } else if (opts.style && opts.style !== 'any') cands = cands.filter((e) => e.style === opts.style);
  const allText = lines.map((l) => l.text).join(' ');
  const cache = new Map<string, any>();
  const results: { key: string; score: number; fits: LineFit[] }[] = [];
  // Quick pre-filter: the same comparison on a small copy of the widest line (about
  // 24 px tall), for every font; the detailed comparison then runs on the best ones.
  const POOL = 28;
  if (cands.length > POOL) {
    const l0 = lines.reduce((a, b) => ((b.info.inkBox.x1 - b.info.inkBox.x0) > (a.info.inkBox.x1 - a.info.inkBox.x0) ? b : a));
    const small = shrinkLine(l0.info, 24);
    const qcache = new Map<string, any>();
    const scored: { e: FontEntry; d: number }[] = [];
    for (const e of cands) {
      const font = await lib.load(e.key);
      if (missingChars(font, l0.text.replace(/[®©™]/g, '')).length) continue;
      const f = fitLine(lib.platform, font, e.key, small, l0.text, qcache);
      if (f) scored.push({ e, d: -f.score });
    }
    scored.sort((a, b) => a.d - b.d);
    cands = scored.slice(0, POOL).map((x) => x.e);
  }
  for (const e of cands) {
    const font = await lib.load(e.key);
    if (missingChars(font, allText.replace(/[®©™]/g, '')).length) continue;
    const fits: LineFit[] = [];
    let total = 0, wsum = 0;
    for (const l of lines) {
      const f = fitLine(lib.platform, font, e.key, l.info, l.text, cache);
      if (!f) continue;
      const wgt = (l.info.inkBox.x1 - l.info.inkBox.x0) * (l.info.inkBox.y1 - l.info.inkBox.y0);
      fits.push(f); total += f.score * wgt; wsum += wgt;
    }
    if (!fits.length) continue;
    results.push({ key: e.key, score: total / wsum, fits });
  }
  results.sort((a, b) => b.score - a.score);
  if (!results.length) throw new Error('Hittade inget typsnitt som kan skriva texten.');
  let best = results[0];
  if (opts.prefer) {
    const p = results.find((r) => r.key === opts.prefer);
    if (p && p.score > best.score - (opts.preferTol ?? 0.04)) best = p;
  }
  const e = lib.entry(best.key);
  return { key: best.key, family: e.family, weight: e.weight, score: best.score, lines: best.fits, ranking: results.slice(0, 20).map((r) => ({ key: r.key, score: +r.score.toFixed(3) })) };
}
