// Builds odd PDFs to stress the reader: node scripts/make-stress-pdfs.mjs <src.pdf> <out-dir>
import { PDFDocument, StandardFonts, rgb, degrees, PDFName, PDFRawStream } from 'pdf-lib';
import { readFile, writeFile } from 'node:fs/promises';
import { execSync } from 'node:child_process';
const [src, out] = process.argv.slice(2);
const bytes = await readFile(src);
const orig = await PDFDocument.load(bytes);
// pull out the page JPEG
let jpeg;
for (const [, obj] of orig.context.enumerateIndirectObjects()) if (obj instanceof PDFRawStream && obj.dict.lookup(PDFName.of('Subtype'))?.toString() === '/Image') jpeg = obj.contents;
await writeFile(out + '/page.jpg', jpeg);
// 1. two pages: ProSense + a text page
{ const d = await PDFDocument.create(); const [p] = await d.copyPages(orig, [0]); d.addPage(p);
  const p2 = d.addPage([595, 842]); const f = await d.embedFont(StandardFonts.Helvetica); p2.drawText('Sida 2 – lite text', { x: 60, y: 760, size: 20, font: f });
  await writeFile(out + '/two-pages.pdf', await d.save()); }
// 2. real text page (not flattened)
{ const d = await PDFDocument.create(); const p = d.addPage([595, 842]); const f = await d.embedFont(StandardFonts.HelveticaBold); const g = await d.embedFont(StandardFonts.TimesRoman);
  p.drawText('KVALSTERSKYDD MARIA', { x: 60, y: 760, size: 28, font: f, color: rgb(0.2, 0.3, 0.2) });
  p.drawText('Storlek 50 x 60 cm. Tvätta i 60 grader.', { x: 60, y: 720, size: 14, font: g });
  await writeFile(out + '/real-text.pdf', await d.save()); }
// 3. CMYK JPEG page
execSync(`python3 -c "from PIL import Image; Image.open('${out}/page.jpg').convert('CMYK').save('${out}/page-cmyk.jpg', quality=92)"`);
{ const d = await PDFDocument.create(); const p = d.addPage([842, 595]);
  const data = await readFile(out + '/page-cmyk.jpg');
  const s = d.context.flateStream ? null : null;
  const img = d.context.stream(data, { Type: 'XObject', Subtype: 'Image', Width: 1672, Height: 941, ColorSpace: 'DeviceCMYK', BitsPerComponent: 8, Filter: 'DCTDecode', Decode: [1, 0, 1, 0, 1, 0, 1, 0] });
  const ref = d.context.register(img);
  p.node.setXObject(PDFName.of('Im0'), ref);
  const cs = d.context.stream(`q 842 0 0 474 0 60 cm /Im0 Do Q`);
  p.node.set(PDFName.of('Contents'), d.context.register(cs));
  await writeFile(out + '/cmyk.pdf', await d.save()); }
// 4. rotated page
{ const d = await PDFDocument.load(bytes); d.getPage(0).setRotation(degrees(90)); await writeFile(out + '/rotated.pdf', await d.save()); }
// 5. big 300 ppi page
execSync(`python3 -c "from PIL import Image; Image.open('${out}/page.jpg').resize((3508,1974), Image.LANCZOS).save('${out}/page-big.jpg', quality=90)"`);
{ const d = await PDFDocument.create(); const p = d.addPage([842, 595]); const im = await d.embedJpg(await readFile(out + '/page-big.jpg')); p.drawImage(im, { x: 0, y: 60, width: 842, height: 474 }); await writeFile(out + '/big-300ppi.pdf', await d.save()); }
// 6. encrypted + 7. junk + 8. empty-ish
execSync(`qpdf --encrypt user owner 256 -- ${src} ${out}/locked.pdf`);
execSync(`qpdf --encrypt "" owner 256 --print=none -- ${src} ${out}/restricted.pdf`);
await writeFile(out + '/junk.pdf', 'hej detta är inte en pdf');
await writeFile(out + '/truncated.pdf', bytes.subarray(0, Math.floor(bytes.length / 2)));
console.log('ok');
