// Browser versions of the engine's platform hooks: canvas, fonts, image
// coding, OCR and the call to Claude (through our own server route).

import { createWorker } from 'tesseract.js';
import { FontLib, Platform } from '../engine/fonts';
import { flattenOnWhite, type Codec } from '../engine/pdf';
import type { Box, Raster } from '../engine/raster';
import type { OcrLine } from '../engine/edit';
import { mergeOcr } from '../engine/ocr-merge';
import { ocrRotated } from '../engine/rotate';

export const platform: Platform = {
  createCanvas: (w, h) => {
    const c = document.createElement('canvas');
    c.width = Math.max(1, w); c.height = Math.max(1, h);
    return c as any;
  },
  loadFile: async (p) => {
    const r = await fetch(`fonts/${p}`);
    if (!r.ok) throw new Error(`Kunde inte ladda ${p}`);
    return new Uint8Array(await r.arrayBuffer());
  },
};

export function rasterToCanvas(r: Raster, box?: Box, keepAlpha = false): HTMLCanvasElement {
  const b = box ?? { x0: 0, y0: 0, x1: r.w, y1: r.h };
  const w = Math.max(1, Math.round(b.x1 - b.x0)), h = Math.max(1, Math.round(b.y1 - b.y0));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d')!;
  const id = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    const sy = Math.round(b.y0) + y;
    if (sy < 0 || sy >= r.h) continue;
    for (let x = 0; x < w; x++) {
      const sx = Math.round(b.x0) + x;
      if (sx < 0 || sx >= r.w) continue;
      const i = (sy * r.w + sx) * 4, j = (y * w + x) * 4;
      id.data[j] = r.data[i]; id.data[j + 1] = r.data[i + 1]; id.data[j + 2] = r.data[i + 2]; id.data[j + 3] = keepAlpha ? r.data[i + 3] : 255;
    }
  }
  ctx.putImageData(id, 0, 0);
  return c;
}

function blobOf(c: HTMLCanvasElement, type: string, q?: number): Promise<Blob> {
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Kunde inte skapa bilden.'))), type, q));
}

export const codec: Codec = {
  async decodeJpeg(bytes) {
    const bmp = await createImageBitmap(new Blob([bytes as BlobPart], { type: 'image/jpeg' }), { colorSpaceConversion: 'none' } as any);
    const c = document.createElement('canvas');
    c.width = bmp.width; c.height = bmp.height;
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(bmp, 0, 0);
    const d = ctx.getImageData(0, 0, bmp.width, bmp.height);
    return { w: bmp.width, h: bmp.height, data: new Uint8ClampedArray(d.data) };
  },
  async renderPage(bytes, pageIndex, scale) {
    const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs/pdf.worker.min.mjs', location.href).href;
    const task = pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, verbosity: 0 });
    const doc = await task.promise;
    try {
      const page = await doc.getPage(pageIndex + 1);
      const vp = page.getViewport({ scale, rotation: 0 });
      const c = document.createElement('canvas');
      c.width = Math.round(vp.width); c.height = Math.round(vp.height);
      const g = c.getContext('2d', { willReadFrequently: true })!;
      g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: g, canvas: c, viewport: vp }).promise;
      const d = g.getImageData(0, 0, c.width, c.height);
      return { w: c.width, h: c.height, data: new Uint8ClampedArray(d.data) };
    } finally { await task.destroy(); }
  },
  async decodeImage(bytes, mime) {
    const bmp = await createImageBitmap(new Blob([bytes as BlobPart], { type: mime }), { colorSpaceConversion: 'none' } as any);
    const c = document.createElement('canvas');
    c.width = bmp.width; c.height = bmp.height;
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(bmp, 0, 0);
    const d = ctx.getImageData(0, 0, bmp.width, bmp.height);
    let see = false;
    for (let i = 3; i < d.data.length; i += 4) if (d.data[i] < 255) { see = true; break; }
    if (!see) return { w: bmp.width, h: bmp.height, data: new Uint8ClampedArray(d.data) };
    // transparent parts become white for the engine; the original pixels are kept for saving
    const rgba = new Uint8ClampedArray(d.data);
    return { w: bmp.width, h: bmp.height, data: flattenOnWhite(rgba), rgba };
  },
  async encodeJpeg(r, quality = 0.95) {
    return new Uint8Array(await (await blobOf(rasterToCanvas(r), 'image/jpeg', quality)).arrayBuffer());
  },
  async encodePng(r, keepAlpha) {
    return new Uint8Array(await (await blobOf(rasterToCanvas(r, undefined, keepAlpha), 'image/png')).arrayBuffer());
  },
};

