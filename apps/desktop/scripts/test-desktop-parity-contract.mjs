import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import test from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, '..');
const repoRoot = resolve(desktopRoot, '..', '..');

const appSource = readFileSync(resolve(desktopRoot, 'src', 'App.tsx'), 'utf8');
const desktopIconSource = readFileSync(resolve(desktopRoot, 'src', 'DesktopIcon.tsx'), 'utf8');
const i18nSource = readFileSync(resolve(desktopRoot, 'src', 'i18n.tsx'), 'utf8');
const stylesSource = readFileSync(resolve(desktopRoot, 'src', 'styles.css'), 'utf8');
const parityDoc = readFileSync(resolve(repoRoot, 'docs', 'DESKTOP_PARITY_MATRIX.md'), 'utf8');
const tauriBuild = readFileSync(resolve(desktopRoot, 'src-tauri', 'build.rs'), 'utf8');
const tauriCapability = readFileSync(resolve(desktopRoot, 'src-tauri', 'capabilities', 'main.json'), 'utf8');
const secureStoreSource = readFileSync(resolve(desktopRoot, 'src-tauri', 'src', 'secure_store.rs'), 'utf8');
const enthusiastV1Source = readFileSync(resolve(desktopRoot, 'src-tauri', 'src', 'enthusiast_v1.rs'), 'utf8');
const enrollmentSource = readFileSync(resolve(desktopRoot, 'src-tauri', 'src', 'fast_wallet_enrollment.rs'), 'utf8');
const desktopNotificationsSource = readFileSync(resolve(desktopRoot, 'src-tauri', 'src', 'desktop_notifications.rs'), 'utf8');
const desktopRecipientScannerSource = readFileSync(resolve(desktopRoot, 'src', 'DesktopRecipientQrScanner.tsx'), 'utf8');
const desktopInfoPlist = readFileSync(resolve(desktopRoot, 'src-tauri', 'Info.plist'), 'utf8');
const ledgerCorePatch = readFileSync(resolve(repoRoot, 'native', 'desktop-bridge', 'patches', 'monero-ledger-view-key-api.patch'), 'utf8');
const nativeWalletSource = readFileSync(resolve(desktopRoot, 'src-tauri', 'src', 'native_wallet.rs'), 'utf8');
const desktopBridgeHeader = readFileSync(resolve(repoRoot, 'native', 'desktop-bridge', 'include', 'DesktopWalletCore.h'), 'utf8');
const desktopBridgeSource = readFileSync(resolve(repoRoot, 'native', 'desktop-bridge', 'cpp', 'DesktopWalletCore.cpp'), 'utf8');
const walletEngineSource = readFileSync(resolve(repoRoot, 'native', 'monero-bridge', 'cpp', 'WalletEngine.cpp'), 'utf8');
const desktopLedgerBleSource = readFileSync(resolve(repoRoot, 'native', 'desktop-bridge', 'cpp', 'DesktopLedgerBleMac.mm'), 'utf8');
const windowsExports = readFileSync(resolve(desktopRoot, 'windows', 'tex8_wallet_core.def'), 'utf8');

function rustFunction(source, name) {
  const start = source.indexOf(`fn ${name}(`);
  assert.notEqual(start, -1, `missing Rust command ${name}`);
  const nextCommand = source.indexOf('#[tauri::command]', start + 3);
  return source.slice(start, nextCommand === -1 ? source.length : nextCommand);
}

test('desktop primary navigation matches the mobile bottom menu contract', () => {
  const primaryMatch = appSource.match(/function primarySections[\s\S]*?return \[([\s\S]*?)\];\s*}/);
  assert.ok(primaryMatch, 'primarySections() must stay explicit and reviewable');

  const ids = [...primaryMatch[1].matchAll(/id: '([^']+)'/g)].map((match) => match[1]);
  assert.deepEqual(ids, ['home', 'send', 'receive', 'enthusiast', 'menu']);
  const icons = [...primaryMatch[1].matchAll(/icon: '([^']+)'/g)].map((match) => match[1]);
  assert.deepEqual(icons, ['home', 'send', 'receive', 'community-tab', 'menu']);
  assert.doesNotMatch(primaryMatch[1], /[⌂↑↓◎☰]/, 'platform-dependent text glyphs are not navigation icons');
  assert.match(appSource, /active=\{primaryNavigationSection\(section\)\}/);
  assert.match(appSource, /new Set\(\['wallets', 'mfw', 'assistant', 'settings'\]\)/);
  for (const icon of ['home', 'send', 'receive', 'community-tab', 'menu']) {
    assert.match(desktopIconSource, new RegExp(`case '${icon}'`));
  }
});

test('desktop counts complete wallet balances once and delays wallet scan UI until ready', () => {
  assert.match(walletEngineSource, /wallet->numSubaddressAccounts\(\)/);
  assert.match(walletEngineSource, /next\.balanceAtomic \+= balance/);
  assert.doesNotMatch(walletEngineSource, /next\.balanceAtomic = wallet->balance\(0\)/);
  assert.match(appSource, /const selectedSnapshot = wallet\?\.id/);
  assert.match(appSource, /const balanceAtomic = atomicValue\(selectedSnapshot\?\.balanceAtomic\)\.toString\(\)/);
  assert.match(appSource, /const showWalletSync = connected && walletOpened/);
  assert.match(appSource, /showWalletSync && <DesktopSyncProgressRow/);
});

test('desktop Menu exposes every React Native Menu destination without release-flag hiding', () => {
  const menuSource = appSource.slice(
    appSource.indexOf('function DesktopMenu('),
    appSource.indexOf('function marketChartTimestamp('),
  );

  for (const destination of ['wallets', 'mfw', 'enthusiast', 'settings', 'assistant']) {
    assert.match(menuSource, new RegExp(`section: '${destination}'`));
  }
  assert.match(menuSource, /section: 'settings', icon: 'globe'/, 'Node status must remain available');
  for (const icon of ['wallet', 'key', 'community-menu', 'settings', 'sparkles', 'globe']) {
    assert.match(menuSource, new RegExp(`icon: '${icon}'`));
  }
  assert.doesNotMatch(menuSource, /[◈＠◎⚙✦◌]/, 'desktop menu must use the mobile SVG icon family');
  assert.doesNotMatch(menuSource, /v1ReleaseFeatures\.(mfwNameRegistration|assistant)/);
  assert.match(appSource, /section === 'mfw' && <MfwNames/);
  assert.match(appSource, /section === 'assistant' && <Assistant/);
});

