# PDF-ändraren v2

A small web app that lets Elin change text on her label and packaging files by
chatting, and download the result. It takes PDFs (flattened "Print to PDF"
files as well as real-text/vector PDFs from Illustrator, InDesign, Canva) and
pictures (PNG/JPG, saved back in the same format). The UI is in Swedish.

## How it works

Claude decides **what** changes; a precise engine in the browser does the
pixel work. That's why it's fast and predictable.

1. **Open:** the app takes the page picture out of the PDF and reads all the
   text on it with OCR in the browser (tesseract.js, two passes: dark-on-light
   and light-on-dark). Takes ~25 s once per file. Nothing is uploaded.
2. **Plan (Claude, 1 call):** Claude sees the page, the OCR lines (with
   positions), the area Elin marked and her message. It returns an edit plan:
   which text blocks change, the new text, alignment and style group. It asks
   a question only when the request is truly unclear.
3. **Fonts:** for each style group the engine fits ~200 open-licence fonts to
   the original lettering (size, spacing, baseline, stroke weight). Claude
   looks at the top 4 drawn the same way and picks the closest (1 small call).
4. **Apply (engine):**
   - Lines that don't change aren't touched.
   - If only some words in a line change, only those are replaced. The rest of
     the line keeps its original pixels (shifted sideways if needed), and the
     new word is drawn into the picture with the same softness, so it can't be
     told apart.
   - Whole new lines and blocks are set as sharp vector text in the matched
     font, size and colour; long text wraps and shrinks to fit (Elin is told).
   - Old text is removed by filling the letters with background that continues
     the surface, including the paper or kraft grain.
5. **Check (Claude, 1 call):** before/after close-ups of every change plus the
   whole page. If something looks off (old text visible, too bold, misaligned,
   wrong size), the engine corrects it once.
6. **Versions:** every change is a new version: Före / Efter / Sida vid sida,
   Ångra, and download of any version (`<name>-andrad-<n>.pdf`). The PDF keeps
   the original page, size and placement. Only the picture is swapped
   (losslessly) and the new text is added as embedded vector text.

The API key only lives on the server (`api/claude.js`). That route checks the
login cookie, rate-limits, and only passes on the fields the app needs. The
model can only be one of two: `claude-opus-5-5` or `claude-sonnet-5-5`. Each
call must use exactly one of the app's three tools (`edit_plan`, `pick_fonts`,
`check_result`) with plain text/image turns, so the route can't be used as a
general-purpose Claude API. Logins are limited per address (10 per 15 min) and
overall (60 per hour); use a long password (16+ characters).

## Model choice (button in the app)

Elin picks it next to the chat; the choice is remembered in her browser.

- **Opus – svår (default):** best quality. Use for big rewrites, many blocks at
  once, or tricky layouts. ~15–30 s for small changes, ~1.5–2 min for a full
  rewrite. About 3x the cost of Sonnet.
- **Sonnet – lätt:** faster and cheaper. Fine for swapping a word, name, size
  or number. On big rewrites it more often leaves an overlap to fix afterwards.

## Test results (Elin's ProSense file, 25 Oct 2026)

| Test | Claude Opus 5.5 (default) | Claude Sonnet 5.5 |
|---|---|---|
| MARIA → SOFIA everywhere (4 places) | 14 s · ≈0.9 kr | 8 s · ≈0.3 kr |
| 50 × 60 → 60 × 70 cm everywhere (incl. white text in the green circle) | 18 s · ≈1.0 kr | 9 s · ≈0.3 kr |
| Remove OEKO-TEX/ECARF badges + footnote | 17 s · ≈0.9 kr | 8 s · ≈0.3 kr |
| Brownie rewrite of the whole box (~30 blocks) | 106 s · ≈3.4 kr | 79 s · ≈1.3 kr |

Opus gave the cleaner result on the big rewrite (no overlaps; it also updated
the 3D mockup heading), so it's the default. Sonnet takes about half the time
at a third of the cost. Opening a file (OCR) adds ~25 s once. Costs are
estimates from token counts at list prices. `CLAUDE_MODEL` only sets the
fallback if the app sends no model.

## Run on Vercel

