// Vite builds the static app. In development, a small plugin runs the same
// password middleware and /api functions that Vercel runs in production, so
// `npm run dev` behaves like the deployed site.

import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv, type Plugin, type ViteDevServer } from 'vite';
// @ts-expect-error plain JS helper
import { patchCmyk } from './scripts/pdfjs-cmyk.mjs';

const NM = path.resolve(import.meta.dirname, 'node_modules');
/** Files served under /tesseract/ (OCR runs in the browser; nothing comes from a CDN).
 * The language files keep their gzip bytes but are named .wasm, a type every host
 * (incl. Claude artifacts) serves as-is; the OCR worker is told the new name. */
const TESSERACT: Record<string, string> = {
  'worker.min.js': 'tesseract.js/dist/worker.min.js',
  'core/tesseract-core-lstm.wasm.js': 'tesseract.js-core/tesseract-core-lstm.wasm.js',
  'core/tesseract-core-simd-lstm.wasm.js': 'tesseract.js-core/tesseract-core-simd-lstm.wasm.js',
  'core/tesseract-core-relaxedsimd-lstm.wasm.js': 'tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm.js',
  'lang/swe.traineddata.wasm': '@tesseract.js-data/swe/4.0.0_best_int/swe.traineddata.gz',
  'lang/eng.traineddata.wasm': '@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz',
};
/** pdf.js worker, legacy build so older browsers work too (renders pages that aren't one plain picture), served under /pdfjs/. */
const PDFJS: Record<string, string> = { 'pdf.worker.min.mjs': 'pdfjs-dist/legacy/build/pdf.worker.min.mjs' };

/** Copy/serve local assets: OCR (tesseract) and the pdf.js worker. Nothing comes from a CDN. */
function localAssets(): Plugin {
  const sets: [string, Record<string, string>][] = [['tesseract', TESSERACT], ['pdfjs', PDFJS]];
  return {
    name: 'local-assets',
    configureServer(server) {
      for (const [dir, map] of sets)
        server.middlewares.use('/' + dir, (req, res, next) => {
          const rel = map[decodeURIComponent((req.url ?? '').split('?')[0]).replace(/^\//, '')];
          if (!rel) return next();
          res.setHeader('content-type', /\.m?js$/.test(rel) ? 'text/javascript' : 'application/octet-stream');
          res.setHeader('cache-control', 'public, max-age=86400');
          if (dir === 'pdfjs') return void res.end(patchCmyk(fs.readFileSync(path.join(NM, rel), 'utf8')));
          fs.createReadStream(path.join(NM, rel)).pipe(res);
        });
    },
    writeBundle(options) {
      for (const [dir, map] of sets) {
        const out = path.join(options.dir ?? 'dist', dir);
        for (const [to, from] of Object.entries(map)) {
          fs.mkdirSync(path.dirname(path.join(out, to)), { recursive: true });
          // pdf.js: CMYK colours as Acrobat/Chrome show them (see scripts/pdfjs-cmyk.mjs)
          if (dir === 'pdfjs') fs.writeFileSync(path.join(out, to), patchCmyk(fs.readFileSync(path.join(NM, from), 'utf8')));
          else fs.copyFileSync(path.join(NM, from), path.join(out, to));
        }
      }
    },
  };
}

async function toRequest(req: IncomingMessage): Promise<Request> {
  const url = `http://${req.headers.host ?? 'localhost'}${req.url}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
  let body: ArrayBuffer | undefined;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    // read the body once and keep it: the login middleware and the API route both need a Request
    const r = req as IncomingMessage & { _body?: ArrayBuffer };
    if (!r._body) {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const all = Buffer.concat(chunks);
      r._body = all.buffer.slice(all.byteOffset, all.byteOffset + all.byteLength) as ArrayBuffer;
    }
    body = r._body;
  }
  return new Request(url, { method: req.method, headers, body });
}

async function send(res: ServerResponse, r: Response): Promise<void> {
  res.statusCode = r.status;
  r.headers.forEach((v, k) => res.setHeader(k, v));
  if (!r.body) return void res.end();
  // stream through, like Vercel does (the agent route streams its progress)
  const reader = r.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(Buffer.from(value));
  }
  res.end();
}

/** Run middleware.js and api/*.js like Vercel does. */
function vercelDev(): Plugin {
  return {
    name: 'vercel-dev',
    configureServer(server: ViteDevServer) {
      server.middlewares.use(async (req, res, next) => {
        try {
          const pathname = (req.url ?? '/').split('?')[0];
          const isPage = pathname === '/' || pathname === '/index.html';
          // api/_lib/* are shared modules (Vercel never serves them as routes);
          // here Vite serves them to the browser bundle like any source file
          const isApi = /^\/api\/[a-z0-9-]+$/i.test(pathname);
          const open = pathname === '/api/login' || pathname === '/login.html';
          if ((isPage || isApi) && !open) {
            const mw = await server.ssrLoadModule('/middleware.js');
            const r: Response = await mw.default(await toRequest(req));
            if (!r.headers.get('x-middleware-next')) return send(res, r);
          }
          if (isApi) {
            const name = pathname.slice(5);
            const file = path.resolve(import.meta.dirname, 'api', `${name}.js`);
            if (!fs.existsSync(file)) return send(res, Response.json({ error: 'Finns inte.' }, { status: 404 }));
            const mod = await server.ssrLoadModule(`/api/${name}.js`);
            const handler = mod[req.method ?? 'GET'];
            if (!handler) return send(res, Response.json({ error: 'Metoden stöds inte.' }, { status: 405 }));
            return send(res, await handler(await toRequest(req)));
          }
          next();
        } catch (e) {
          console.error(e);
          send(res, Response.json({ error: 'Serverfel i utvecklingsläget.' }, { status: 500 }));
        }
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  // make .env values visible to the dev versions of the API functions
  Object.assign(process.env, loadEnv(mode, process.cwd(), ''));
  return {
    plugins: [react(), localAssets(), vercelDev()],
    build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
    worker: { format: 'es' },
  };
});
