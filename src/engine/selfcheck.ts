// Automatic checks on a finished result (no AI needed): things the engine can see for itself.
import type { Box, Raster } from './raster';
import type { Applied, Edit } from './edit';

const pct = (v: number, of: number) => Math.round((v / of) * 100);

/**
 * 1. Stray changes: picture areas that differ from the original although no edit touched them
 *    (a leftover patch, a seam, a shifted neighbour).
 * 2. Weak spots: edits whose typeface fit was poor, so the new text may look different.
 * Returns short Swedish notes for the user.
 */
export function selfCheck(orig: Raster, applied: Applied, edits: Edit[]): string[] {
  const notes: string[] = [];
  const pad = 24;
  const zones: Box[] = applied.reports.map((r) => ({ x0: r.box.x0 - pad, y0: r.box.y0 - pad, x1: r.box.x1 + pad, y1: r.box.y1 + pad }));
  const inZone = (x: number, y: number) => zones.some((z) => x >= z.x0 && x <= z.x1 && y >= z.y0 && y <= z.y1);
  if (orig.w === applied.raster.w && orig.h === applied.raster.h) {
    // 8 px cells that visibly differ from the original and lie outside every edit's area
    const C = 8, gw = Math.ceil(orig.w / C), gh = Math.ceil(orig.h / C);
    const bad = new Uint8Array(gw * gh);
    const a = orig.data, b = applied.raster.data;
    for (let y = 0; y < orig.h; y++) for (let x = 0; x < orig.w; x++) {
      const i = (y * orig.w + x) * 4;
      if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 36) {
        const cx = (x / C) | 0, cy = (y / C) | 0;
        if (!bad[cy * gw + cx] && !inZone(cx * C + C / 2, cy * C + C / 2)) bad[cy * gw + cx] = 1;
      }
    }
    const seen = new Uint8Array(gw * gh);
    for (let k = 0; k < bad.length; k++) {
      if (!bad[k] || seen[k]) continue;
      const st = [k]; seen[k] = 1; let n = 0, sx = 0, sy = 0;
      while (st.length) {
        const q = st.pop()!, cx = q % gw, cy = (q / gw) | 0; n++; sx += cx; sy += cy;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx, ny = cy + dy, m = ny * gw + nx;
          if (nx >= 0 && ny >= 0 && nx < gw && ny < gh && bad[m] && !seen[m]) { seen[m] = 1; st.push(m); }
        }
      }
      if (n >= 3) notes.push(`Att titta på: Något har ändrats på ett ställe där inget skulle ändras (ungefär ${pct((sx / n) * C, orig.w)} % från vänster, ${pct((sy / n) * C, orig.h)} % uppifrån).`);
    }
  }
  for (const r of applied.reports) {
    const e = edits[r.index];
    if (!e || e.kind !== 'text' || !r.match || /^same/.test(r.mode ?? '')) continue;
    const snippet = e.new.replace(/\s+/g, ' ').trim().slice(0, 40);
    if (r.match.score < 0.5) notes.push(`Att titta på: "${snippet}" – typsnittet passar bara ungefär, så texten kan se lite annorlunda ut än resten.`);
    if ((r.shrunk ?? 1) < 0.8) notes.push(`Att titta på: "${snippet}" fick krympas ganska mycket (${Math.round((r.shrunk ?? 1) * 100)} %) för att få plats.`);
  }
  return notes;
}
