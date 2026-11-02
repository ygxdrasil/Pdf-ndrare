// Word swaps without Claude, to check weight/softness: npx tsx scripts/try-word.ts out.pdf
import { readFile, writeFile } from 'node:fs/promises';
import { readPage, writePdf } from '../src/engine/pdf';
import { applyEdits, Edit } from '../src/engine/edit';
import { codec, makeLib } from './node-platform';
const ocr = JSON.parse(await readFile('/home/claude/elin-v2/work/tests/ocr.json', 'utf8'));
const bytes = new Uint8Array(await readFile('/home/claude/elin-v2/samples/original.pdf'));
const { image, raster } = await readPage(bytes, codec);
const lib = await makeLib();
const L = (id: number) => ocr.find((o: any) => o.id === id).text;
const edits: Edit[] = [
  { kind: 'text', lines: [15], old: ['ProSense MARIA kuddskydd är tillverkat av Evolon®-'], new: 'ProSense SOFIA kuddskydd är tillverkat av Evolon®-', align: 'left' },
  { kind: 'text', lines: [0], old: ['ARTWORK – PROSENSE MARIA KUDDSKYDD'], new: 'ARTWORK – PROSENSE SOFIA KUDDSKYDD', align: 'left' },
  { kind: 'text', lines: [31], old: ['50 × 60 cm'], new: '60 × 70 cm', align: 'center', style: 'sans' },
  { kind: 'text', lines: [95], old: ['Tenovägen 35'], new: 'Tenovägen 40', align: 'center' },
  { kind: 'text', lines: [82], old: ['Tenovägen 35'], new: 'Tenovägen 40', align: 'left' },
];
const res = await applyEdits(raster, ocr, edits, lib);
for (const r of res.reports) console.log(r.index, r.mode, r.font);

await writeFile(process.argv[2], await writePdf(bytes, image, res.raster, res.items, lib, codec));
