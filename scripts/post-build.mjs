/**
 * Post-build script: copies manifest.json, offscreen HTML, and data to dist/.
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from 'fs';
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
