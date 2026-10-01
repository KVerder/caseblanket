import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `base: './'` keeps the build relocatable (GitHub Pages sub-path, file hosting).
export default defineConfig(({ mode }) => ({
  base: './',
  plugins: [react()],
  worker: { format: 'es' },
  build: {
    chunkSizeWarningLimit: 1200,
    // `single` mode keeps everything in one chunk so scripts/single-html.mjs can inline it.
    rolldownOptions: mode === 'single' ? { output: { codeSplitting: false } } : undefined,
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 60000,
  },
}));
