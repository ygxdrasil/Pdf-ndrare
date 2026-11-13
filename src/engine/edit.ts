// Applies an edit plan to the page picture.
// - Lines that don't change are not touched at all.
// - If only some words in a line change, only those words are replaced and the
//   rest of the line keeps its original pixels (moved sideways if needed).
// - Otherwise the line/block is erased and set again in the matched font.

import { pageFontHints } from './pdf';
import { Box, Raster, RGB, cloneRaster, cropRaster, pasteRaster, median, unionBox, padBox, clampBox, px, dist, makeMask, dilate } from './raster';
import { analyzeLine, LineInfo } from './analyze';
import { eraseArea, eraseBox, eraseLine, surfaceModel } from './erase';
import { matchFont, MatchResult } from './match';
import { FontLib, FEATURES, drawText } from './fonts';
import type { TextItem } from './pdf';

export interface OcrWord { text: string; box: Box }
export interface OcrLine {
  id: number;
  text: string;
  box: Box;
  words?: OcrWord[];
  /** Text that does not run left to right: 90 = reads bottom to top (turned counter-clockwise), -90 = reads top to bottom. */
  rot?: 90 | -90;
  /** The OCR engine's own confidence for the line (0-100), when known. */
  conf?: number;
}

export interface TextEdit {
  kind: 'text';
  lines: number[];
  boxes?: Box[];
  old: string[];
  new: string;
  align?: 'left' | 'center' | 'right';
  maxWidth?: number;
  maxHeight?: number;
  style?: 'sans' | 'serif' | 'script' | 'any';
  font?: string;
  weight?: number;
  group?: string;
  sizeScale?: number;
  /** internal: skip the replace-only-the-changed-words mode (set when a retry should redo the whole line) */
  noWords?: boolean;
  /** internal: `weight` was set by a retry, not asked for by the plan */
  weightFromRetry?: boolean;
  /** internal: letters at their natural width and spacing (a retry when the fit had to squeeze them) */
  noSqueeze?: boolean;
  /** internal: size (px) taken from a similar, well-fitted line elsewhere on the page (a retry when this line's own fit was disturbed by other ink) */
  forceSize?: number;
}

export interface EraseEdit { kind: 'erase'; box: Box }
/** Move a non-text element (icon, badge, logo + its caption) as exact pixels. */
export interface MoveEdit { kind: 'move'; box: Box; to: { x: number; y: number } }
export type Edit = TextEdit | EraseEdit | MoveEdit;

export interface EditReport {
  index: number;
  font?: string;
  sizePx?: number;
  shrunk?: number;
  lines?: number;
  mode?: string;
  warnings: string[];
  match?: MatchResult;
  box: Box;
}

export interface Applied { raster: Raster; items: TextItem[]; reports: EditReport[] }

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
const words = (s: string) => norm(s).split(' ').filter(Boolean);
const simpleKey = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/**
 * Alignment of a lone line, judged from the lines around it: a column of numbers shares its right edge,
 * a label with a caption stacked right under it shares its centre; otherwise left.
 */
function alignFromNeighbours(box: Box, ocr: OcrLine[], self?: OcrLine): 'left' | 'center' | 'right' {
  const h = Math.max(1, box.y1 - box.y0), tol = Math.max(3, h * 0.25);
  const near = ocr.filter((o) => o !== self && o.text.trim().length > 0 && (o.box.y1 - o.box.y0) > h * 0.5 && (o.box.y1 - o.box.y0) < h * 2 && Math.abs((o.box.y0 + o.box.y1) / 2 - (box.y0 + box.y1) / 2) < h * 14);
  const cx = (b: Box) => (b.x0 + b.x1) / 2;
  // centred: a line right above/below (within ~2 line heights) whose centre matches although its edges don't
  const stacked = near.filter((o) => Math.abs(o.box.y0 - box.y1) < h * 1.6 || Math.abs(box.y0 - o.box.y1) < h * 1.6);
  if (stacked.some((o) => Math.abs(cx(o.box) - cx(box)) < tol && Math.abs(o.box.x0 - box.x0) > tol * 1.5 && Math.abs(o.box.x1 - box.x1) > tol * 1.5)) return 'center';
  // right: at least two other lines in the same column end at the same x (and don't start at the same x)
  // (equal-width neighbours share both edges: one differing left edge among them is enough, as long as the left edge isn't the one the column keeps)
  const sameR = near.filter((o) => Math.abs(o.box.x1 - box.x1) < tol);
  const sameL = near.filter((o) => Math.abs(o.box.x0 - box.x0) < tol);
  if (sameR.length >= 2 && sameR.some((o) => Math.abs(o.box.x0 - box.x0) > tol) && sameL.filter((o) => Math.abs(o.box.x1 - box.x1) > tol).length < 2) return 'right';
  return 'left';
}

function detectAlign(infos: LineInfo[], ocr: OcrLine[] = [], self?: OcrLine): 'left' | 'center' | 'right' {
  if (infos.length < 2) return alignFromNeighbours(infos[0]?.box ?? { x0: 0, y0: 0, x1: 1, y1: 1 }, ocr, self);
  const spread = (v: number[]) => Math.max(...v) - Math.min(...v);
  const l = spread(infos.map((i) => i.inkBox.x0));
  const c = spread(infos.map((i) => (i.inkBox.x0 + i.inkBox.x1) / 2));
  const r = spread(infos.map((i) => i.inkBox.x1));
  const m = Math.min(l, c, r);
  return m === c && c < l - 2 ? 'center' : m === r && r < l - 2 ? 'right' : 'left';
}

/** Resample a picture by a factor (smooth). */
async function scaleRaster(lib: FontLib, r: Raster, f: number): Promise<Raster> {
  const w = Math.max(1, Math.round(r.w * f)), h = Math.max(1, Math.round(r.h * f));
  const a = lib.platform.createCanvas(r.w, r.h), g = a.getContext('2d');
  const id = g.createImageData(r.w, r.h); id.data.set(r.data); g.putImageData(id, 0, 0);
  const b = lib.platform.createCanvas(w, h), g2 = b.getContext('2d');
  (g2 as any).imageSmoothingQuality = 'high';
  g2.drawImage(a as any, 0, 0, w, h);
  const d = g2.getImageData(0, 0, w, h);
  return { w, h, data: new Uint8ClampedArray(d.data) };
}

export function inkExtent(font: any, text: string, size: number, tracking: number, hs = 1, slant = 0) {
  const run = font.layout(text, FEATURES);
  const s = (size / font.unitsPerEm) * hs;
  const b = run.bbox;
  const n = run.glyphs.length;
  const v = size / font.unitsPerEm; // leaning letters reach further right at the top, further left at the bottom
  return { minX: b.minX * s + Math.min(0, slant * b.minY * v), maxX: b.maxX * s + Math.max(0, slant * b.maxY * v) + tracking * Math.max(0, n - 1), adv: run.advanceWidth * s + tracking * n };
}

/**
 * How far (px) the line's rows stay free of other lettering from x in direction dir.
 * A column counts as lettering when some pixel in it stands out from that column's own
 * median (taken over a taller window), so photos and gradients don't count as ink.
 */
function freeRun(src: Raster, ink: Box, x: number, dir: 1 | -1, lim: number, thresh: number): number {
  const h = ink.y1 - ink.y0;
  const y0 = Math.max(0, Math.round(ink.y0)), y1 = Math.min(src.h, Math.round(ink.y1));
  const w0 = Math.max(0, Math.round(ink.y0 - h * 0.6)), w1 = Math.min(src.h, Math.round(ink.y1 + h * 0.6));
  for (let d = 1; d <= lim; d++) {
    if (d <= 2) continue; // the word's own soft edge / the thin flag of a "1" can lie just outside its ink box
    const xx = Math.round(x + dir * d);
    if (xx < 0 || xx >= src.w) return d - 1;
    const col: number[][] = [];
    for (let y = w0; y < w1; y += 2) col.push(px(src, xx, y));
    const med = [0, 1, 2].map((c) => col.map((v) => v[c]).sort((a, b) => a - b)[col.length >> 1]) as RGB;
    // faint tints (zebra rows, watermarks) are not lettering: only clear ink stops the free run
    for (let y = y0; y < y1; y++) if (dist(px(src, xx, y), med) > Math.max(thresh, 60)) return d - 1;
  }
  return lim;
}

function wrap(font: any, text: string, size: number, tracking: number, maxW: number, hs = 1): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    const ws = para.split(/\s+/).filter(Boolean);
    if (!ws.length) { out.push(''); continue; }
    let cur = ws[0];
    for (const w of ws.slice(1)) {
      const t = cur + ' ' + w;
      const e = inkExtent(font, t, size, tracking, hs);
      if (e.maxX - e.minX <= maxW) cur = t;
      else { out.push(cur); cur = w; }
    }
    out.push(cur);
  }
  return out;
}

/** Copy the ink of `info` (soft coverage) from `src` onto `dst`, shifted by dx. */
function pasteInk(dst: Raster, src: Raster, info: LineInfo, dx: number) {
  const A = info.area, W = A.x1 - A.x0;
  const s = Math.round(dx);
  for (let y = A.y0; y < A.y1; y++)
    for (let x = A.x0; x < A.x1; x++) {
      const k = (y - A.y0) * W + (x - A.x0);
      if (!info.erase.m[k]) continue;
      // copy the original pixels as they are (they already hold the soft edge)
      const tx = x + s;
      if (tx < 0 || tx >= dst.w) continue;
      const si = (y * src.w + x) * 4, di = (y * dst.w + tx) * 4;
      for (let c = 0; c < 3; c++) dst.data[di + c] = src.data[si + c];
    }
}

/**
 * Find the element Claude pointed at: the blobs of non-surface pixels that sit
 * in the box (Claude's boxes are approximate). Blobs that reach far outside it
 * (a border, a colour band, the next icon) are not part of it.
 */