/** JPEG (base64) of part of a raster, scaled, for Claude. */
export async function encodeForClaude(r: Raster, box?: Box, scale = 1) {
  let c = rasterToCanvas(r, box);
  const s = Math.min(scale, 1568 / Math.max(c.width, c.height));
  if (Math.abs(s - 1) > 0.01) {
    const d = document.createElement('canvas');
    d.width = Math.round(c.width * s); d.height = Math.round(c.height * s);
    const g = d.getContext('2d')!;
    g.imageSmoothingQuality = 'high';
    g.drawImage(c, 0, 0, d.width, d.height);
    c = d;
  }
  const b = await blobOf(c, 'image/jpeg', 0.92);
  const buf = new Uint8Array(await b.arrayBuffer());
  let s2 = '';
  for (let i = 0; i < buf.length; i += 0x8000) s2 += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return { media_type: 'image/jpeg', data: btoa(s2) };
}

export async function makeLib() {
  const lib = new FontLib(platform);
  await lib.init();
  return lib;
}

// ---------- Claude ----------
// Two ways to reach Claude: our own server route (deployed app, API key on the
// server), or – when the page runs as a Claude artifact – the viewer's own
// Claude account through the artifact runtime.
let sampleFn: any = null;
let downloadsCap: any = null;
let maxImages = 5;
export async function initArtifactRuntime(): Promise<boolean> {
  const c = (window as any).claude;
  if (!c?.use) return false;
  try { sampleFn = await c.use('sample'); } catch { sampleFn = null; }
  try { maxImages = (await sampleFn?.limits())?.images?.maxCount ?? maxImages; } catch { /* keep default */ }
  try { downloadsCap = await c.use('downloads'); } catch { downloadsCap = null; }
  return !!sampleFn;
}
export const inArtifact = () => !!sampleFn;

function b64ToBlob(b64: string, type: string): Blob {
  const bin = atob(b64);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return new Blob([u], { type });
}

const SAMPLE_ERRORS: Record<string, string> = {
  not_granted: 'Du behöver tillåta att sidan använder AI:n (rutan som dök upp). Ladda om sidan och välj Tillåt.',
  rate_limited: 'Många förfrågningar på kort tid, eller din Claude-gräns är nådd. Vänta en stund och försök igen.',
  session_expired: 'Du har blivit utloggad från Claude. Logga in igen och ladda om sidan.',
  images_unavailable: 'Den här vyn kan inte skicka bilder till Claude.',
  invalid_json: 'AI:n svarade i fel format. Försök igen.',
  refused: 'AI:n ville inte göra den här ändringen. Formulera om och försök igen.',
};

/** Stack pictures vertically (white gap), scaled to fit ~1.2 MP. */
async function stackImages(list: Blob[]): Promise<Blob> {
  if (list.length === 1) return list[0];
  const bmps = await Promise.all(list.map((b) => createImageBitmap(b)));
  const W = Math.max(...bmps.map((b) => b.width)), gap = 16;
  const H = bmps.reduce((a, b) => a + b.height, 0) + gap * (bmps.length - 1);
  const s = Math.min(1, Math.sqrt(1.2e6 / (W * H)));
  const c = document.createElement('canvas');
  c.width = Math.round(W * s); c.height = Math.round(H * s);
  const g = c.getContext('2d')!;
  g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
  g.imageSmoothingQuality = 'high';
  let y = 0;
  for (const b of bmps) { g.drawImage(b, 0, Math.round(y * s), Math.round(b.width * s), Math.round(b.height * s)); y += b.height + gap; }
  return blobOf(c, 'image/jpeg', 0.9);
}

