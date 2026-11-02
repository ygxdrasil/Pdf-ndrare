// Real-UI stress test: drives the app in Chromium like a user does.
// node scripts/stress-ui.mjs <outdir> <lane> <lanes> [filter]
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const { chromium } = createRequire('/home/claude/.npm-global/lib/node_modules/')('playwright');

const BASE = 'http://localhost:5199';
const PW = readFileSync('/home/claude/elin-v2/app/.env', 'utf8').match(/^APP_PASSWORD=(.*)$/m)[1].trim();
const [OUT, LANE = '0', LANES = '1', FILTER = ''] = process.argv.slice(2);
const F = '/home/claude/elin-v2/elinfiles/', N = F + 'new/';
const ORIG = '/home/claude/elin-v2/samples/original.pdf';

// marks are fractions of the page (x0,y0,x1,y1)
const S = [
  { id: 'maria-3turn', file: ORIG, steps: [{ msg: 'byt maria till sofia överallt' }, { msg: 'ändra storleken till 60x70 överallt' }, { msg: 'Fixa' }, { download: 1 }], has: ['SOFIA', '60'], not: ['MARIA'] },
  { id: 'maria-mark', file: ORIG, steps: [{ msg: 'ändra denna text till elin', mark: [355 / 1672, 370 / 941, 485 / 1672, 410 / 941] }, { msg: 'gör den lite större' }, { undo: 1 }, { msg: 'skriv ELIN i stället för SOFIA på baksidan också' }, { download: 1 }], has: ['ELIN'] },
  { id: 'png-icons', file: F + 'img-etikett-maria.png', steps: [{ msg: 'ändra denna text till elin', mark: [350 / 884, 600 / 1268, 530 / 884, 655 / 1268] }, { msg: 'ta bort denna och jämna ut de andra 3', mark: [285 / 884, 770 / 1268, 410 / 884, 895 / 1268] }, { msg: 'Fixa' }, { download: 1 }], has: ['ELIN'] },
  { id: 'png-size', file: F + 'img-etikett-maria.png', steps: [{ msg: 'ändra 50 x 60 cm till 70x90 cm' }, { download: 1 }], has: ['70', '90'] },
  { id: 'legfix', file: N + '45851650-55004_ProSense_LegFix_XL__9-23_1.pdf', steps: [{ msg: 'ändra 55004 till 882232 och 6kg till 2' }, { msg: 'ändra XL till L överallt' }, { download: 1 }], has: ['882232'], not: ['55004'] },
  { id: 'headfix', file: N + '2a16f8a3-50002_ProSense_HeadFix_M_NY_--9_9-23_1.pdf', steps: [{ msg: 'byt adressen till Olofsdalsvägen 12 överallt' }, { msg: 'ändra 100 st till 50 st' }, { download: 1 }], has: ['Olofsdalsvägen 12'] },
  { id: 'julia-indesign', file: N + '1b0d3034-60001_250617_1.pdf', steps: [{ msg: 'byt JULIA till EMMA överallt' }, { msg: 'ändra krympa cirka 3% till 5%' }, { download: 1 }], has: ['EMMA', '5%'], not: ['JULIA'] },
  { id: 'julia-2pages', file: N + '573f714a-60001S__6.pdf', page: 1, steps: [{ msg: 'ändra art nr till 60002S' }, { download: 1 }], has: ['60002S'] },
  { id: 'canva-moa', file: N + '9bc0015c-KVALSTERSKYDD__PRODUKTER__11500__label_on_box_1.pdf', steps: [{ msg: 'ändra 150 x 210 till 220 x 220' }, { msg: 'byt MOA till LISA' }, { download: 1 }], has: ['220', 'LISA'], not: ['MOA'] },
  { id: 'print-heading', file: N + '1d41d6aa-11500___.pdf', steps: [{ msg: 'ändra rubriken högst upp till KVALSTERSKYDD FÖR KUDDE - MOA 50 X 60 cm' }, { download: 1 }], has: ['KUDDE'] },
  { id: 'small-label', file: N + '2ebfeeb5-__________1.pdf', steps: [{ msg: 'byt Liten till Stor och S till L' }, { download: 1 }], has: ['Stor'] },
  { id: 'add-remove-line', file: F + 'f207b577-Prosense_Maria_Kuddskydd_f_rpackningsvy_260908_ver61_1_1.pdf', steps: [{ msg: 'lägg till en rad under adressen på baksidan: Tel 035-12 34 56' }, { msg: 'ta bort den igen' }, { download: 1 }] },
  { id: 'jpg-carton', file: F + 'img-kartong-60004.jpg', steps: [{ msg: 'ändra artikelnumret till 60009 överallt' }, { download: 1 }], has: ['60009'] },
  { id: 'vague-typos', file: ORIG, steps: [{ msg: 'kan du göra så det står sofia ist för maria men bara på framsidan' }, { msg: 'ändra adressen' }, { msg: 'Tenovägen 40' }, { download: 1 }], has: ['SOFIA'] },
  { id: 'png-julia', file: F + 'img-julia-60001S.png', steps: [{ msg: 'byt namnet till EMMA' }, { download: 1 }], has: ['EMMA'] },
];
const RUNS = [];
for (const s of S) for (const model of (process.env.MODELS ?? 'opus,opus,sonnet').split(',')) RUNS.push({ ...s, model });
const done = (r) => { const f = `${OUT}/${r.id}-${r.model}-${r.n}.json`; try { return JSON.parse(readFileSync(f, 'utf8')).ok; } catch { return false; } };
const mine = RUNS.map((r, i) => ({ ...r, n: i })).filter((r) => r.n % Number(LANES) === Number(LANE) && (!FILTER || r.id.includes(FILTER)) && !(process.env.SKIP_DONE && done(r)));

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
// log in once per lane, like a person (the app allows 10 logins per 15 min)
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
{ const p0 = await ctx.newPage(); await p0.goto(BASE + '/'); if (await p0.locator('#pw').count()) { await p0.fill('#pw', PW); await p0.click('#b'); await p0.waitForSelector('.drop', { timeout: 30000 }); } await p0.close(); }
for (const run of mine) {
  const tag = `${run.id}-${run.model}-${run.n}`;
  const log = { tag, id: run.id, model: run.model, steps: [], pageErrors: [], ok: true };
  const page = await ctx.newPage();
  page.on('pageerror', (e) => log.pageErrors.push(e.message.slice(0, 300)));
  const t0 = Date.now();
  try {
    await page.goto(BASE + '/');
    if (await page.locator('#pw').count()) { await page.fill('#pw', PW); await page.click('#b'); }
    await page.waitForSelector('.drop', { timeout: 30000 });
    await page.setInputFiles('.drop input', run.file);
    const pick = page.locator('.pagepick button');
    await Promise.race([page.waitForSelector('.msg.assistant', { timeout: 300000 }), pick.first().waitFor({ timeout: 300000 })]);
    if (await pick.count()) { await pick.nth((run.page ?? 1) - 1).click(); await page.waitForSelector('.msg.assistant', { timeout: 300000 }); }
    log.openS = Math.round((Date.now() - t0) / 1000);
    if (run.model === 'sonnet') await page.locator('.modelpick button', { hasText: 'Sonnet' }).click();
    for (const st of run.steps) {
      const rec = { ...st };
      if (st.undo) { await page.click('button:has-text("Ångra")'); await page.waitForTimeout(800); rec.done = true; log.steps.push(rec); continue; }
      if (st.download) {
        const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 300000 }), page.locator('.primary', { hasText: 'Ladda ner' }).click()]);
        const out = `${OUT}/${tag}-${dl.suggestedFilename()}`;
        await dl.saveAs(out); rec.file = out; rec.bytes = statSync(out).size; log.steps.push(rec); continue;
      }
      if (st.mark) {
        const stage = page.locator('.stage').first();
        const [x0, y0, x1, y1] = st.mark;
        // scroll the marked area into the middle of the window first, like a person would
        await stage.evaluate((el, f) => { const r = el.getBoundingClientRect(); const sc = el.closest('.pages') ?? document.scrollingElement; sc.scrollBy(0, r.top + r.height * f - innerHeight / 2); }, (y0 + y1) / 2);
        await page.waitForTimeout(300);
        const b = await stage.boundingBox();
        await page.mouse.move(b.x + x0 * b.width, b.y + y0 * b.height); await page.mouse.down();
        await page.mouse.move(b.x + x1 * b.width, b.y + y1 * b.height, { steps: 8 }); await page.mouse.up();
      }
      const before = await page.locator('.msg.assistant').count();
      await page.fill('#msg', st.msg);
      const t1 = Date.now();
      await page.click('form button.primary');
      await page.waitForFunction((n) => (document.querySelectorAll('.msg.assistant').length > n || document.querySelector('.chat .error')) && !document.querySelector('.msg.status'), before, { timeout: 420000 });
      rec.s = Math.round((Date.now() - t1) / 1000);
      rec.reply = (await page.locator('.msg.assistant').last().innerText()).slice(0, 900);
      rec.error = (await page.locator('.chat .error').count()) ? await page.locator('.chat .error').innerText() : null;
      if (rec.error) log.ok = false;
      await page.locator('.pages').screenshot({ path: `${OUT}/${tag}-step${log.steps.length + 1}.png` }).catch(() => {});
      log.steps.push(rec);
    }
  } catch (e) { log.ok = false; log.crash = String(e?.message ?? e).slice(0, 400); await page.screenshot({ path: `${OUT}/${tag}-crash.png` }).catch(() => {}); }
  if (log.pageErrors.length) log.ok = false;
  // read the downloaded result back (OCR of the rendered page) and check the expected text
  const dl = log.steps.find((s) => s.file)?.file;
  if (dl && (run.has || run.not)) {
    try {
      let img = dl;
      if (dl.endsWith('.pdf')) { execFileSync('pdftoppm', ['-r', '110', '-f', String(run.page ?? 1), '-l', String(run.page ?? 1), '-png', dl, `${OUT}/${tag}-render`]); img = execFileSync('bash', ['-c', `ls ${OUT}/${tag}-render*.png | head -1`]).toString().trim(); }
      const txt = execFileSync('tesseract', [img, '-', '-l', 'swe+eng', '--psm', '11'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().replace(/\s+/g, ' ');
      const norm = (s) => s.toUpperCase().replace(/\s+/g, '');
      log.missing = (run.has ?? []).filter((h) => !norm(txt).includes(norm(h)));
      log.stillThere = (run.not ?? []).filter((h) => norm(txt).includes(norm(h)));
    } catch (e) { log.verifyError = String(e?.message ?? e).slice(0, 200); }
  }
  log.totalS = Math.round((Date.now() - t0) / 1000);
  writeFileSync(`${OUT}/${tag}.json`, JSON.stringify(log, null, 1));
  console.log(`${log.ok ? 'OK  ' : 'FAIL'} ${tag} ${log.totalS}s ${log.crash ?? ''} ${log.steps.filter((s) => s.error).map((s) => s.error).join(' | ')} missing=${JSON.stringify(log.missing ?? [])} still=${JSON.stringify(log.stillThere ?? [])}`);
  await page.close();
}
await browser.close();
