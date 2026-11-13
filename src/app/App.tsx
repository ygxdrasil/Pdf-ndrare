import { useEffect, useMemo, useRef, useState } from 'react';
import { readPage, readImage, writePdf, writeImage, pageCount, PageImage, TextItem } from '../engine/pdf';
import { runRequest, renderPreview } from '../engine/agent';
import type { OcrLine } from '../engine/edit';
import type { Box, Raster } from '../engine/raster';
import type { FontLib } from '../engine/fonts';
import { callClaude, codec, encodeForClaude, inArtifact, initArtifactRuntime, makeLib, ocrPage, ocrRegion, readText, rasterToCanvas, saveFile } from './browser';

type ModelKey = 'opus' | 'sonnet';
const MODELS: Record<ModelKey, { id: string; name: string; hint: string }> = {
  opus: { id: 'claude-opus-5-5', name: 'Opus – svår', hint: 'Bäst kvalitet. För stora omskrivningar och knepiga ändringar. Lite långsammare.' },
  sonnet: { id: 'claude-sonnet-5-5', name: 'Sonnet – lätt', hint: 'Snabbare och billigare. Räcker för att byta ett ord, ett namn eller en siffra.' },
};
function loadModel(): ModelKey { try { return localStorage.getItem('pdfa-model') === 'sonnet' ? 'sonnet' : 'opus'; } catch { return 'opus'; } }

interface Version {
  clean: Raster; // the page picture with old words removed
  items: TextItem[]; // new words as vector text on top
  preview: Raster; // what it looks like
  label: string;
  ocr?: OcrLine[];
}
interface Msg { role: 'user' | 'assistant' | 'status'; text: string; notes?: string[] }

const EXAMPLES = ['Byt MARIA till SOFIA överallt', 'Ändra 50 × 60 cm till 60 × 70 cm', 'Ta bort fotnoten längst ner'];

