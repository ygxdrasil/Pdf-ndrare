"""Build the Claude-artifact version: one HTML page (CSS + JS inlined) plus
fonts/ and tesseract/ next to it. Run `npx vite build` first.
Usage: python3 scripts/build-artifact.py <out-dir>"""
import glob, os, re, shutil, sys

# Artifact hosting rejects raw control bytes: write them as \xHH escapes (they only
# occur inside string/regex literals of the bundled libraries).
def esc(js):
    return re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]', lambda m: '\\x%02x' % ord(m.group(0)), js)

out = sys.argv[1]
os.makedirs(out, exist_ok=True)
for d in ('fonts', 'tesseract', 'pdfjs'):
    shutil.rmtree(os.path.join(out, d), ignore_errors=True)
    shutil.copytree(os.path.join('dist', d), os.path.join(out, d))
main = [f for f in glob.glob('dist/assets/index-*.js')][0]
# lazy-loaded chunks sit next to the page (an inline module resolves imports against the page URL)
for f in glob.glob(os.path.join(out, '*.js')): os.remove(f)
for f in glob.glob('dist/assets/*.js'):
    if f != main:
        open(os.path.join(out, os.path.basename(f)), 'w').write(esc(open(f).read())); print('chunk', os.path.basename(f))
js = esc(open(main).read()).replace('</script', '<\\/script').replace('\ufffd', '\\uFFFD')
css = open(glob.glob('dist/assets/*.css')[0]).read()
open(os.path.join(out, 'index.html'), 'w').write(f'''<!doctype html>
<html lang="sv">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PDF-ändraren</title>
<style>{css}</style>
</head>
<body>
<div id="root"></div>
<script type="module">{js}</script>
</body>
</html>''')
print('ok', out)

for f in glob.glob(os.path.join(out, 'pdfjs', '*.mjs')) + glob.glob(os.path.join(out, 'tesseract', '*.js')):
    t = open(f, encoding='utf-8', errors='surrogateescape').read()
    e = esc(t)
    if e != t: open(f, 'w', encoding='utf-8', errors='surrogateescape').write(e); print('escaped', os.path.relpath(f, out))
