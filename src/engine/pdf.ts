// Reads the page picture out of a flattened PDF and writes the edited PDF:
// same page, same placement, the cleaned picture swapped in, and the new
// words on top as real (vector) text in embedded fonts.

import { PDFDocument, PDFName, PDFRawStream, PDFDict, PDFArray, PDFRef, decodePDFRawStream, rgb, setCharacterSpacing, setCharacterSqueeze, setTextRenderingMode, TextRenderingMode, setLineWidth, setLineJoin, LineJoinStyle, setStrokingRgbColor, pushGraphicsState, popGraphicsState } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import type { Raster } from './raster';
import { FontLib, FEATURES } from './fonts';

export interface PageImage {
  /** 'swap': the page is one JPEG picture, swapped in place. 'render': anything
   * else (an already-edited file, several pictures, real text): the page is
   * rendered to one picture and rebuilt from it. */
  mode: 'swap' | 'render' | 'image';
  /** 'image' mode: the file was a picture (PNG/JPG) and is saved back as one */
  format?: 'png' | 'jpeg';
  /** picture pixels per inch on the printed page (render mode) */
  ppi?: number;
  /** why it was rendered: 'layers' = pictures/text on top (e.g. an edited file), 'text' = no page picture (real text), 'format' = picture format we don't swap directly */
  reason?: 'layers' | 'text' | 'format';
  pageIndex: number;
  pageCount: number;
  name: string; // XObject name on the page ('' in render mode)
  ref?: PDFRef;
  w: number;
  h: number;
  ctm: number[]; // [a b c d e f] image unit square -> page space
  pageW: number;
  pageH: number;
  jpeg?: Uint8Array; // original bytes if DCT
  /** 'image' mode, PNG with transparency: the original pixels incl. alpha */
  rgba?: Uint8ClampedArray;
}

export interface Codec {
  decodeJpeg(bytes: Uint8Array): Promise<Raster>;
  /** keepAlpha: keep the raster's alpha (transparent PNG), otherwise saved fully opaque */
  encodePng(r: Raster, keepAlpha?: boolean): Promise<Uint8Array>;
  /** Render one page (0-based) at `scale` pixels per PDF point, no rotation. */
  renderPage(bytes: Uint8Array, pageIndex: number, scale: number): Promise<Raster>;
  /** Decode a PNG/JPG file (transparency flattened onto white). `rgba` holds the
   * untouched pixels when the picture has transparent parts. */
  decodeImage(bytes: Uint8Array, mime: string): Promise<Raster & { rgba?: Uint8ClampedArray }>;
  encodeJpeg(r: Raster, quality?: number): Promise<Uint8Array>;
}

const mul = (m: number[], n: number[]) => [
  m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3],
  m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5],
];

/** Minimal content-stream walk: tracks q/Q/cm, records `Do` placements and counts other painting. */
function findPlacements(content: string): { name: string; ctm: number[] }[] & { paints?: number } {
  const out: { name: string; ctm: number[] }[] & { paints?: number } = [];
  let paints = 0;
  const PAINT = new Set(['f', 'F', 'f*', 'B', 'B*', 'b', 'b*', 'S', 's', 'sh', 'Tj', 'TJ', "'", '"', 'BI']);
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack: number[][] = [];
  const nums: number[] = [];
  let lastName = '';
  const re = /\/([^\s/<>\[\]()]+)|(-?\d*\.?\d+(?:[eE][-+]?\d+)?)|([A-Za-z'"*]+)|\(|\[|\]|<|>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) {
    if (m[1] !== undefined) { lastName = m[1]; continue; }
    if (m[2] !== undefined) { nums.push(parseFloat(m[2])); continue; }
    if (m[0] === '(') { // skip a string literal (may contain anything)
      let depth = 1, i = re.lastIndex;
      for (; i < content.length && depth; i++) { const ch = content[i]; if (ch === '\\') i++; else if (ch === '(') depth++; else if (ch === ')') depth--; }
      re.lastIndex = i; nums.length = 0; continue;
    }
    const op = m[3];
    if (op === 'q') stack.push(ctm);
    else if (op === 'Q') ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0];
    else if (op === 'cm' && nums.length >= 6) ctm = mul(nums.slice(-6), ctm);
    else if (op === 'Do') out.push({ name: lastName, ctm });
    else if (op && PAINT.has(op) && out.length) paints++; // only drawing on top of a picture matters
    else if (op === 'BI') { const end = content.indexOf('EI', re.lastIndex); re.lastIndex = end < 0 ? content.length : end + 2; }
    if (op) nums.length = 0;
  }
  out.paints = paints;
  return out;
}

