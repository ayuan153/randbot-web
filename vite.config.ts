import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import { resolve } from 'path';

export default defineConfig({
  plugins: [preact()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        'inject/hook': resolve(__dirname, 'src/inject/hook.ts'),
        'content/bridge': resolve(__dirname, 'src/content/bridge.ts'),
        'worker/sw': resolve(__dirname, 'src/worker/sw.ts'),
        'eval/eval-worker': resolve(__dirname, 'src/eval/eval-worker.ts'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        format: 'es',
      },
    },
    target: 'esnext',
    minify: false, // easier to debug
  },
});