export default function App() {
  const [lib, setLib] = useState<FontLib | null>(null);
  const [file, setFile] = useState<{ name: string; bytes: Uint8Array; image: PageImage } | null>(null);
  const [versions, setVersions] = useState<Version[]>([]);
  const [cur, setCur] = useState(0);
  const [view, setView] = useState<'after' | 'before' | 'both'>('after');
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [mark, setMark] = useState<Box | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pick, setPick] = useState<{ name: string; bytes: Uint8Array; n: number } | null>(null);
  const [model, setModelState] = useState<ModelKey>(loadModel);
  const setModel = (m: ModelKey) => { setModelState(m); try { localStorage.setItem('pdfa-model', m); } catch { /* ignore */ } };

  useEffect(() => {
    initArtifactRuntime().catch(() => false);
    makeLib().then(setLib).catch(() => setError('Kunde inte ladda typsnitten. Ladda om sidan.'));
  }, []);

  const v = versions[cur];
  const prev = versions[Math.max(0, cur - 1)];

  async function open(f: File) {
    setError(null);
    const isImg = /\.(png|jpe?g)$/i.test(f.name);
    if (!/\.pdf$/i.test(f.name) && !isImg) return setError('Välj en PDF, PNG eller JPG.');
    if (f.size > 60 * 1024 * 1024) return setError('Filen är för stor (över 60 MB). Spara en mindre fil och försök igen.');
    const bytes = new Uint8Array(await f.arrayBuffer());
    if (isImg) return openImage(f.name, bytes, /\.png$/i.test(f.name) ? 'image/png' : 'image/jpeg');
    if (String.fromCharCode(...bytes.subarray(0, 1024)).indexOf('%PDF') < 0) return setError('Filen är inte en PDF. Välj en PDF-fil.');
    let n = 1;
    try { n = await pageCount(bytes); } catch { /* readPage gives the clear message */ }
    if (n > 1) { setPick({ name: f.name, bytes, n }); return; }
    await openPage(f.name, bytes, 0);
  }

  async function openImage(fileName: string, bytes: Uint8Array, mime: string) {
    return openPage(fileName, bytes, 0, () => readImage(bytes, mime, codec));
  }

  async function openPage(fileName: string, bytes: Uint8Array, pageIndex: number, reader?: () => Promise<{ image: PageImage; raster: Raster }>) {
    setPick(null);
    setBusy('Öppnar filen …');
    try {
      const { image, raster } = await (reader ? reader() : readPage(bytes, codec, pageIndex));
      const first: Version = { clean: raster, items: [], preview: raster, label: 'Original' };
      setFile({ name: fileName.replace(/\.(pdf|png|jpe?g)$/i, ''), bytes, image });
      setVersions([first]); setCur(0); setMsgs([]); setMark(null);
      first.ocr = await ocrPage(raster, setBusy);
      setVersions([{ ...first }]);
      const extra = [
        image.pageCount > 1 ? `Du ändrar sida ${pageIndex + 1} av ${image.pageCount}. De andra sidorna följer med orörda.` : '',
        image.mode === 'render' && (image.ppi ?? 300) < 200 ? 'Sidan är mycket stor, så ny text sätts som skarp text (inte som bild).' : '',
        image.reason === 'text' ? 'Den här PDF:en har riktig text. Bara det du ändrar läggs ovanpå sidan, resten av PDF:en är orörd.' : '',
        image.mode === 'image' ? `Bilden sparas som ${image.format === 'png' ? 'PNG' : 'JPG'} igen när du laddar ner.` : '',
      ].filter(Boolean).join(' ');
      setMsgs([{ role: 'assistant', text: `Klart! Skriv vad du vill ändra. Du kan också dra en ruta på sidan för att visa exakt var.${extra ? '\n\n' + extra : ''}` }]);
    } catch (e: any) {
      setError(e?.message || 'Kunde inte öppna PDF:en.');
      setFile(null);
    }
    setBusy(null);
  }

  async function send(text: string) {
    if (!lib || !v || !text.trim() || busy) return;
    setError(null);
    const history = msgs.filter((m) => m.role !== 'status').slice(-6).map((m) => ({ role: m.role as 'user' | 'assistant', text: m.notes?.length ? `${m.text}\n${m.notes.join('\n')}` : m.text }));
    setMsgs((m) => [...m, { role: 'user', text }]);
    setInput('');
    try {
      let ocr = v.ocr;
      if (!ocr) { ocr = await ocrPage(v.preview, setBusy); v.ocr = ocr; }
      setBusy('AI läser sidan …');
      const res = await runRequest({
        lib, model: MODELS[model].id, effort: 'medium', compact: true, allowPictures: import.meta.env.VITE_ALLOW_PICTURE_EDITS === '1', vectorOnly: file!.image.mode === 'render' && (file!.image.ppi ?? 300) < 200,
        claude: callClaude,
        encode: encodeForClaude,
        ocrRegion: (b) => ocrRegion(v.preview, b),
        readBack: readText,
        log: (s) => { if (!s.startsWith('  ')) setBusy(s); },
      }, v.preview, ocr, { instruction: text, mark: mark ?? undefined, history }, v.clean, v.items);
      if (res.question) {
        setMsgs((m) => [...m, { role: 'assistant', text: res.question! }]);
      } else if (res.applied) {
        setBusy('Gör förhandsvisningen …');
        const preview = await renderPreview({ lib }, res.applied, v.clean.w, v.clean.h);
        const nv: Version = { clean: res.applied.raster, items: res.applied.items, preview, label: text.slice(0, 40) };
        const list = [...versions.slice(0, cur + 1), nv];
        setVersions(list); setCur(list.length - 1); setView('after'); setMark(null);
        const warn = res.notes.filter((n) => /krympt|får inte|Rättat|Att titta/i.test(n));
        setMsgs((m) => [...m, { role: 'assistant', text: `${res.summary || 'Klart.'} (${Math.round(res.usage.ms / 1000)} s)`, notes: warn }]);
      }
    } catch (e: any) {
      console.error(e);
      const raw = String(e?.message ?? '');
      const swedish = /[åäöÅÄÖ]/.test(raw) || /^(Claude|AI|API|Du |Dagens|Många|Kunde|Hittade|Planen|Bilderna|Felaktig)/.test(raw);
      setError(swedish ? raw : 'Något gick fel i bildbehandlingen. Försök igen, beskriv ändringen på ett annat sätt, eller dra en ruta runt det du menar.');
    }
    setBusy(null);
  }

  async function download(i = cur) {
    if (!file || !lib) return;
    const ver = versions[i];
    setBusy('Skapar filen …');
    try {
      const im = file.image;
      if (i === 0) {
        // the original: hand back the exact file that was opened, untouched
        const ext = im.mode === 'image' ? (im.format === 'png' ? 'png' : 'jpg') : 'pdf';
        await saveFile(`${file.name}.${ext}`, file.bytes, im.mode === 'image' ? (im.format === 'png' ? 'image/png' : 'image/jpeg') : 'application/pdf');
      } else if (im.mode === 'image') {
        const ext = im.format === 'png' ? 'png' : 'jpg';
        const out = await writeImage(im, ver.clean, ver.items, lib, codec, (a) => renderPreview({ lib }, a as any, im.w, im.h));
        await saveFile(i === 0 ? `${file.name}.${ext}` : `${file.name}-andrad-${i}.${ext}`, out, im.format === 'png' ? 'image/png' : 'image/jpeg');
      } else {
        const pdf = await writePdf(file.bytes, im, ver.clean, ver.items, lib, codec, versions[0].clean);
        await saveFile(i === 0 ? `${file.name}.pdf` : `${file.name}-andrad-${i}.pdf`, pdf, 'application/pdf');
      }
    } catch (e: any) {
      if (e?.code !== 'cancelled' && e?.code !== 'declined') setError(e?.message || 'Kunde inte skapa PDF:en.');
    }
    setBusy(null);
  }

  if (!file || !v)
    return (
      <div className="start">
        <h1>PDF-ändraren</h1>
        <p>Ändra text i dina etiketter och förpackningar. Ladda upp PDF:en eller bilden så börjar vi.</p>
        <label className={`drop ${busy ? 'busy' : ''}`}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) open(f); }}>
          <input type="file" accept="application/pdf,image/png,image/jpeg" onChange={(e) => { const f = e.target.files?.[0]; if (f) open(f); }} disabled={!!busy || !lib} />
          <strong>{busy ?? (lib ? 'Släpp filen här (PDF, PNG eller JPG) eller klicka för att välja' : 'Laddar …')}</strong>
        </label>
        {pick && (
          <div className="pagepick">
            <p>PDF:en har {pick.n} sidor. Vilken sida vill du ändra?</p>
            {pick.n <= 40
              ? <div>{Array.from({ length: pick.n }, (_, i) => <button key={i} onClick={() => openPage(pick.name, pick.bytes, i)}>Sida {i + 1}</button>)}</div>
              : <select aria-label="Välj sida" defaultValue="" onChange={(e) => e.target.value && openPage(pick.name, pick.bytes, Number(e.target.value))}>
                  <option value="" disabled>Välj sida (1–{pick.n})</option>
                  {Array.from({ length: pick.n }, (_, i) => <option key={i} value={i}>Sida {i + 1}</option>)}
                </select>}
          </div>
        )}
        <ModelPick model={model} setModel={setModel} disabled={!!busy} />
        {error && <div className="error" role="alert">{error}</div>}
      </div>
    );

  return (
    <div className="app">
      <header>
        <h1>PDF-ändraren</h1>
        <span className="fname">{file.name}.{file.image.mode === 'image' ? (file.image.format === 'png' ? 'png' : 'jpg') : 'pdf'}</span>
        <div className="seg" role="tablist">
          {(['after', 'before', 'both'] as const).map((k) => (
            <button key={k} role="tab" aria-selected={view === k} className={view === k ? 'on' : ''} onClick={() => setView(k)} disabled={cur === 0 && k !== 'after'}>
              {k === 'after' ? 'Efter' : k === 'before' ? 'Före' : 'Sida vid sida'}
            </button>
          ))}
        </div>
        <button onClick={() => setCur(Math.max(0, cur - 1))} disabled={cur === 0 || !!busy}>Ångra</button>
        <select value={cur} onChange={(e) => setCur(Number(e.target.value))} disabled={!!busy} aria-label="Version">
          {versions.map((x, i) => <option key={i} value={i}>{i === 0 ? 'Original' : `Version ${i}: ${x.label}`}</option>)}
        </select>
        <button className="primary" onClick={() => download()} disabled={!!busy}>{file.image.mode === 'image' ? 'Ladda ner bild' : 'Ladda ner PDF'}</button>
        <button className="link" onClick={() => { setFile(null); setVersions([]); }} disabled={!!busy}>Ny fil</button>
      </header>
      <main>
        <section className={`pages ${view}`}>
          {(view === 'before' || view === 'both') && <Page raster={prev.preview} caption="Före" />}
          {(view === 'after' || view === 'both') && <Page raster={v.preview} caption={view === 'both' ? 'Efter' : undefined} mark={mark} onMark={busy ? undefined : setMark} />}
        </section>
        <aside className="chat">
          <div className="msgs">
            {msgs.map((m, i) => (
              <div key={i} className={`msg ${m.role}`}>
                {m.text}
                {m.notes?.length ? <ul>{m.notes.map((n, k) => <li key={k}>{n}</li>)}</ul> : null}
              </div>
            ))}
            {busy && <div className="msg status"><span className="dot" /> {busy}</div>}
            {error && <div className="error" role="alert">{error}</div>}
          </div>
          <ModelPick model={model} setModel={setModel} disabled={!!busy} compact />
          {mark && <div className="markinfo">Markerat område används. <button className="link" onClick={() => setMark(null)}>Ta bort markeringen</button></div>}
          <form onSubmit={(e) => { e.preventDefault(); send(input); }}>
            <textarea id="msg" value={input} onChange={(e) => setInput(e.target.value)} placeholder="Vad vill du ändra?" rows={3}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input); } }} disabled={!!busy} />
            <button className="primary" type="submit" disabled={!!busy || !input.trim()}>Skicka</button>
          </form>
          {versions.length === 1 && <div className="examples">{EXAMPLES.map((x) => <button key={x} onClick={() => setInput(x)} disabled={!!busy}>{x}</button>)}</div>}
        </aside>
      </main>
    </div>
  );
}