/** How many pages the PDF has (cheap). */
export async function pageCount(bytes: Uint8Array): Promise<number> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true });
  return doc.getPageCount();
}

export async function readPage(bytes: Uint8Array, codec: Codec, pageIndex = 0): Promise<{ image: PageImage; raster: Raster }> {
  let doc: PDFDocument;
  try { doc = await PDFDocument.load(bytes, { updateMetadata: false }); }
  catch (e: any) {
    if (/encrypt/i.test(String(e?.message))) throw new Error('PDF:en är lösenordsskyddad eller låst. Spara en olåst kopia och försök igen.');
    throw new Error('Filen gick inte att läsa som PDF. Är den skadad? Prova att spara/skriva ut den som PDF igen.');
  }
  const pages = doc.getPageCount();
  if (pages < 1) throw new Error('PDF:en har inga sidor.');
  if (pageIndex >= pages) pageIndex = 0;
  const page = doc.getPage(pageIndex);
  const { width: pageW, height: pageH } = page.getSize();
  const mb = page.getMediaBox();
  const contents = page.node.Contents();
  const streams: PDFRawStream[] = [];
  if (contents instanceof PDFArray) for (let i = 0; i < contents.size(); i++) streams.push(contents.lookup(i) as PDFRawStream);
  else if (contents) streams.push(contents as unknown as PDFRawStream);
  let text = '';
  for (const s of streams) { try { text += new TextDecoder('latin1').decode(decodePDFRawStream(s as any).decode()) + '\n'; } catch { text += '\nBT\n'; /* unreadable: force render */ } }
  const xobjs = (page.node.Resources()?.lookup(PDFName.of('XObject')) as PDFDict | undefined);
  const places = findPlacements(text);
  // all pictures on the page, biggest first
  const imgs: { name: string; ref: PDFRef; w: number; h: number; ctm: number[]; dct?: Uint8Array }[] = [];
  let forms = 0;
  for (const p of places) {
    const ref = xobjs?.get(PDFName.of(p.name));
    if (!(ref instanceof PDFRef)) continue;
    const obj = doc.context.lookup(ref);
    if (!(obj instanceof PDFRawStream)) continue;
    const sub = obj.dict.lookup(PDFName.of('Subtype'))?.toString();
    if (sub === '/Form') { forms++; continue; }
    if (sub !== '/Image') continue;
    const w = Number(obj.dict.lookup(PDFName.of('Width'))?.toString());
    const h = Number(obj.dict.lookup(PDFName.of('Height'))?.toString());
    const filter = obj.dict.lookup(PDFName.of('Filter'))?.toString() ?? '';
    const cs = obj.dict.lookup(PDFName.of('ColorSpace'))?.toString() ?? '';
    const plainJpeg = filter === '/DCTDecode' || filter === '[ /DCTDecode ]';
    const rgbish = cs === '/DeviceRGB' || cs === '/DeviceGray' || /ICCBased/.test(cs) || cs.includes(' R');
    imgs.push({ name: p.name, ref, w, h, ctm: p.ctm, dct: plainJpeg && rgbish && !obj.dict.has(PDFName.of('SMask')) && !obj.dict.has(PDFName.of('Decode')) ? obj.contents : undefined });
  }
  imgs.sort((a, b) => b.w * b.h - a.w * a.h);
  const main = imgs[0];
  // ---- simple case: the page is exactly one JPEG picture ----
  if (main && imgs.length === 1 && !forms && !places.paints && main.dct) {
    try {
      const raster = await codec.decodeJpeg(main.dct);
      if (raster.w === main.w && raster.h === main.h)
        return { image: { mode: 'swap', pageIndex, pageCount: pages, name: main.name, ref: main.ref, w: main.w, h: main.h, ctm: main.ctm, pageW, pageH, jpeg: main.dct }, raster };
    } catch { /* fall through to rendering */ }
  }
  // ---- everything else: render the page ----
  // Real text and drawings are rendered at print resolution (300 ppi); a page
  // that is mostly one picture keeps that picture's own resolution.
  let ppp = 300 / 72;
  if (main && !places.paints && !forms) {
    const pw = Math.hypot(main.ctm[0], main.ctm[1]), ph = Math.hypot(main.ctm[2], main.ctm[3]);
    ppp = Math.max(main.w / Math.max(1, pw), main.h / Math.max(1, ph));
    if (ppp < 100 / 72) ppp = 150 / 72;
  }
  ppp = Math.min(ppp, Math.sqrt(16e6 / (pageW * pageH)), 400 / 72); // cap ~16 MP (big cartons get less)
  const raster = await codec.renderPage(bytes, pageIndex, ppp);
  return {
    image: { mode: 'render', reason: !main ? 'text' : imgs.length > 1 || forms || places.paints ? 'layers' : 'format', pageIndex, pageCount: pages, name: '', w: raster.w, h: raster.h, ctm: [pageW, 0, 0, pageH, mb.x, mb.y], pageW, pageH, ppi: Math.round(ppp * 72) },
    raster,
  };
}

