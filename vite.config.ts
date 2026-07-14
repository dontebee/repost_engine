import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// Two pages: the Repost Engine (index) and PD's Outline Builder (outline).
export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        outline: resolve(__dirname, 'outline.html'),
      },
    },
  },
});
