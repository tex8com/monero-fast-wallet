#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const read = relative => readFileSync(path.join(root, relative), 'utf8');

const moneroPatch = read(
  'third_party/monero-patches/0031-wallet-derive-Ledger-key-images-only-for-owned-outputs.patch',
);
const mobile = read('wallets/mobile/src/services/WalletService.ts');
const desktop = read('wallets/desktop/src-tauri/src/lib.rs');
const bridge = read('native/monero-bridge/cpp/WalletEngine.cpp');
const moneroAdditions = moneroPatch
  .split('\n')
  .filter(line => line.startsWith('+') && !line.startsWith('+++'))
  .map(line => line.slice(1))
  .join('\n');

assert.match(
  moneroAdditions,
  /for \(size_t index = 0; index < destination\.m_transfers\.size\(\); \+\+index\)/,
  'Ledger work must scale with locally discovered owned outputs',
);
assert.match(
  moneroAdditions,
  /cryptonote::generate_key_image_helper\(/,
  'each owned output must be bound to a hardware-derived key image',
);
assert.match(
  moneroAdditions,
  /ephemeral\.pub == output_public_key/,
  'hardware key images must be bound to the expected output public key',
);
assert.match(
  moneroAdditions,
  /destination\.import_key_images\([\s\S]*?true\);/,
  'spent state must use Monero trusted-daemon reconciliation',
);
assert.doesNotMatch(
  moneroAdditions,
  /m_transfers\.size\(\) == destination\.m_transfers\.size\(\)/,
  'the hardware cache must not require a prior historical scan',
);

const mobileReconciliation = mobile.slice(
  mobile.indexOf('async reconcileLedgerViewOnlyWallet('),
  mobile.indexOf('async restoreWalletWithNativeSeed('),
);
assert.match(mobileReconciliation, /waitForLedgerLocalScanReady/);
assert.match(mobileReconciliation, /deriving-owned-output-key-images/);
assert.doesNotMatch(
  mobileReconciliation,
  /startRefresh\(hardwareSession\)/,
  'mobile must never refresh the Ledger hardware cache historically',
);

const desktopReconciliation = desktop.slice(
  desktop.indexOf('fn reconcile_ledger_balance('),
  desktop.indexOf('fn ledger_read_only_exists('),
);
assert.match(
  desktopReconciliation,
  /synchronized_wallet_height\(&native\.snapshot\(&view_only_wallet_id\)/,
);
assert.doesNotMatch(
  desktopReconciliation,
  /synchronized_wallet_height\(&native\.snapshot\(&hardware_wallet_id\)/,
  'desktop must not wait for a hardware-wallet historical scan',
);
assert.match(desktop, /!input\.defer_sync\.unwrap_or\(false\)/);

assert.match(bridge, /verifiedOutputCount/);
assert.match(bridge, /verificationDurationMs/);

console.log('Ledger owned-output synchronization contract passed.');
