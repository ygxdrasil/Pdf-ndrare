// Makes the pdf.js worker turn DeviceCMYK into RGB the way Acrobat and Chrome (pdfium) do,
// using the measured table in vendor/cmyk-lut.json. Without it, our page render and the
// viewer disagree (100% black is #2C2E35 in pdf.js but #231F20 in the viewers), and edited
// patches laid on a vector page show up as slightly off-colour boxes.
import fs from 'node:fs';
const LUT = JSON.parse(fs.readFileSync(new URL('../vendor/cmyk-lut.json', import.meta.url), 'utf8'));

const helper = `const __cmykN=${LUT.n},__cmykT=new Uint8Array(${JSON.stringify(LUT.rgb)});
function __cmyk(s,o,sc,d,p){const N=__cmykN-1,v=[s[o]*sc,s[o+1]*sc,s[o+2]*sc,s[o+3]*sc],i=[0,0,0,0],f=[0,0,0,0];
for(let q=0;q<4;q++){let x=v[q]<0?0:v[q]>1?N:v[q]*N;let j=Math.floor(x);if(j>=N)j=N-1;i[q]=j;f[q]=x-j}
let r=0,g=0,b=0;for(let c=0;c<16;c++){let w=1,ix=0;for(let q=0;q<4;q++){const bit=(c>>(3-q))&1;w*=bit?f[q]:1-f[q];ix=ix*__cmykN+i[q]+bit}
if(w===0)continue;ix*=3;r+=w*__cmykT[ix];g+=w*__cmykT[ix+1];b+=w*__cmykT[ix+2]}d[p]=r;d[p+1]=g;d[p+2]=b}
`;

export function patchCmyk(code) {
  if (code.includes('__cmykT')) return code;
  const at = code.indexOf('class DeviceCmykCS');
  if (at < 0) throw new Error('pdf.js: DeviceCmykCS not found');
  const re = /#(\w+)\(\s*(\w+),\s*(\w+),\s*(\w+),\s*(\w+),\s*(\w+)\s*\)\s*\{/y;
  let k = code.indexOf('#', at), m;
  for (; k > 0; k = code.indexOf('#', k + 1)) { re.lastIndex = k; if ((m = re.exec(code))) break; }
  if (!m) throw new Error('pdf.js: CMYK convert method not found');
  const open = re.lastIndex - 1;
  let depth = 0, end = open;
  for (; end < code.length; end++) { if (code[end] === '{') depth++; else if (code[end] === '}' && --depth === 0) break; }
  const body = code.slice(open + 1, end);
  if (!body.includes('4.387332384609988')) throw new Error('pdf.js: unexpected CMYK method');
  const [, , a, b, c, d, e] = m;
  const out = code.slice(0, open + 1) + `__cmyk(${a},${b},${c},${d},${e})` + code.slice(end);
  // put the helper after any leading import/export header lines so the module stays valid
  return helper + out;
}