1. Import the folder/repo in Vercel (settings come from `vercel.json`).
2. Environment variables: `ANTHROPIC_API_KEY`, `APP_PASSWORD`, and optionally
   `CLAUDE_MODEL`, `AUTH_SECRET`, `RATE_LIMIT_PER_10_MIN`, `RATE_LIMIT_PER_DAY`.
3. Redeploy. Set a monthly spend limit in the Anthropic console as the hard cap.

Notes:
- Vercel's free Hobby plan is for non-commercial, personal use only. For a
  company, use Pro ($20 per month per developer seat). The app is a static site
  plus one function (`api/claude.js`) and the login middleware, so it moves easily.
- Requests to Claude stay well under Vercel's 4.5 MB body limit (JPEGs ≤1568 px).
- The OCR language files are gzip data named `*.traineddata.wasm` (so any host
  serves them untouched); the app's OCR worker asks for that name.

## Develop

```
cp .env.example .env    # fill in the key and a password
npm install
npm run dev             # http://localhost:5173, login + API included
npm run build
```

Claude-artifact test version (no server, no key: it runs on the viewer's own
Claude account; "Opus" = most capable tier, "Sonnet" = balanced tier):
`npx vite build && python3 scripts/build-artifact.py <out-dir>`, then publish
`<out-dir>/index.html` with `fonts/` and `tesseract/` as supporting files and
the capabilities `sample` (with images) and `downloads`.

Engine tests against the real Claude API (Node):
`npx tsx scripts/run-tests.ts claude-opus-5-5 sofia size badges brownie2`
(needs `tessdata/swe.traineddata.gz` + `eng.traineddata.gz`, copied from
`node_modules/@tesseract.js-data/*/4.0.0_best_int/`, and a key in `../.env`).
Browser end-to-end: start `npx vite --port 5199`, then `node scripts/e2e.mjs`.

## Layout

```
src/engine/   the editing engine (browser + Node)
  pdf.ts        read the page picture + placement; write the edited PDF
  analyze.ts    background model, ink mask, ink colour, ink box, stroke weight
  erase.ts      remove lettering (smooth fill + surface grain)
  match.ts      font/size/spacing/weight fitting against the original pixels
  edit.ts       apply a plan: unchanged / word / line / block modes
  agent.ts      Claude: plan, font pick, check + one correction
  ocr-merge.ts  merge OCR passes
src/app/      the React UI (chat, mark, versions, download) + browser adapters
api/          claude.js (the only door to Claude), login, logout
middleware.js login required for every page and API route
public/fonts/ 46 open-licence font families (SIL OFL, GUST), see licenses/
```

## Which files work

- **Flattened pages** (one JPEG picture, e.g. "Print to PDF"): the picture is
  swapped in place, losslessly. Best case.
- **Real-text / vector PDFs and anything else** (Illustrator, InDesign, Canva,
  an already-edited file, several pictures on a page): the page is rendered once
  with pdf.js (300 ppi when it has text or drawings, capped at 16 MP) for
  reading and editing. On download, the original page is kept as it is and only
  the changed areas are laid on top as small pictures plus vector text, so
  everything untouched stays sharp and selectable.
- **Very large sheets** (cartons where 16 MP means under 200 ppi): new text is
  always sharp vector text; a changed word is swapped alone and only the words
  that must move are re-set.
- **PNG/JPG pictures**: edited the same way and saved in the same format
  (JPG at quality 95). Up to 40 MP. Transparent PNGs stay transparent: edits on
  a see-through background come back see-through, edits inside a solid area stay
  solid. Phone photos are turned upright from their EXIF orientation.
- **Several pages**: Elin picks the page (a list for files with more than 40
  pages); the other pages are kept untouched.
- **Rotated pages** are shown and edited the way they are stored; the download
  keeps the page's rotation, so it looks right in every viewer.
- Locked/password PDFs, broken files and other formats get a clear Swedish message.
- **Colours**: pdf.js is patched (`scripts/pdfjs-cmyk.mjs`) to turn CMYK into
  RGB the way Acrobat and Chrome do (a table measured from pdfium in
  `vendor/cmyk-lut.json`, made by `scripts/cmyk-lut.py`), so patches match the
  page around them.

## Elin's real files (26 Oct 2026)