export interface TextItem {
  text: string;
  key: string; // font key
  size: number; // image px
  tracking: number; // image px
  /** horizontal scale of the letters (1 = normal) */
  hs?: number;
  /** synthetic emboldening: outline width, image px */
  bold?: number;
  x: number; // pen x, image px
  baseline: number; // image y
  color: [number, number, number];
  /** draw into the picture (same softness as its neighbours) instead of as vector text */
  raster?: boolean;
}

/** image px -> page point */
export function toPage(img: PageImage, x: number, y: number): [number, number] {
  const u = x / img.w, v = 1 - y / img.h;
  const m = img.ctm;
  return [m[0] * u + m[2] * v + m[4], m[1] * u + m[3] * v + m[5]];
}

/** Areas where two same-size pictures differ, as boxes (merged, padded). */
export function changedBoxes(a: Raster, b: Raster, pad = 3): { x0: number; y0: number; x1: number; y1: number }[] {
  const C = 8, gw = Math.ceil(a.w / C), gh = Math.ceil(a.h / C);
  const g = new Uint8Array(gw * gh);
  for (let y = 0; y < a.h; y++) for (let x = 0; x < a.w; x++) {
    const i = (y * a.w + x) * 4;
    if (Math.abs(a.data[i] - b.data[i]) > 4 || Math.abs(a.data[i + 1] - b.data[i + 1]) > 4 || Math.abs(a.data[i + 2] - b.data[i + 2]) > 4) g[((y / C) | 0) * gw + ((x / C) | 0)] = 1;
  }
  const seen = new Uint8Array(gw * gh), out: { x0: number; y0: number; x1: number; y1: number }[] = [];
  for (let k = 0; k < g.length; k++) {
    if (!g[k] || seen[k]) continue;
    let x0 = gw, y0 = gh, x1 = 0, y1 = 0; const st = [k]; seen[k] = 1;
    while (st.length) {
      const q = st.pop()!, cx = q % gw, cy = (q / gw) | 0;
      x0 = Math.min(x0, cx); y0 = Math.min(y0, cy); x1 = Math.max(x1, cx); y1 = Math.max(y1, cy);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = cx + dx, ny = cy + dy, n = ny * gw + nx;
        if (nx >= 0 && ny >= 0 && nx < gw && ny < gh && g[n] && !seen[n]) { seen[n] = 1; st.push(n); }
      }
    }
    out.push({ x0: Math.max(0, x0 * C - pad), y0: Math.max(0, y0 * C - pad), x1: Math.min(a.w, (x1 + 1) * C + pad), y1: Math.min(a.h, (y1 + 1) * C + pad) });
  }
  // merge boxes that overlap or nearly touch: a patch edge running through a letter shows as a hairline seam in some viewers
  const G = 40;
  for (let changed = true; changed; ) {
    changed = false;
    for (let i = 0; i < out.length && !changed; i++) for (let j = i + 1; j < out.length; j++) {
      const p = out[i], q = out[j];
      if (p.x0 <= q.x1 + G && q.x0 <= p.x1 + G && p.y0 <= q.y1 + G && q.y0 <= p.y1 + G) {
        out[i] = { x0: Math.min(p.x0, q.x0), y0: Math.min(p.y0, q.y0), x1: Math.max(p.x1, q.x1), y1: Math.max(p.y1, q.y1) };
        out.splice(j, 1); changed = true; break;
      }
    }
  }
  return out;
}

function crop(r: Raster, b: { x0: number; y0: number; x1: number; y1: number }): Raster {
  const w = b.x1 - b.x0, h = b.y1 - b.y0, data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) data.set(r.data.subarray(((b.y0 + y) * r.w + b.x0) * 4, ((b.y0 + y) * r.w + b.x1) * 4), y * w * 4);
  return { w, h, data };
}

