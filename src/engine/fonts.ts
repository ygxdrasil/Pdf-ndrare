// Font library: open-licence fonts, laid out with fontkit so the preview,
// the matching and the PDF all use exactly the same glyph shapes and widths.

import fontkit from '@pdf-lib/fontkit';

/** Same features as the PDF writer (pdf-lib), so widths match exactly. */
export const FEATURES: any = { kern: false };

export interface FontEntry {
  key: string;
  family: string;
  weight: number;
  style: 'sans' | 'serif' | 'script';
  file: string;
}

export interface CanvasLike {
  width: number;
  height: number;
  getContext(t: '2d'): any;
}

export interface Platform {
  createCanvas(w: number, h: number): CanvasLike;
  loadFile(path: string): Promise<Uint8Array>; // path relative to the fonts folder
}

export interface LaidGlyph {
  path: any;
  x: number; // in font units, pen position
  y: number;
}

export class FontLib {
  entries: FontEntry[] = [];
  private fonts = new Map<string, any>();
  private bytes = new Map<string, Uint8Array>();
  constructor(public platform: Platform) {}

  async init() {
    const m = JSON.parse(new TextDecoder().decode(await this.platform.loadFile('manifest.json')));
    this.entries = m.map((e: any) => ({ key: e.key, family: e.family, weight: e.weight, style: e.style, file: e.file }));
  }

  entry(key: string): FontEntry {
    const e = this.entries.find((x) => x.key === key);
    if (!e) throw new Error(`Okänt typsnitt: ${key}`);
    return e;
  }

  find(family: string, weight: number): FontEntry | undefined {
    const fam = this.entries.filter((e) => e.family.toLowerCase() === family.toLowerCase());
    if (!fam.length) return undefined;
    return fam.reduce((a, b) => (Math.abs(b.weight - weight) < Math.abs(a.weight - weight) ? b : a));
  }

  async load(key: string): Promise<any> {
    let f = this.fonts.get(key);
    if (f) return f;
    const b = await this.fontBytes(key);
    f = fontkit.create(b as any);
    this.fonts.set(key, f);
    return f;
  }

  async fontBytes(key: string): Promise<Uint8Array> {
    let b = this.bytes.get(key);
    if (!b) {
      b = await this.platform.loadFile(this.entry(key).file);
      this.bytes.set(key, b);
    }
    return b;
  }
}

/** Width of a string in px at `size` px, with extra `tracking` px between glyphs. */
export function textWidth(font: any, text: string, size: number, tracking = 0): number {
  const run = font.layout(text, FEATURES);
  let w = 0;
  for (const p of run.positions) w += p.xAdvance;
  const n = run.glyphs.length;
  return (w / font.unitsPerEm) * size + tracking * Math.max(0, n - 1);
}

/** Missing glyphs (characters the font cannot draw). */
export function missingChars(font: any, text: string): string[] {
  const out = new Set<string>();
  for (const ch of text) {
    if (/\s/.test(ch)) continue;
    if (!font.hasGlyphForCodePoint(ch.codePointAt(0)!)) out.add(ch);
  }
  return [...out];
}

/**
 * Draw `text` with its pen starting at (x, baseline) in canvas pixels.
 * Returns the advance width.
 */
/** `hs` = horizontal scale of the letters (like Illustrator's horizontal scale); tracking is final px.
 * `bold` = extra outline width in px (synthetic emboldening, for fonts lacking the in-between weight). */
export function drawText(ctx: any, font: any, text: string, x: number, baseline: number, size: number, tracking = 0, color = '#000', hs = 1, bold = 0, slant = 0): number {
  const run = font.layout(text, FEATURES);
  const s = size / font.unitsPerEm, sx = s * hs;
  let pen = 0;
  ctx.fillStyle = color;
  ctx.beginPath();
  run.glyphs.forEach((g: any, i: number) => {
    const pos = run.positions[i];
    const ox = x + (pen + pos.xOffset) * sx + tracking * i;
    const oy = baseline - pos.yOffset * s;
    for (const c of g.path.commands) {
      const a = c.args;
      switch (c.command) {
        case 'moveTo': ctx.moveTo(ox + a[0] * sx + slant * a[1] * s, oy - a[1] * s); break;
        case 'lineTo': ctx.lineTo(ox + a[0] * sx + slant * a[1] * s, oy - a[1] * s); break;
        case 'quadraticCurveTo': ctx.quadraticCurveTo(ox + a[0] * sx + slant * a[1] * s, oy - a[1] * s, ox + a[2] * sx + slant * a[3] * s, oy - a[3] * s); break;
        case 'bezierCurveTo': ctx.bezierCurveTo(ox + a[0] * sx + slant * a[1] * s, oy - a[1] * s, ox + a[2] * sx + slant * a[3] * s, oy - a[3] * s, ox + a[4] * sx + slant * a[5] * s, oy - a[5] * s); break;
        case 'closePath': ctx.closePath(); break;
      }
    }
    pen += pos.xAdvance;
  });
  ctx.fill();
  if (bold > 0) { ctx.lineWidth = bold; ctx.lineJoin = 'round'; ctx.strokeStyle = color; ctx.stroke(); }
  return pen * sx + tracking * Math.max(0, run.glyphs.length - 1);
}