async function callViaSample(body: any) {
  const parts: string[] = [];
  const images: Blob[] = [];
  if (typeof body.system === 'string') parts.push(body.system);
  for (const m of body.messages ?? []) {
    const content = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;
    for (const c of content) {
      if (c.type === 'text') parts.push(c.text);
      else if (c.type === 'image') { images.push(b64ToBlob(c.source.data, c.source.media_type)); parts.push(`[Picture ${images.length}]`); }
    }
  }
  const tool = body.tools?.[0];
  // The artifact runtime allows only a few pictures per call: stack extras into one tall picture.
  if (images.length > maxImages) {
    const per = Math.ceil(images.length / Math.max(1, maxImages));
    const groups: Blob[][] = [];
    for (let i = 0; i < images.length; i += per) groups.push(images.slice(i, i + per));
    const merged = await Promise.all(groups.map(stackImages));
    for (let k = 0; k < parts.length; k++) parts[k] = parts[k].replace(/^\[Picture (\d+)\]$/, (_, n) => {
      const i = Number(n) - 1, g = Math.floor(i / per), p = i % per;
      return groups[g].length > 1 ? `[Picture ${g + 1}, part ${p + 1} of ${groups[g].length} from the top]` : `[Picture ${g + 1}]`;
    });
    images.splice(0, images.length, ...merged);
  }
  if (images.length) parts.push(`(The ${images.length} picture(s) are attached in this order: Picture 1${images.length > 1 ? ` … Picture ${images.length}` : ''}. Coordinates refer to each picture as attached.)`);
  if (tool) parts.push(`Reply with ONLY one JSON object, no other text, matching this JSON Schema ("${tool.name}"):\n${JSON.stringify(tool.input_schema)}`);
  const hard = String(body.model ?? '').includes('opus');
  // Opus mode: the most capable model plans and checks; the small font pick uses the balanced one.
  const modelTier = hard && tool?.name !== 'pick_fonts' ? 'complex' : 'default';
  try {
    const opts: any = { modelTier, cache: false };
    if (images.length) opts.images = images;
    if (tool) {
      let data: any;
      try { data = await sampleFn.json(parts.join('\n\n'), opts); }
      catch (e: any) {
        // one quiet retry for passing hiccups (not for things the viewer must fix)
        if (['not_granted', 'refused', 'rate_limited', 'session_expired', 'images_unavailable'].includes(e?.code)) throw e;
        data = await sampleFn.json(parts.join('\n\n'), opts);
      }
      return { content: [{ type: 'tool_use', name: tool.name, input: data }], usage: { input_tokens: 0, output_tokens: 0 }, stop_reason: 'end_turn' };
    }
    const r = await sampleFn(parts.join('\n\n'), opts);
    return { content: [{ type: 'text', text: r.text }], usage: { input_tokens: 0, output_tokens: 0 }, stop_reason: r.truncated ? 'max_tokens' : 'end_turn' };
  } catch (e: any) {
    throw new Error(SAMPLE_ERRORS[e?.code] ?? 'Något gick fel hos AI:n. Försök igen.');
  }
}

