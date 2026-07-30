import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDirectory, '..');
const repositoryRoot = path.resolve(desktopRoot, '../..');
const read = relative =>
  fs.readFileSync(path.join(repositoryRoot, relative), 'utf8');

test('desktop uses the shared update lifecycle and official Tauri verifier', () => {
  const adapter = read('apps/desktop/src/appUpdate.ts');
  const host = read('apps/desktop/src-tauri/src/lib.rs');
  const capabilities = read(
    'apps/desktop/src-tauri/capabilities/main.json',
  );
  assert.match(adapter, /packages\/app-update-core\/src\/index/);
  assert.match(adapter, /@tauri-apps\/plugin-updater/);
  assert.match(adapter, /downloadAndInstall/);
  assert.match(adapter, /@tauri-apps\/plugin-process/);
  assert.match(host, /tauri_plugin_updater::Builder::new\(\)\.build\(\)/);
  assert.match(capabilities, /"updater:default"/);
  assert.match(capabilities, /"process:default"/);
});

test('desktop updater cannot be enabled accidentally without release keys', () => {
  const config = JSON.parse(read('config/app-update.json'));
  const releaseTemplate = JSON.parse(
    read('apps/desktop/src-tauri/tauri.updater.example.conf.json'),
  );
  assert.equal(config.desktop.enabled, false);
  assert.equal(releaseTemplate.bundle.createUpdaterArtifacts, true);
  assert.match(
    releaseTemplate.plugins.updater.pubkey,
    /^REPLACE_WITH_THE_OFFLINE_/,
  );
  assert.ok(
    releaseTemplate.plugins.updater.endpoints.every(endpoint =>
      endpoint.startsWith('https://tex8.com/'),
    ),
  );
});

test('mobile and desktop policy is independent of wallet and renderer code', () => {
  const core = read('packages/app-update-core/src/index.ts');
  assert.doesNotMatch(core, /react-native|@tauri-apps|Wallet|private key/i);
  assert.match(core, /rolloutPercentage/);
  assert.match(core, /minimumVersion/);
  assert.match(core, /allowedHosts/);
});