export function snapElement(src: Raster, b: Box, opts: { text?: boolean } = {}) {
  const bw = b.x1 - b.x0, bh = b.y1 - b.y0;
  const reach = Math.max(12, 0.6 * Math.max(bw, bh));
  const R = clampBox(padBox(b, reach), src);
  const mode = surfaceModel(src, b).mode;
  const W = R.x1 - R.x0, H = R.y1 - R.y0;
  const on = new Uint8Array(W * H);
  // for text, only the letters' strong ink counts (not soft shading around them)
  let thr = 30;
  if (opts.text) {
    let maxD = 0;
    for (let y = Math.max(0, Math.floor(b.y0)); y < Math.min(src.h, Math.ceil(b.y1)); y++) for (let x = Math.max(0, Math.floor(b.x0)); x < Math.min(src.w, Math.ceil(b.x1)); x++) maxD = Math.max(maxD, dist(px(src, x, y), mode));
    thr = Math.max(30, maxD * 0.5);
  }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (dist(px(src, R.x0 + x, R.y0 + y), mode) > thr) on[y * W + x] = 1;
  const lab = new Int32Array(W * H).fill(-1);
  const keep = makeMask(R);
  let found: Box | null = null;
  const stack: number[] = [];
  const rest: { pts: number[]; b: Box }[] = [];
  const kh: number[] = [];
  const kept: Box[] = [];
  for (let k0 = 0; k0 < W * H; k0++) {
    if (!on[k0] || lab[k0] >= 0) continue;
    const pts: number[] = [];
    lab[k0] = k0; stack.push(k0);
    let x0 = W, y0 = H, x1 = 0, y1 = 0, inside = 0;
    while (stack.length) {
      const k = stack.pop()!; pts.push(k);
      const x = k % W, y = (k / W) | 0;
      if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y;
      const gx = R.x0 + x, gy = R.y0 + y;
      if (gx >= b.x0 && gx < b.x1 && gy >= b.y0 && gy < b.y1) inside++;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        const kk = yy * W + xx;
        if (on[kk] && lab[kk] < 0) { lab[kk] = k0; stack.push(kk); }
      }
    }
    // touches the edge of the search area = part of something bigger: not ours
    if (x0 === 0 || y0 === 0 || x1 === W - 1 || y1 === H - 1) continue;
    const cb = { x0: R.x0 + x0, y0: R.y0 + y0, x1: R.x0 + x1 + 1, y1: R.y0 + y1 + 1 };
    if (inside < pts.length * (opts.text ? 0.5 : 0.3)) { rest.push({ pts, b: cb }); continue; }
    // text: letters only, never the frame or icon the text sits in
    if (opts.text && (cb.y1 - cb.y0 > bh * 1.5 || cb.x1 - cb.x0 > bw * 1.3)) continue;
    for (const k of pts) keep.m[k] = 1;
    kept.push(cb);
    kh.push(cb.y1 - cb.y0);
    found = found ? unionBox([found, cb]) : cb;
  }
  // lines of a caption that stick out below/above the box belong to the element too
  if (found && !opts.text) {
    const gap = Math.max(3, 0.8 * median(kh.filter((h) => h >= 3 && h < 0.5 * (found!.y1 - found!.y0)).concat([8])));
    for (let grew = true; grew; ) {
      grew = false;
      for (let i = rest.length - 1; i >= 0; i--) {
        const c = rest[i].b, f: Box = found;
        const ov = Math.min(c.x1, f.x1) - Math.max(c.x0, f.x0);
        const vgap = c.y0 >= f.y1 ? c.y0 - f.y1 : c.y1 <= f.y0 ? f.y0 - c.y1 : 0;
        const stacked = ov >= 0.5 * (c.x1 - c.x0) && vgap <= gap && (c.y0 >= f.y1 - 2 || c.y1 <= f.y0 + 2 || vgap === 0);
        if (!stacked) continue;
        for (const k of rest[i].pts) keep.m[k] = 1;
        found = unionBox([f, c]); rest.splice(i, 1); grew = true;
      }
    }
  }
  return { box: found, mask: keep, parts: kept };
}

/** Group letter boxes into text rows (top to bottom). */
export function textRows(parts: Box[]): Box[] {
  const rows: Box[] = [];
  for (const b of [...parts].sort((a, c) => a.y0 - c.y0)) {
    const h = b.y1 - b.y0;
    const r = rows.find((q) => Math.min(q.y1, b.y1) - Math.max(q.y0, b.y0) > 0.4 * Math.min(h, q.y1 - q.y0));
    if (r) { r.x0 = Math.min(r.x0, b.x0); r.x1 = Math.max(r.x1, b.x1); r.y0 = Math.min(r.y0, b.y0); r.y1 = Math.max(r.y1, b.y1); }
    else rows.push({ ...b });
  }
  return rows.sort((a, c) => a.y0 - c.y0);
}

/** The pixels of an element with a soft edge, and the surface under it. */
function liftElement(src: Raster, b: Box) {
  const sn = snapElement(src, b);
  const box = clampBox(padBox(sn.box ?? b, 3), src);
  const S = surfaceModel(src, box);
  const core = makeMask(box), W = box.x1 - box.x0, K = sn.mask, KW = K.box.x1 - K.box.x0;
  for (let y = box.y0; y < box.y1; y++) for (let x = box.x0; x < box.x1; x++) {
    const kx = x - K.box.x0, ky = y - K.box.y0;
    const inK = kx >= 0 && ky >= 0 && kx < KW && ky < K.box.y1 - K.box.y0 && K.m[ky * KW + kx];
    if (sn.box ? inK : dist(px(src, x, y), S.at(x, y)) > 22) core.m[(y - box.y0) * W + (x - box.x0)] = 1;
  }
  const mask = dilate(core, 2); // include the soft (anti-aliased) edge
  return { box, mask, bg: S.at };
}

/** Split a line into words by the gaps in its ink (when OCR's word boxes don't fit). */
function inkWords(info: LineInfo, oldLine: string): Box[] | null {
  const n = words(oldLine).length;
  if (n < 2) return null;
  const A = info.area, W = A.x1 - A.x0, B = info.inkBox;
  const col: boolean[] = [];
  for (let x = Math.floor(B.x0); x < Math.ceil(B.x1); x++) {
    let on = false;
    for (let y = Math.floor(B.y0); y < Math.ceil(B.y1) && !on; y++) { const v = info.cov[(y - A.y0) * W + (x - A.x0)]; if (v !== undefined && v > 0.3) on = true; }
    col.push(on);
  }
  // runs of empty columns, widest first: the n-1 widest are the word gaps
  const gaps: { a: number; b: number }[] = [];
  for (let i = 0; i < col.length; ) { if (col[i]) { i++; continue; } let j = i; while (j < col.length && !col[j]) j++; if (i > 0 && j < col.length) gaps.push({ a: i, b: j }); i = j; }
  if (gaps.length < n - 1) return null;
  gaps.sort((g, h) => (h.b - h.a) - (g.b - g.a));
  const use = gaps.slice(0, n - 1);
  // the word gaps must be clearly wider than letter gaps
  const rest = gaps.slice(n - 1);
  if (rest.length && (use[use.length - 1].b - use[use.length - 1].a) < (rest[0].b - rest[0].a) * 1.5) return null;
  use.sort((g, h) => g.a - h.a);
  const out: Box[] = [];
  let start = 0;
  for (const g of use) { out.push({ x0: B.x0 + start, x1: B.x0 + g.a, y0: B.y0, y1: B.y1 }); start = g.b; }
  out.push({ x0: B.x0 + start, x1: B.x1, y0: B.y0, y1: B.y1 });
  return out;
}

/** Map the words of `oldLine` to OCR word boxes, if the count matches. */
function wordBoxes(ocr: OcrLine | undefined, oldLine: string): Box[] | null {
  if (!ocr?.words?.length) return null;
  const ow = words(oldLine);
  if (ow.length !== ocr.words.length) return null;
  // sanity: most words should roughly agree with OCR
  let agree = 0;
  ow.forEach((w, i) => { const a = simpleKey(w), b = simpleKey(ocr.words![i].text); if (a && b && (a === b || a.slice(0, 3) === b.slice(0, 3))) agree++; });
  if (agree < Math.ceil(ow.length * 0.5)) return null;
  return ocr.words.map((w) => w.box);
}

/** Similarity of two texts (character bigrams, letters/digits only). */
export function similar(a: string, b: string): number {
  const A = simpleKey(a), B = simpleKey(b);
  if (!A || !B) return A === B ? 1 : 0;
  if (A === B) return 1;
  const grams = (t: string) => { const m = new Map<string, number>(); for (let i = 0; i < t.length - 1; i++) { const g = t.slice(i, i + 2); m.set(g, (m.get(g) ?? 0) + 1); } return m; };
  const ga = grams(A), gb = grams(B);
  let both = 0;
  for (const [g, n] of ga) both += Math.min(n, gb.get(g) ?? 0);
  const tot = Math.max(1, A.length - 1) + Math.max(1, B.length - 1);
  return (2 * both) / tot;
}

/**
 * Make sure an OCR line really is the text Claude means:
 * - if OCR merged several columns into one line, keep only the matching words;
 * - if the id points at the wrong line, find the right one nearby.
 */
const alnum = (t: string) => t.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();

/** When OCR read fewer letters than the old text has, grow the line box sideways over
 * the ink that continues the word (same colour as the line's ink, small gaps only),
 * at most as far as the missing letters can reach. */
export function extendToInk(src: Raster, l: OcrLine, oldText: string): OcrLine {
  const a = alnum(l.text), o = alnum(oldText);
  if (!a || o.length <= a.length + 1) return l;
  const right = similar(o.slice(0, a.length), a) >= 0.75, left = !right && similar(o.slice(-a.length), a) >= 0.75;
  if (!right && !left) return l;
  const b = l.box, h = b.y1 - b.y0;
  const perChar = (b.x1 - b.x0) / a.length;
  const maxExt = perChar * (o.length - a.length) * 1.6, gapMax = Math.max(4, h * 0.6);
  const info = analyzeLine(src, b);
  const ink = info.color;
  const y0 = Math.round(b.y0 + h * 0.12), y1 = Math.round(b.y1 - h * 0.12);
  const d = (p: number[], q: number[]) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
  const inkCol = (x: number) => {
    if (x < 0 || x >= src.w) return false;
    const col: number[][] = [];
    for (let y = Math.max(0, y0); y < Math.min(src.h, y1); y++) { const i = (y * src.w + x) * 4; col.push([src.data[i], src.data[i + 1], src.data[i + 2]]); }
    if (!col.length) return false;
    const med = [0, 1, 2].map((c) => col.map((p) => p[c]).sort((u, v) => u - v)[col.length >> 1]);
    if (d(med, ink) < 30) return true; // the column is mostly ink
    let n = 0;
    for (const p of col) if (d(p, ink) < d(p, med) * 0.6 && d(p, med) > 25) n++;
    return n >= Math.max(2, col.length * 0.03);
  };
  const dir = right ? 1 : -1;
  let x = right ? Math.ceil(b.x1) : Math.floor(b.x0) - 1, last = x - dir;
  const limit = right ? b.x1 + maxExt : b.x0 - maxExt;
  while (right ? x <= limit : x >= limit) {
    if (inkCol(x)) last = x;
    else if (Math.abs(x - last) > gapMax) break;
    x += dir;
  }
  const moved = right ? last - b.x1 : b.x0 - last;
  if (moved < perChar * 0.5) return l;
  const box = right ? { ...b, x1: Math.min(src.w, last + 3) } : { ...b, x0: Math.max(0, last - 3) };
  const words = l.words?.length ? l.words.map((w, i, all) => (right && i === all.length - 1) ? { ...w, box: { ...w.box, x1: box.x1 } } : (left && i === 0) ? { ...w, box: { ...w.box, x0: box.x0 } } : w) : l.words;
  return { ...l, box, words };
}

export function resolveLine(ocr: OcrLine[], l: OcrLine | undefined, oldText: string): OcrLine | undefined {
  if (!l || !oldText.trim()) return l;
  const target = words(oldText);
  const sub = (line: OcrLine): { line: OcrLine; score: number } => {
    const full = similar(line.text, oldText);
    let best = { line, score: full };
    const ws = line.words ?? [];
    if (ws.length > target.length) {
      for (let i = 0; i < ws.length; i++)
        for (let j = i + 1; j <= ws.length && j - i <= target.length + 1; j++) {
          const t = ws.slice(i, j).map((w) => w.text).join(' ');
          const sc = similar(t, oldText) - 0.02 * Math.abs(j - i - target.length);
          if (sc > best.score + 0.05) best = { line: { id: line.id, text: t, box: unionBox(ws.slice(i, j).map((w) => w.box)), words: ws.slice(i, j) }, score: sc };
        }
    }
    return best;
  };
  let best = sub(l);
  if (best.score < 0.55) {
    const cy = (l.box.y0 + l.box.y1) / 2, cx = (l.box.x0 + l.box.x1) / 2;
    for (const o of ocr) {
      if (o === l) continue;
      const oy = (o.box.y0 + o.box.y1) / 2, ox = (o.box.x0 + o.box.x1) / 2;
      if (Math.abs(oy - cy) > 120 || Math.abs(ox - cx) > 400) continue;
      const c = sub(o);
      if (c.score > best.score + 0.15) best = c;
    }
  }
  return best.line;
}

