import type { OcrLine } from './edit';
import type { Box } from './raster';

const area = (b: Box) => Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);
const overlap = (a: Box, b: Box) => area({ x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) });

/** Merge OCR passes (normal + inverted). Keeps the first pass's line where both found one. */
export function mergeOcr(...passes: OcrLine[][]): OcrLine[] {
  const out: OcrLine[] = [];
  for (const pass of passes)
    for (const l of pass) {
      // junk filter: mostly symbols
      const letters = (l.text.match(/[\p{L}\p{N}]/gu) ?? []).length;
      if (letters < 2 || letters < l.text.replace(/\s/g, '').length * 0.5) continue;
      if (out.some((o) => overlap(o.box, l.box) > 0.4 * Math.min(area(o.box), area(l.box)))) continue;
      out.push(l);
    }
  out.sort((a, b) => a.box.y0 - b.box.y0 || a.box.x0 - b.box.x0);
  out.forEach((l, i) => (l.id = i));
  return out;
}
