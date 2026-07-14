import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// Three pages: the Repost Engine (index), PD's Outline Builder (outline),
// and the Second Brain synapse explorer (brain).
export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        outline: resolve(__dirname, 'outline.html'),
        brain: resolve(__dirname, 'brain.html'),
      },
    },
  },
});