/**
 * `src` is what the page looks like now (used for reading the text); `base`
 * (optional) is the picture to edit, when earlier new text lives as vector
 * text on top of it rather than in its pixels.
 */

/** Number of ink pixels (clearly different from the surface) in a box of `out`. */
function inkCount(out: Raster, src: Raster, b: Box, ref: Box): number {
  const mode = surfaceModel(src, ref).mode;
  const x0 = Math.max(0, Math.floor(b.x0)), x1 = Math.min(out.w, Math.ceil(b.x1)), y0 = Math.max(0, Math.floor(b.y0)), y1 = Math.min(out.h, Math.ceil(b.y1));
  let n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (dist(px(out, x, y), mode) > 70) n++;
  return n;
}

/** Share of a new word's letter pixels that lie on ink still left in `out` (old letters that were not erased). */
async function overlapRatio(out: Raster, src: Raster, it: { text: string; key: string; size: number; tracking: number; hs?: number; bold?: number; x: number; baseline: number }, lib: FontLib, ref: Box): Promise<number> {
  const font = await lib.load(it.key);
  const ext = inkExtent(font, it.text, it.size, it.tracking, it.hs ?? 1);
  const x0 = Math.max(0, Math.floor(it.x + ext.minX - 2)), x1 = Math.min(out.w, Math.ceil(it.x + ext.maxX + 2));
  const y0 = Math.max(0, Math.floor(it.baseline - it.size * 0.85)), y1 = Math.min(out.h, Math.ceil(it.baseline + it.size * 0.3));
  const w = x1 - x0, h = y1 - y0;
  if (w < 2 || h < 2) return 0;
  const cv = lib.platform.createCanvas(w, h);
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
  drawText(ctx, font, it.text, it.x - x0, it.baseline - y0, it.size, it.tracking, '#fff', it.hs ?? 1, it.bold ?? 0);
  const d = ctx.getImageData(0, 0, w, h).data;
  const mode = surfaceModel(src, ref).mode;
  let glyph = 0, over = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (d[(y * w + x) * 4] < 160) continue;
    glyph++;
    if (dist(px(out, x0 + x, y0 + y), mode) > 70) over++;
  }
  return glyph ? over / glyph : 0;
}


// ---------------------------------------------------------------------------
// Result checks
// ---------------------------------------------------------------------------
export interface Quality { collision: number; weight: number; fit: number; sizeRatio: number; side: number; squeeze: number; read?: number }

/** Stroke thickness of a soft ink mask: 2 x area / perimeter (the perimeter is the total variation, so blur doesn't change it). */
function strokeThickness(cov: ArrayLike<number>, W: number, H: number): number {
  let a = 0, tv = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const v = cov[y * W + x]; a += v;
    if (x + 1 < W) tv += Math.abs(v - cov[y * W + x + 1]);
    if (y + 1 < H) tv += Math.abs(v - cov[(y + 1) * W + x]);
  }
  return tv > 0 ? (2 * a) / tv : 0;
}

/**
 * Looks at what an edit produced (before its new words are drawn into `pre`):
 *  collision - how much of the new letters lies on ink that is not theirs (a wall, a box, another word, a ghost of the old text)
 *  weight    - stroke thickness of the new letters against the old line (1 = same)
 *  fit       - how well the chosen typeface matched the old line (0..1)
 *  side      - where a collision is (-1 left .. 1 right), to pick a better alignment
 */
async function measureQuality(src: Raster, pre: Raster, reg: Box, fresh: TextItem[], infos: LineInfo[], m: MatchResult, lib: FontLib, moved: { info: LineInfo; dx: number }[] = [], midRef?: LineInfo): Promise<Quality> {
  const ref = infos[0];
  const T = Math.max(60, ref.thresh * 1.5);
  const A = ref.area;
  let glyph = 0, hit = 0, sx = 0, thickN = 0, thickW = 0, minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
  for (const it of fresh) {
    const gc = await glyphCoverage(it, lib);
    if (!gc) continue;
    const { x0, y0, W, H, cov } = gc;
    const t = strokeThickness(cov, W, H);
    let sum = 0; for (let k = 0; k < cov.length; k++) sum += cov[k];
    if (t > 0) { thickN += t * sum; thickW += sum; }
    const inkAt = (X: number, Y: number): boolean => {
      if (X < reg.x0 || X >= reg.x1 || Y < reg.y0 || Y >= reg.y1) return false;
      const p = pre.data, i = ((Y - reg.y0) * pre.w + (X - reg.x0)) * 4;
      const b = ref.bgAt(Math.min(Math.max(X, A.x0), A.x1 - 1), Math.min(Math.max(Y, A.y0), A.y1 - 1));
      return Math.abs(p[i] - b[0]) + Math.abs(p[i + 1] - b[1]) + Math.abs(p[i + 2] - b[2]) > T;
    };
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const c = cov[y * W + x];
      if (c <= 0.2) continue;
      const X = x0 + x, Y = y0 + y;
      if (c > 0.5) { glyph++; minX = Math.min(minX, X); maxX = Math.max(maxX, X); minY = Math.min(minY, Y); maxY = Math.max(maxY, Y); }
      // on foreign ink, or touching it (the next pixel over)
      if (inkAt(X, Y) || inkAt(X + 1, Y) || inkAt(X - 1, Y) || inkAt(X, Y + 1) || inkAt(X, Y - 1)) { hit++; sx += X; }
    }
  }
  // kept words that were pushed sideways must not land on foreign ink either (a wall, a box edge, another word)
  const inOld = (X: number, Y: number) => infos.some((f) => X >= f.inkBox.x0 - 4 && X <= f.inkBox.x1 + 4 && Y >= f.inkBox.y0 - 4 && Y <= f.inkBox.y1 + 4);
  const srcInk = (X: number, Y: number): boolean => {
    if (X < 0 || Y < 0 || X >= src.w || Y >= src.h) return false;
    const i = (Y * src.w + X) * 4, b = ref.bgAt(Math.min(Math.max(X, A.x0), A.x1 - 1), Math.min(Math.max(Y, A.y0), A.y1 - 1));
    return Math.abs(src.data[i] - b[0]) + Math.abs(src.data[i + 1] - b[1]) + Math.abs(src.data[i + 2] - b[2]) > T;
  };
  for (const { info, dx } of moved) {
    const B = info.area, Wm = B.x1 - B.x0, sh = Math.round(dx);
    for (let y = B.y0; y < B.y1; y++) for (let x = B.x0; x < B.x1; x++) {
      if (!info.erase.m[(y - B.y0) * Wm + (x - B.x0)]) continue;
      const X = x + sh;
      glyph++;
      if (!inOld(X, y) && (srcInk(X, y) || srcInk(X + 1, y) || srcInk(X - 1, y))) { hit++; sx += X; }
    }
  }
  const collision = glyph ? hit / glyph : 0;
  const cxNew = (minX + maxX) / 2;
  const side = hit ? Math.max(-1, Math.min(1, (sx / hit - cxNew) / Math.max(1, (maxX - minX) / 2))) : 0;
  // old line's stroke thickness
  const wRef = midRef ?? ref;
  const oldCov = wRef.cov, ow = wRef.area.x1 - wRef.area.x0, oh = wRef.area.y1 - wRef.area.y0;
  const tOld = strokeThickness(oldCov, ow, oh);
  // thickness relative to the type size (letter shapes - capitals, digits - change ink height, not weight)
  const sizeNew = fresh.length ? fresh.reduce((a, f) => a + f.size, 0) / fresh.length : 1, sizeOld = Math.max(1, median(m.lines.map((l) => l.size)));
  const weight = thickW > 0 && tOld > 0 ? (thickN / thickW / Math.max(1, sizeNew)) / (tOld / sizeOld) : 1;
  // size: height of the new ink against the old ink (only meaningful when both are one line)
  const hOld = Math.max(1, ref.inkBox.y1 - ref.inkBox.y0), hNew = maxY > minY ? maxY - minY : hOld;
  // letters squeezed or stretched (or spaced very tight/loose) to fit an old line that the typeface doesn't really match
  const hs = median(m.lines.map((l) => l.hs ?? 1)), trk = median(m.lines.map((l) => Math.abs(l.tracking) / Math.max(1, l.size)));
  const squeeze = Math.max(Math.abs(Math.log(hs)), trk * 3);
  return { collision, weight, fit: m.score, sizeRatio: hNew / hOld, side, squeeze };
}

/** One number for "how wrong is this": 0 is fine. */
function badness(q: Quality): number {
  let b = 0;
  b += Math.max(0, q.collision - 0.003) * 25; // even a thin line crossing the letters is a flaw
  b += Math.max(0, Math.abs(Math.log(Math.max(0.2, Math.min(5, q.sizeRatio)))) - 0.25) * 3; // far taller/shorter than the old text
  const w = Math.abs(Math.log(Math.max(0.2, Math.min(5, q.weight))));
  b += Math.max(0, w - 0.18) * 1.6;
  b += Math.max(0, 0.65 - q.fit) * 1.2;
  b += Math.max(0, q.squeeze - 0.07) * 3;
  if (q.read !== undefined) b += Math.max(0, 0.8 - q.read) * 4; // what OCR reads back differs from what was meant
  return b;
}

function describeQuality(q: Quality): string {
  const parts: string[] = [];
  if (q.collision > 0.05) parts.push('nya texten ligger över annat');
  if (q.weight < 0.8) parts.push('texten är tunnare än originalet');
  if (q.weight > 1.25) parts.push('texten är fetare än originalet');
  if (q.fit < 0.5) parts.push('typsnittet passar bara ungefär');
  if (q.squeeze > 0.1) parts.push('bokstäverna är hoptryckta eller utdragna');
  if (q.read !== undefined && q.read < 0.8) parts.push('resultatet läses inte som tänkt vid kontrolläsning');
  return parts.join(', ') || 'osäker';
}

