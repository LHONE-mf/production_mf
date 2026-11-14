/** Deliberately outside the release dist/ and main Android asset source set. */
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
await build({ configFile: false, base: '/', plugins: [react(), tailwindcss()],
  build: { outDir: 'android/app/src/debug/assets/public', emptyOutDir: true,
    rollupOptions: { input: 'tests/android-storage/index.html' } } });
