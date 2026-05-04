/**
 * Post-build script: copies manifest.json to dist/ with correct paths.
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
manifest.web_accessible_resources[0].resources = ['inject/hook.js', 'eval/eval-worker.js'];

// Write to dist
if (!existsSync(distDir)) mkdirSync(distDir, { recursive: true });
writeFileSync(resolve(distDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

// Copy data files if they exist
const dataDir = resolve(distDir, 'data');
if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
const setsFile = resolve(root, 'data/gen9randombattle.json');
if (existsSync(setsFile)) {
  copyFileSync(setsFile, resolve(dataDir, 'gen9randombattle.json'));
}

console.log('✓ manifest.json and data copied to dist/');