/** The next way to try an edit, given what was wrong with the last result. */
interface Peer { family: string; weight: number; size: number; h: number; style?: string }
function nextAlternative(cur: { e: TextEdit; align: 'left' | 'center' | 'right'; q: Quality; family: string; weight: number; ranking: string[] }, orig: TextEdit, lib: FontLib, tried: Set<string>, peers: Peer[], h: number): TextEdit | null {
  const q = cur.q;
  const cands: { key: string; e: TextEdit }[] = [];
  // colliding: smaller, then pushed away from what it hits, then the plain whole-line way
  if (q.collision > 0.004) {
    cands.push({ key: 's.92', e: { ...cur.e, sizeScale: (cur.e.sizeScale ?? 1) * 0.92 } });
    // (only a centred text may lean to one side: a left- or right-aligned text keeps its edge, or it would grow into the margin)
    if (cur.align === 'center') cands.push({ key: `a${q.side > 0 ? 'R' : 'L'}`, e: { ...cur.e, align: q.side > 0 ? 'right' : 'left' } });
    cands.push({ key: 'nw', e: { ...cur.e, noWords: true } });
    cands.push({ key: 's.84', e: { ...cur.e, sizeScale: (cur.e.sizeScale ?? 1) * 0.84 } });
  }
  // the fit was disturbed (ink of something else inside the line): borrow typeface and size from a similar well-fitted line
  if ((q.fit < 0.5 || q.squeeze > 0.15) && !orig.font) {
    const near = peers.filter((p) => p.style === orig.style && p.h / h > 0.75 && p.h / h < 1.33).sort((a, b) => Math.abs(Math.log(a.h / h)) - Math.abs(Math.log(b.h / h)))[0];
    if (near) cands.push({ key: 'peer', e: { ...cur.e, font: near.family, weight: orig.weight ?? near.weight, forceSize: near.size * (h / near.h), noSqueeze: true } });
  }
  const fam = lib.entries.filter((x) => x.family === cur.family).sort((a, b) => a.weight - b.weight);
  // too thin / too heavy: the neighbouring weight of the same typeface
  if (!orig.weight && q.weight < 0.85) { const h = fam.find((x) => x.weight > cur.weight); if (h) cands.push({ key: `w${h.weight}`, e: { ...cur.e, weight: h.weight, weightFromRetry: true } }); }
  if (!orig.weight && q.weight > 1.2) { const l = [...fam].reverse().find((x) => x.weight < cur.weight); if (l) cands.push({ key: `w${l.weight}`, e: { ...cur.e, weight: l.weight, weightFromRetry: true } }); }
  // poor typeface fit: the next best other families
  if (!orig.font && (q.fit < 0.65 || Math.abs(Math.log(Math.max(0.2, Math.min(5, q.weight)))) > 0.3)) {
    const fams: string[] = [];
    for (const k of cur.ranking) { const f = lib.entry(k).family; if (f !== cur.family && !fams.includes(f)) fams.push(f); }
    for (const f of fams.slice(0, 3)) cands.push({ key: `f${f}`, e: { ...cur.e, font: f, weight: undefined } });
  }
  // letters squeezed to fit an old line the typeface doesn't match: set them at their natural width instead
  if (q.squeeze > 0.09) cands.push({ key: 'ns', e: { ...cur.e, noSqueeze: true } });
  for (const c of cands) if (!tried.has(c.key)) { tried.add(c.key); return c.e; }
  return null;
}

export interface ApplyOpts {
  vectorOnly?: boolean;
  /** Read the text in an area of a picture (OCR): used to check that a finished edit really reads as intended. */
  readBack?: (r: Raster, box: Box) => Promise<string>;
}

/** How much of `want` is found in `got` (0..1): approximate containment by edit distance, ignoring case and spaces. */
export function containment(want: string, got: string): number {
  const norm = (t: string) => t.toLowerCase().replace(/[\s\u00a0|]+/g, '');
  const P = norm(want), T = norm(got);
  if (!P.length) return 1;
  if (!T.length) return 0;
  // semi-global alignment: the pattern may start and end anywhere in the text
  let prev = new Array(T.length + 1).fill(0), cur = new Array(T.length + 1).fill(0);
  for (let i = 1; i <= P.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= T.length; j++) cur[j] = Math.min(prev[j - 1] + (P[i - 1] === T[j - 1] ? 0 : 1), prev[j] + 1, cur[j - 1] + 1);
    [prev, cur] = [cur, prev];
  }
  let best = Infinity; for (let j = 0; j <= T.length; j++) best = Math.min(best, prev[j]);
  return Math.max(0, 1 - best / P.length);
}

