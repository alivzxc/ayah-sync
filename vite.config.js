import { defineConfig } from 'vite';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.config.js';

export default defineConfig({
  plugins: [crx({ manifest })],
  worker: { format: 'es' },
  build: {
    rollupOptions: {
      input: {
        offscreen: 'src/offscreen/offscreen.html',
        youtubeSandbox: 'src/cpu/youtube-sandbox.html',
      },
    },
  },
  server: {
    port: 5190,
    strictPort: true,
  },
});
