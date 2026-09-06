import { createReadStream } from 'node:fs';
import { cp } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';
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

export default defineConfig({
  plugins: [react(), mediapipeWasm()],
  build: {
    // the medusa3d chunk intentionally carries three.js and only loads on the
    // stage when a Medusa round starts
    chunkSizeWarningLimit: 700,
  },
  server: {
    host: true,
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
});
