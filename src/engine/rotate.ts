// Text that runs up or down the page (dimension lines on drawings, spines).
// The engine only sets straight text, so:
//  - OCR: the page is read again turned a quarter turn each way; lines found that way are
//    mapped back and tagged with `rot`.
//  - Editing: the part of the page around such a line is cut out, turned so the text is straight,
//    edited by the ordinary engine, turned back and pasted in again.

import { Box, Raster, cloneRaster, cropRaster, pasteRaster, rotateCCW, rotateCW, shrinkRaster, unionBox, clampBox, padBox } from './raster';
import { applyEdits, ApplyOpts, Applied, containment, Edit, EditReport, OcrLine, scaleRaster, TextEdit } from './edit';
import { drawText, FontLib } from './fonts';

type PassFn = (r: Raster, region: Box, invert: boolean, minConf?: number) => Promise<OcrLine[]>;

/** Box in the turned picture -> box on the page. `cw` = the picture was turned clockwise. */
function backBox(b: Box, page: { w: number; h: number }, cw: boolean): Box {
  return cw
    ? { x0: b.y0, x1: b.y1, y0: page.h - b.x1, y1: page.h - b.x0 }
    : { x0: page.w - b.y1, x1: page.w - b.y0, y0: b.x0, y1: b.x1 };
}

/** Box on the page (relative to a cut-out of size cw x ch) -> box in the turned cut-out. */
function forwardBox(b: Box, cut: { w: number; h: number }, cw: boolean): Box {
  return cw
    ? { x0: cut.h - b.y1, x1: cut.h - b.y0, y0: b.x0, y1: b.x1 }
    : { x0: b.y0, x1: b.y1, y0: cut.w - b.x1, y1: cut.w - b.x0 };
}

/**
 * Read the page turned each way and return the lines that run vertically, in page coordinates.
 * Only confident lines with real content are kept; the caller merges them with the normal reading.
 */
export async function ocrRotated(page: Raster, pass: PassFn): Promise<OcrLine[]> {
  // big renders (print resolution) are read on a smaller copy: vertical text is rare, and the cost is per pixel
  const f = Math.max(1, Math.max(page.w, page.h) / 2200);
  const r = shrinkRaster(page, f);
  const out: OcrLine[] = [];
  for (const cw of [true, false]) {
    const rr = cw ? rotateCW(r) : rotateCCW(r);
    const lines = await pass(rr, { x0: 0, y0: 0, x1: rr.w, y1: rr.h }, false, (typeof process !== 'undefined' && process.env?.ROTCONF ? +process.env.ROTCONF : 50));
    const up = (b: Box): Box => { const t = backBox(b, r, cw); return { x0: t.x0 * f, y0: t.y0 * f, x1: t.x1 * f, y1: t.y1 * f }; };
    for (const l of lines) {
      const alnum = (l.text.match(/[\p{L}\p{N}]/gu) ?? []).length;
      if (alnum < 4 || !/\d|\p{L}{3}/u.test(l.text)) continue;
      out.push({
        id: 0,
        text: l.text,
        box: up(l.box),
        words: (l.words ?? []).map((w) => ({ text: w.text, box: up(w.box) })),
        rot: cw ? 90 : -90,
        conf: l.conf,
      });
    }
  }
  return out;
}

/** Draw the vector items into a copy of the picture (the same as the app's preview does). */
async function flatten(lib: FontLib, a: Applied): Promise<Raster> {
  const { w, h } = a.raster;
  const cv = lib.platform.createCanvas(w, h);
  const ctx = cv.getContext('2d');
  const id = ctx.createImageData(w, h);
  id.data.set(a.raster.data);
  ctx.putImageData(id, 0, 0);
  for (const it of a.items) {
    const font = await lib.load(it.key);
    drawText(ctx, font, it.text, it.x, it.baseline, it.size, it.tracking, `rgb(${it.color.map(Math.round).join(',')})`, it.hs ?? 1, it.bold ?? 0);
  }
  const d = ctx.getImageData(0, 0, w, h);
  return { w, h, data: new Uint8ClampedArray(d.data) };
}

