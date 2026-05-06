/**
 * Post-build script: copies manifest.json, offscreen HTML, and data to dist/.
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const distDir = resolve(root, 'dist');

// Read source manifest
const manifest = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf-8'));

// Update paths for built output
manifest.content_scripts[0].js = ['content/bridge.js'];
manifest.background.service_worker = 'worker/sw.js';
manifest.web_accessible_resources[0].resources = [
  'inject/hook.js',
  'eval/eval-worker.js',
  'data/gen9randombattle.json',
  'models/*',
];

// Write manifest to dist
if (!existsSync(distDir)) mkdirSync(distDir, { recursive: true });
writeFileSync(resolve(distDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

// Copy offscreen HTML
const offscreenDir = resolve(distDir, 'offscreen');
if (!existsSync(offscreenDir)) mkdirSync(offscreenDir, { recursive: true });
copyFileSync(resolve(root, 'offscreen/eval.html'), resolve(offscreenDir, 'eval.html'));

// Copy data files
const dataDir = resolve(distDir, 'data');
if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
const setsFile = resolve(root, 'data/gen9randombattle.json');
if (existsSync(setsFile)) {
  copyFileSync(setsFile, resolve(dataDir, 'gen9randombattle.json'));
}

console.log('✓ manifest.json, offscreen HTML, and data copied to dist/');

// Copy ONNX models (graceful if none exist yet)
const modelsDir = resolve(root, 'models');
const distModelsDir = resolve(distDir, 'models');
if (existsSync(modelsDir)) {
  if (!existsSync(distModelsDir)) mkdirSync(distModelsDir, { recursive: true });
  for (const file of readdirSync(modelsDir)) {
    if (file.endsWith('.onnx')) {
      copyFileSync(resolve(modelsDir, file), resolve(distModelsDir, file));
    }
  }
  console.log('✓ ONNX models copied to dist/models/');
} else {
  console.log('ℹ No models/ directory found, skipping model copy');
}
