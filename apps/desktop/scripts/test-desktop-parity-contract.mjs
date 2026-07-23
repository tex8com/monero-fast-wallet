import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import test from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, '..');
const repoRoot = resolve(desktopRoot, '..', '..');

const appSource = readFileSync(resolve(desktopRoot, 'src', 'App.tsx'), 'utf8');
const parityDoc = readFileSync(resolve(repoRoot, 'docs', 'DESKTOP_PARITY_MATRIX.md'), 'utf8');
const tauriBuild = readFileSync(resolve(desktopRoot, 'src-tauri', 'build.rs'), 'utf8');
const tauriCapability = readFileSync(resolve(desktopRoot, 'src-tauri', 'capabilities', 'main.json'), 'utf8');
const ledgerCorePatch = readFileSync(resolve(repoRoot, 'native', 'desktop-bridge', 'patches', 'monero-ledger-view-key-api.patch'), 'utf8');

test('desktop primary navigation matches the mobile bottom menu contract', () => {
  const primaryMatch = appSource.match(/function primarySections[\s\S]*?return \[([\s\S]*?)\];\s*}/);
  assert.ok(primaryMatch, 'primarySections() must stay explicit and reviewable');

  const ids = [...primaryMatch[1].matchAll(/id: '([^']+)'/g)].map((match) => match[1]);
  assert.deepEqual(ids, ['home', 'send', 'receive', 'community', 'menu']);
});

test('desktop does not expose removed Modules or standalone Fast navigation', () => {
  const primaryMatch = appSource.match(/function primarySections[\s\S]*?return \[([\s\S]*?)\];\s*}/);
  assert.ok(primaryMatch);
  assert.equal(/id: 'fast'/.test(primaryMatch[1]), false);
  assert.equal(/id: 'modules'/.test(primaryMatch[1]), false);
  assert.equal(/\bModules\b/.test(parityDoc), false);
  assert.equal(/\|\s*Fast Wallet\s*\|\s*Fast\s*\|/.test(parityDoc), false);
});

test('desktop parity document records closed-app notification preparation truthfully', () => {
  assert.match(parityDoc, /APNs and private Windows\/Linux background-agent adapters/);
  assert.match(parityDoc, /live closed-app delivery remain release gates/);
  assert.equal(/while app is open implemented; APNs closed-app delivery remains/.test(parityDoc), false);
});

test('desktop Send keeps the same simple two-step primary flow as mobile', () => {
  const sendSource = appSource.slice(appSource.indexOf('function Send('), appSource.indexOf('function Receive('));
  assert.match(appSource, /type SendStep = 'recipient-choice' \| 'manual-recipient' \| 'amount' \| 'review'/);
  assert.match(sendSource, /priority: 'low'/);
  assert.match(sendSource, /setStep\('review'\)/);
  assert.equal(/priority-choice/.test(sendSource), false, 'fee priority must not be a primary send choice');
  assert.equal(/RecentTransactions/.test(sendSource), false, 'recent activity must not distract from the send journey');
});

test('desktop Receive keeps QR and copy primary while address tools stay optional', () => {
  const receiveSource = appSource.slice(appSource.indexOf('function Receive('), appSource.indexOf('function HardwareWalletCard('));
  assert.match(receiveSource, /receive-simple-card/);
  assert.match(receiveSource, /copy-icon-button/);
  assert.match(receiveSource, /showAddressTools/);
  assert.match(receiveSource, /receive\.manageAddresses/);
});

test('desktop keeps the balance summary but removes the transient sync status after Core confirms completion', () => {
  assert.match(appSource, /const showPrimaryWalletCard = Boolean\(walletId\);/);
  assert.match(appSource, /primary-wallet-balance/);
  assert.match(appSource, /!snapshot\?\.synchronized && <div className="primary-wallet-sync">/);
  assert.match(appSource, /className="sync-refresh"/);
  assert.equal(/>\{t\('common\.refresh'\)\}<\/button>/.test(appSource), false);
});

test('desktop dashboard keeps the mobile order: chart, balance, news, then wallet actions', () => {
  const homeSource = appSource.slice(appSource.indexOf('function Home('), appSource.indexOf('function RecentTransactions('));
  const chart = homeSource.indexOf('<section className="market-card">');
  const balance = homeSource.indexOf('home-primary-wallet');
  const news = homeSource.indexOf('<section className="official-updates"');
  const actions = homeSource.indexOf('<section className="home-quick-actions"');
  assert.ok(chart >= 0 && balance > chart && news > balance && actions > news);
});

test('desktop news uses the same TEX8 feed and categories as mobile', () => {
  const newsSource = readFileSync(resolve(desktopRoot, 'src', 'moneroNews.ts'), 'utf8');
  assert.match(newsSource, /https:\/\/xmr\.tex8\.com\/news\/v1\/news\?limit=18/);
  assert.match(newsSource, /'network' \| 'wallet' \| 'ecosystem'/);
  assert.doesNotMatch(appSource, /api\.github\.com\/repos\/monero-project/);
  assert.match(appSource, /const \[newsCategory, setNewsCategory\]/);
  assert.match(appSource, /home\.newsSource/);
});

