// Text that runs up or down the page (dimension lines on drawings, spines).
// The engine only sets straight text, so:
//  - OCR: the page is read again turned a quarter turn each way; lines found that way are
//    mapped back and tagged with `rot`.
//  - Editing: the part of the page around such a line is cut out, turned so the text is straight,
//    edited by the ordinary engine, turned back and pasted in again.

import { Box, Raster, cloneRaster, cropRaster, pasteRaster, rotateCCW, rotateCW, unionBox, clampBox, padBox } from './raster';
import { applyEdits, Applied, Edit, EditReport, OcrLine, TextEdit } from './edit';
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
export async function ocrRotated(r: Raster, pass: PassFn): Promise<OcrLine[]> {
  const out: OcrLine[] = [];
  for (const cw of [true, false]) {
    const rr = cw ? rotateCW(r) : rotateCCW(r);
    const lines = await pass(rr, { x0: 0, y0: 0, x1: rr.w, y1: rr.h }, false, 70);
    for (const l of lines) {
      const alnum = (l.text.match(/[\p{L}\p{N}]/gu) ?? []).length;
      if (alnum < 4 || !/\d|\p{L}{3}/u.test(l.text)) continue;
      out.push({
        id: 0,
        text: l.text,
        box: backBox(l.box, r, cw),
        words: (l.words ?? []).map((w) => ({ text: w.text, box: backBox(w.box, r, cw) })),
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
export async function applyEditsRot(src: Raster, ocr: OcrLine[], edits: Edit[], lib: FontLib, base?: Raster, opts: { vectorOnly?: boolean } = {}): Promise<Applied> {
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
