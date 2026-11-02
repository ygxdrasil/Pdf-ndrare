# Builds vendor/cmyk-lut.json: how Acrobat/Chrome (pdfium) turn DeviceCMYK into RGB, on a 9-step grid.
# pdf.js uses a different formula, so without this our render and the viewer disagree on CMYK colours.
import io, json, itertools, numpy as np, pypdfium2 as pdfium
from reportlab.pdfgen import canvas
N = 9; P = 4; side = N * N
steps = [i / (N - 1) for i in range(N)]
buf = io.BytesIO(); c = canvas.Canvas(buf, pagesize=(side * P, side * P))
cells = list(itertools.product(range(N), repeat=4))
for idx, (ci, mi, yi, ki) in enumerate(cells):
    col, row = idx % side, idx // side
    c.setFillColorCMYK(steps[ci], steps[mi], steps[yi], steps[ki]); c.rect(col * P, (side - 1 - row) * P, P, P, stroke=0, fill=1)
c.save()
img = np.asarray(pdfium.PdfDocument(buf.getvalue())[0].render(scale=2).to_pil().convert('RGB'))
out = []
for idx in range(len(cells)):
    col, row = idx % side, idx // side
    out.extend(int(v) for v in img[row * P * 2 + P, col * P * 2 + P])
json.dump({'n': N, 'rgb': out}, open('vendor/cmyk-lut.json', 'w'), separators=(',', ':'))
print('k=1 ->', out[(N**4 - 1 - (N**3 - 1)) * 3 - 0: (N**4 - (N**3 - 1)) * 3], 'white', out[:3], 'C=1', out[(N-1)*N**3*3:(N-1)*N**3*3+3])
