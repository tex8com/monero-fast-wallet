import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const desktopRoot = join(import.meta.dirname, '..');
const app = readFileSync(join(desktopRoot, 'src/App.tsx'), 'utf8');
const native = readFileSync(join(desktopRoot, 'src-tauri/src/lib.rs'), 'utf8');
const capability = readFileSync(
  join(desktopRoot, 'src-tauri/capabilities/main.json'),
  'utf8',
);

test('desktop settings expose the same fixed clearnet and onion presets as mobile', () => {
  assert.match(app, /fixedMainnetNodeConnection/);
  assert.match(app, /\['clearnet', 'onion'\]/);
  assert.match(app, /settings\.availableNodeAddresses/);
});

test('Community Worker selection crosses a native verified command boundary', () => {
  assert.match(app, /list_community_fast_wallet_workers/);
  assert.match(app, /select_community_fast_wallet_worker/);
  assert.match(native, /verify_community_worker/);
  assert.match(capability, /allow-list-community-fast-wallet-workers/);
  assert.match(capability, /allow-select-community-fast-wallet-worker/);
});

test('the selected Worker is used for Fast Wallet enrollment', () => {
  assert.match(app, /selectedDesktopEnrollmentWorker/);
  assert.match(app, /worker: selectedDesktopEnrollmentWorker/);
});

test('settings link to the complete Monero Name Registry screen', () => {
  assert.match(app, /onOpenMfwNames/);
  assert.match(app, /settings\.mfwRegistry/);
  assert.match(app, /v1ReleaseFeatures\.mfwNameRegistration/);
});
