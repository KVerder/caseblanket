import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `base: './'` keeps the build relocatable (GitHub Pages sub-path, file hosting).
export default defineConfig({
  base: './',
  plugins: [react()],
  worker: { format: 'es' },
  build: { chunkSizeWarningLimit: 1200 },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
