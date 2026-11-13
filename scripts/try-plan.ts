// Engine test as the app uses it: the plan gives `old` (as printed) and `new`; `find` only locates the OCR line.
// npx tsx scripts/try-plan.ts <in.png|in.pdf> <out.png|out.pdf> '<json: [{find, old, new, align?, style?}]>'
import { readFile, writeFile } from 'node:fs/promises';
import { readImage, readPage, writeImage, writePdf } from '../src/engine/pdf';
import { Edit, OcrLine } from '../src/engine/edit';
import { applyEditsRot } from '../src/engine/rotate';
import { renderPreview } from '../src/engine/agent';
import { selfCheck } from '../src/engine/selfcheck';
import { codec, makeLib } from './node-platform';
import { ocrRaster, closeOcr } from './ocr-node';
const [f, out, spec] = process.argv.slice(2);
const bytes = new Uint8Array(await readFile(f));
const isPdf = /\.pdf$/i.test(f);
const { image, raster } = isPdf ? await readPage(bytes, codec, +(process.env.PAGE ?? 0)) : await readImage(bytes, 'image/png', codec);
let ocr: OcrLine[] | null = null;
const cacheF = process.env.OCRCACHE ? process.env.OCRCACHE + '/' + (process.env.OCRNAME ?? f.split('/').pop()) + (+(process.env.PAGE ?? 0) ? '.p' + process.env.PAGE : '') + '.json' : '';
try { if (cacheF) ocr = JSON.parse(await readFile(cacheF, 'utf8')); } catch { /* not cached yet */ }
if (!ocr) { ocr = await ocrRaster(raster); await closeOcr(); if (cacheF) await writeFile(cacheF, JSON.stringify(ocr)); }
const OCR: OcrLine[] = ocr;
if (process.env.SHRINK) for (const l of OCR) { const w = l.words; if (w && w.length >= 2) { const b = w[w.length - 1].box; b.x0 += (b.x1 - b.x0) * +process.env.SHRINK; } } // test: word boxes that miss part of the letters
console.log('OCR:', OCR.map((o) => `${o.id}:${o.rot ? '↻' : ''}${o.text}`).join(' | '));
const lib = await makeLib();
const edits: Edit[] = [];
for (const e of JSON.parse(spec)) {
  if (e.sub) { // regex substitution on every OCR line it matches: sub = [pattern, replacement]; '$UPPER' / '$CM2' / '$MM2' are special
    const re = new RegExp(e.sub[0], 'g'); let n = 0;
    const fmt = (v: number) => String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    const rep = (m: string, ...g: any[]): string => e.sub[1] === '$UPPER' ? m.toUpperCase() : e.sub[1] === '$CM2' ? fmt(parseFloat(g[0].replace(/\s/g, '').replace(',', '.')) * 10000) + ' cm²' : e.sub[1] === '$MM2' ? fmt(parseFloat(g[0].replace(/\s/g, '').replace(',', '.')) * 1000000) + ' mm²' : m.replace(new RegExp(e.sub[0]), e.sub[1]);
    for (const x of OCR) {
      re.lastIndex = 0; if (!re.test(x.text)) continue; re.lastIndex = 0;
      let old = x.text; for (const [a, b] of e.fixold ?? []) old = old.replace(new RegExp(a, 'g'), b);
      const nt = old.replace(re, rep as any);
      if (nt !== old || e.force) { edits.push({ kind: 'text', lines: [x.id], old: [old], new: nt, align: e.align, style: e.style, group: e.group, weight: e.weight }); n++; }
    }
    console.log('SUB', e.sub[0], '->', n, 'lines'); continue;
  }
  if (e.swap) { // swap two labels (name + the area line right below each): text swap, centred
    const [A, B] = e.swap;
    const nameOf = (t: string) => OCR.find((o: OcrLine) => o.text.trim() === t);
    const a = nameOf(A), b = nameOf(B);
    if (!a || !b) { console.log('NOT FOUND swap', A, B); continue; }
    const below = (l: OcrLine) => OCR.filter((o: OcrLine) => /m[²2?]/.test(o.text) && o.box.y0 >= l.box.y1 - 4 && o.box.y0 - l.box.y1 < 90 && Math.abs((o.box.x0 + o.box.x1) / 2 - (l.box.x0 + l.box.x1) / 2) < 120).sort((p, q) => p.box.y0 - q.box.y0)[0];
    const pairs: [OcrLine, string][] = [[a, B], [b, A]];
    const ar = [below(a), below(b)];
    for (const [l, t] of pairs) edits.push({ kind: 'text', lines: [l.id], old: [l.text.trim()], new: t, align: 'center', style: 'sans', group: 'rum' });
    if (ar[0] && ar[1]) { edits.push({ kind: 'text', lines: [ar[0]!.id], old: [ar[0]!.text.trim()], new: ar[1]!.text.trim(), align: 'center', style: 'sans', group: 'yta' }); edits.push({ kind: 'text', lines: [ar[1]!.id], old: [ar[1]!.text.trim()], new: ar[0]!.text.trim(), align: 'center', style: 'sans', group: 'yta' }); }
    continue;
  }
  if (e.finds) { // a paragraph over several OCR lines: finds = start of each line, old = the lines' text
    const ids = e.finds.map((f: string) => OCR.find((o: OcrLine) => o.text.includes(f))?.id);
    if (ids.some((x: any) => x === undefined)) { console.log('NOT FOUND', e.finds.join(' / ')); continue; }
    edits.push({ kind: 'text', lines: ids, old: e.old, new: e.new, align: e.align, style: e.style, group: e.group, weight: e.weight }); continue;
  }
  const h = e.box ? [] : OCR.filter((o: OcrLine) => (e.id !== undefined ? o.id === e.id : e.exact ? o.text.trim() === e.find : o.text.includes(e.find)));
  if (!h.length && !e.box) { console.log('NOT FOUND', e.find); continue; }
  if (e.box) { const k = e.refW ? raster.w / e.refW : 1; /* box given for a picture e.refW wide */ const bx = { x0: e.box.x0 * k, y0: e.box.y0 * k, x1: e.box.x1 * k, y1: e.box.y1 * k }; edits.push({ kind: 'text', lines: [], boxes: [bx], old: [e.old], new: e.new, align: e.align, style: e.style, group: e.group, weight: e.weight }); continue; }
  for (const x of h) edits.push({ kind: 'text', lines: [x.id], old: [e.old ?? x.text], new: e.new, align: e.align, style: e.style, group: e.group, weight: e.weight });
}
const vectorOnly = image.mode === 'render' && (image.ppi ?? 300) < 200;
console.log('mode', image.mode, 'ppi', image.ppi, 'vectorOnly', vectorOnly);
const res = await applyEditsRot(raster, OCR, edits, lib, undefined, { vectorOnly });
if (process.env.STRAY) for (let y = 40; y < 90; y++) for (let x = 40; x < 90; x++) { const i = (y * res.raster.w + x) * 4; res.raster.data[i] = 255; res.raster.data[i + 1] = 255; res.raster.data[i + 2] = 255; } // test: damage outside every edit
console.log('SELFCHECK', JSON.stringify(selfCheck(raster, res, edits, OCR)));
for (const r of res.reports) console.log(r.index, r.mode, r.font, JSON.stringify((edits[r.index] as any).new), r.warnings.join(' '));
if (process.env.DUMPS) await writeFile(process.env.DUMPS, await codec.encodePng(raster));
if (process.env.DUMPR) await writeFile(process.env.DUMPR, await codec.encodePng(res.raster)); // debug: the engine's own picture
const outBytes = isPdf
  ? await writePdf(bytes, image, res.raster, res.items, lib, codec, raster)
  : await writeImage(image, res.raster, res.items, lib, codec, (a) => renderPreview({ lib }, a as any, image.w, image.h));
await writeFile(out, outBytes);