/**
 * `original` is the untouched page picture (needed in render mode): then only the
 * changed areas are laid over the original page as small pictures, so the rest of
 * a real-text/vector PDF stays exactly as it was (sharp, selectable).
 */
export async function writePdf(original: Uint8Array, img: PageImage, edited: Raster, items: TextItem[], lib: FontLib, codec: Codec, orig?: Raster): Promise<Uint8Array> {
  const doc = await PDFDocument.load(original, { updateMetadata: false });
  doc.registerFontkit(fontkit as any);
  const page = doc.getPage(img.pageIndex);
  if (img.mode === 'swap') {
    // swap in the cleaned picture (lossless), same name, same placement
    const png = await doc.embedPng(await codec.encodePng(edited));
    const xobjs = page.node.Resources()!.lookup(PDFName.of('XObject')) as PDFDict;
    xobjs.set(PDFName.of(img.name), png.ref);
  } else if (orig && orig.w === edited.w && orig.h === edited.h) {
    // patch only what changed, on top of the original page
    const sx = img.ctm[0] / img.w, sy = img.ctm[3] / img.h;
    for (const b of changedBoxes(orig, edited)) {
      const png = await doc.embedPng(await codec.encodePng(crop(edited, b)));
      page.drawImage(png, { x: img.ctm[4] + b.x0 * sx, y: img.ctm[5] + (img.h - b.y1) * sy, width: (b.x1 - b.x0) * sx, height: (b.y1 - b.y0) * sy });
    }
  } else {
    // rebuild the page from the rendered picture (the old drawing is in it)
    const png = await doc.embedPng(await codec.encodePng(edited));
    page.node.set(PDFName.of('Contents'), doc.context.obj([]));
    page.drawImage(png, { x: img.ctm[4], y: img.ctm[5], width: img.ctm[0], height: img.ctm[3] });
  }
  // new words as vector text
  const scale = Math.hypot(img.ctm[2], img.ctm[3]) / img.h; // page pt per image px (vertical)
  const embedded = new Map<string, any>();
  for (const it of items) {
    let f = embedded.get(it.key);
    if (!f) {
      f = await doc.embedFont(await lib.fontBytes(it.key), { subset: true, features: FEATURES } as any);
      embedded.set(it.key, f);
    }
    const [x, y] = toPage(img, it.x, it.baseline);
    const hs = it.hs ?? 1, bold = it.bold ?? 0;
    const col = rgb(it.color[0] / 255, it.color[1] / 255, it.color[2] / 255);
    // Tz scales the spacing too, so the spacing is given before scaling
    page.pushOperators(pushGraphicsState(), setCharacterSpacing((it.tracking * scale) / hs), setCharacterSqueeze(hs * 100));
    if (bold > 0) page.pushOperators(setTextRenderingMode(TextRenderingMode.FillAndOutline), setLineWidth(bold * scale), setLineJoin(LineJoinStyle.Round), setStrokingRgbColor(col.red, col.green, col.blue));
    page.drawText(it.text, { x, y, size: it.size * scale, font: f, color: col });
    page.pushOperators(popGraphicsState());
  }
  doc.setProducer('PDF-ändraren');
  return doc.save({ useObjectStreams: false });
}

/** Open a PNG/JPG file as the page picture. */
export async function readImage(bytes: Uint8Array, mime: string, codec: Codec): Promise<{ image: PageImage; raster: Raster }> {
  let raster: Raster & { rgba?: Uint8ClampedArray };
  try { raster = await codec.decodeImage(bytes, mime); }
  catch { throw new Error('Bilden gick inte att öppna. Spara den som PNG eller JPG igen och försök på nytt.'); }
  if (raster.w * raster.h > 40e6) throw new Error('Bilden är för stor (över 40 megapixel). Spara en mindre version och försök igen.');
  const png = /png/i.test(mime);
  const rgba = png ? raster.rgba : undefined;
  return { image: { mode: 'image', format: png ? 'png' : 'jpeg', pageIndex: 0, pageCount: 1, name: '', w: raster.w, h: raster.h, ctm: [raster.w, 0, 0, raster.h, 0, 0], pageW: raster.w, pageH: raster.h, ...(rgba ? { rgba } : {}) }, raster: { w: raster.w, h: raster.h, data: raster.data } };
}

