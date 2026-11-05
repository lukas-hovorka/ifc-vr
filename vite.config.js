import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const modelsDir = path.join(root, 'models');

// web-ifc.wasm se kopíruje do public/wasm, aby ho servíroval dev server i build.
const wasmSrc = path.join(root, 'node_modules', 'web-ifc', 'web-ifc.wasm');
const wasmDir = path.join(root, 'public', 'wasm');
fs.mkdirSync(wasmDir, { recursive: true });
fs.copyFileSync(wasmSrc, path.join(wasmDir, 'web-ifc.wasm'));

/** Instalace jako aplikace (PWA): manifest z barev EBC_UI_vibe a service worker s verzí buildu. */
function pwaPlugin() {
  const tokens = JSON.parse(fs.readFileSync(path.join(root, 'src', 'ebc', 'ebc-tokens.dark.json'), 'utf-8'));
  const manifest = JSON.stringify({
    name: 'IFC VR',
    short_name: 'IFC VR',
    description: 'Prohlížeč modelů IFC ve VR a AR pro Meta Quest 3',
    lang: 'cs',
    start_url: './',
    scope: './',
    display: 'standalone',
    background_color: tokens['color.bg.window'],
    theme_color: tokens['color.bg.chrome'],
    icons: [
      { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: 'icons/icon-maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
      { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }, null, 2);
  const sw = () => fs.readFileSync(path.join(root, 'src', 'sw.js'), 'utf-8').replace("'ifc-vr-__VERSION__'", `'ifc-vr-${Date.now().toString(36)}'`);
  return {
    name: 'pwa',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if ((req.url || '').endsWith('/manifest.webmanifest')) {
          res.setHeader('Content-Type', 'application/manifest+json');
          res.end(manifest);
        } else next();
      });
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'manifest.webmanifest', source: manifest });
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: sw() });
    },
  };
}

/** Seznam a stahování modelů ze složky models/ (jen dev a preview server). */
function modelsPlugin() {
  const handler = (req, res, next) => {
    const url = decodeURIComponent((req.url || '').split('?')[0]);
    if (url.endsWith('/api/models')) {
      fs.mkdirSync(modelsDir, { recursive: true });
      const files = fs.readdirSync(modelsDir)
        .filter((f) => f.toLowerCase().endsWith('.ifc'))
        .map((f) => ({ name: f, size: fs.statSync(path.join(modelsDir, f)).size }))
        .sort((a, b) => a.name.localeCompare(b.name, 'cs'));
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(files));
      return;
    }
    const m = url.match(/\/models\/([^/]+\.ifc)$/i);
    if (m) {
      const file = path.join(modelsDir, path.basename(m[1]));
      if (!fs.existsSync(file)) { res.statusCode = 404; res.end(); return; }
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Length', fs.statSync(file).size);
      fs.createReadStream(file).pipe(res);
      return;
    }
    next();
  };
  return {
    name: 'ifc-models',
    configureServer(server) { server.middlewares.use(handler); },
    configurePreviewServer(server) { server.middlewares.use(handler); },
  };
}

// `vite --mode https` (npm run dev:quest): HTTPS s certifikátem podepsaným sebou samým pro Quest přes Wi-Fi.
export default defineConfig(({ mode }) => ({
  base: './',
  plugins: [...(mode === 'https' ? [basicSsl()] : []), modelsPlugin(), pwaPlugin()],
  server: { host: true, port: 5173 },
  preview: { host: true, port: 4173 },
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
}));