function ModelPick({ model, setModel, disabled, compact }: { model: ModelKey; setModel: (m: ModelKey) => void; disabled?: boolean; compact?: boolean }) {
  return (
    <div className={`modelpick ${compact ? 'compact' : ''}`}>
      <span className="mp-label" id="mp-label">AI-modell</span>
      <div className="seg" role="radiogroup" aria-labelledby="mp-label">
        {(Object.keys(MODELS) as ModelKey[]).map((k) => (
          <button key={k} type="button" role="radio" aria-checked={model === k} className={model === k ? 'on' : ''} onClick={() => setModel(k)} disabled={disabled}>
            {MODELS[k].name}
          </button>
        ))}
      </div>
      <p className="mp-hint">{MODELS[model].hint}</p>
    </div>
  );
}

function Page({ raster, caption, mark, onMark }: { raster: Raster; caption?: string; mark?: Box | null; onMark?: (b: Box | null) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const canvas = useMemo(() => rasterToCanvas(raster), [raster]);
  const [drag, setDrag] = useState<{ x: number; y: number; x2: number; y2: number } | null>(null);
  useEffect(() => {
    const el = ref.current?.querySelector('.cv');
    if (el) { el.innerHTML = ''; canvas.style.width = '100%'; canvas.style.height = 'auto'; canvas.style.display = 'block'; el.appendChild(canvas); }
  }, [canvas]);
  const toImg = (e: React.PointerEvent) => {
    const r = ref.current!.querySelector('.cv')!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * raster.w, y: ((e.clientY - r.top) / r.height) * raster.h };
  };
  const box = drag ? { x0: Math.min(drag.x, drag.x2), y0: Math.min(drag.y, drag.y2), x1: Math.max(drag.x, drag.x2), y1: Math.max(drag.y, drag.y2) } : mark;
  const pct = (b: Box) => ({ left: `${(b.x0 / raster.w) * 100}%`, top: `${(b.y0 / raster.h) * 100}%`, width: `${((b.x1 - b.x0) / raster.w) * 100}%`, height: `${((b.y1 - b.y0) / raster.h) * 100}%` });
  return (
    <figure ref={ref}>
      {caption && <figcaption>{caption}</figcaption>}
      <div className={`stage ${onMark ? 'markable' : ''}`}
        onPointerDown={onMark ? (e) => { (e.target as Element).setPointerCapture?.(e.pointerId); const p = toImg(e); setDrag({ x: p.x, y: p.y, x2: p.x, y2: p.y }); } : undefined}
        onPointerMove={drag ? (e) => { const p = toImg(e); setDrag({ ...drag, x2: p.x, y2: p.y }); } : undefined}
        onPointerUp={drag ? () => { const b = box!; setDrag(null); onMark?.(b.x1 - b.x0 > 6 && b.y1 - b.y0 > 6 ? b : null); } : undefined}>
        <div className="cv" />
        {box && <div className="mark" style={pct(box)} />}
      </div>
    </figure>
  );
}