test('narrow desktop windows keep the same bottom-navigation behavior as mobile', () => {
  const narrowStart = stylesSource.indexOf('@media (max-width: 820px)');
  assert.notEqual(narrowStart, -1);
  const narrowStyles = stylesSource.slice(narrowStart, stylesSource.indexOf('.mfw-names-page', narrowStart));
  assert.match(narrowStyles, /\.sidebar\s*\{[^}]*position:\s*fixed/);
  assert.match(narrowStyles, /\.sidebar\s*\{[^}]*bottom:\s*0/);
  assert.match(narrowStyles, /\.content\s*\{[^}]*padding:[^;}]*94px/);
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

test('desktop Send keeps the same simple recipient-first flow as mobile', () => {
  const sendSource = appSource.slice(appSource.indexOf('function Send('), appSource.indexOf('function Receive('));
  assert.match(appSource, /type SendStep = 'recipient-choice' \| 'manual-recipient' \| 'address-book' \| 'amount' \| 'review'/);
  assert.match(sendSource, /priority: 'low'/);
  assert.match(sendSource, /setStep\('review'\)/);
  assert.match(sendSource, /saveRecipientContacts/);
  assert.match(sendSource, /recentContacts\.map/);
  assert.match(sendSource, /Donation stays first/);
  assert.match(sendSource, /validate_recipient_address/);
  assert.match(sendSource, /validateAndUseRecipient/);
  assert.match(sendSource, /send-choice-card primary-choice/);
  assert.match(sendSource, /setScannerOpen\(true\)/);
  assert.ok(
    sendSource.indexOf('send-choice-card primary-choice') < sendSource.indexOf("setStep('manual-recipient')"),
    'QR scanning must be the first, primary recipient choice like mobile',
  );
  assert.match(sendSource, /send-keypad/);
  assert.equal(/priority-choice/.test(sendSource), false, 'fee priority must not be a primary send choice');
  assert.equal(/RecentTransactions/.test(sendSource), false, 'recent activity must not distract from the send journey');
});

test('desktop recipient scanning uses the Mac webcam without depending on BarcodeDetector', () => {
  assert.match(desktopRecipientScannerSource, /navigator\.mediaDevices\?\.getUserMedia/);
  assert.match(desktopRecipientScannerSource, /import jsQR from 'jsqr'/);
  assert.match(desktopRecipientScannerSource, /context\.getImageData/);
  assert.match(desktopRecipientScannerSource, /jsQR\(pixels\.data/);
  assert.doesNotMatch(desktopRecipientScannerSource, /new BarcodeDetector|window[^\n]*BarcodeDetector/);
  assert.match(desktopInfoPlist, /NSCameraUsageDescription/);
  assert.match(stylesSource, /\.camera-scanner-overlay\s*\{[^}]*position:\s*fixed/);
  assert.match(stylesSource, /\.camera-scanner-dialog\s*\{[^}]*min-height:\s*calc\(100dvh - 36px\)/);
});

test('desktop MFW address derivation stays native and disabled until Mainnet parameters are frozen', () => {
  const hostSource = readFileSync(resolve(desktopRoot, 'src-tauri', 'src', 'lib.rs'), 'utf8');
  const verifySource = rustFunction(hostSource, 'verify_mfw_name_record_address');
  assert.match(tauriBuild, /"verify_mfw_name_record_address"/);
  assert.match(tauriCapability, /"allow-verify-mfw-name-record-address"/);
  assert.match(verifySource, /release_features::require\(\s*"mfwNameResolution"/);
  assert.match(
    verifySource,
    /tex8_mfw_verify_and_encode_name_address_v1/,
  );
  assert.match(verifySource, /validate_recipient_address\(&address, network\)/);
});

test('desktop Receive keeps QR and copy primary while address tools stay optional', () => {
  const receiveSource = appSource.slice(appSource.indexOf('function Receive('), appSource.indexOf('function HardwareWalletCard('));
  assert.match(receiveSource, /receive-simple-card/);
  assert.match(receiveSource, /copy-icon-button/);
  assert.match(receiveSource, /showAddressTools/);
  assert.match(receiveSource, /receive\.manageAddresses/);
  assert.match(receiveSource, /invoke<string>\('list_subaddresses'/);
  assert.match(receiveSource, /manageAddressesRequest\?\.walletId === wallet\?\.id/);
  const walletsSource = appSource.slice(appSource.indexOf('function Wallets('), appSource.indexOf('function LedgerViewKeyExportOverlay('));
  assert.match(walletsSource, /onManageAddresses\(wallet\)/);
});

test('desktop keeps the balance summary and separate collapsible blockchain and wallet progress', () => {
  const homeSource = appSource.slice(appSource.indexOf('function Home('), appSource.indexOf('function RecentTransactions('));
  assert.match(appSource, /const showPrimaryWalletCard = Boolean\(walletId\);/);
  assert.match(homeSource, /primary-wallet-balance/);
  assert.match(homeSource, /<DesktopSyncProgress/);
  assert.match(appSource, /data-testid="sync-status-popup"/);
  assert.match(appSource, /const blockchainCurrent =/);
  assert.doesNotMatch(appSource, /walletProvesCurrentDownload/);
  assert.match(appSource, /const blockchainPercent = network\.ready \? 100 : network\.progress \?\? 0/);
  assert.match(appSource, /blockchainPercent === 100 \? t\('home\.syncComplete'\)/);
  assert.match(appSource, /home\.blockchainData/);
  assert.match(appSource, /home\.walletScan/);
  assert.match(appSource, /className="sync-refresh"/);
  assert.match(appSource, /className=\{`desktop-sync-status-card \$\{expanded \? 'expanded' : 'collapsed'\}`\}/);
  assert.match(homeSource, /wallet-mini-sync/);
  assert.match(homeSource, /syncStartHeightsRef\.current\.get\(item\.id\)/);
  assert.ok(
    homeSource.indexOf('<DesktopSyncProgress') < homeSource.indexOf('<section className="market-card">'),
    'the persistent sync status must stay above the market card like mobile',
  );
  assert.equal(/>\{t\('common\.refresh'\)\}<\/button>/.test(homeSource), false);
});

test('desktop renderer may read the authoritative shared network-sync status', () => {
  assert.match(appSource, /invoke<string>\('network_sync_status'/);
  assert.match(tauriBuild, /"network_sync_status"/);
  assert.match(tauriCapability, /"allow-network-sync-status"/);
});

test('desktop dashboard keeps the mobile order: chart, balance, news, then wallet actions', () => {
  const homeSource = appSource.slice(appSource.indexOf('function Home('), appSource.indexOf('function RecentTransactions('));
  const chart = homeSource.indexOf('<section className="market-card">');
  const balance = homeSource.indexOf('home-primary-wallet');
  const news = homeSource.indexOf('<section className="official-updates"');
  const actions = homeSource.indexOf('<section className="home-quick-actions"');
  assert.ok(chart >= 0 && balance > chart && news > balance && actions > news);
});

test('desktop computes sync percentage from the wallet restore range, never the full chain', () => {
  const homeSource = appSource.slice(appSource.indexOf('function Home('), appSource.indexOf('function RecentTransactions('));
  assert.match(homeSource, /syncStartHeightForWallet\(\s*wallet\?\.restoreHeight,/);
  assert.match(homeSource, /presentWalletSync\(selectedSnapshot, \{ startHeight: syncStartHeight \}\)/);
  assert.match(appSource, /sync\.phase === 'finalizing' \? 99/);
});

test('desktop news uses the same TEX8 feed and categories as mobile', () => {
  const newsSource = readFileSync(resolve(desktopRoot, 'src', 'moneroNews.ts'), 'utf8');
  assert.match(newsSource, /https:\/\/xmr\.tex8\.com\/news\/v1\/news\?limit=18/);
  assert.match(newsSource, /'network' \| 'wallet' \| 'ecosystem'/);
  assert.doesNotMatch(appSource, /api\.github\.com\/repos\/monero-project/);
  assert.match(appSource, /const \[newsCategory, setNewsCategory\]/);
  assert.match(appSource, /home\.newsSource/);
});

test('desktop Community mirrors mobile automatic coarse-location loading without a retry control', () => {
  const communitySource = appSource.slice(
    appSource.indexOf('function Community()'),
    appSource.indexOf('function Settings('),
  );
  assert.match(communitySource, /locationRefreshStarted/);
  assert.match(communitySource, /getCurrentPosition\(\{ enableHighAccuracy: false/);
  assert.match(communitySource, /approximateAreaForCoordinates/);
  assert.match(communitySource, /Exact coordinates were discarded/);
  assert.match(stylesSource, /\.community-page > header \.secondary \{ display: none; \}/);
});

test('desktop persists the Fast Wallet default and exposes the choice for create, restore, and Ledger setup', () => {
  const setupSource = appSource.slice(appSource.indexOf('function Setup('), appSource.indexOf('function FastWallets('));
  const fastSource = appSource.slice(appSource.indexOf('function FastWallets('), appSource.indexOf('function WalletFeature('));
  assert.match(appSource, /loadFastWalletPreference/);
  assert.match(appSource, /saveFastWalletPreference/);
  assert.match(setupSource, />Fast Wallet</);
  assert.match(setupSource, /Also reserve Ledger account 1 as a separate Fast Wallet address/);
  assert.match(setupSource, /Also create a separate local wallet with its own recovery words/);
  assert.match(setupSource, /const fastChoice =/);
  assert.match(setupSource, /\{fastChoice\}/);
  assert.match(appSource, /createFastWalletAfterBackup/);
  assert.match(appSource, /pendingFastWalletSourceRef/);
  assert.match(fastSource, /create_fast_wallet/);
  assert.match(fastSource, /restore_fast_wallet_with_native_seed/);
  assert.match(fastSource, /present_fast_wallet_recovery_seed/);
  assert.match(fastSource, /complete balance and history are rebuilt and verified on this device/);
  assert.match(appSource, /function isFastWalletRegistration/);
  assert.match(appSource, /fast-wallet-badge/);
  assert.match(appSource, /wallet\.kind === 'hardware' \? `Fast Wallet ·/);
});

test('desktop wallet-mode choices cannot collapse into an unreadable grid column', () => {
  const styles = readFileSync(resolve(desktopRoot, 'src', 'styles.css'), 'utf8');
  assert.match(styles, /\.setup-preference-row\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/);
  assert.match(styles, /\.setup-preference-row\s*\{[^}]*min-width:\s*0/);
  assert.match(styles, /\.setup-preference-copy\s*\{[^}]*min-width:\s*0/);
  assert.match(styles, /\.setup-preference-copy small\s*\{[^}]*overflow-wrap:\s*anywhere/);
  assert.match(styles, /input\[type="checkbox"\]\s*\{[^}]*width:\s*42px\s*!important/);
});

test('desktop presents private and Fast Wallets in one mobile-parity wallet list', () => {
  const walletsSource = appSource.slice(appSource.indexOf('function Wallets('), appSource.indexOf('function LedgerReadOnlySetup('));
  const receiveSource = appSource.slice(appSource.indexOf('function Receive('), appSource.indexOf('function HardwareWalletCard('));
  assert.doesNotMatch(walletsSource, /<FastWallets/);
  assert.match(appSource, /<FastWalletReceive appProtection=\{appProtection\} \/>/);
  assert.match(receiveSource, /function FastWalletReceive/);
  assert.match(receiveSource, /Fast Wallet addresses/);
  assert.match(receiveSource, /Address copied/);
  assert.match(appSource, /const managedWallets = useMemo/);
  assert.match(appSource, /\.map\(fastWalletAsRegistration\)/);
  assert.match(walletsSource, /wallets\.map\(\(wallet\)/);
  assert.match(walletsSource, /Receive quickly/);
  assert.match(walletsSource, /fast-wallet-badge/);
  assert.doesNotMatch(appSource, /Independent local wallets|Independent wallets|FastWalletPreview|FastWalletWalletRows/);
  assert.doesNotMatch(appSource, /Ledger Fast Wallet is not available yet/);
});

test('desktop uses the same two-row sync status structure as React Native', () => {
  const styles = readFileSync(resolve(desktopRoot, 'src', 'styles.css'), 'utf8');
  const syncSource = appSource.slice(appSource.indexOf('function DesktopSyncProgress('), appSource.indexOf('function Home('));
  assert.match(syncSource, /testId="blockchain-progress"/);
  assert.match(syncSource, /testId="wallet-progress"/);
  assert.match(syncSource, /home\.blockchainData/);
  assert.match(syncSource, /home\.walletScan/);
  assert.match(syncSource, /const fullySynced =/);
  assert.match(syncSource, /useState\(\(\) => !fullySynced\)/);
  assert.match(syncSource, /data-testid="sync-status-toggle"/);
  assert.match(syncSource, /aria-expanded=\{expanded\}/);
  assert.match(syncSource, /data-testid="sync-status-details"/);
  assert.match(syncSource, /networkStatus\?\.phaseElapsedMs/);
  assert.match(syncSource, /home\.syncStartingConnectionElapsed/);
  assert.doesNotMatch(syncSource, /syncWalletsTogether|walletCount/);
  assert.match(styles, /\.desktop-sync-status-card \.primary-wallet-sync\s*\{[^}]*grid-template-columns:\s*1fr/);
  assert.match(styles, /\.desktop-sync-status-card \.desktop-sync-progress \+ \.desktop-sync-progress\s*\{[^}]*border-top:\s*1px/);
  assert.match(styles, /\.desktop-sync-status-card\.collapsed\s*\{/);
  assert.match(styles, /\.desktop-sync-status-toggle\s*\{/);
});

test('Ledger read-only setup and spent-output reconciliation are reachable through Tauri command permissions', () => {
  for (const command of ['enable_ledger_read_only', 'create_ledger_read_only_from_device', 'reconcile_ledger_balance', 'registered_wallet_snapshots', 'registered_wallet_transactions']) {
    assert.match(tauriBuild, new RegExp(`"${command}"`));
    assert.match(tauriCapability, new RegExp(`"allow-${command.replaceAll('_', '-')}"`));
  }
  const hostSource = readFileSync(resolve(desktopRoot, 'src-tauri', 'src', 'lib.rs'), 'utf8');
  const reconcileSource = rustFunction(hostSource, 'reconcile_ledger_balance');
  assert.match(reconcileSource, /sync_ledger_key_images/);
  assert.match(reconcileSource, /ledger_key_images_verified_height/);
  assert.match(reconcileSource, /flow", "owned-outputs-only"/);
  assert.match(
    reconcileSource,
    /synchronized_wallet_height\(&native\.snapshot\(&view_only_wallet_id\)/,
    'Ledger reconciliation must wait only for the local view-wallet scan',
  );
  assert.doesNotMatch(
    reconcileSource,
    /synchronized_wallet_height\(&native\.snapshot\(&hardware_wallet_id\)/,
    'the physical Ledger must never repeat the historical blockchain scan',
  );
  assert.match(appSource, /activeLedgerNeedsAutomaticVerification/);
  assert.match(appSource, /MONERO_DESKTOP_LEDGER_AUTO_VERIFICATION_FAILED/);
  assert.match(appSource, /Remember Ledger for viewing/);
  assert.doesNotMatch(appSource, /Show Ledger balance/);
  assert.match(hostSource, /registration_id: registration\.id\.clone\(\)/);
  assert.match(
    hostSource,
    /uses_ledger_read_only: snapshot_registration\.kind == "view-only"/,
    'snapshot provenance must distinguish a live Ledger from its local read-only companion',
  );
  assert.match(appSource, /wallet\.kind !== 'view-only'/);
  assert.match(appSource, /desktopLedgerBalanceNeedsVerification/);
  assert.match(
    appSource,
    /deferSync: persistLedgerViewOnly/,
    'Ledger setup with a local view companion must not schedule hardware refresh',
  );
  assert.match(
    appSource,
    /if \(wallet\.kind !== 'hardware'\) return false;[\s\S]*if \(!usesLedgerReadOnly\) return true;/,
    'a directly connected Ledger balance must stay excluded until encrypted view-key storage and signed key images verify it',
  );
});

test('desktop Ledger Bluetooth discovery never blocks or re-enters the AppKit main queue', () => {
  const hostSource = readFileSync(resolve(desktopRoot, 'src-tauri', 'src', 'lib.rs'), 'utf8');
  const commandSource = rustFunction(hostSource, 'ledger_transport_status');
  assert.match(commandSource, /spawn_blocking/);
  assert.match(desktopLedgerBleSource, /ledgerBleQueue\(\)/);
  assert.doesNotMatch(desktopLedgerBleSource, /dispatch_sync\(dispatch_get_main_queue/);
  assert.doesNotMatch(desktopLedgerBleSource, /queue:dispatch_get_main_queue\(\)/);
});

test('desktop Ledger wallet creation cannot block the AppKit main thread', () => {
  const hostSource = readFileSync(resolve(desktopRoot, 'src-tauri', 'src', 'lib.rs'), 'utf8');
  const commandSource = rustFunction(hostSource, 'create_hardware_wallet');
  assert.match(hostSource, /async fn create_hardware_wallet/);
  assert.match(commandSource, /spawn_blocking/);
  assert.match(commandSource, /\.await/);
  assert.match(commandSource, /require_app_unlocked/);
});

test('macOS Ledger BLE prepares the protocol before reporting the device ready', () => {
  assert.match(desktopLedgerBleSource, /kLedgerBleGetMtuTag = 0x08/);
  assert.match(desktopLedgerBleSource, /120 \* NSEC_PER_MSEC/);
  assert.match(desktopLedgerBleSource, /maximumWriteValueLengthForType/);
  assert.match(desktopLedgerBleSource, /framesForCommand\(command, frameSize\)/);
  assert.match(desktopLedgerBleSource, /const BOOL connected = \[transport connect\]/);
  assert.match(desktopLedgerBleSource, /payload\[@"available"\] = @\(connected\)/);
  assert.match(desktopLedgerBleSource, /protocolMtu\.fallback/);
});

test('Ledger Fast Wallet is release-gated before reading anything from Ledger', () => {
  const hostSource = readFileSync(resolve(desktopRoot, 'src-tauri', 'src', 'lib.rs'), 'utf8');
  const ledgerFastSource = rustFunction(hostSource, 'enable_ledger_fast_wallet');
  assert.match(ledgerFastSource, /release_features::require\(\s*"ledgerFastWallet"/);
  assert.match(ledgerFastSource, /disabled by release configuration/);
  assert.ok(
    ledgerFastSource.indexOf('release_features::require') <
      ledgerFastSource.indexOf('export_hardware_private_view_key'),
  );
});

test('renderer exposes Ledger Fast Wallet enrollment only through Ledger setup', () => {
  const setupSource = appSource.slice(appSource.indexOf('function Setup('), appSource.indexOf('function FastWallets('));
  assert.match(setupSource, /createFast: createFastWallet/);
  assert.match(setupSource, /Also reserve Ledger account 1 as a separate Fast Wallet address/);
  assert.doesNotMatch(setupSource, /Ledger Fast Wallet is not available yet/);
});

test('Ledger setup explicitly offers encrypted local private-view-key storage', () => {
  const setupSource = appSource.slice(appSource.indexOf('function Setup('), appSource.indexOf('function FastWallets('));
  assert.match(setupSource, /persistLedgerViewOnly/);
  assert.match(setupSource, /Remember Ledger for viewing/);
  assert.match(setupSource, /Keep an encrypted, read-only wallet on this device/);
  assert.match(setupSource, /mode === 'ledger' && persistLedgerViewOnly/);
  assert.match(setupSource, /invoke<WalletOperationResponse>\('enable_ledger_read_only'/);
  assert.match(setupSource, /sourceWalletId: result\.walletId/);
  assert.match(setupSource, /sourceRegistrationId: result\.wallet\.id/);
  assert.match(setupSource, /ledgerViewKeyExportPending && <LedgerViewKeyExportOverlay/);
});

test('desktop native bridge enables the authenticated TEX8 Ledger extension', () => {
  const buildSource = readFileSync(resolve(desktopRoot, 'src-tauri', 'build.rs'), 'utf8');
  assert.match(buildSource, /contains\("hardwarePrivateViewKey"\)/);
  assert.match(buildSource, /TEX8_WALLET_BRIDGE_WITH_TEX8_EXTENSIONS", Some\("1"\)/);
});

test('legacy plaintext scanner registration fails closed before producing credentials', () => {
  const hostSource = readFileSync(resolve(desktopRoot, 'src-tauri', 'src', 'lib.rs'), 'utf8');
  const enableSource = rustFunction(hostSource, 'enable_fast_wallet');
  assert.match(
    enableSource,
    /release_features::require\(\s*"plaintextFastWalletHosting"/,
  );
  assert.ok(
    enableSource.indexOf('release_features::require') <
      enableSource.indexOf('register_fast_wallet_with_scanner'),
  );
  assert.doesNotMatch(appSource, /enable_fast_wallet|scannerAuthToken|scannerToken|Scanner token/);
});

test('desktop encrypted Worker enrollment stays native, pinned, and separately authorized', () => {
  const hostSource = readFileSync(resolve(desktopRoot, 'src-tauri', 'src', 'lib.rs'), 'utf8');
  for (const command of [
    'pair_private_fast_wallet_worker',
    'enable_encrypted_fast_wallet_alerts',
    'turn_off_fast_wallet_alerts',
    'delete_hosted_fast_wallet_data',
    'restore_fast_wallet_with_native_seed',
    'present_fast_wallet_recovery_seed',
    'wallet_open_requires_password',
  ]) {
    assert.match(tauriBuild, new RegExp(`"${command}"`));
    assert.match(tauriCapability, new RegExp(`"allow-${command.replaceAll('_', '-')}"`));
  }
  const enableSource = rustFunction(hostSource, 'enable_encrypted_fast_wallet_alerts');
  const pairSource = rustFunction(hostSource, 'pair_private_fast_wallet_worker');
  assert.match(enableSource, /seed_backup_status != "verified"/);
  assert.match(enableSource, /require_fresh_app_authorization/);
  assert.match(enableSource, /seal_fast_receive_watch/);
  assert.match(enableSource, /fast_wallet_enrollment::submit_watch/);
  assert.doesNotMatch(enableSource, /private_view_key|fast_receive_registration_payload/);
  assert.match(pairSource, /verify_private_worker_qr/);
  assert.match(pairSource, /require_fresh_app_authorization/);
  assert.match(enrollmentSource, /WorkerDescriptor::decode/);
  assert.match(enrollmentSource, /compiled_official_root/);
  assert.match(enrollmentSource, /redirect\(Policy::none\(\)\)/);
  assert.match(enrollmentSource, /WATCH_ENVELOPE_SIZE/);
  assert.match(secureStoreSource, /store_fast_wallet_assignment_state/);
  assert.match(secureStoreSource, /store_fast_wallet_private_worker/);
});

test('desktop shows orange transfer state before enrollment and green only after server acceptance', () => {
  const flowStart = appSource.indexOf('const completeRecoverySeedBackup = async () =>');
  const flowEnd = appSource.indexOf('const closeActiveWallet = useCallback', flowStart);
  const flow = appSource.slice(flowStart, flowEnd);
  const transferring = flow.indexOf("setFastWalletTransferStatus('transferring')");
  const enrollment = flow.indexOf("invoke<FastWalletRecord>('enable_encrypted_fast_wallet_alerts'");
  const accepted = flow.indexOf("setFastWalletTransferStatus('accepted')");

  assert.ok(transferring >= 0 && enrollment > transferring && accepted > enrollment);
  assert.match(flow, /else if \(v1ReleaseFeatures\.officialWorker\)/);
  assert.match(appSource, /function FastWalletTransferOverlay/);
  assert.match(appSource, /Cuprate scan service accepted the encrypted view key/);
  assert.match(stylesSource, /\.fast-wallet-transfer-state\.accepted/);
  assert.match(stylesSource, /background:\s*#25d98b/);
  assert.match(stylesSource, /background:\s*#ff9d18/);
  const receiveSource = appSource.slice(appSource.indexOf('function FastWalletReceive('), appSource.indexOf('function HardwareWalletCard('));
  const deferredTransfer = receiveSource.indexOf("status: 'transferring'");
  const deferredEnrollment = receiveSource.indexOf("invoke<FastWalletRecord>('enable_encrypted_fast_wallet_alerts'");
  const deferredAccepted = receiveSource.indexOf("status: 'accepted'");
  assert.ok(deferredTransfer >= 0 && deferredEnrollment > deferredTransfer && deferredAccepted > deferredEnrollment);
  assert.match(receiveSource, /fast-wallet-inline-transfer/);
});

test('desktop alerts use simple language and keep opt-out, hosted deletion, and local removal separate', () => {
  const fastSource = appSource.slice(appSource.indexOf('function FastWallets('), appSource.indexOf('function WalletFeature('));
  assert.match(fastSource, /Use recommended TEX8 scan service/);
  assert.match(fastSource, /Use my own scan service/);
  assert.match(fastSource, /Alerts on/);
  assert.match(fastSource, /Setting up/);
  assert.match(fastSource, /Needs attention/);
  assert.match(fastSource, /Turn all alerts off/);
  assert.match(fastSource, /Delete hosted scan data/);
  assert.match(fastSource, /Remove empty Fast Wallet/);
  assert.match(fastSource, /v1ReleaseFeatures\.officialWorker/);
  assert.match(fastSource, /v1ReleaseFeatures\.privateWorkerPairing/);
  assert.doesNotMatch(fastSource, /relayOrigin|workerRootId|assignmentEpoch|watchMessageId/);
});

test('desktop notification service origin is immutable build configuration', () => {
  assert.match(tauriBuild, /FAST_WALLET_GATEWAY_ORIGIN/);
  assert.match(tauriBuild, /officialWorker requires FAST_WALLET_OFFICIAL_WORKER_ROOT_ID/);
  assert.match(desktopNotificationsSource, /option_env!\("TEX8_FAST_WALLET_GATEWAY_ORIGIN"\)/);
  assert.doesNotMatch(desktopNotificationsSource, /std::env::var\("TEX8_NOTIFICATION_SERVICE_URL"\)/);
});

test('desktop records the exact encrypted Fast Wallet enrollment phase without logging secrets', () => {
  const hostSource = readFileSync(resolve(desktopRoot, 'src-tauri', 'src', 'lib.rs'), 'utf8');
  const enrollment = rustFunction(hostSource, 'enable_encrypted_fast_wallet_alerts');
  assert.match(enrollment, /fast-wallet\.enrollment-started/);
  assert.match(enrollment, /fast-wallet\.enrollment-accepted/);
  assert.match(enrollment, /fast-wallet\.enrollment-failed/);
  for (const phase of ['release-gate', 'authorization', 'notification-installation', 'notification-gateway', 'worker-descriptor', 'assignment', 'credential', 'encryption', 'relay-upload']) {
    assert.match(enrollment, new RegExp(phase));
  }
  assert.doesNotMatch(enrollment, /private_view_key|recovery_seed|spend_key|envelope\s*\.clone/);
});

test('Ledger read-only sync consumes the Core-approved view key without reconnecting', () => {
  const bridgeSource = readFileSync(resolve(repoRoot, 'native', 'monero-bridge', 'cpp', 'WalletEngine.cpp'), 'utf8');
  const hostSource = readFileSync(resolve(desktopRoot, 'src-tauri', 'src', 'lib.rs'), 'utf8');
  assert.match(ledgerCorePatch, /hardwarePrivateViewKey/);
  assert.match(bridgeSource, /hardwarePrivateViewKey\(\)/);
  const recoverySource = hostSource.slice(hostSource.indexOf('fn create_ledger_read_only_from_device'), hostSource.indexOf('#\[tauri::command\]\nfn wallet_open_requires_password'));
  assert.equal(/reconnect_hardware\(&export_wallet_id\)/.test(recoverySource), false);
});

test('native wallet close stops public refresh work before storing the cache', () => {
  const bridgeSource = readFileSync(resolve(repoRoot, 'native', 'monero-bridge', 'cpp', 'WalletEngine.cpp'), 'utf8');
  const closeStart = bridgeSource.indexOf('void closeSessionWallet(');
  assert.notEqual(closeStart, -1);
  const closeEnd = bridgeSource.indexOf('WalletId addWallet(', closeStart);
  assert.notEqual(closeEnd, -1);
  const closeBody = bridgeSource.slice(closeStart, closeEnd);
  const pauseRefresh = closeBody.indexOf('wallet->pauseRefresh();');
  const stop = closeBody.indexOf('wallet->stop();');
  const store = closeBody.indexOf('if (!wallet->store(""))');
  assert.notEqual(pauseRefresh, -1);
  assert.notEqual(stop, -1);
  assert.notEqual(store, -1);
  assert.ok(pauseRefresh < stop);
  assert.ok(stop < store);
  assert.equal(closeBody.includes('wallet->stopRefresh();'), false);
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

test('a repeated Ledger view-key action is blocked before another device session starts', () => {
  const hostSource = readFileSync(resolve(desktopRoot, 'src-tauri', 'src', 'lib.rs'), 'utf8');
  const recoverySource = hostSource.slice(hostSource.indexOf('fn create_ledger_read_only_from_device'), hostSource.indexOf('#\[tauri::command\]\nfn wallet_open_requires_password'));
  assert.match(hostSource, /struct LedgerViewKeyExportState/);
  assert.match(hostSource, /ledger\.view-key-export-duplicate-blocked/);
  assert.match(recoverySource, /if ledger_read_only_exists\(&app, &source\.id\)\?/);
  assert.ok(recoverySource.indexOf('ledger_read_only_exists') < recoverySource.indexOf('create_from_device'));
  assert.match(recoverySource, /begin_ledger_view_key_export\(&app, &exports, &source\.id, "recovery-device-session"\)/);
});

test('desktop keeps one Ledger instruction dialog open while direct balance setup resolves', () => {
  assert.match(appSource, /function LedgerViewKeyExportOverlay\(\{/);
  assert.match(appSource, /approve <strong>Export view key<\/strong> once/);
  assert.match(appSource, /ledgerVerificationPhase && <LedgerViewKeyExportOverlay title="Verify with your Ledger" detail=\{ledgerVerificationPhase\}/);
  assert.match(appSource, /finally \{\s*setLedgerVerificationPhase\(null\);\s*\}/);
  assert.doesNotMatch(appSource, /mode: 'open'/);
  assert.doesNotMatch(appSource, /wallet-switch-open-flow-shown/);
});

test('desktop uses one app-wide authentication boundary for every wallet', () => {
  const hostSource = readFileSync(resolve(desktopRoot, 'src-tauri', 'src', 'lib.rs'), 'utf8');
  for (const command of ['app_protection_status', 'retry_app_protection_status', 'set_app_protection_password', 'verify_app_protection_password', 'set_app_protection_mode', 'verify_system_auth', 'lock_app', 'record_app_user_activity', 'auto_lock_settings', 'set_auto_lock_timeout']) {
    assert.match(tauriBuild, new RegExp(`"${command}"`));
    assert.match(tauriCapability, new RegExp(`"allow-${command.replaceAll('_', '-')}"`));
  }
  assert.match(appSource, /if \(appProtection\.locked\) return <AppProtectionGate/);
  assert.match(appSource, /function AppProtectionGate/);
  assert.match(appSource, /protection\.welcomeTitle/);
  assert.match(appSource, /protection\.getStarted/);
  assert.match(appSource, /onboardingComplete: welcomeAcknowledged/);
  assert.match(appSource, /presentation === 'welcome'/);
  assert.match(appSource, /t\('protection\.choose'\)/);
  assert.match(appSource, /t\('protection\.biometricPrivacy'\)/);
  assert.match(i18nSource, /Choose the quick system sign-in or your own app password\./);
  assert.match(i18nSource, /Wähle die schnelle Geräte-Anmeldung oder ein eigenes App-Passwort\./);
  assert.match(i18nSource, /Your biometric data stays with the operating system\./);
  assert.match(i18nSource, /Deine biometrischen Daten bleiben beim Betriebssystem\./);
  assert.match(i18nSource, /Unlock the app once, then select saved wallets without separate password prompts\./);
  assert.match(i18nSource, /Entsperre die App einmal und wähle gespeicherte Wallets danach ohne zusätzliche Passwortabfragen\./);
  assert.match(appSource, /const unlockForWalletAction = useCallback/);
  assert.match(appSource, /await invoke<AppProtectionStatus>\('verify_system_auth'\)/);
  assert.match(appSource, /if \(!await unlockForWalletAction\(\)\) return;/);
  assert.match(appSource, /window\.addEventListener\(event, reportUserActivity/);
  assert.match(appSource, /listen<boolean>\('app-lock-state-changed'/);
  assert.doesNotMatch(appSource, /refreshProtectionAfterFocus/);
  assert.match(appSource, /automaticSystemUnlockAttemptedRef/);
  assert.match(appSource, /returning to a locked\n  \/\/ biometric app presents exactly one system-auth request/);
  assert.match(hostSource, /fn lock_app\(/);
  assert.match(hostSource, /FastWalletSessionState/);
  assert.match(hostSource, /MONERO_DESKTOP_APP_PROTECTION locked/);
  assert.match(hostSource, /require_app_unlocked\(&protection\)\?/);
  assert.match(hostSource, /require_fresh_app_authorization/);
  assert.match(secureStoreSource, /Argon2/);
  assert.match(secureStoreSource, /store_app_protection_mode/);
  assert.doesNotMatch(tauriBuild, /"clear_app_protection_password"/);
  assert.doesNotMatch(tauriCapability, /"allow-clear-app-protection-password"/);
  assert.doesNotMatch(appSource, /restoreOpenSessions/);
  assert.doesNotMatch(appSource, /walletsToOpen/);
  assert.doesNotMatch(appSource, /walletSwitchQueueRef/);
});

test('system-auth setup keeps one AppVault recovery password, never a wallet password', () => {
  const hostSource = readFileSync(resolve(desktopRoot, 'src-tauri', 'src', 'lib.rs'), 'utf8');
  assert.match(appSource, /const needsPassword = setup \|\| mode === 'password' \|\| useRecoveryPassword;/);
  assert.match(appSource, /const passwordForm = setup \|\| mode === 'password' \|\| \(!setup && useRecoveryPassword\);/);
  assert.match(appSource, /setMode\('system'\); setPassword\(''\); setConfirmation\(''\);/);
  assert.match(appSource, /validateRecoveryPassword\(password\)/);
  assert.match(hostSource, /secure_store::unlock_app_vault_with_system\(\)\?;/);
  assert.doesNotMatch(appSource, /walletPassword/);
});

test('desktop recovery-seed authorization follows the protection method selected at first run', () => {
  const hostSource = readFileSync(resolve(desktopRoot, 'src-tauri', 'src', 'lib.rs'), 'utf8');
  const standardSeedSource = rustFunction(hostSource, 'present_recovery_seed');
  const fastSeedSource = rustFunction(hostSource, 'present_fast_wallet_recovery_seed');
  const fastUiSource = appSource.slice(
    appSource.indexOf('function FastWallets('),
    appSource.indexOf('function WalletFeature('),
  );

  assert.match(standardSeedSource, /require_fresh_app_authorization/);
  assert.match(fastSeedSource, /require_fresh_app_authorization/);
  assert.match(appSource, /appProtection\?\.mode === 'system'/);
  assert.match(appSource, /return presentRecoverySeedRequest\(request\)/);
  assert.match(appSource, /allowPasswordFallback=\{appProtection\.passwordConfigured\}/);
  assert.match(appSource, /seedRevealInFlightRef\.current/);
  assert.match(appSource, /if \(appProtection\.mode === null\) return/);
  assert.doesNotMatch(appSource, /mode=\{appProtection\.mode \?\? 'password'\}/);
  assert.match(fastUiSource, /const systemAuthorization = appProtection\.mode === 'system'/);
  assert.match(fastUiSource, /will confirm before the recovery words are shown/);
  assert.match(fastUiSource, /You will confirm this payment with/);
  assert.doesNotMatch(fastUiSource, /App password \(only if/);
});

test('desktop shows recovery words in a deliberate in-app backup screen, never a system alert', () => {
  const hostSource = readFileSync(resolve(desktopRoot, 'src-tauri', 'src', 'lib.rs'), 'utf8');
  const standardSeedSource = rustFunction(hostSource, 'present_recovery_seed');
  const fastSeedSource = rustFunction(hostSource, 'present_fast_wallet_recovery_seed');
  const standardConfirmSource = rustFunction(hostSource, 'confirm_recovery_seed_backup');
  const fastConfirmSource = rustFunction(hostSource, 'confirm_fast_wallet_recovery_seed_backup');
  assert.doesNotMatch(standardSeedSource, /MessageDialog/);
  assert.doesNotMatch(fastSeedSource, /MessageDialog/);
  assert.match(standardConfirmSource, /mark_seed_backed_up/);
  assert.match(fastConfirmSource, /mark_seed_backed_up/);
  assert.match(appSource, /function RecoverySeedBackupScreen/);
  assert.match(appSource, /Write down your recovery words/);
  assert.match(appSource, /I have written down all/);
  assert.match(appSource, /I have saved my words/);
  assert.match(appSource, /setRecoverySeedScreen\(null\)/);
  assert.match(stylesSource, /\.recovery-seed-words/);
});

test('desktop Keychain failures cannot create a focus-loss prompt loop', () => {
  const hostSource = readFileSync(resolve(desktopRoot, 'src-tauri', 'src', 'lib.rs'), 'utf8');
  const lockSource = hostSource.slice(
    hostSource.indexOf('fn lock_app_native('),
    hostSource.indexOf('#[tauri::command]\nfn lock_app('),
  );
  assert.match(secureStoreSource, /SessionSecretCacheEntry::Failure/);
  assert.match(secureStoreSource, /failure-cache-hit/);
  assert.match(secureStoreSource, /retry_failed_secret_reads/);
  assert.match(appSource, /'retry_app_protection_status'/);
  assert.match(appSource, /status-retry-requested/);
  assert.doesNotMatch(appSource, /window\.location\.reload\(\)/);
  assert.doesNotMatch(appSource, /visibilitychange/);
  assert.doesNotMatch(lockSource, /app_protection_configured|load_app_protection_mode|load_secret/);
  assert.match(lockSource, /clear_session_secret_cache/);
  assert.doesNotMatch(lockSource, /note_session_lock/);
  assert.match(lockSource, /secure_session_cache=cleared/);
  assert.match(lockSource, /Locking is a one-way in-memory transition/);
});

test('wallet switching reads only the current secure store after the app is unlocked', () => {
  const hostSource = readFileSync(resolve(desktopRoot, 'src-tauri', 'src', 'lib.rs'), 'utf8');
  const openSource = hostSource.slice(
    hostSource.indexOf('fn open_wallet('),
    hostSource.indexOf('#[tauri::command]\nfn close_wallet('),
  );
  const storeSource = secureStoreSource.slice(
    secureStoreSource.indexOf('pub fn store_wallet_password('),
    secureStoreSource.indexOf('pub fn delete_wallet_password('),
  );

  assert.match(openSource, /load_wallet_password_current/);
  assert.doesNotMatch(openSource, /load_wallet_password\(&physical_registration\.id\)/);
  assert.doesNotMatch(openSource, /retry_wallet_password/);
  assert.doesNotMatch(appSource, /retrySecureStorage/);
  assert.match(openSource, /legacy credentials are never auto-read/);
  assert.match(storeSource, /app_vault::put_secret/);
  assert.doesNotMatch(storeSource, /platform_store_secret/);
  assert.doesNotMatch(storeSource, /platform_load_current_secret/);
  assert.doesNotMatch(storeSource, /Entry::new/);
});

test('one app unlock primes every current wallet credential before switching', () => {
  const hostSource = readFileSync(resolve(desktopRoot, 'src-tauri', 'src', 'lib.rs'), 'utf8');
  const primeSource = rustFunction(hostSource, 'migrate_and_prime_app_session_credentials');
  for (const unlockFunction of [
    'verify_app_protection_password',
    'verify_system_auth',
  ]) {
    assert.match(
      rustFunction(hostSource, unlockFunction),
      /migrate_and_prime_app_session_credentials\(&app\)/,
    );
  }
  assert.match(primeSource, /load_wallet_password_current/);
  assert.match(primeSource, /load_fast_wallet_password_current/);
  assert.match(primeSource, /security\.session-credentials-primed/);
  assert.match(secureStoreSource, /pub fn load_fast_wallet_password_current/);
  assert.doesNotMatch(primeSource, /load_fast_wallet_password\(/);
});

test('every successful global unlock starts a fresh native inactivity window', () => {
  const hostSource = readFileSync(resolve(desktopRoot, 'src-tauri', 'src', 'lib.rs'), 'utf8');
  const resetSource = rustFunction(hostSource, 'reset_app_session_activity');
  assert.match(resetSource, /last_user_activity = Instant::now\(\)/);
  for (const unlockFunction of [
    'set_app_protection_password',
    'verify_app_protection_password',
    'set_app_protection_mode',
    'verify_system_auth',
  ]) {
    assert.match(
      rustFunction(hostSource, unlockFunction),
      /reset_app_session_activity\(&app\)\?/,
      `${unlockFunction} must not inherit an expired timeout from the prior session`,
    );
  }
});

test('removing a saved wallet cannot be blocked by a stale native session', () => {
  const hostSource = readFileSync(resolve(desktopRoot, 'src-tauri', 'src', 'lib.rs'), 'utf8');
  const removalSource = rustFunction(hostSource, 'remove_registered_wallet');
  assert.match(removalSource, /native-close-failed registration-removal-continues/);
  assert.match(removalSource, /wallet_registry::remove\(&app, &input\.wallet_id\)\?/);
  assert.doesNotMatch(removalSource, /return Err\(error\);/);
  assert.match(appSource, /invoke<void>\('remove_registered_wallet'/);
});

test('wallet create and open diagnostics identify the slow native stage in milliseconds', () => {
  const hostSource = readFileSync(resolve(desktopRoot, 'src-tauri', 'src', 'lib.rs'), 'utf8');
  for (const event of [
    'wallet.create-started',
    'wallet.core-created',
    'wallet.create-complete',
    'wallet.open-started',
    'wallet.core-opened',
    'wallet.open-complete',
  ]) assert.match(hostSource, new RegExp(event.replace('.', '\\.')));
  assert.match(hostSource, /elapsedMs/);
  assert.match(hostSource, /Instant::now\(\)/);
});

test('wallet create and open return before slow node initialization', () => {
  const hostSource = readFileSync(resolve(desktopRoot, 'src-tauri', 'src', 'lib.rs'), 'utf8');
  const finishSource = hostSource.slice(
    hostSource.indexOf('fn finish_wallet_operation('),
    hostSource.indexOf('\npub fn run()', hostSource.indexOf('fn finish_wallet_operation(')),
  );
  assert.match(hostSource, /fn schedule_wallet_sync\(/);
  assert.match(hostSource, /tauri::async_runtime::spawn_blocking/);
  assert.match(finishSource, /schedule_wallet_sync\(app\.clone\(\), wallet_id\.clone\(\), wallet\.network\.clone\(\)\)/);
  assert.match(finishSource, /Ok\(WalletOperationResponse \{ wallet_id, wallet \}\)/);
  assert.match(hostSource, /wallet\.node-configuration-started/);
  assert.match(hostSource, /wallet\.node-configured/);
});

test('wallet switching never runs native lock waits on the Tauri UI thread', () => {
  const hostSource = readFileSync(resolve(desktopRoot, 'src-tauri', 'src', 'lib.rs'), 'utf8');
  for (const command of [
    'open_wallet',
    'start_wallet_refresh',
    'wallet_snapshot',
    'registered_wallet_snapshots',
    'wallet_transactions',
  ]) {
    assert.match(
      hostSource,
      new RegExp(`async fn ${command}\\(`),
      `${command} must execute through Tauri's async runtime`,
    );
  }
  assert.match(appSource, /Opening\/creating a wallet already queues exactly one native sync worker/);
  assert.doesNotMatch(appSource, /void loadSnapshot\(true\);\s*void loadTransactions\(\);\s*void loadRegisteredSnapshots\(\);/);
});

test('normal wallet snapshots keep the Core aggregate across every Monero account', () => {
  const hostSource = readFileSync(resolve(desktopRoot, 'src-tauri', 'src', 'lib.rs'), 'utf8');
  const snapshotSource = rustFunction(hostSource, 'wallet_snapshot');
  const registeredSnapshotsSource = rustFunction(hostSource, 'registered_wallet_snapshots');
  assert.match(snapshotSource, /match input\.account_index/);
  assert.match(snapshotSource, /None => wallet\.snapshot\(&input\.wallet_id\)/);
  assert.match(registeredSnapshotsSource, /let legacy_account_scoped/);
  assert.match(registeredSnapshotsSource, /wallet\.snapshot\(session_id\)/);
  assert.match(appSource, /const snapshotAccountIndex = legacyLedgerAccountScoped/);
  assert.match(appSource, /snapshotAccountIndex === undefined/);
});

test('slow node handshakes never freeze wallet selection, snapshots, or removal', () => {
  const hostSource = readFileSync(resolve(desktopRoot, 'src-tauri', 'src', 'lib.rs'), 'utf8');
  const removeSource = rustFunction(hostSource, 'remove_registered_wallet');
  const snapshotSource = rustFunction(hostSource, 'wallet_snapshot');
  const registeredSnapshotsSource = rustFunction(hostSource, 'registered_wallet_snapshots');
  const transactionSource = rustFunction(hostSource, 'wallet_transactions');
  assert.match(hostSource, /struct NodeSyncState/);
  assert.match(hostSource, /wallet\.sync-queued-behind-active-network-work/);
  assert.match(hostSource, /struct NodeSyncPermit/);
  assert.match(hostSource, /fn try_lock_native_wallet/);
  assert.match(snapshotSource, /try_lock_native_wallet/);
  assert.match(registeredSnapshotsSource, /try_lock_native_wallet/);
  assert.match(transactionSource, /try_lock_native_wallet/);
  assert.match(removeSource, /try_lock\(\)/);
  assert.match(removeSource, /wallet\.remove-native-close-deferred/);
  assert.match(appSource, /function isBackgroundWalletWork/);
  assert.match(appSource, /if \(!isBackgroundWalletWork\(reason\)\)/);
});

test('saved software wallets switch directly after one app-wide unlock', () => {
  const hostSource = readFileSync(resolve(desktopRoot, 'src-tauri', 'src', 'lib.rs'), 'utf8');
  const switchSource = appSource.slice(
    appSource.indexOf('const openSavedWallet ='),
    appSource.indexOf('const createFastWalletAfterBackup ='),
  );
  assert.match(hostSource, /defer_sync: bool/);
  assert.match(hostSource, /fn queue_registered_wallet_sync\(/);
  assert.match(hostSource, /struct WalletSyncState/);
  assert.match(switchSource, /invoke<WalletOperationResponse>\('open_wallet'/);
  assert.match(switchSource, /deferSync: true/);
  assert.match(switchSource, /queue_registered_wallet_sync/);
  assert.match(switchSource, /destination: Section = 'home'/);
  assert.match(switchSource, /setSection\(resolvedDestination\)/);
  assert.match(switchSource, /wallet\.kind !== 'hardware'/);
  assert.match(switchSource, /generation === walletSwitchGenerationRef\.current/);
  assert.doesNotMatch(switchSource, /const siblings =/);
  assert.doesNotMatch(
    switchSource.slice(0, switchSource.indexOf("if (selected.kind === 'hardware')")),
    /mode: 'open'/,
  );
});

test('global unlock warms local and Ledger view-only sessions, then schedules every wallet for background sync', () => {
  const hostSource = readFileSync(resolve(desktopRoot, 'src-tauri', 'src', 'lib.rs'), 'utf8');
  const warmSource = rustFunction(hostSource, 'warm_registered_wallet_sessions_after_unlock');
  const openSource = rustFunction(hostSource, 'open_wallet');
  assert.match(hostSource, /struct WalletWarmState/);
  assert.match(hostSource, /manage\(WalletWarmState\(Mutex::new\(false\)\)\)/);
  assert.match(warmSource, /spawn_blocking/);
  assert.match(warmSource, /physical_registration_for_open\(&app, &registration\)/);
  assert.match(warmSource, /physical\.kind != "hardware"/);
  assert.match(warmSource, /shared_native_session_for_physical_registration/);
  assert.match(warmSource, /sessions\.insert\(physical\.id\.clone\(\), native_id\.clone\(\)\)/);
  assert.match(warmSource, /sessions\.insert\(registration\.id, native_id\.clone\(\)\)/);
  assert.doesNotMatch(warmSource, /if registration\.kind == "hardware"/);
  assert.match(warmSource, /"wallet-warm"/);
  assert.match(warmSource, /"fast-wallet-warm"/);
  assert.match(warmSource, /wallet\.warm-pass-complete/);
  assert.match(warmSource, /app_is_locked\(&protection_state\)\.unwrap_or\(true\)/);
  assert.match(warmSource, /native\.close\(&native_id, false\)/);
  assert.match(warmSource, /sync_after_warm/);
  assert.match(warmSource, /schedule_wallet_sync\(app\.clone\(\), native_id, network_name\)/);
  assert.doesNotMatch(warmSource, /set_daemon|start_refresh|reconnect_hardware/);
  assert.match(openSource, /wallet\.warm-session-activated/);
  assert.ok(openSource.indexOf('warm-session-activated') < openSource.indexOf('native.open'));
});

test('optimized desktop sync passes the configured gRPC endpoint into Monero Core', () => {
  for (const source of [nativeWalletSource, desktopBridgeHeader, desktopBridgeSource, windowsExports]) {
    assert.match(source, /tex8_desktop_wallet_set_grpc_endpoint/);
  }
  const hostSource = readFileSync(resolve(desktopRoot, 'src-tauri', 'src', 'lib.rs'), 'utf8');
  assert.match(hostSource, /profile\.mode != "original-rpc"/);
  assert.match(hostSource, /native\.set_grpc_endpoint\(&wallet_id, &grpc_endpoint\)/);
  assert.match(hostSource, /wallet\.grpc-configured/);
});

test('the first-party node survives a broken local DNS resolver without changing custom nodes', () => {
  const hostSource = readFileSync(resolve(desktopRoot, 'src-tauri', 'src', 'lib.rs'), 'utf8');
  assert.match(hostSource, /fn first_party_endpoint_with_dns_fallback\(/);
  assert.match(hostSource, /endpoint\.strip_prefix\("xmr\.tex8\.com:"\)/);
  assert.match(hostSource, /152\.53\.133\.188:\{port\}/);
  assert.match(hostSource, /wallet\.node-dns-fallback/);
  assert.match(hostSource, /address: &daemon_address/);
  assert.match(hostSource, /set_grpc_endpoint\(&wallet_id, &grpc_endpoint\)/);
});

test('desktop diagnostic builds allow screenshots while production stays protected', () => {
  const hostSource = readFileSync(resolve(desktopRoot, 'src-tauri', 'src', 'lib.rs'), 'utf8');
  assert.match(hostSource, /fn desktop_screen_capture_protection_enabled\(\)/);
  assert.match(hostSource, /cfg!\(debug_assertions\)/);
  assert.match(hostSource, /MONERO_DESKTOP_PROTECT_SCREEN_CAPTURE/);
  assert.match(hostSource, /\.set_content_protected\(protected\)/);
  assert.match(hostSource, /MONERO_DESKTOP_SCREEN_CAPTURE protected=/);
});

test('the isolated diagnostic secure store is debug-only and cannot affect production', () => {
  assert.match(secureStoreSource, /#\[cfg\(debug_assertions\)\]\nstatic DIAGNOSTIC_SECRET_STORE/);
  assert.match(secureStoreSource, /MONERO_DESKTOP_DIAGNOSTIC_IN_MEMORY_SECURE_STORE/);
  assert.match(secureStoreSource, /Monero Fast Wallet Diagnostic\.app/);
  assert.match(secureStoreSource, /current_exe\(\)/);
  assert.match(secureStoreSource, /MONERO_DESKTOP_DIAGNOSTIC_AUTOMATION_UNLOCK/);
  assert.match(secureStoreSource, /diagnostic_automation_unlock_enabled/);
  assert.match(secureStoreSource, /#\[cfg\(not\(debug_assertions\)\)\]\n\s*\{\n\s*false/);
  assert.match(secureStoreSource, /diagnostic-memory-read/);
  assert.match(secureStoreSource, /diagnostic-memory-write/);
});

test('diagnostic UI automation cannot lose its wallet session when focus moves to the controller', () => {
  const hostSource = readFileSync(resolve(desktopRoot, 'src-tauri', 'src', 'lib.rs'), 'utf8');
  assert.doesNotMatch(hostSource, /main_window\.on_window_event/);
  assert.match(hostSource, /if secure_store::diagnostic_automation_unlock_enabled\(\)/);
  assert.match(hostSource, /security\.auto-lock-monitor-started/);
});

test('macOS wallet development builds launch only the stable signed app bundle', () => {
  const packageJson = JSON.parse(readFileSync(resolve(desktopRoot, 'package.json'), 'utf8'));
  const runner = readFileSync(resolve(desktopRoot, 'scripts', 'run-macos-signed-debug.sh'), 'utf8');
  const signScript = readFileSync(resolve(desktopRoot, 'scripts', 'sign-macos-app.sh'), 'utf8');
  const cargo = readFileSync(resolve(desktopRoot, 'src-tauri', 'Cargo.toml'), 'utf8');
  const hostSource = readFileSync(resolve(desktopRoot, 'src-tauri', 'src', 'lib.rs'), 'utf8');
  const developmentEntitlements = readFileSync(resolve(desktopRoot, 'src-tauri', 'Entitlements.plist'), 'utf8');
  const productionEntitlements = readFileSync(resolve(desktopRoot, 'src-tauri', 'Entitlements.production.plist'), 'utf8');

  assert.equal(packageJson.scripts['dev:wallet'], 'bash scripts/run-macos-signed-debug.sh');
  assert.match(runner, /tauri build -- --debug --bundles app/);
  assert.match(runner, /sign-macos-app\.sh" local debug/);
  assert.match(runner, /mfw-signed-runtime/);
  assert.match(runner, /ditto "\$\{source_app_path\}" "\$\{app_path\}"/);
  assert.match(runner, /MONERO_DESKTOP_APP_PATH="\$\{app_path\}"/);
  assert.match(runner, /Monero Fast Wallet\.app/);
  assert.match(runner, /Contents\/MacOS\/monero-wallet-desktop/);
  assert.doesNotMatch(runner, /npm run tauri dev/);
  assert.match(signScript, /mfw-signing-keychain/);
  assert.match(signScript, /developer-id-application\.key/);
  assert.match(signScript, /apple-tool:,apple:,codesign:/);
  assert.match(signScript, /security delete-keychain/);
  assert.match(signScript, /signed_team_identifier/);
  assert.match(signScript, /keychain-access-groups/);
  assert.match(signScript, /verify_keychain_entitlements/);
  assert.match(signScript, /signed_keychain_group/);
  assert.match(signScript, /Monero::WalletManagerFactory::getWalletManager/);
  assert.match(signScript, /Refusing to sign an app without the native Monero wallet engine/);
  assert.match(cargo, /security-framework.*OSX_10_15/);
  assert.match(cargo, /tauri-plugin-single-instance/);
  const singleInstance = hostSource.indexOf('.plugin(tauri_plugin_single_instance::init');
  const notification = hostSource.indexOf('.plugin(tauri_plugin_notification::init');
  assert.ok(singleInstance >= 0 && notification > singleInstance);
  assert.doesNotMatch(hostSource, /let initially_locked = match secure_store::app_protection_configured/);
  assert.match(hostSource, /AppProtectionState\(Mutex::new\(true\)\)/);
  for (const entitlements of [developmentEntitlements, productionEntitlements]) {
    assert.match(entitlements, /com\.apple\.application-identifier/);
    assert.match(entitlements, /com\.apple\.developer\.team-identifier/);
    assert.match(entitlements, /keychain-access-groups/);
    assert.match(entitlements, /F98729Y989\.com\.tex8\.monerowallet\.desktop/);
  }
});

test('desktop Community V1 matches mobile local search, contacts, history, and notification contracts', () => {
  for (const command of [
    'enthusiast_v1_search',
    'enthusiast_v1_suggestions',
    'enthusiast_v1_clear_search_history',
    'enthusiast_v1_request_contact',
    'enthusiast_v1_enable_notifications',
  ]) {
    assert.match(tauriBuild, new RegExp(`"${command}"`));
    assert.match(tauriCapability, new RegExp(`"allow-${command.replaceAll('_', '-')}"`));
    assert.match(appSource, new RegExp(`'${command}'`));
  }
  assert.match(enthusiastV1Source, /NativeHarrier::load_verified_xnnpack/);
  assert.match(enthusiastV1Source, /open_with_keys_and_query_cache/);
  assert.match(enthusiastV1Source, /install_catalog/);
  assert.match(enthusiastV1Source, /install_query_catalog/);
  assert.match(enthusiastV1Source, /ensure_community_v1_search_store_key/);
  assert.match(enthusiastV1Source, /No complete, signed Community catalog/);
  assert.match(appSource, /MONERO_DESKTOP_COMMUNITY suggestions-failed/);
  assert.match(appSource, /communityV1\.clearSearchHistory/);
  assert.match(appSource, /result\.item\.ownerPublicId/);
});

test('every renderer-accessible wallet and privacy command fails closed behind the native lock', () => {
  const hostSource = readFileSync(resolve(desktopRoot, 'src-tauri', 'src', 'lib.rs'), 'utf8');
  const protectedCommands = [
    'ledger_transport_status',
    'store_wallet_password',
    'delete_wallet_password',
    'wallet_open_requires_password',
    'open_wallet',
    'close_wallet',
    'rename_wallet',
    'remove_registered_wallet',
    'list_registered_wallets',
    'activate_registered_wallet',
    'list_fast_wallets',
    'open_fast_wallet',
    'close_fast_wallet',
    'remove_fast_wallet',
    'create_fast_wallet',
    'enable_fast_wallet',
    'enable_ledger_fast_wallet',
    'refresh_fast_wallet_status',
    'disable_fast_wallet',
    'load_node_settings',
    'save_node_settings',
    'set_daemon',
    'start_wallet_refresh',
    'stop_wallet_refresh',
    'wallet_address',
    'validate_recipient_address',
    'verify_mfw_name_record_address',
    'present_recovery_seed',
    'wallet_snapshot',
    'registered_wallet_snapshots',
    'wallet_balance',
    'wallet_unlocked_balance',
    'create_subaddress',
    'list_subaddresses',
    'wallet_transactions',
    'prepare_transaction',
    'commit_transaction',
    'wallet_hardware_status',
    'reconnect_hardware_wallet',
    'show_hardware_wallet_address',
    'notification_installation_status',
    'request_notification_installation',
    'disable_notification_installation',
    'consume_pending_notification_open',
    'background_notification_agent_config_path',
    'community_load_profile',
    'community_update_profile',
    'community_list_nearby',
    'community_list_contacts',
    'community_request_contact',
    'community_accept_contact',
    'community_list_messages',
    'community_send_message',
    'community_block_profile',
    'community_report_profile',
    'community_delete_identity',
  ];
  for (const command of protectedCommands) {
    const source = rustFunction(hostSource, command);
    assert.match(source, /protection: State<'_, AppProtectionState>/, `${command} must receive native protection state`);
    assert.match(source, /require_app_unlocked\(&protection\)/, `${command} must fail closed while locked`);
  }
});

test('desktop removes a Fast Wallet only after native sync and zero-balance checks', () => {
  const hostSource = readFileSync(resolve(desktopRoot, 'src-tauri', 'src', 'lib.rs'), 'utf8');
  const removalSource = rustFunction(hostSource, 'remove_fast_wallet');
  assert.doesNotMatch(removalSource, /seed_backup_status != "verified"/);
  assert.match(removalSource, /authoritative zero-balance safety gate/);
  assert.match(removalSource, /fast-wallet\.remove-started/);
  assert.match(removalSource, /fast-wallet\.remove-blocked/);
  assert.match(removalSource, /fast-wallet\.removed/);
  assert.match(removalSource, /validate_fast_wallet_removal_snapshot\(&raw\)/);
  assert.ok(
    removalSource.indexOf('validate_fast_wallet_removal_snapshot') <
      removalSource.indexOf('fast_wallet::remove'),
  );
  assert.match(appSource, /'remove_fast_wallet'/);
  assert.match(appSource, /invoke<void>\(metadataOnly \? 'remove_fast_wallet_entry'/);
  assert.match(tauriBuild, /"remove_fast_wallet_entry"/);
  assert.match(appSource, /Remove empty Fast Wallet/);
  assert.match(appSource, /encrypted wallet files are kept for recovery/);
  assert.match(tauriBuild, /"remove_fast_wallet"/);
  assert.match(tauriCapability, /"allow-remove-fast-wallet"/);
  assert.match(tauriCapability, /"allow-remove-fast-wallet-entry"/);
});

test('desktop exposes no per-wallet password command or current settings control', () => {
  const activeSettings = appSource.slice(appSource.indexOf('function LeanSettings('));
  assert.doesNotMatch(activeSettings, /change_wallet_password/);
  assert.doesNotMatch(tauriBuild, /"change_wallet_password"/);
  assert.doesNotMatch(tauriCapability, /"allow-change-wallet-password"/);
});
