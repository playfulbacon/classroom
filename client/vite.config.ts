import { execSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { cp } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import react from '@vitejs/plugin-react';

// Serve/copy the MediaPipe wasm bundles from node_modules (~34MB — far too
// heavy to commit, and deploy hosts run npm install anyway). Dev: middleware;
// build: copied into dist/mediapipe-wasm.
function mediapipeWasm(): Plugin {
  const require = createRequire(import.meta.url);
  // resolve the main entry (the exports map hides package.json) — it lives in
  // the package root, next to the wasm/ directory
  const wasmDir = path.join(path.dirname(require.resolve('@mediapipe/tasks-vision')), 'wasm');
  const types: Record<string, string> = {
    '.js': 'text/javascript',
    '.wasm': 'application/wasm',
  };
  return {
    name: 'mediapipe-wasm',
    configureServer(server) {
      server.middlewares.use('/mediapipe-wasm', (req, res, next) => {
        const file = path.join(wasmDir, path.basename(req.url ?? ''));
        const type = types[path.extname(file)];
        if (!type) return next();
        res.setHeader('Content-Type', type);
        createReadStream(file)
          .on('error', () => {
            res.statusCode = 404;
            res.end();
          })
          .pipe(res);
      });
    },
    async closeBundle() {
      await cp(wasmDir, path.resolve(import.meta.dirname, 'dist/mediapipe-wasm'), {
        recursive: true,
      });
    },
  };
}

// `vite --mode https` (via `npm run dev:https` at the root) serves dev over
// https with a self-signed cert. Phones only expose the camera to secure
// pages, so Medusa's eye mode over LAN needs this: the stage QR then encodes
// an https:// URL, and each phone accepts the certificate warning once.
// Plain `npm run dev` stays http for everything else. (--mode instead of an
// env var so the script works on Windows too.)
// Baked into the bundle for the 🐞 debug panel, so "is this phone running
// the code I just pulled?" is answerable at a glance. (Fixed at dev-server
// start — restart `npm run dev` after pulling to refresh it.)
function gitVersion(): string {
  try {
    const opts = { stdio: ['ignore', 'pipe', 'ignore'] } as const;
    const hash = execSync('git rev-parse --short HEAD', opts).toString().trim();
    const dirty = execSync('git status --porcelain', opts).toString().trim() ? '*' : '';
    return hash + dirty;
  } catch {
    return 'unknown';
  }
}

export default defineConfig(({ mode }) => {
  const useHttps = mode === 'https' || !!process.env.HTTPS;
  return {
  define: { __APP_VERSION__: JSON.stringify(gitVersion()) },
  plugins: [react(), mediapipeWasm(), ...(useHttps ? [basicSsl()] : [])],
  build: {
    // three.js lands in a lazy chunk (medusaScene) used by the stage
    // renderer (medusa3d) — it must never load eagerly
    chunkSizeWarningLimit: 700,
  },
  server: {
    host: true,
    // `npm run dev:tunnel` fronts the dev server with a Cloudflare quick
    // tunnel so phones get a real https URL (cameras need secure pages).
    allowedHosts: ['.trycloudflare.com'],
    proxy: {
      '/socket.io': {
        target: 'http://localhost:3001',
        ws: true,
      },
      '/art': {
        target: 'http://localhost:3001',
      },
    },
  },
  };
});
