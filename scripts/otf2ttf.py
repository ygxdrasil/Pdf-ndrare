# Convert CFF (.otf) fonts to TrueType outlines: pdf-lib can only subset TrueType reliably.
# python3 scripts/otf2ttf.py in.otf out.ttf
import sys
from fontTools.ttLib import TTFont, newTable
from fontTools.pens.cu2quPen import Cu2QuPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
src, dst = sys.argv[1:3]
f = TTFont(src)
gs = f.getGlyphSet(); order = f.getGlyphOrder()
glyf = newTable('glyf'); glyf.glyphOrder = order; glyf.glyphs = {}
for n in order:
    pen = TTGlyphPen(gs)
    gs[n].draw(Cu2QuPen(pen, 1.0, reverse_direction=True))
    glyf.glyphs[n] = pen.glyph()
glyf.padding = 4  # fontkit (pdf-lib) needs aligned glyph data when subsetting
f['glyf'] = glyf; f['loca'] = newTable('loca')
f['maxp'] = newTable('maxp'); m = f['maxp']
m.tableVersion = 0x00010000; m.maxZones = 1; m.maxTwilightPoints = m.maxStorage = m.maxFunctionDefs = m.maxInstructionDefs = m.maxStackElements = m.maxSizeOfInstructions = 0
for k in ('maxPoints', 'maxContours', 'maxCompositePoints', 'maxCompositeContours', 'maxComponentElements', 'maxComponentDepth'): setattr(m, k, 0)
f['head'].indexToLocFormat = 0; f['head'].glyphDataFormat = 0
f['post'].formatType = 2.0; f['post'].extraNames = []; f['post'].mapping = {}
f['post'].glyphOrder = order
del f['CFF ']
if 'VORG' in f: del f['VORG']
f.sfntVersion = '\x00\x01\x00\x00'
f.save(dst)
print('ok', dst)