export async function callClaude(body: any) {
  if (sampleFn) return callViaSample(body);
  const r = await fetch('api/claude', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Något gick fel hos AI:n. Försök igen.');
  return j;
}

/** Save a file for the viewer (a normal download, or the artifact's save dialog). */
export async function saveFile(name: string, bytes: Uint8Array, type: string) {
  if (downloadsCap) {
    await downloadsCap.save({ filename: name, data: new Blob([bytes as BlobPart], { type }) });
    return;
  }
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

// ---------- OCR (runs in the browser; nothing leaves the computer) ----------
let worker: any = null;
async function getWorker() {
  if (!worker) {
    // Small wrapper around the OCR worker: language files are published as
    // *.traineddata.wasm (gzip inside), so rewrite the name it asks for.
    const shim = `const f=self.fetch.bind(self);self.fetch=(u,o)=>f(String(u).replace(/\\.traineddata\\.gz$/,'.traineddata.wasm'),o);importScripts(${JSON.stringify(new URL('tesseract/worker.min.js', location.href).href)});`;
    worker = await createWorker(['swe', 'eng'], 1, {
      workerPath: URL.createObjectURL(new Blob([shim], { type: 'text/javascript' })),
      workerBlobURL: false,
      corePath: new URL('tesseract/core', location.href).href,
      langPath: new URL('tesseract/lang', location.href).href,
      gzip: true,
    } as any);
    await worker.setParameters({ tessedit_pageseg_mode: '11' as any, preserve_interword_spaces: '1' });
  }
  return worker;
}

async function pass(r: Raster, region: Box, invert: boolean, minConf = 30): Promise<OcrLine[]> {
  // small pictures are enlarged for OCR; big (high-resolution) ones are not
  const rw = region.x1 - region.x0, rh = region.y1 - region.y0;
  const small = rw * rh < 0.25 * r.w * r.h; // a close-up: enlarge more, tiny text needs it
  const S = Math.min(small ? 4 : 2, Math.max(1, 3400 / Math.max(rw, rh)));
  const src = rasterToCanvas(r, region);
  if (invert) {
    const ctx = src.getContext('2d')!;
    const d = ctx.getImageData(0, 0, src.width, src.height);
    for (let i = 0; i < d.data.length; i += 4) { d.data[i] = 255 - d.data[i]; d.data[i + 1] = 255 - d.data[i + 1]; d.data[i + 2] = 255 - d.data[i + 2]; }
    ctx.putImageData(d, 0, 0);
  }
  const c = document.createElement('canvas');
  c.width = Math.round(src.width * S); c.height = Math.round(src.height * S);
  const g = c.getContext('2d')!;
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, 0, 0, c.width, c.height);
  const wk = await getWorker();
  const res = await wk.recognize(c, {}, { blocks: true });
  const tb = (b: any): Box => ({ x0: region.x0 + b.x0 / S, y0: region.y0 + b.y0 / S, x1: region.x0 + b.x1 / S, y1: region.y0 + b.y1 / S });
  const lines: OcrLine[] = [];
  for (const b of res.data.blocks ?? []) for (const p of b.paragraphs) for (const l of p.lines) {
    const t = l.text.trim();
    if (!t || l.confidence < minConf) continue;
    lines.push({ id: 0, text: t, box: tb(l.bbox), conf: l.confidence, words: (l.words ?? []).filter((w: any) => w.text.trim()).map((w: any) => ({ text: w.text.trim(), box: tb(w.bbox) })) });
  }
  return lines;
}

export async function ocrPage(r: Raster, onStep?: (s: string) => void): Promise<OcrLine[]> {
  const all = { x0: 0, y0: 0, x1: r.w, y1: r.h };
  onStep?.('Läser texten på sidan (1/2) …');
  const a = await pass(r, all, false);
  onStep?.('Läser texten på sidan (2/2) …');
  const b = await pass(r, all, true);
  // small print is missed on a whole-page pass: read the page again in overlapping tiles, enlarged (a big, high-resolution render already has the detail)
  const t = Math.max(r.w, r.h) > 2600 ? [] : await tilePasses(r, onStep);
  // vertical text (dimension lines): read the page turned each way
  onStep?.('Läser lodrät text …');
  const v = await ocrRotated(r, pass);
  return mergeOcr(a, b, t, v);
}

/** Overlapping tiles (about 1/3 of the longest side), each read enlarged, in two reading modes. At most 12 tiles. */
async function tilePasses(r: Raster, onStep?: (s: string) => void): Promise<OcrLine[]> {
  const side = Math.max(400, Math.ceil(Math.max(r.w, r.h) / 3.2));
  const step = Math.round(side * 0.82);
  const xs: number[] = [], ys: number[] = [];
  for (let x = 0; x < Math.max(1, r.w - side * 0.2); x += step) xs.push(Math.min(x, Math.max(0, r.w - side)));
  for (let y = 0; y < Math.max(1, r.h - side * 0.2); y += step) ys.push(Math.min(y, Math.max(0, r.h - side)));
  const boxes: Box[] = [];
  for (const y of ys) for (const x of xs) if (boxes.length < 12) boxes.push({ x0: x, y0: y, x1: Math.min(r.w, x + side), y1: Math.min(r.h, y + side) });
  const out: OcrLine[] = [];
  const wk = await getWorker();
  let k = 0;
  try {
    // sparse text (11) finds loose labels; block mode (6) finds small lines inside boxes and tables
    for (const mode of ['11', '6']) {
      await wk.setParameters({ tessedit_pageseg_mode: mode as any });
      for (const box of boxes) { onStep?.(`Läser liten text (${++k}/${boxes.length * 2}) …`); out.push(...(await pass(r, box, false, 30))); }
    }
  } finally { await wk.setParameters({ tessedit_pageseg_mode: '11' as any }); }
  return out;
}

export async function ocrRegion(r: Raster, box: Box): Promise<OcrLine[]> {
  return mergeOcr(await pass(r, box, false), await pass(r, box, true));
}
