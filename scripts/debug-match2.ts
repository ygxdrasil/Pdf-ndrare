// npx tsx scripts/debug-match2.ts file x0 y0 x1 y1 "text" [family...]
import { readFile } from 'node:fs/promises';
import { readImage, readPage } from '../src/engine/pdf';
import { analyzeLine } from '../src/engine/analyze';
import { matchFont } from '../src/engine/match';
import { codec, makeLib } from './node-platform';
const [f, a, b, c, d, text, ...fams] = process.argv.slice(2);
const bytes = new Uint8Array(await readFile(f));
const { raster } = /\.(png|jpe?g)$/i.test(f) ? await readImage(bytes, /png$/i.test(f) ? 'image/png' : 'image/jpeg', codec) : await readPage(bytes, codec, 0);
const lib = await makeLib();
const info = analyzeLine(raster, { x0: +a, y0: +b, x1: +c, y1: +d });
const any = await matchFont(lib, [{ info, text }], {});
console.log('any', any.family, any.weight, any.score.toFixed(3), any.ranking?.slice(0, 6));
for (const fam of fams) { const m = await matchFont(lib, [{ info, text }], { families: [fam] }); console.log(fam, m.weight, m.score.toFixed(3), m.lines[0].size.toFixed(1), 'hs', m.lines[0].hs.toFixed(2), 'bold', m.lines[0].bold.toFixed(2), 'tr', m.lines[0].tracking.toFixed(1), m.ranking.slice(0,3)); }