/**
 * Like applyEdits, but text edits whose lines run vertically are done on a turned cut-out.
 * Everything else goes through applyEdits as before.
 */

/** Tilt of the lettering inside a box (degrees, clockwise positive, text reading left to right), or null when it is straight or has no clear direction. */
export function inkTilt(r: Raster, box: Box): number | null {
  const b = clampBox(box, r), w = b.x1 - b.x0, h = b.y1 - b.y0;
  if (w < 12 || h < 12) return null;
  // ground = the colour along the box's border
  const ring: number[][] = [];
  for (let x = b.x0; x < b.x1; x += 2) for (const y of [b.y0, b.y1 - 1]) ring.push([r.data[(y * r.w + x) * 4], r.data[(y * r.w + x) * 4 + 1], r.data[(y * r.w + x) * 4 + 2]]);
  for (let y = b.y0; y < b.y1; y += 2) for (const x of [b.x0, b.x1 - 1]) ring.push([r.data[(y * r.w + x) * 4], r.data[(y * r.w + x) * 4 + 1], r.data[(y * r.w + x) * 4 + 2]]);
  const med = [0, 1, 2].map((c) => ring.map((v) => v[c]).sort((p, q) => p - q)[ring.length >> 1]);
  let n = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
  const pts: number[] = [];
  for (let y = b.y0; y < b.y1; y++) for (let x = b.x0; x < b.x1; x++) {
    const i = (y * r.w + x) * 4;
    if (Math.abs(r.data[i] - med[0]) + Math.abs(r.data[i + 1] - med[1]) + Math.abs(r.data[i + 2] - med[2]) > 90) { pts.push(x, y); n++; sx += x; sy += y; }
  }
  if (n < 60) return null;
  const mx = sx / n, my = sy / n;
  for (let k = 0; k < pts.length; k += 2) { const dx = pts[k] - mx, dy = pts[k + 1] - my; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
  sxx /= n; syy /= n; sxy /= n;
  const tr = sxx + syy, det = sxx * syy - sxy * sxy, disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
  const l1 = tr / 2 + disc, l2 = Math.max(1e-6, tr / 2 - disc);
  if (l1 / l2 < 3.5) return null; // not a long thin run of letters
  let a = (0.5 * Math.atan2(2 * sxy, sxx - syy) * 180) / Math.PI; // principal axis, (-90, 90]
  if (a > 90) a -= 180;
  return Math.abs(a) < 6 || Math.abs(a) > 84 ? null : a;
}

/** Turn a picture by `deg` (clockwise positive) around its centre onto a larger canvas filled with `fill`. */
function rotateAny(r: Raster, deg: number, fill: [number, number, number]) {
  const t = (deg * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
  const W = Math.ceil(Math.abs(r.w * c) + Math.abs(r.h * s)), H = Math.ceil(Math.abs(r.w * s) + Math.abs(r.h * c));
  const out = new Uint8ClampedArray(W * H * 4);
  const cx = r.w / 2, cy = r.h / 2, CX = W / 2, CY = H / 2;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const dx = x + 0.5 - CX, dy = y + 0.5 - CY;
    const sx = cx + dx * c + dy * s - 0.5, sy = cy - dx * s + dy * c - 0.5; // inverse turn
    const o = (y * W + x) * 4;
    const x0 = Math.floor(sx), y0 = Math.floor(sy), fx = sx - x0, fy = sy - y0;
    for (let k = 0; k < 3; k++) {
      const at = (xx: number, yy: number) => (xx >= 0 && yy >= 0 && xx < r.w && yy < r.h ? r.data[(yy * r.w + xx) * 4 + k] : fill[k]);
      out[o + k] = at(x0, y0) * (1 - fx) * (1 - fy) + at(x0 + 1, y0) * fx * (1 - fy) + at(x0, y0 + 1) * (1 - fx) * fy + at(x0 + 1, y0 + 1) * fx * fy;
    }
    out[o + 3] = 255;
  }
  const fwd = (x: number, y: number): [number, number] => { const dx = x - cx, dy = y - cy; return [CX + dx * c - dy * s, CY + dx * s + dy * c]; };
  return { raster: { w: W, h: H, data: out } as Raster, fwd };
}

/** Edit text that is tilted by `deg`: straighten the area, edit it like any line, tilt it back, paste only what changed. */
async function editTilted(raster: Raster, region: Box, e: TextEdit, deg: number, lib: FontLib, opts: ApplyOpts): Promise<{ report?: EditReport; box: Box }> {
  const crop = cropRaster(raster, region), w = crop.w, h = crop.h;
  // ground colour = median of the area's border
  const ring: number[][] = [];
  for (let x = 0; x < w; x += 2) for (const y of [0, h - 1]) ring.push([crop.data[(y * w + x) * 4], crop.data[(y * w + x) * 4 + 1], crop.data[(y * w + x) * 4 + 2]]);
  for (let y = 0; y < h; y += 2) for (const x of [0, w - 1]) ring.push([crop.data[(y * w + x) * 4], crop.data[(y * w + x) * 4 + 1], crop.data[(y * w + x) * 4 + 2]]);
  const fill = [0, 1, 2].map((c) => ring.map((v) => v[c]).sort((p, q) => p - q)[ring.length >> 1]) as [number, number, number];
  const { raster: flat, fwd } = rotateAny(crop, -deg, fill);
  // the lettering's own box in the straightened picture
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    if (Math.abs(crop.data[i] - fill[0]) + Math.abs(crop.data[i + 1] - fill[1]) + Math.abs(crop.data[i + 2] - fill[2]) > 90) { const [fx, fy] = fwd(x, y); x0 = Math.min(x0, fx); x1 = Math.max(x1, fx); y0 = Math.min(y0, fy); y1 = Math.max(y1, fy); }
  }
  const lineBox: Box = { x0: Math.max(0, x0 - 2), y0: Math.max(0, y0 - 2), x1: Math.min(flat.w, x1 + 2), y1: Math.min(flat.h, y1 + 2) };
  const oldT = (e.old[0] ?? '').trim();
  const localEdit: TextEdit = { ...e, lines: [0], boxes: undefined, old: [oldT] };
  const localOcr: OcrLine[] = [{ id: 0, text: oldT, box: lineBox }];
  const before = cloneRaster(flat);
  const res = await applyEdits(flat, localOcr, [localEdit], lib, undefined, { vectorOnly: false });
  const done = await flatten(lib, res);
  // changed pixels (a little widened), carried back to the page
  const W = flat.w, H = flat.h, ch = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    if (Math.abs(done.data[i] - before.data[i]) + Math.abs(done.data[i + 1] - before.data[i + 1]) + Math.abs(done.data[i + 2] - before.data[i + 2]) > 24) ch[y * W + x] = 1;
  }
  const wide = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (ch[y * W + x]) for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const xx = x + dx, yy = y + dy; if (xx >= 0 && yy >= 0 && xx < W && yy < H) wide[yy * W + xx] = 1; }
  const t = (-deg * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t), CX = W / 2, CY = H / 2, cx = w / 2, cy = h / 2; // (the same turn that straightened the area)
  // every pixel of the page area: where does it lie in the straightened picture; take it from the edited one where something changed there
  const reach: Box = { x0: 1e9, y0: 1e9, x1: -1e9, y1: -1e9 };
  const pad = Math.ceil(Math.hypot(W, H));
  for (let y = -pad; y < h + pad; y++) for (let x = -pad; x < w + pad; x++) {
    const px = region.x0 + x, py = region.y0 + y;
    if (px < 0 || py < 0 || px >= raster.w || py >= raster.h) continue;
    const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
    const fx = CX + dx * c - dy * s - 0.5, fy = CY + dx * s + dy * c - 0.5;
    const ix = Math.round(fx), iy = Math.round(fy);
    if (ix < 0 || iy < 0 || ix >= W || iy >= H || !wide[iy * W + ix]) continue;
    const x0f = Math.floor(fx), y0f = Math.floor(fy), ax = fx - x0f, ay = fy - y0f, o = (py * raster.w + px) * 4;
    for (let k = 0; k < 3; k++) {
      const at = (xx: number, yy: number) => done.data[(Math.min(H - 1, Math.max(0, yy)) * W + Math.min(W - 1, Math.max(0, xx))) * 4 + k];
      raster.data[o + k] = at(x0f, y0f) * (1 - ax) * (1 - ay) + at(x0f + 1, y0f) * ax * (1 - ay) + at(x0f, y0f + 1) * (1 - ax) * ay + at(x0f + 1, y0f + 1) * ax * ay;
    }
    reach.x0 = Math.min(reach.x0, px); reach.y0 = Math.min(reach.y0, py); reach.x1 = Math.max(reach.x1, px + 1); reach.y1 = Math.max(reach.y1, py + 1);
  }
  return { report: res.reports[0], box: reach.x1 > reach.x0 ? reach : region };
}