/** Save an edited picture file: the new text drawn into the picture itself. */
export async function writeImage(img: PageImage, edited: Raster, items: TextItem[], lib: FontLib, codec: Codec, render: (a: { raster: Raster; items: TextItem[] }) => Promise<Raster>): Promise<Uint8Array> {
  const full = items.length ? await render({ raster: edited, items }) : edited;
  if (img.format === 'png' && img.rgba) return codec.encodePng(restoreAlpha(full, img.rgba), true);
  return img.format === 'png' ? codec.encodePng(full) : codec.encodeJpeg(full, 0.95);
}

/** Composite RGBA pixels over white (how the engine sees a transparent picture). */
export function flattenOnWhite(rgba: Uint8ClampedArray): Uint8ClampedArray {
  const out = new Uint8ClampedArray(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3];
    out[i] = (rgba[i] * a + 255 * (255 - a)) / 255;
    out[i + 1] = (rgba[i + 1] * a + 255 * (255 - a)) / 255;
    out[i + 2] = (rgba[i + 2] * a + 255 * (255 - a)) / 255;
    out[i + 3] = 255;
  }
  return out;
}

/** Give an edited transparent PNG its transparency back. Untouched pixels are the
 * original ones. Each changed patch looks at the untouched pixels right around it:
 * on a solid surface (e.g. text in a coloured box) it stays solid; on a see-through
 * surface the white the engine edited on becomes see-through again and the ink keeps
 * its colour with matching coverage. */
export function restoreAlpha(full: Raster, rgba: Uint8ClampedArray): Raster {
  const { w, h } = full, n = w * h;
  const flat = flattenOnWhite(rgba);
  const d = full.data;
  const changed = new Uint8Array(n);
  for (let p = 0, i = 0; p < n; p++, i += 4)
    if (Math.abs(d[i] - flat[i]) > 3 || Math.abs(d[i + 1] - flat[i + 1]) > 3 || Math.abs(d[i + 2] - flat[i + 2]) > 3) changed[p] = 1;
  // grow the changed pixels a little so the bits of one edit form one patch
  const R = 2, grown = new Uint8Array(n), rowG = new Uint8Array(n);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let m = 0; for (let k = Math.max(0, x - R); k <= Math.min(w - 1, x + R) && !m; k++) m = changed[y * w + k];
    rowG[y * w + x] = m;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let m = 0; for (let k = Math.max(0, y - R); k <= Math.min(h - 1, y + R) && !m; k++) m = rowG[k * w + x];
    grown[y * w + x] = m;
  }
  // patches and the surface just outside each one
  const label = new Int32Array(n).fill(-1), solid: boolean[] = [];
  const stack = new Int32Array(n);
  for (let s0 = 0; s0 < n; s0++) {
    if (!grown[s0] || label[s0] >= 0) continue;
    const id = solid.length; let top = 0, see = 0, opaque = 0;
    stack[top++] = s0; label[s0] = id;
    while (top) {
      const p = stack[--top], x = p % w, y = (p - x) / w;
      const nb = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1];
      for (const q of nb) {
        if (q < 0) continue;
        if (grown[q]) { if (label[q] < 0) { label[q] = id; stack[top++] = q; } }
        else if (rgba[q * 4 + 3] < 128) see++; else opaque++;
      }
    }
    solid.push(opaque >= see);
  }
  // ink colour of each see-through patch: its darkest changed pixel
  const inkAt = new Int32Array(solid.length).fill(-1), inkD = new Int16Array(solid.length);
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    if (!changed[p]) continue;
    const id = label[p], D = Math.max(255 - d[i], 255 - d[i + 1], 255 - d[i + 2]);
    if (D > inkD[id]) { inkD[id] = D; inkAt[id] = i; }
  }
  const out = new Uint8ClampedArray(rgba.length);
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    if (!changed[p]) { out[i] = rgba[i]; out[i + 1] = rgba[i + 1]; out[i + 2] = rgba[i + 2]; out[i + 3] = rgba[i + 3]; continue; }
    if (solid[label[p]]) { out[i] = d[i]; out[i + 1] = d[i + 1]; out[i + 2] = d[i + 2]; out[i + 3] = 255; continue; }
    const id = label[p], K = inkAt[id], DK = inkD[id];
    const A = Math.max(255 - d[i], 255 - d[i + 1], 255 - d[i + 2]);
    if (A <= 2 || DK <= 2) continue; // white on a see-through part: stays see-through
    // the pixel is ink K laid over white with some coverage: keep K, coverage = how far from white
    out[i] = d[K]; out[i + 1] = d[K + 1]; out[i + 2] = d[K + 2];
    out[i + 3] = Math.min(255, Math.round((A * 255) / DK));
  }
  return { w, h, data: out };
}