export async function applyEdits(src: Raster, ocr: OcrLine[], edits: Edit[], lib: FontLib, base?: Raster, opts: ApplyOpts = {}): Promise<Applied> {
  const out = cloneRaster(base ?? src);
  const items: TextItem[] = [];
  const reports: EditReport[] = [];
  let pageFamily: string | undefined;
  // 1. removals, 2. moves (all sources lifted first, then placed), 3. text
  for (let i = 0; i < edits.length; i++) {
    const e = edits[i];
    if (e.kind !== 'erase') continue;
    const sn = snapElement(src, e.box);
    if (sn.box) eraseArea(out, src, padBox(sn.box, 3));
    else eraseBox(out, src, e.box, analyzeLine(src, e.box));
    reports.push({ index: i, warnings: [], box: sn.box ?? e.box, mode: 'erase' });
  }
  // text that is only removed goes before the moves, so it can't wipe a moved element
  const textOrder = edits.map((e, i) => i).filter((i) => edits[i].kind === 'text').sort((a, b) => Number(!!(edits[a] as TextEdit).new.trim()) - Number(!!(edits[b] as TextEdit).new.trim()));
  const removals = textOrder.filter((i) => !(edits[i] as TextEdit).new.trim());
  const moves = edits.map((e, i) => ({ e, i })).filter((x): x is { e: MoveEdit; i: number } => x.e.kind === 'move');
  const placeMoves = () => {
    const lifted = moves.map(({ e }) => liftElement(src, e.box));
    moves.forEach((_, k) => eraseArea(out, src, lifted[k].box));
    moves.forEach(({ e, i }, k) => {
      const L = lifted[k], dx = Math.round(e.to.x - e.box.x0), dy = Math.round(e.to.y - e.box.y0); // 'to' is the new top-left of Claude's box
      const M = L.mask, W = M.box.x1 - M.box.x0;
      for (let y = M.box.y0; y < M.box.y1; y++)
        for (let x = M.box.x0; x < M.box.x1; x++) {
          if (!M.m[(y - M.box.y0) * W + (x - M.box.x0)]) continue;
          const tx = x + dx, ty = y + dy;
          if (tx < 0 || ty < 0 || tx >= out.w || ty >= out.h) continue;
          // carry the element's difference from its own surface onto the new spot's surface
          const si = (y * src.w + x) * 4, di = (ty * out.w + tx) * 4, g = L.bg(x, y);
          for (let c = 0; c < 3; c++) out.data[di + c] = out.data[di + c] + (src.data[si + c] - g[c]);
        }
      const tb = { x0: L.box.x0 + dx, y0: L.box.y0 + dy, x1: L.box.x1 + dx, y1: L.box.y1 + dy };
      reports.push({ index: i, warnings: [], box: unionBox([L.box, tb]), mode: 'move' });
    });
  };
  let meta: { infos: LineInfo[]; m: MatchResult; align: 'left' | 'center' | 'right' } | null = null;
  let movedRec: { info: LineInfo; dx: number }[] = []; // kept words that were shifted by the current attempt
  const runEdit = async (i: number, e: TextEdit): Promise<void> => {
    let ocrLines: (OcrLine | undefined)[] = e.boxes?.length ? e.boxes.map(() => undefined) : e.lines.map((id) => ocr.find((o) => o.id === id));
    if (!e.boxes?.length) ocrLines = ocrLines.map((l, k) => resolveLine(ocr, l, e.old[k] ?? ''));
    // OCR can read only part of big, thin lettering (e.g. "KVALSTERS" of "KVALSTERSKYDD"):
    // reach the box out over the rest of the word's ink, so nothing of the old text stays
    if (!e.boxes?.length) ocrLines = ocrLines.map((l, k) => (l ? extendToInk(src, l, e.old[k] ?? '') : l));
    const boxes = e.boxes?.length ? e.boxes : ocrLines.map((l) => { if (!l) throw new Error('Okänd rad.'); return l.box; });
    const infos = boxes.map((b) => analyzeLine(src, b));
    if (!infos.length) return; // nothing on the page to work on
    let touched = unionBox(infos.map((x) => x.area));
    const grow = (x0: number, x1: number) => { touched = { ...touched, x0: Math.min(touched.x0, x0), x1: Math.max(touched.x1, x1) }; }; // new text may reach beyond the old areas
    const warnings: string[] = [];
    // ---- remove only ----
    if (!e.new.trim()) {
      for (const info of infos) eraseLine(out, src, info);
      reports.push({ index: i, warnings, box: touched, lines: 0, mode: 'remove' });
      return;
    }
    // ---- font (fitted on all old lines of the block) ----
    let pairs = infos.map((info, k) => ({ info, text: (e.old[k] ?? '').trim() || ocrLines[k]?.text || '' })).filter((p) => p.text.trim());
    // no old text known (e.g. a box drawn round lettering OCR couldn't read): fit the font on the new text instead
    if (!pairs.length) pairs = infos.slice(0, 1).map((info) => ({ info, text: e.new.split('\n')[0].trim() || 'Aa' }));
    const fam = e.font ? lib.entries.find((x) => x.family.toLowerCase() === e.font!.toLowerCase())?.family : undefined;
    let m = await matchFont(lib, pairs, fam ? { families: [fam] } : { style: e.style ?? 'any' });
    // A short label gives weak evidence for a typeface ("Hall", "Bedroom 2"): lean towards the typeface the page's longest lines use
    if (!fam && !e.font) {
      const letters = pairs.map((q) => q.text).join('').replace(/[^\p{L}]/gu, '').length;
      // the PDF itself says which typeface the page uses (Helvetica = Arimo, Times = Termes): the best evidence there is
      const names = pageFontHints.names;
      const want = (e.style === 'serif' ? /times/i : /helvetica|arial/i);
      const hint = names.some((n) => want.test(n)) ? (e.style === 'serif' ? 'Termes PA' : 'Arimo') : '';
      if (hint && lib.entries.some((x) => x.family === hint) && hint !== m.family) {
        try { const alt = await matchFont(lib, pairs, { families: [hint] }); if (alt.score > m.score - (letters <= 14 ? 0.35 : 0.12)) m = alt; } catch { /* can't write it */ }
      } else if (!hint && letters <= 14) {
        pageFamily ??= await (async () => {
          let best: { info: LineInfo; text: string } | null = null;
          // the longest clean OCR line of the page (best evidence), else the longest edited line
          for (const l of ocr) { const t = l.text.trim(); const lt = t.replace(/[^\p{L}]/gu, '').length; if (t.length >= 18 && lt / t.length > 0.75 && (l.conf ?? 100) >= 70 && t.length > (best?.text.length ?? 0)) best = { info: analyzeLine(src, l.box), text: t }; }
          if (!best) for (const x of edits) if (x.kind === 'text') x.lines.forEach((id, k) => { const l = ocr.find((o) => o.id === id); const t = (x.old[k] ?? l?.text ?? '').trim(); if (l && t.length > (best?.text.length ?? 15)) best = { info: analyzeLine(src, l.box), text: t }; });
          return best ? (await matchFont(lib, [best], { style: e.style ?? 'any' })).family : '';
        })();
        if (pageFamily && pageFamily !== m.family) {
          try { const alt = await matchFont(lib, pairs, { families: [pageFamily] }); if (alt.score > m.score - 0.15) m = alt; } catch { /* the page family can't write it */ }
        }
      }
    }
    if (e.weight) { const want = lib.find(m.family, e.weight); if (want) m = await matchFont(lib, pairs, { families: [m.family], prefer: want.key, preferTol: 10 }); }
    const font = await lib.load(m.key);
    meta = { infos, m, align: 'left' } as any;
    const fitOf = (k: number) => m.lines[pairs.findIndex((p) => p.info === infos[k])];
    const ss = e.sizeScale ?? 1;
    if (ss !== 1) for (const l of m.lines) { l.size *= ss; l.tracking *= ss; l.bold *= ss; }
    if (e.forceSize) for (const l of m.lines) { l.size = e.forceSize; l.hs = 1; l.tracking = 0; }
    const size0 = median(m.lines.map((l) => l.size));
    const track0 = e.noSqueeze ? 0 : median(m.lines.map((l) => l.tracking));
    const hs0 = e.noSqueeze ? 1 : median(m.lines.map((l) => l.hs ?? 1));
    const bold0 = median(m.lines.map((l) => l.bold ?? 0));
    const color: RGB = [median(infos.map((x) => x.color[0])), median(infos.map((x) => x.color[1])), median(infos.map((x) => x.color[2]))];
    const align = e.align ?? detectAlign(infos, ocr, ocrLines[0]);
    if (meta) (meta as any).align = align;
    const baselines = m.lines.map((l) => l.baseline).sort((a, b) => a - b);
    const pitch = baselines.length > 1 ? median(baselines.slice(1).map((b, k) => b - baselines[k])) : size0 * 1.25;
    const blockX0 = Math.min(...infos.map((x) => x.inkBox.x0));
    const blockX1 = Math.max(...infos.map((x) => x.inkBox.x1));
    const explicit = e.new.split('\n');
    const oneToOne = explicit.length === infos.length;
    let modes: string[] = [];

    if (oneToOne) {
      // ---- line by line ----
      for (let li = 0; li < infos.length; li++) {
        const oldL = e.old[li] ?? '', newL = explicit[li];
        if (norm(oldL) === norm(newL)) { modes.push('same'); continue; }
        const info = infos[li];
        const fit = fitOf(li) ?? { size: size0, tracking: track0, hs: hs0, bold: bold0, baseline: info.inkBox.y1 - size0 * 0.2 };
        // one block = one size: use the block's typical size unless this line clearly differs
        const consistent = Math.abs(fit.size / size0 - 1) < 0.25;
        const size = consistent ? size0 : fit.size, tr = consistent ? track0 : fit.tracking, base = fit.baseline;
        const hs = consistent ? hs0 : fit.hs, bold = consistent ? bold0 : fit.bold;
        const ow = words(oldL), nw = words(newL);
        // (numbers must match as written: "11,7" and "117" are different values; for words OCR/AI differences in punctuation are ignored)
        const edge = (w: string) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
        const same = (a: string, b: string) => a === b || edge(a) === edge(b);
        let p = 0; while (p < ow.length && p < nw.length && same(ow[p], nw[p])) p++;
        let s = 0; while (s < ow.length - p && s < nw.length - p && same(ow[ow.length - 1 - s], nw[nw.length - 1 - s])) s++;
        // a requested weight belongs to the whole named thing: words that follow the changed ones are redrawn in that weight too (words before them stay as they were)
        if (e.weight && !e.weightFromRetry && (p > 0 || s < ow.length)) s = 0;
        let wb = (p > 0 || s > 0) ? (wordBoxes(ocrLines[li], oldL) ?? inkWords(info, oldL)) : null;
        // low-resolution working picture (vector page): only a changed word that keeps
        // its neighbours in place can be swapped alone (as vector text); otherwise the line
        if (wb && opts.vectorOnly && p >= ow.length - s) wb = null;
        if (wb && !e.noWords && !(align === 'center' && Math.abs(nw.join(' ').length - ow.join(' ').length) > 2) && (p + s < ow.length || nw.length > ow.length) && (p + s) >= 1) { // (a centred line that changes length is centred anew as a whole) // a changed word, or words inserted between kept ones
          // ---- word mode: replace only words p..ow.length-s-1 ----
          const midOld = wb.slice(p, ow.length - s);
          const midNew = nw.slice(p, nw.length - s).join(' ');
          const pre = wb.slice(0, p), suf = wb.slice(ow.length - s);
          // word boxes can be taller than the line; keep them to the line's own height
          // so the lines above and below are never touched
          const lb = boxes[li];
          const inLine = (bs: Box[]) => { const u = unionBox(bs); return { x0: u.x0, x1: u.x1, y0: Math.max(u.y0, lb.y0 - 1), y1: Math.min(u.y1, lb.y1 + 1) }; };
          // OCR word boxes can overlap: the kept words must not reach into the replaced ones
          const midB = midOld.length ? inLine(midOld) : null;
          if (meta) (meta as any).midRef = midB ? analyzeLine(src, midB) : undefined; // the old words being replaced: the weight check compares against these, not the whole (maybe mixed) line
          const preB = pre.length ? inLine(pre) : null, sufB = suf.length ? inLine(suf) : null;
          if (midB && preB && preB.x1 > midB.x0 - 1) preB.x1 = Math.max(preB.x0 + 1, midB.x0 - 1);
          if (midB && sufB && sufB.x0 < midB.x1 + 1) sufB.x0 = Math.min(sufB.x1 - 1, midB.x1 + 1);
          // and their masks stay inside this line's rows (no descenders from the line above)
          const rows = (x: LineInfo): LineInfo => {
            const A = x.area, W = A.x1 - A.x0, m = new Uint8Array(x.erase.m);
            for (let y = A.y0; y < A.y1; y++) if (y < lb.y0 - 2 || y > lb.y1 + 2) m.fill(0, (y - A.y0) * W, (y - A.y0 + 1) * W);
            return { ...x, erase: { ...x.erase, m } };
          };
          const midInfo = midB ? rows(analyzeLine(src, midB)) : null;
          const preInfo = preB ? rows(analyzeLine(src, preB)) : null;
          const sufInfo = sufB ? rows(analyzeLine(src, sufB)) : null;
          const drawColor = midInfo?.color ?? color;
          // family: this line's own letters are the best evidence; keep the
          // block's family unless another clearly fits this line better
          let fm = m, wSize = size, wTr = tr, wBase = base, wHs = hs, wBold = bold;
          if (oldL.replace(/[^\p{L}\p{N}]/gu, '').length >= 10 && info.noise < 5) { // textured surfaces (kraft) confuse the fit: keep the block's family
            // the plan's style holds here too; a script face is never picked unless the plan says script
            const own = await matchFont(lib, [{ info, text: oldL }], { style: e.style ?? 'any' });
            const mine = await matchFont(lib, [{ info, text: oldL }], { families: [m.family] });
            const isScript = lib.entries.find((x) => x.family === own.family)?.style === 'script' && e.style !== 'script';
            if (own.family !== m.family && !isScript && own.score > mine.score + 0.05) {
              fm = own;
              wSize = own.lines[0].size * (e.sizeScale ?? 1); wTr = own.lines[0].tracking * (e.sizeScale ?? 1); wBase = own.lines[0].baseline; wHs = own.lines[0].hs; wBold = own.lines[0].bold * (e.sizeScale ?? 1);
            }
          }
          // a short changed word ("3" in "3 st /piece") can be set in another face than
          // the rest of the line: fit the font on it and the word right next to it
          const midTxt = ow.slice(p, ow.length - s).join(' ');
          let nb: number | undefined;
          if (midB && midTxt.replace(/[^\p{L}\p{N}]/gu, '').length <= 3 && info.noise < 5) {
            nb = s > 0 ? ow.length - s : p - 1;
            const lb2 = unionBox([midB, inLine([wb[nb]])]);
            const ltxt = s > 0 ? `${midTxt} ${ow[nb]}` : `${ow[nb]} ${midTxt}`;
            const li2 = analyzeLine(src, lb2);
            // the plan's style (sans/serif) still holds for a tiny word: its ink is too little to overrule it
            const loc = await matchFont(lib, [{ info: li2, text: ltxt }], { style: e.style ?? 'any' });
            const cur = await matchFont(lib, [{ info: li2, text: ltxt }], { families: [fm.family] });
            if (loc.family !== fm.family && loc.score > cur.score + 0.06) fm = loc;
            const use = loc.family === fm.family ? loc : cur;
            wSize = use.lines[0].size * (e.sizeScale ?? 1); wTr = use.lines[0].tracking * (e.sizeScale ?? 1); wBase = use.lines[0].baseline; wHs = use.lines[0].hs; wBold = use.lines[0].bold * (e.sizeScale ?? 1);
          }
          // a very short word (little ink to measure) can be misjudged in size: it stays within 15 % of the line's own size
          if (midTxt.replace(/[^\p{L}\p{N}]/gu, '').length <= 3 && (wSize < size * 0.85 || wSize > size * 1.15)) { wSize = size; wTr = tr; wHs = hs; wBold = bold; wBase = base; }
          // weight: the one whose redrawing of a kept word of this line is as dark as the real one
          const keptIdx = [...Array(p).keys(), ...Array.from({ length: s }, (_, k) => ow.length - s + k)].filter((k) => ow[k].replace(/[^\p{L}\p{N}]/gu, '').length >= 3);
          const kk = nb !== undefined && ow[nb].replace(/[^\p{L}\p{N}]/gu, '').length >= 2 ? nb : keptIdx.sort((a, b) => ow[b].length - ow[a].length)[0];
          let key = fm.key;
          // the weight of the words being replaced is the best evidence of the weight the new ones should have
          // (a price in bold stays bold even if the words around it are regular); kept words are the fallback
          if (!e.weight) {
            if (midB && midTxt.replace(/[^\p{L}\p{N}]/gu, '').length >= 2) ({ key, bold: wBold } = await calibrateWeight(src, lib, fm.family, analyzeLine(src, midB), midTxt, wSize, wTr, wBase, drawColor, fm.key, wHs, wBold));
            else if (kk !== undefined) ({ key, bold: wBold } = await calibrateWeight(src, lib, fm.family, analyzeLine(src, wb[kk]), ow[kk], wSize, wTr, wBase, drawColor, fm.key, wHs, wBold));
          }
          const kfont = await lib.load(key);
          const wSl = info.slant ?? 0; // italic lines stay italic
          // word gap: as measured between the line's own words, when we can
          let space = inkExtent(kfont, ' ', wSize, wTr, wHs).adv + wTr;
          const gaps = wb.slice(1).map((bx, k) => bx.x0 - wb[k].x1).filter((g) => g > 0);
          if (gaps.length >= 2) space = Math.min(space * 2, Math.max(space * 0.6, median(gaps)));
          // old middle span in ink terms; if empty (pure insertion), use the gap
          const oldX0 = midInfo ? midInfo.inkBox.x0 : (preInfo ? preInfo.inkBox.x1 + space : sufInfo!.inkBox.x0);
          const oldX1 = midInfo ? midInfo.inkBox.x1 : oldX0 - space;
          let ext = midNew ? inkExtent(kfont, midNew, wSize, wTr, wHs, wSl) : { minX: 0, maxX: -space, adv: 0 };
          let newW = midNew ? ext.maxX - ext.minX : -space;
          // same width in the fitted font (e.g. digit for digit): keep the neighbours where they are
          const oldModel = midInfo && midNew ? inkExtent(kfont, midTxt, wSize, wTr, wHs) : null;
          const sameWidth = !!oldModel && Math.abs(newW - (oldModel.maxX - oldModel.minX)) < Math.max(0.5, wSize * 0.03);
          let delta = sameWidth ? 0 : newW - (oldX1 - oldX0);
          let shiftPre = align === 'center' ? -delta / 2 : align === 'right' ? -delta : 0;
          // with no shift, a right/centre aligned word sits where the old one ended / was centred
          let placeX = sameWidth && align !== 'left' ? (align === 'right' ? oldX1 - newW : (oldX0 + oldX1) / 2 - newW / 2) : oldX0 + shiftPre;
          let shiftSuf = align === 'center' ? delta / 2 : align === 'right' ? 0 : delta;
          if (delta > 0.5 && midNew && (midInfo || sufInfo || preInfo)) {
            const anchor = (midInfo ?? sufInfo ?? preInfo)!; // (an inserted word has no old ink of its own: use its neighbour)
            // A longer word needs room. Take it from wide word gaps first (justified text),
            // then from free space beside the line, never pushing into other text; only the
            // side(s) the alignment allows move. Not enough room: squeeze the word a little.
            const free = (x: number, dir: 1 | -1) => freeRun(src, anchor.inkBox, x, dir, Math.round(wSize * 8), info.thresh);
            const keep = wSize * 0.3;
            // a word gap may close down to about one normal space, never tighter ("10,2cm²" looks glued)
            const slackR = sufInfo ? Math.max(0, sufInfo.inkBox.x0 - oldX1 - space * 0.95) : 0;
            const slackL = preInfo ? Math.max(0, oldX0 - preInfo.inkBox.x1 - space * 0.95) : 0;
            const roomR = align === 'right' ? 0 : Math.max(0, free((sufInfo ?? anchor).inkBox.x1, 1) - keep);
            const roomL = align === 'left' ? 0 : Math.max(0, free((preInfo ?? anchor).inkBox.x0, -1) - keep);
            const capR = slackR + roomR, capL = slackL + roomL;
            let gR = Math.min(capR, align === 'left' ? delta : align === 'right' ? 0 : delta / 2);
            const gL = Math.min(capL, delta - gR);
            gR = Math.min(capR, delta - gL);
            if (gR + gL < delta - 0.5) {
              const k = Math.max(0.8, (oldX1 - oldX0 + gR + gL) / newW);
              wHs *= k; ext = inkExtent(kfont, midNew, wSize, wTr * k, wHs, wSl); wTr *= k; newW = ext.maxX - ext.minX;
              if (k < 0.97) warnings.push(`"${midNew}" trycktes ihop till ${Math.round(k * 100)} % för att få plats.`);
              delta = newW - (oldX1 - oldX0);
            }
            const used = Math.max(0, delta);
            const r = Math.min(gR, used), l = Math.max(0, used - r);
            // share each side's growth between the word gap and the free space beyond,
            // so the gaps on the line stay even
            shiftSuf = capR > 0 ? r * (roomR / capR) : 0;
            shiftPre = capL > 0 ? -l * (roomL / capL) : 0;
            placeX = oldX0 - l;
          }
          if (opts.vectorOnly && midInfo) {
            // sharp vector text: the changed word, plus the words that would have to move
            // (moving them as pixels would blur them at this resolution)
            const movePre = Math.abs(shiftPre) >= 0.5 || (delta < -0.5 && align !== 'left');
            const moveSuf = Math.abs(shiftSuf) >= 0.5 || (delta < -0.5 && align !== 'right');
            const moved = movePre || moveSuf;
            const from = movePre ? 0 : p, to = moveSuf ? nw.length : nw.length - s;
            const anchor: 'left' | 'right' | 'center' = movePre && moveSuf ? 'center' : movePre ? 'right' : 'left';
            const vt = nw.slice(from, to).join(' ');
            eraseLine(out, src, midInfo);
            if (from < p && preInfo) eraseLine(out, src, preInfo);
            if (to > nw.length - s && sufInfo) eraseLine(out, src, sufInfo);
            const vx = inkExtent(kfont, vt, wSize, wTr, wHs);
            const L = from < p && preInfo ? preInfo.inkBox.x0 : placeX, R = to > nw.length - s && sufInfo ? sufInfo.inkBox.x1 : placeX + newW;
            const x = !moved ? placeX - vx.minX : anchor === 'right' ? R - vx.maxX : anchor === 'center' ? (L + R) / 2 - (vx.minX + vx.maxX) / 2 : L - vx.minX;
            items.push({ text: vt, key, size: wSize, tracking: wTr, hs: wHs, bold: wBold, slant: wSl, x, baseline: wBase, color: drawColor });
            modes.push(`words-vector(${p},${s})`);
            continue;
          }
          // the new word keeps the line's own word gap (a wider word must not eat the space before it)
          if (preInfo && midInfo && midNew && !sufInfo) {
            const gap0 = midInfo.inkBox.x0 - preInfo.inkBox.x1;
            const want = Math.min(Math.max(gap0, space * 0.7), space * 1.4);
            const have = placeX - (preInfo.inkBox.x1 + (Math.abs(shiftPre) >= 0.5 ? shiftPre : 0));
            if (have < want * 0.85) placeX += want - have;
          }
          const ub = unionBox([info.area, ...(midInfo ? [midInfo.area] : []), ...(preInfo ? [preInfo.area] : []), ...(sufInfo ? [sufInfo.area] : [])]);
          // the moved words and the new word land outside the old areas: the backup must cover them too
          const backupBox = clampBox(padBox({ ...ub, x0: Math.min(ub.x0, ub.x0 + shiftPre, placeX + ext.minX), x1: Math.max(ub.x1, ub.x1 + shiftSuf, placeX + ext.maxX) }, 6), out);
          const backup = cropRaster(out, backupBox);
          // Changed words with unchanged ones between them ("80 °C vatten i 2" -> "95 °C vatten i 4"): when everything lands
          // where the old words stood, redo only the changed words and leave the ones between as the original pixels
          if (!opts.vectorOnly && midInfo && midNew && info.noise < 5) {
            const oldM = ow.slice(p, ow.length - s), newM = nw.slice(p, nw.length - s);
            const changed = oldM.length === newM.length ? oldM.map((w, j) => !same(w, newM[j])) : [];
            if (oldM.length === newM.length && oldM.length >= 3 && Math.abs(delta) < Math.max(1.5, wSize * 0.06) && changed[0] && changed[changed.length - 1] && changed.includes(false)) {
              const origin = oldX0 - ext.minX;
              const startOf = (j: number) => origin + (j ? inkExtent(kfont, newM.slice(0, j).join(' ') + ' ', wSize, wTr, wHs, wSl).adv : 0);
              let ok = true;
              const runs: [number, number][] = [];
              for (let j = 0; j < oldM.length && ok; j++) {
                if (!changed[j]) {
                  const bi = analyzeLine(src, inLine([midOld[j]]));
                  const ie = inkExtent(kfont, newM[j], wSize, wTr, wHs, wSl);
                  if (Math.abs(startOf(j) + ie.minX - bi.inkBox.x0) > Math.max(2, wSize * 0.04)) ok = false;
                } else if (j === 0 || !changed[j - 1]) runs.push([j, j]); else runs[runs.length - 1][1] = j;
              }
              if (ok) {
                const parts = runs.map(([a, b]) => ({ text: newM.slice(a, b + 1).join(' '), x: startOf(a), info: rows(analyzeLine(src, inLine(midOld.slice(a, b + 1)))) }));
                const bb = clampBox(padBox(unionBox([info.area, midInfo.area]), 6), out);
                const bak = cropRaster(out, bb);
                for (const q of parts) eraseLine(out, src, q.info);
                const its = parts.map((q) => ({ text: q.text, key, size: wSize, tracking: wTr, hs: wHs, bold: wBold, slant: wSl, x: q.x, baseline: wBase, color: drawColor, raster: true, ref: q.info }));
                let badP = false;
                for (let q = 0; q < its.length && !badP; q++) if ((await overlapRatio(out, src, its[q] as any, lib, parts[q].info.area)) > 0.1) badP = true;
                if (!badP) { items.push(...(its as any[])); modes.push(`words-parts(${parts.length})`); continue; }
                pasteRaster(out, bak, bb.x0, bb.y0);
              }
            }
          }
          if (midInfo) eraseLine(out, src, midInfo);
          if (preInfo && Math.abs(shiftPre) >= 0.5) { eraseLine(out, src, preInfo); pasteInk(out, src, preInfo, shiftPre); movedRec.push({ info: preInfo, dx: shiftPre }); }
          if (sufInfo && Math.abs(shiftSuf) >= 0.5) { eraseLine(out, src, sufInfo); pasteInk(out, src, sufInfo, shiftSuf); movedRec.push({ info: sufInfo, dx: shiftSuf }); }
          const wordItem = midNew ? { text: midNew, key, size: wSize, tracking: wTr, hs: wHs, bold: wBold, slant: wSl, x: placeX - ext.minX, baseline: wBase, color: drawColor, raster: true, ref: midInfo ?? preInfo ?? sufInfo ?? info } : null;
          // Safety net: if old letters are still under the new word (a word box that missed part of them),
          // undo this and set the whole line instead, which clears everything.
          // ...also old ink left between the kept words on either side of the new word (a word box that cut the letters)
          const winL = preInfo ? preInfo.inkBox.x1 + (Math.abs(shiftPre) >= 0.5 ? shiftPre : 0) + 1 : (midInfo ? midInfo.inkBox.x0 - space : info.inkBox.x0);
          const winR = sufInfo ? sufInfo.inkBox.x0 + (Math.abs(shiftSuf) >= 0.5 ? shiftSuf : 0) - 1 : Math.max(oldX1, placeX + newW) + space * 0.5;
          const left = !!midInfo && !!wordItem && info.noise < 5 && winR > winL + 2 && inkCount(out, src, { x0: winL, x1: winR, y0: info.inkBox.y0 - 1, y1: info.inkBox.y1 + 1 }, midInfo.area) >= 6;
          const bad = !!wordItem && info.noise < 5 && (left || (await overlapRatio(out, src, wordItem, lib, (midInfo ?? info).area)) > 0.1);
          if (bad) {
            pasteRaster(out, backup, backupBox.x0, backupBox.y0);
            warnings.push('Ordet lades om som hel rad för att inga rester av den gamla texten skulle stå kvar.');
          } else {
            if (wordItem) items.push(wordItem as any);
            grow(Math.min(placeX + ext.minX, preInfo ? preInfo.area.x0 + shiftPre : 1e9) - 6, Math.max(placeX + ext.maxX, sufInfo ? sufInfo.area.x1 + shiftSuf : -1e9) + 6);
            modes.push(`words(${p},${s})`);
            continue;
          }
        }
        // ---- whole line ----
        eraseLine(out, src, info);
        let maxW = e.maxWidth ?? Math.max(info.inkBox.x1 - info.inkBox.x0, (blockX1 - blockX0) * (infos.length > 1 ? 1 : 1.0));
        if (!e.maxWidth && infos.length === 1) {
          // a lone line (a heading, a name) may grow into the free space beside it
          const free = (x: number, dir: 1 | -1) => freeRun(src, info.inkBox, x, dir, Math.round(size * (align === 'left' ? 4 : 14)), info.thresh); // (a centred or right-aligned heading may grow further than a left-aligned label)
          const keep = size * 0.4;
          const fr = Math.max(0, free(info.inkBox.x1, 1) - keep), fl = Math.max(0, free(info.inkBox.x0, -1) - keep);
          const inkW0 = info.inkBox.x1 - info.inkBox.x0;
          maxW = Math.max(maxW, inkW0 + (align === 'left' ? fr : align === 'right' ? fl : 2 * Math.min(fl, fr)));
        }
        let k = 1;
        let ext = inkExtent(font, newL, size, tr, hs, info.slant);
        while (ext.maxX - ext.minX > maxW && k > 0.6) { k -= 0.02; ext = inkExtent(font, newL, size * k, tr * k, hs, info.slant); }
        if (k < 0.999) warnings.push(`"${newL}" krymptes till ${Math.round(k * 100)} % för att få plats.`);
        const x0 = info.inkBox.x0, x1 = info.inkBox.x1;
        const anchorL = infos.length > 1 && align === 'left' ? blockX0 : x0;
        const anchorR = infos.length > 1 && align === 'right' ? blockX1 : x1;
        const cx = infos.length > 1 && align === 'center' ? (blockX0 + blockX1) / 2 : (x0 + x1) / 2;
        const pen = align === 'center' ? cx - (ext.minX + ext.maxX) / 2 : align === 'right' ? anchorR - ext.maxX : anchorL - ext.minX;
        // weight: as dark as the old line was (unless Claude asked for a weight)
        let lkey = m.key, lbold = bold;
        if (!e.weight && oldL.replace(/[^\p{L}\p{N}]/gu, '').length >= 3) {
          ({ key: lkey, bold: lbold } = await calibrateWeight(src, lib, m.family, info, oldL, size, tr, base, info.color, m.key, hs, bold));
          if (lkey !== m.key) {
            // a different weight is a little wider or narrower: re-place it
            const lf = await lib.load(lkey);
            ext = inkExtent(lf, newL, size * k, tr * k, hs, info.slant);
            while (ext.maxX - ext.minX > maxW && k > 0.6) { k -= 0.02; ext = inkExtent(lf, newL, size * k, tr * k, hs, info.slant); }
          }
        }
        const pen2 = align === 'center' ? cx - (ext.minX + ext.maxX) / 2 : align === 'right' ? anchorR - ext.maxX : anchorL - ext.minX;
        grow(pen2 + ext.minX - 6, pen2 + ext.maxX + 6);
        items.push({ text: newL, key: lkey, size: size * k, tracking: tr * k, hs, bold: lbold * k, slant: info.slant, x: pen2, baseline: base, color: info.color });
        modes.push('line');
      }
      reports.push({ index: i, font: `${m.family} ${m.weight}`, sizePx: +size0.toFixed(1), shrunk: 1, lines: infos.length, mode: modes.join(','), warnings, match: m, box: touched });
      return;
    }

    // ---- whole block, re-wrapped ----
    for (const info of infos) eraseLine(out, src, info);
    const maxW = e.maxWidth ?? Math.max(blockX1 - blockX0, 1);
    const oldTop = Math.min(...infos.map((x) => x.inkBox.y0));
    const oldBottom = Math.max(...infos.map((x) => x.inkBox.y1));
    let maxH = e.maxHeight ?? oldBottom - oldTop + (infos.length > 1 ? pitch : size0 * 0.6);
    // Never let a taller block grow into what lies below it (e.g. a CE mark under an address):
    // look down from the old block for the first row with ink and stop above it.
    {
      const bgRef = infos[infos.length - 1];
      const th = Math.max(60, bgRef.thresh * 1.5);
      const x0 = Math.max(0, Math.floor(blockX0)), x1 = Math.min(src.w, Math.ceil(blockX1));
      const yStart = Math.ceil(oldBottom + size0 * 0.15), yEnd = Math.min(src.h, Math.ceil(oldBottom + Math.max(maxH, pitch * 2)));
      let clearTo = yEnd;
      for (let y = yStart; y < yEnd; y++) {
        let hits = 0;
        for (let x = x0; x < x1; x++) {
          const i = (y * src.w + x) * 4, b = bgRef.bgAt(x, Math.min(y, bgRef.area.y1 - 1));
          if (Math.abs(src.data[i] - b[0]) + Math.abs(src.data[i + 1] - b[1]) + Math.abs(src.data[i + 2] - b[2]) > th) hits++;
        }
        if (hits > Math.max(2, (x1 - x0) * 0.01)) { clearTo = y; break; }
      }
      const room = clearTo - size0 * 0.3 - oldTop; // keep a little gap above what's below
      if (room > 0 && room < maxH) maxH = Math.max(oldBottom - oldTop, room);
    }
    let k = 1, lines: string[] = [];
    // Room to the right of a left-aligned block that is free of ink (rows of the block) may be used,
    // so a line that was squeezed earlier can get its own width back instead of breaking.
    let roomW = maxW;
    // (a paragraph of several lines keeps its width: its right edge is the margin; only short lines/blocks may grow sideways)
    if (e.maxWidth === undefined && align === 'left' && (infos.length === 1 || e.new.includes('\n'))) {
      const bgRef = infos[0], th = Math.max(60, bgRef.thresh * 1.5);
      const y0 = Math.max(0, Math.floor(oldTop)), y1 = Math.min(src.h, Math.ceil(oldBottom));
      const xEnd = Math.min(src.w, Math.ceil(blockX1 + (blockX1 - blockX0) * 0.3));
      let clear = xEnd;
      for (let x = Math.ceil(blockX1 + size0 * 0.2); x < xEnd && clear === xEnd; x++) {
        let hits = 0;
        for (let y = y0; y < y1; y++) { const i = (y * src.w + x) * 4, b = bgRef.bgAt(Math.min(x, bgRef.area.x1 - 1), y); if (Math.abs(src.data[i] - b[0]) + Math.abs(src.data[i + 1] - b[1]) + Math.abs(src.data[i + 2] - b[2]) > th) hits++; }
        if (hits > 1) clear = x;
      }
      roomW = Math.max(maxW, clear - size0 * 0.3 - blockX0);
    }
    // a centred or right-aligned short text may grow too: to the left (right-aligned) or to both sides (centred), up to what is free
    if (e.maxWidth === undefined && align !== 'left' && (infos.length === 1 || e.new.includes('\n'))) {
      const bgRef = infos[0], th = Math.max(60, bgRef.thresh * 1.5);
      const y0 = Math.max(0, Math.floor(oldTop)), y1 = Math.min(src.h, Math.ceil(oldBottom));
      const inkCol = (x: number) => { let hits = 0; for (let y = y0; y < y1; y++) { const i = (y * src.w + x) * 4, b = bgRef.bgAt(Math.min(Math.max(x, bgRef.area.x0), bgRef.area.x1 - 1), y); if (Math.abs(src.data[i] - b[0]) + Math.abs(src.data[i + 1] - b[1]) + Math.abs(src.data[i + 2] - b[2]) > th) hits++; } return hits > 1; };
      const edge = Math.round(src.w * 0.04);
      let clearR = src.w - edge, clearL = edge;
      for (let x = Math.ceil(blockX1 + size0 * 0.2); x < src.w - edge; x++) if (inkCol(x)) { clearR = x; break; }
      for (let x = Math.floor(blockX0 - size0 * 0.2); x > edge; x--) if (inkCol(x)) { clearL = x; break; }
      const cxb = (blockX0 + blockX1) / 2;
      const grown = align === 'right' ? blockX1 - (clearL + size0 * 0.3) : 2 * Math.min(cxb - (clearL + size0 * 0.3), clearR - size0 * 0.3 - cxb);
      roomW = Math.max(roomW, grown);
    }
    const widestOf = (ls: string[], kk: number) => Math.max(...ls.map((t) => { const x = inkExtent(font, t, size0 * kk, track0 * kk, hs0); return x.maxX - x.minX; }));
    // 1st choice: keep Elin's lines as written (no extra line breaks), shrinking a little if needed
    const asWritten = e.new.split('\n');
    let found = false;
    for (k = 1; k >= 0.8; k -= 0.025) {
      const height = (asWritten.length - 1) * pitch * k + size0 * k * 0.75;
      if (widestOf(asWritten, k) <= roomW * 1.001 && height <= maxH + 1) { lines = asWritten; found = true; break; }
    }
    if (!found) for (k = 1; k >= 0.55; k -= 0.025) {
      lines = wrap(font, e.new, size0 * k, track0 * k, maxW, hs0);
      const height = (lines.length - 1) * pitch * k + size0 * k * 0.75;
      if (widestOf(lines, k) <= maxW * 1.001 && height <= maxH + 1) break;
    }
    if (k < 0.55) { k = 0.55; warnings.push('Texten får inte plats ens på 55 % storlek.'); }
    else if (k < 0.999) warnings.push(`Texten krymptes till ${Math.round(k * 100)} % för att få plats.`);
    const size = size0 * k, tr = track0 * k;
    const firstBase = baselines[0] ?? oldBottom;
    const cx = (blockX0 + blockX1) / 2;
    lines.forEach((t, li) => {
      const ext = inkExtent(font, t, size, tr, hs0);
      const pen = align === 'center' ? cx - (ext.minX + ext.maxX) / 2 : align === 'right' ? blockX1 - ext.maxX : blockX0 - ext.minX;
      items.push({ text: t, key: m.key, size, tracking: tr, hs: hs0, bold: bold0 * k, slant: infos[0].slant, x: pen, baseline: firstBase + li * pitch * k, color });
    });
    reports.push({ index: i, font: `${m.family} ${m.weight}`, sizePx: +size.toFixed(1), shrunk: +k.toFixed(3), lines: lines.length, mode: 'block', warnings, match: m, box: touched });
  };

  // ---- Every text edit is checked before it is accepted; a bad result is redone another way ----
  let retriesLeft = 60; // per page: keeps a page with very many edits fast
  const peers: Peer[] = []; // well-fitted edits so far: a disturbed fit can borrow their typeface and size
  const checkedRun = async (i: number, e0: TextEdit): Promise<void> => {
    const lineBoxes = (e0.boxes?.length ? e0.boxes : e0.lines.map((id) => ocr.find((o) => o.id === id)?.box)).filter(Boolean) as Box[];
    if (!lineBoxes.length || !e0.new.trim()) { await runEdit(i, e0); return; }
    const ub = unionBox(lineBoxes), uw = ub.x1 - ub.x0, uh = ub.y1 - ub.y0;
    const reg = clampBox({ x0: ub.x0 - Math.max(80, uw * 1.5), x1: ub.x1 + Math.max(80, uw * 1.5), y0: ub.y0 - Math.max(30, uh * 1.5), y1: ub.y1 + Math.max(30, uh * 1.5) }, out);
    const base0 = cropRaster(out, reg);
    const markItems = items.length, markReports = reports.length;
    type Attempt = { e: TextEdit; align: 'left' | 'center' | 'right'; q: Quality; crop: Raster; items: TextItem[]; reports: EditReport[]; family: string; weight: number; ranking: string[] };
    const done: Attempt[] = [];
    const attempt = async (e: TextEdit): Promise<Attempt | null> => {
      pasteRaster(out, base0, reg.x0, reg.y0); items.length = markItems; reports.length = markReports; meta = null; movedRec = [];
      await runEdit(i, e);
      const mt = meta as { infos: LineInfo[]; m: MatchResult; align: 'left' | 'center' | 'right' } | null;
      if (!mt) return null;
      const fresh = items.slice(markItems);
      const pre = cropRaster(out, reg); // the picture with old text gone, kept words in place, new words not yet drawn
      const q = await measureQuality(src, pre, reg, fresh, mt.infos, mt.m, lib, movedRec, (mt as any).midRef);
      if (e.noSqueeze) q.squeeze = 0;
      if (e.forceSize) { q.fit = 0.8; q.sizeRatio = 1; q.weight = 1; q.squeeze = 0; } // borrowed from a trusted line: this line's own (disturbed) ink is no reference
      if (e0.weight) q.weight = 1; // a weight was asked for: it is not a flaw that it differs from the old line
      // draw the new words into the picture now (they can then be checked and undone like everything else)
      const kept: TextItem[] = [];
      for (const it of fresh) { if (it.raster) await rasterizeInto(out, it, lib, (it as any).ref); else kept.push(it); }
      items.length = markItems; items.push(...kept);
      if (opts.readBack && !e.new.includes('\n') ) {
        try {
          // read the finished area back (vector words are drawn into a copy first) and compare with what was meant
          const view = cropRaster(out, reg);
          for (const it of kept) await rasterizeInto(view, { ...it, x: it.x - reg.x0, baseline: it.baseline - reg.y0 }, lib);
          // OCR reads best when the letters are about 25 px tall (it is run at 2x): scale the crop to that
          const f = Math.max(0.1, Math.min(3, 25 / Math.max(6, uh / Math.max(1, e0.lines.length || 1))));
          const sv = Math.abs(f - 1) > 0.08 ? await scaleRaster(lib, view, f) : view;
          const got = await opts.readBack(sv, { x0: 0, y0: 0, x1: sv.w, y1: sv.h });
          q.read = containment(e.new, got);
          if (process.env.DBGQ) console.error('DBGREAD', JSON.stringify(e.new), '->', JSON.stringify(got), q.read.toFixed(2));
        } catch { /* no read-back available: the other checks stand */ }
      }
      if (typeof process !== 'undefined' && process.env?.DBGQ) console.error('DBGQ', i, JSON.stringify({ font: e.font, weight: e.weight, ss: e.sizeScale, nw: e.noWords, ns: e.noSqueeze, align: e.align }), mt.m.family, mt.m.weight, JSON.stringify({ ...q, bad: +badness(q).toFixed(2) }));
      return { e, q, crop: cropRaster(out, reg), items: items.slice(markItems), reports: reports.slice(markReports), family: mt.m.family, weight: mt.m.weight, align: mt.align, ranking: mt.m.ranking.map((r) => r.key) };
    };
    let first: Attempt | null = null;
    try { first = await attempt(e0); } catch (err) { throw err; }
    if (!first) return;
    done.push(first);
    try {
      let cur = first;
      const tried = new Set<string>();
      for (let n = 0; n < 5 && retriesLeft > 0 && badness(cur.q) > 0.06; n++) {
        const alt = nextAlternative(cur, e0, lib, tried, peers, uh);
        if (!alt) break;
        retriesLeft--;
        const a = await attempt(alt);
        if (!a) continue;
        done.push(a);
        if (badness(a.q) < badness(cur.q)) cur = a;
      }
    } catch (err) { if (typeof process !== 'undefined' && process.env?.DBGQ) console.error('DBGQ-ERR', err); /* keep the best so far */ }
    const best = done.reduce((a, b) => (badness(b.q) < badness(a.q) - 0.02 ? b : a));
    pasteRaster(out, base0, reg.x0, reg.y0); items.length = markItems; reports.length = markReports;
    pasteRaster(out, best.crop, reg.x0, reg.y0); items.push(...best.items); reports.push(...best.reports);
    const rep = reports[reports.length - 1];
    if (rep && best !== first) rep.warnings.push('Resultatet kontrollerades och gjordes om på ett annat sätt (för att undvika krock/fel stil).');
    if (rep && badness(best.q) > 0.3) rep.warnings.push(`Kontrollen är inte nöjd: ${describeQuality(best.q)}`);
    (rep as any).quality = best.q;
    if (rep && badness(best.q) < 0.15 && best.q.fit > 0.6 && rep.sizePx) peers.push({ family: best.family, weight: best.weight, size: rep.sizePx, h: uh, style: e0.style });
  };
  for (const i of [...removals, ...(moves.length ? [-1] : []), ...textOrder.filter((i) => !removals.includes(i))]) {
    if (i === -1) { placeMoves(); continue; }
    const e0 = edits[i];
    if (e0.kind !== 'text') continue;
    await checkedRun(i, e0);
  }
  // Words that sit among original words are drawn into the picture itself,
  // with the same softness, so they can't be told apart from their neighbours.
  const vector: TextItem[] = [];
  for (const it of items) {
    if (it.raster) await rasterizeInto(out, it, lib, (it as any).ref);
    else vector.push(it);
  }
  return { raster: out, items: vector, reports };
}

