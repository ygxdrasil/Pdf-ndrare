import type { OcrLine } from './edit';
import type { Box } from './raster';

const area = (b: Box) => Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);
const overlap = (a: Box, b: Box) => area({ x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) });

/** OCR often reads the small superscript in units (m², cm²) as "?": "8,6 m?" -> "8,6 m²". Only after a number. */
const UNIT_Q = /(\d\s*)((?:[cdkm]?)m)\?(?![\p{L}\p{N}])/gu;
const fixUnits = (t: string) => t.replace(UNIT_Q, '$1$2²');

/** "50m²" read as one word -> "50" + "m²" (own boxes), so a number and its unit can be changed separately. */
const NUM_UNIT = /^(\d[\d.,]*)((?:[cdkm]?)m²)$/u;
function splitUnitWords(l: OcrLine) {
  if (!l.words?.some((w) => NUM_UNIT.test(w.text))) return;
  const words: NonNullable<OcrLine['words']> = [];
  for (const w of l.words) {
    const m = NUM_UNIT.exec(w.text);
    if (!m) { words.push(w); continue; }
    // widths in "characters": digits 1 each, unit letters 1 each, the superscript about half
    const nw = m[1].length, uw = m[2].length - 0.5, x = w.box.x0 + ((w.box.x1 - w.box.x0) * nw) / (nw + uw);
    words.push({ text: m[1], box: { ...w.box, x1: x - 1 } }, { text: m[2], box: { ...w.box, x0: x } });
  }
  l.words = words;
  l.text = l.text.replace(/(\d)((?:[cdkm]?)m²)/gu, '$1 $2');
}

/** Merge OCR passes (normal + inverted). Keeps the first pass's line where both found one. */
export function mergeOcr(...passes: OcrLine[][]): OcrLine[] {
  const out: OcrLine[] = [];
  for (const pass of passes)
    for (const l of pass) {
      // junk filter: mostly symbols
      const letters = (l.text.match(/[\p{L}\p{N}]/gu) ?? []).length;
      if (letters < 2 || letters < l.text.replace(/\s/g, '').length * 0.5) continue;
      // a few characters spread over a huge box: lines and arrows of a drawing read as letters. It would
      // sit on top of the real text next to it and hide it.
      if (!l.rot && letters <= 4 && (l.box.x1 - l.box.x0) / letters > 1.3 * Math.max(1, l.box.y1 - l.box.y0)) continue;
      if (UNIT_Q.test(l.text)) { UNIT_Q.lastIndex = 0; l.text = fixUnits(l.text); for (const w of l.words ?? []) w.text = fixUnits(w.text); }
      UNIT_Q.lastIndex = 0;
      splitUnitWords(l);
      if (l.rot) {
        // a vertical line read upright comes out as short junk: the vertical reading wins over such
        // fragments, but never over horizontal text of 4 characters or more
        const over = out.flatMap((o, i) => (overlap(o.box, l.box) > 0.3 * Math.min(area(o.box), area(l.box)) ? [i] : []));
        const nn = (t: string) => (t.match(/[\p{L}\p{N}]/gu) ?? []).length;
        // with the engine's own confidence: the vertical reading must be clearly surer than what it covers
        const sure = (i: number) => l.conf != null && out[i].conf != null ? l.conf >= out[i].conf! + 10 : nn(out[i].text) <= 3;
        if (over.some((i) => out[i].rot || !sure(i))) continue;
        for (const i of over.reverse()) out.splice(i, 1);
        out.push(l);
        continue;
      }
      const hits = out.flatMap((o, i) => (overlap(o.box, l.box) > 0.4 * Math.min(area(o.box), area(l.box)) ? [i] : []));
      if (hits.length) {
        // the same spot read twice: keep the first. Only when everything it covers is a tiny
        // fragment ("By") and the new reading is the whole line, replace them with it.
        const n = (t: string) => (t.match(/[\p{L}\p{N}]/gu) ?? []).length;
        if (hits.every((i) => n(out[i].text) <= 3) && n(l.text) >= Math.max(...hits.map((i) => n(out[i].text))) + 4) {
          out[hits[0]] = l;
          for (const i of hits.slice(1).reverse()) out.splice(i, 1);
        }
        continue;
      }
      out.push(l);
    }
  out.sort((a, b) => a.box.y0 - b.box.y0 || a.box.x0 - b.box.x0);
  out.forEach((l, i) => (l.id = i));
  return out;
}
