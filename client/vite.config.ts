import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
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