/** Pick the weight (within one family) whose redrawing of an existing word looks most like the real one. */
async function calibrateWeight(src: Raster, lib: FontLib, family: string, kw: LineInfo, text: string, size: number, tr: number, base: number, color: RGB, fallback: string, hs = 1, bold0 = 0): Promise<{ key: string; bold: number }> {
  const fams = lib.entries.filter((x) => x.family === family);
  // each real weight as is, and slightly thickened (for families without the in-between weight)
  const cands: { key: string; bold: number; w?: number }[] = [];
  // (small text: only real weights; faking extra weight by widening the outline smears tiny glyphs such as the ²)
  // and no heavier than 500: the darkness measure overshoots on small text and then a unit like "cm²" turns out bold next to its regular-weight digits
  for (const c of fams) if (size >= 30 || c.weight <= 500) for (const b of size < 30 ? [0] : [0, size * 0.03, size * 0.06]) cands.push({ key: c.key, bold: b, w: c.weight });
  if (bold0 > 0 && size >= 30) cands.push({ key: fallback, bold: bold0 });
  const blank = cloneRaster(src);
  eraseLine(blank, src, kw);
  // measure only around the word itself (the area around it can hold bits of other lines)
  const A = clampBox(padBox(kw.inkBox, 2), src);
  // total darkness against the cleaned background: blur- and shape-proof, so
  // it compares stroke weight as it will actually look on the page
  const dark = (r: Raster) => {
    let sum = 0;
    for (let y = A.y0; y < A.y1; y++) for (let x = A.x0; x < A.x1; x++) {
      const i = (y * src.w + x) * 4;
      // signed: background grain/texture averages out instead of adding up
      for (let q = 0; q < 3; q++) sum += blank.data[i + q] - r.data[i + q];
    }
    return sum;
  };
  // the real word's darkness against its background model (not against our fill,
  // whose overall tone can differ slightly on textured surfaces)
  let tsum = 0;
  for (let y = A.y0; y < A.y1; y++) for (let x = A.x0; x < A.x1; x++) {
    const i = (y * src.w + x) * 4, g = kw.bgAt(x, y);
    for (let q = 0; q < 3; q++) tsum += g[q] - src.data[i + q];
  }
  const target = Math.abs(tsum);
  if (target <= 0) return { key: fallback, bold: bold0 };
  let best = { key: fallback, bold: bold0 }, bestErr = Infinity;
  for (const c of cands) {
    const font = await lib.load(c.key);
    const ext = inkExtent(font, text, size, tr, hs);
    const t = cloneRaster(blank);
    await rasterizeInto(t, { text, key: c.key, size, tracking: tr, hs, bold: c.bold, x: kw.inkBox.x0 - ext.minX, baseline: base, color, raster: true }, lib, kw);
    // a real weight is preferred over a thickened one when both are about as dark
    // total darkness depends on size and spacing as much as on weight, so small errors there pass for "heavier": a light pull toward a regular weight keeps only clearly bold words bold
    const err = Math.abs(Math.log(Math.max(1, Math.abs(dark(t))) / target)) + (size >= 30 ? 2 : 0.5) * (c.bold / Math.max(1, size)) + (size >= 30 ? 0.02 : 0.06) * (Math.max(0, (c.w ?? 400) - 450) / 100);
    if (err < bestErr) { bestErr = err; best = c; }
  }
  return best;
}

