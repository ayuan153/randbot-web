import { defineConfig, build as viteBuild } from 'vite';
import preact from '@preact/preset-vite';
import { resolve } from 'path';

// Content script must be IIFE (MV3 content scripts can't use ES module imports).
// Other entries use ES format. We use a custom build plugin to run a second
// IIFE build for the content script after the main build.
export default defineConfig({
  plugins: [
    preact(),
    {
      name: 'build-content-script-iife',
      closeBundle: {
        sequential: true,
        order: 'post',
        async handler() {
          await viteBuild({
            plugins: [preact()],
            build: {
              outDir: 'dist',
              emptyOutDir: false,
              rollupOptions: {
                input: {
                  'content/bridge': resolve(__dirname, 'src/content/bridge.ts'),
                },
                output: {
                  entryFileNames: '[name].js',
                  format: 'iife',
                  inlineDynamicImports: true,
                },
              },
              target: 'esnext',
              minify: false,
            },
            configFile: false,
          });
        },
      },
    },
  ],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        'inject/hook': resolve(__dirname, 'src/inject/hook.ts'),
        'worker/sw': resolve(__dirname, 'src/worker/sw.ts'),
        'eval/eval-worker': resolve(__dirname, 'src/eval/eval-worker.ts'),
        'offscreen/eval-host': resolve(__dirname, 'offscreen/eval-host.ts'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        format: 'es',
      },
    },
    target: 'esnext',
    minify: false,
  },
});