test('desktop exposes and creates the default-on Ledger Fast Wallet pair', () => {
  const setupSource = appSource.slice(appSource.indexOf('function Setup('), appSource.indexOf('function FastWallets('));
  assert.match(setupSource, /setCreateFastWallet\(next !== 'open'\)/);
  assert.match(setupSource, /createFast: createFastWallet/);
  assert.match(setupSource, /mode === 'create' \|\| mode === 'restore' \|\| mode === 'ledger'/);
  assert.match(appSource, /function isFastWalletRegistration/);
  assert.match(appSource, /fast-wallet-badge/);
  assert.match(appSource, /FAST WALLET · LEDGER/);
});

test('desktop makes Fast Wallet management reachable from saved wallets', () => {
  const walletsSource = appSource.slice(appSource.indexOf('function Wallets('), appSource.indexOf('function LedgerReadOnlySetup('));
  assert.match(walletsSource, /<FastWallets linked=\{linked\} sourceWalletId=\{walletId\} sourceWallet=\{activeWallet\} \/>/);
  assert.match(walletsSource, /Receive-only Fast Wallet/);
  assert.doesNotMatch(appSource, /Ledger Fast Wallet is not available yet/);
});

test('Ledger read-only setup is reachable through Tauri command permissions', () => {
  for (const command of ['enable_ledger_read_only', 'create_ledger_read_only_from_device']) {
    assert.match(tauriBuild, new RegExp(`"${command}"`));
    assert.match(tauriCapability, new RegExp(`"allow-${command.replaceAll('_', '-')}"`));
  }
});

test('Ledger read-only sync consumes the Core-approved view key without reconnecting', () => {
  const bridgeSource = readFileSync(resolve(repoRoot, 'native', 'monero-bridge', 'cpp', 'WalletEngine.cpp'), 'utf8');
  const hostSource = readFileSync(resolve(desktopRoot, 'src-tauri', 'src', 'lib.rs'), 'utf8');
  assert.match(ledgerCorePatch, /hardwarePrivateViewKey/);
  assert.match(bridgeSource, /hardwarePrivateViewKey\(\)/);
  const recoverySource = hostSource.slice(hostSource.indexOf('fn create_ledger_read_only_from_device'), hostSource.indexOf('#\[tauri::command\]\nfn wallet_open_requires_password'));
  assert.equal(/reconnect_hardware\(&export_wallet_id\)/.test(recoverySource), false);
});

test('a Ledger setup reuses its approved view-key export within one Core session', () => {
  assert.match(ledgerCorePatch, /request_view_key_export/);
  assert.match(ledgerCorePatch, /Ledger view-key export reused from the current device session/);
  assert.match(ledgerCorePatch, /Ledger view-key export requested from device/);
  const normalConnection = ledgerCorePatch
    .slice(
      ledgerCorePatch.indexOf('bool  device_ledger::get_secret_keys'),
      ledgerCorePatch.indexOf('bool device_ledger::request_view_key_export'),
    )
    .split('\n')
    .filter(line => !line.startsWith('-'))
    .join('\n');
  assert.doesNotMatch(normalConnection, /INS_GET_KEY, 0x02/);
  assert.match(normalConnection, /Normal connection deliberately receives fake keys/);
});

test('a physical Ledger export can be diagnosed without logging wallet secrets', () => {
  const hostSource = readFileSync(resolve(desktopRoot, 'src-tauri', 'src', 'lib.rs'), 'utf8');
  assert.match(hostSource, /ledger\.view-key-export-requested/);
  assert.match(hostSource, /ledger\.view-key-export-complete/);
  assert.match(hostSource, /ledger\.recovery-session-opened/);
  const ledgerDiagnostics = hostSource.slice(
    hostSource.indexOf('fn create_ledger_read_only_from_open_source'),
    hostSource.indexOf('#[tauri::command]\nfn wallet_open_requires_password'),
  );
  assert.equal(/private_view_key\.clone\(\)/.test(ledgerDiagnostics), false);
  assert.equal(/exported\.address\.clone\(\)/.test(ledgerDiagnostics), false);
});

test('both desktop Ledger read-only flows keep one instruction dialog open until the native export resolves', () => {
  assert.match(appSource, /function LedgerViewKeyExportOverlay\(\)/);
  assert.match(appSource, /This window closes automatically as soon as the Ledger returns the private view key/);
  assert.match(appSource, /setLedgerViewKeyExportPending\(true\)/);
  assert.match(appSource, /setLedgerViewKeyExportPending\(false\); setBusy\(false\);/);
});

test('desktop uses one app-wide unlock boundary before restoring wallet sessions', () => {
  const hostSource = readFileSync(resolve(desktopRoot, 'src-tauri', 'src', 'lib.rs'), 'utf8');
  for (const command of ['app_protection_status', 'set_app_protection_password', 'verify_app_protection_password', 'clear_app_protection_password', 'lock_app']) {
    assert.match(tauriBuild, new RegExp(`"${command}"`));
    assert.match(tauriCapability, new RegExp(`"allow-${command.replaceAll('_', '-')}"`));
  }
  assert.match(appSource, /appProtection\?\.locked !== false/);
  assert.match(appSource, /function AppProtectionGate/);
  assert.match(appSource, /There is no password per wallet/);
  assert.match(hostSource, /fn lock_app\(/);
  assert.match(hostSource, /FastWalletSessionState/);
  assert.match(hostSource, /MONERO_DESKTOP_APP_PROTECTION locked/);
  assert.match(hostSource, /require_app_unlocked\(&protection\)\?/);
});