/** Where a text item's letters fall: coverage 0..1 per picture pixel over a box, before any softening. */
export async function glyphCoverage(it: TextItem, lib: FontLib): Promise<{ x0: number; y0: number; W: number; H: number; cov: Float32Array } | null> {
  const font = await lib.load(it.key);
  const ext = inkExtent(font, it.text, it.size, it.tracking, it.hs ?? 1, it.slant ?? 0);
  const pad = Math.ceil(4 + (it.bold ?? 0));
  const x0 = Math.floor(it.x + ext.minX) - pad, x1 = Math.ceil(it.x + ext.maxX) + pad;
  const y0 = Math.floor(it.baseline - it.size * 1.05) - pad, y1 = Math.ceil(it.baseline + it.size * 0.35) + pad;
  const W = x1 - x0, H = y1 - y0, S = 4;
  if (W <= 0 || H <= 0) return null;
  const big = lib.platform.createCanvas(W * S, H * S);
  const g = big.getContext('2d');
  drawText(g, font, it.text, (it.x - x0) * S, (it.baseline - y0) * S, it.size * S, it.tracking * S, '#000', it.hs ?? 1, (it.bold ?? 0) * S, it.slant ?? 0);
  const a = g.getImageData(0, 0, W * S, H * S).data;
  // box-downsample to picture resolution
  const cov = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let sum = 0;
    for (let yy = 0; yy < S; yy++) for (let xx = 0; xx < S; xx++) sum += a[((y * S + yy) * W * S + x * S + xx) * 4 + 3];
    cov[y * W + x] = sum / (S * S * 255);
  }
  return { x0, y0, W, H, cov };
}