Ten small edits on her own files through the artifact build in a browser
(product sheets from InDesign, a Canva label, Illustrator cartons up to
145 × 97 cm, a sticker sheet, a 2-page file, PNG/JPG pictures). Fixes from this
round: patch output over the original vector page, CMYK colours as in Acrobat,
horizontal letter scaling and synthetic weight in the font fit, a quick
low-resolution first pass over all fonts (instead of a width filter), Century
Schoolbook/Times/Helvetica look-alikes (TeX Gyre, GUST licence, renamed), the
font of a short changed word fitted on it and its neighbour, OCR boxes that
reach into a photo trimmed, line ids preferred over Claude's rough boxes,
vector word swaps on large sheets, digit-for-digit swaps keep their neighbours.

## Stress test (29 Oct 2026, real browser, like a user)

75 runs, 140+ requests through the real UI on all 12 of Elin's files (InDesign, Illustrator incl. 145 cm sheets, Canva, Print-to-PDF, 2-page PDF, PNG, JPG): casual Swedish with typos, marked boxes, follow-ups, "Fixa", vague requests ("ändra adressen" → it asks, then does it), Ångra, download. Final round on the finished code: 30/30 runs, 0 crashes, 0 error messages; median ~30 s per change. Plus 29 deliberately malformed Claude answers through the engine (scripts/fuzz-plans.ts): all handled.

## Stress test (25 Oct 2026)

54 browser runs through the real UI (both models), ≈37 kr in Claude calls.
Small edits on the ProSense file, final round, both Opus and Sonnet:
MARIA→SOFIA everywhere, 50×60→60×70 everywhere (incl. white text in the green
circle), a sentence insertion, the address on kraft and white panels, removing
two badges and spreading the rest: all clean at 2x zoom. Also passed: re-opening
the app's own output and chat-edited files, 2-page PDF, CMYK, real-text PDF,
rotated page, 300 ppi page, locked/broken files.

Engine fixes from the test: re-open support (pdf.js render path), legacy pdf.js
build (newer builds need very new browsers), font family/weight for swapped words
calibrated against a kept word of the same line, darker ink-colour estimate for
small text, textured (kraft) surfaces erased as a whole word box, word boxes
kept to their line, pure insertions done word by word, word gaps measured from
the line, boxes mapped to OCR lines, unreadable text found from its pixels,
duplicate edits on the same text dropped, one quiet retry on a failed call.

## Limits (honest list)

- **Removing/moving icons and pictures is switched off** by default (`VITE_ALLOW_PICTURE_EDITS=1` turns it on). On photo backgrounds it can't be filled in cleanly and it damaged a QR code and a CE mark in testing. Text changes are not affected; a request that only moves/removes icons gets a polite Swedish answer instead.
- Text on a **patterned photo** (e.g. the quilted sheet) can leave a slightly lighter patch behind the new word. The check step reports it under "Att titta på".
- Text that is **upside down or angled** (mock-up sides, mirrored templates) is skipped, and the reply says so.
- A taller text block only grows into free space below it; otherwise it shrinks. To undo an added line exactly, use **Ångra** (asking to remove it keeps the smaller size).
- Use **Opus** for anything going to print: in testing Sonnet was right but sometimes slightly off-centre.

- The page picture itself stays at its resolution (here 143 ppi). Whole new lines
  are sharp vector text; swapped words are drawn into the picture to match.
- Tiny text inside an icon (e.g. "175°C" inside an oven symbol) is sometimes
  missed; the check step then tells Elin ("Att titta på: …").
- Text on tilted/perspective surfaces (the side of the 3D mockup) is skipped,
  and the small copy on the mockup's front can come out slightly narrower.
- Sonnet occasionally misses one occurrence of an "everywhere" change, or takes
  an odd route on a big rewrite. Opus is the safer choice for anything big.
- Fonts are look-alikes from the open library (incl. Times-, Helvetica- and
  Century-Schoolbook-style faces). Letters can be stretched/squeezed and
  thickened to match horizontally scaled or in-between-weight type. Very unusual
  fonts can still be off.
- JPG pictures are saved again as JPG, so the whole picture is re-compressed
  once (quality 95, not visible in normal use). Use PNG when that matters.
- Icons and pictures can be removed or moved, not redrawn.