export async function applyEditsRot(src: Raster, ocr: OcrLine[], edits: Edit[], lib: FontLib, base?: Raster, opts: ApplyOpts = {}): Promise<Applied> {
  // A text pointed out by a box whose lettering runs at an angle (a stamp, a diagonal watermark): straightened, edited, tilted back.
  {
    const tilted: { e: TextEdit; i: number; deg: number }[] = [];
    edits.forEach((e, i) => {
      if (e.kind !== 'text' || e.boxes?.length !== 1 || (e.old[0] ?? '').replace(/\s/g, '').length < 4) return;
      const deg = inkTilt(src, e.boxes[0]);
      if (deg !== null && Math.abs(deg) < 80) tilted.push({ e, i, deg });
    });
    if (tilted.length) {
      const rest = edits.map((e, i) => ({ e, i })).filter((x) => !tilted.some((t) => t.i === x.i));
      const main = await applyEditsRot(src, ocr, rest.map((r) => r.e), lib, base, opts);
      const reports: EditReport[] = main.reports.map((r) => ({ ...r, index: rest[r.index].i }));
      const raster = cloneRaster(main.raster);
      for (const { e, i, deg } of tilted) {
        const region = clampBox(padBox(e.boxes![0], 14), src);
        try {
          const r = await editTilted(raster, region, e, deg, lib, opts);
          reports.push({ ...(r.report ?? { warnings: [] }), index: i, box: r.box, mode: `tilted(${deg.toFixed(0)}°) ${r.report?.mode ?? ''}`.trim() } as EditReport);
        } catch (err: any) {
          reports.push({ index: i, font: '-', sizePx: 0, shrunk: 1, lines: 1, mode: 'skipped', warnings: [`Ändringen gjordes inte: den vinklade texten kunde inte skrivas om (${err?.message ?? err}).`], box: region } as EditReport);
        }
      }
      return { raster, items: main.items, reports: reports.sort((a, b) => a.index - b.index) };
    }
  }
  // A text pointed out by a box that is much taller than wide, which OCR did not find as a line: it is probably turned.
  // Read the box turned each way and take the direction in which the old text comes out (when OCR can say).
  if (opts.readBack) {
    let nextId = ocr.reduce((m, o) => Math.max(m, o.id), -1) + 1;
    let ocr2: OcrLine[] | null = null, edits2: Edit[] | null = null;
    for (let i = 0; i < edits.length; i++) {
      const e = edits[i];
      if (e.kind !== 'text' || e.boxes?.length !== 1) continue;
      const b = e.boxes[0], w = b.x1 - b.x0, h = b.y1 - b.y0, oldT = (e.old[0] ?? '').trim();
      if (h < w * 1.5 || oldT.replace(/\s/g, '').length < 4) continue;
      let best: { rot: 90 | -90; score: number } | undefined;
      for (const rot of [90, -90] as const) {
        try {
          const crop = cropRaster(src, clampBox(padBox(b, 6), src));
          const t = rot === 90 ? rotateCW(crop) : rotateCCW(crop);
          const f = Math.max(0.25, Math.min(3, 30 / Math.max(6, Math.min(w, h) * 0.6)));
          const sv = Math.abs(f - 1) > 0.08 ? await scaleRaster(lib, t, f) : t;
          const score = containment(oldT, await opts.readBack(sv, { x0: 0, y0: 0, x1: sv.w, y1: sv.h }));
          if (!best || score > best.score) best = { rot, score };
        } catch { /* cannot read: leave the edit as it is */ }
      }
      if (best && best.score >= 0.6) {
        ocr2 ??= [...ocr]; edits2 ??= [...edits];
        ocr2.push({ id: nextId, text: oldT, box: b, rot: best.rot });
        edits2[i] = { ...e, lines: [nextId], boxes: undefined, old: [oldT] };
        nextId++;
      }
    }
    if (ocr2 && edits2) return applyEditsRot(src, ocr2, edits2, lib, base, { ...opts, readBack: undefined });
  }
  const rotOf = (e: Edit): 90 | -90 | undefined => {
    if (e.kind !== 'text' || !e.lines.length || e.boxes?.length) return undefined;
    const rs = e.lines.map((id) => ocr.find((o) => o.id === id)?.rot);
    return rs.every((x) => x && x === rs[0]) ? rs[0] : undefined;
  };
  const rotated = edits.map((e, i) => ({ e, i, rot: rotOf(e) })).filter((x) => x.rot) as { e: TextEdit; i: number; rot: 90 | -90 }[];
  if (!rotated.length) return applyEdits(src, ocr, edits, lib, base, opts);

  const keep = edits.map((e, i) => ({ e, i })).filter((x) => !rotated.some((r) => r.i === x.i));
  const main = await applyEdits(src, ocr, keep.map((k) => k.e), lib, base, opts);
  const reports: EditReport[] = main.reports.map((r) => ({ ...r, index: keep[r.index].i }));
  const raster = cloneRaster(main.raster);

  for (const { e, i, rot } of rotated) {
    const lines = e.lines.map((id) => ocr.find((o) => o.id === id)!);
    const pad = 14;
    const region = clampBox(padBox(unionBox(lines.map((l) => l.box)), pad), src);
    const cw = rot === 90; // text reading bottom to top is straightened by turning the picture clockwise
    const cut = { w: region.x1 - region.x0, h: region.y1 - region.y0 };
    const turn = (r: Raster) => (cw ? rotateCW(r) : rotateCCW(r));
    const rel = (b: Box): Box => ({ x0: b.x0 - region.x0, y0: b.y0 - region.y0, x1: b.x1 - region.x0, y1: b.y1 - region.y0 });
    const localOcr: OcrLine[] = lines.map((l, k) => ({
      id: k,
      text: l.text,
      box: forwardBox(rel(l.box), cut, cw),
      words: (l.words ?? []).map((w) => ({ text: w.text, box: forwardBox(rel(w.box), cut, cw) })),
    }));
    const localEdit: TextEdit = { ...e, lines: lines.map((_, k) => k) };
    // anything the ordinary engine drew earlier in this spot is part of the "before" picture
    const res = await applyEdits(turn(cropRaster(src, region)), localOcr, [localEdit], lib, turn(cropRaster(raster, region)), { vectorOnly: false });
    const done = await flatten(lib, res);
    pasteRaster(raster, cw ? rotateCCW(done) : rotateCW(done), region.x0, region.y0);
    const rep = res.reports[0];
    reports.push({ ...(rep ?? { warnings: [], mode: 'rotated' }), index: i, box: region, mode: `vertical(${rot}) ${rep?.mode ?? ''}`.trim() } as EditReport);
  }
  return { raster, items: main.items, reports: reports.sort((a, b) => a.index - b.index) };
}