export async function rasterizeInto(dst: Raster, it: TextItem, lib: FontLib, ref?: LineInfo) {
  const gc = await glyphCoverage(it, lib);
  if (!gc) return;
  const { x0, y0, W, H, cov } = gc;
  // a light blur like the original
  const blur = (c: Float32Array) => {
    const o = new Float32Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let sum = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        const w = (dx ? 1 : 2) * (dy ? 1 : 2);
        sum += c[yy * W + xx] * w; n += w;
      }
      o[y * W + x] = sum / n;
    }
    return o;
  };
  // softness = share of ink pixels that are half-tone edge pixels; pick the
  // blur that gives the same softness as the original words around it
  const soft = (c: ArrayLike<number>) => { let e = 0, t = 0; for (let i = 0; i < c.length; i++) { if (c[i] > 0.12) t++; if (c[i] > 0.12 && c[i] < 0.8) e++; } return t ? e / t : 0; };
  const target = ref ? soft(ref.cov) : 0.5;
  let bl = cov, best = Math.abs(soft(cov) - target);
  let cur = cov;
  for (let pass = 0; pass < 3; pass++) {
    cur = blur(cur);
    const d = Math.abs(soft(cur) - target);
    if (d < best) { best = d; bl = cur; } else break;
  }
  // keep the original's darkness: scale so the peak matches
  let peak = 0; for (const v of bl) peak = Math.max(peak, v);
  let refPeak = ref ? 0 : 1;
  if (ref) for (let i = 0; i < ref.cov.length; i++) if (ref.cov[i] > refPeak) refPeak = ref.cov[i];
  const gain = peak > 0 ? Math.min(1.15, refPeak / peak) : 1;
  if (gain > 1.01) for (let i = 0; i < bl.length; i++) bl[i] = Math.min(1, bl[i] * gain);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const tx = x0 + x, ty = y0 + y;
    if (tx < 0 || ty < 0 || tx >= dst.w || ty >= dst.h) continue;
    const al = bl[y * W + x];
    if (al <= 0.003) continue;
    const i = (ty * dst.w + tx) * 4;
    for (let c = 0; c < 3; c++) dst.data[i + c] = dst.data[i + c] * (1 - al) + it.color[c] * al;
  }
}

// keep helpers referenced (tree-shaking friendly)
void padBox; void clampBox; void px;
