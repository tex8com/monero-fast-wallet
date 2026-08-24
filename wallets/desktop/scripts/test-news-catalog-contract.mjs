import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import test from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, '..');
const read = (...parts) => readFileSync(resolve(desktopRoot, ...parts), 'utf8');

const news = read('src', 'moneroNews.ts');
const app = read('src', 'App.tsx');
const host = read('src-tauri', 'src', 'lib.rs');
const tauriConfig = read('src-tauri', 'tauri.conf.json');

test('desktop checks the private catalog hash before loading the WebP catalog', () => {
  assert.match(news, /news-catalog-hash/);
  assert.match(news, /fetchCatalogHash\(\)/);
  assert.match(news, /catalogHash/);
  assert.match(news, /imageUrl\?: string/);
  assert.match(host, /\("news-catalog-hash", None\)/);
});

test('desktop only permits the TEX8 WebP prefix and renders it with a local fallback', () => {
  assert.match(news, /https:\/\/cdn\.tex8\.com\/tex8-images\/monero-fast-wallet\/news\/v1\//);
  assert.match(news, /NEWS_IMAGE_URL_PATTERN/);
  assert.match(app, /function NewsCatalogImage/);
  assert.match(app, /item\.imageUrl/);
  assert.match(tauriConfig, /img-src 'self' asset: data: blob: https:\/\/cdn\.tex8\.com/);
});
