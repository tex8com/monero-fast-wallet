import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import test from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, '..');
const repoRoot = resolve(desktopRoot, '..', '..');

const appSource = readFileSync(resolve(desktopRoot, 'src', 'App.tsx'), 'utf8');
const i18nSource = readFileSync(resolve(desktopRoot, 'src', 'i18n.tsx'), 'utf8');
const stylesSource = readFileSync(resolve(desktopRoot, 'src', 'styles.css'), 'utf8');
const parityDoc = readFileSync(resolve(repoRoot, 'docs', 'DESKTOP_PARITY_MATRIX.md'), 'utf8');
const tauriBuild = readFileSync(resolve(desktopRoot, 'src-tauri', 'build.rs'), 'utf8');
const tauriCapability = readFileSync(resolve(desktopRoot, 'src-tauri', 'capabilities', 'main.json'), 'utf8');
const secureStoreSource = readFileSync(resolve(desktopRoot, 'src-tauri', 'src', 'secure_store.rs'), 'utf8');
const enrollmentSource = readFileSync(resolve(desktopRoot, 'src-tauri', 'src', 'fast_wallet_enrollment.rs'), 'utf8');
const desktopNotificationsSource = readFileSync(resolve(desktopRoot, 'src-tauri', 'src', 'desktop_notifications.rs'), 'utf8');
const ledgerCorePatch = readFileSync(resolve(repoRoot, 'native', 'desktop-bridge', 'patches', 'monero-ledger-view-key-api.patch'), 'utf8');

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
  assert.equal(/priority-choice/.test(sendSource), false, 'fee priority must not be a primary send choice');
  assert.equal(/RecentTransactions/.test(sendSource), false, 'recent activity must not distract from the send journey');
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
});

test('desktop keeps the balance summary but removes the transient sync status after Core confirms completion', () => {
  const homeSource = appSource.slice(appSource.indexOf('function Home('), appSource.indexOf('function RecentTransactions('));
  assert.match(appSource, /const showPrimaryWalletCard = Boolean\(walletId\);/);
  assert.match(homeSource, /primary-wallet-balance/);
  assert.match(homeSource, /!snapshot\?\.synchronized && <div className="primary-wallet-sync">/);
  assert.match(homeSource, /className="sync-refresh"/);
  assert.equal(/>\{t\('common\.refresh'\)\}<\/button>/.test(homeSource), false);
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
  assert.match(homeSource, /presentWalletSync\(snapshot, \{ startHeight: syncStartHeight \}\)/);
  assert.match(homeSource, /sync\.phase === 'finalizing'/);
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

test('desktop keeps Fast Wallet manual, local, and independent in safe V1', () => {
  const setupSource = appSource.slice(appSource.indexOf('function Setup('), appSource.indexOf('function FastWallets('));
  const fastSource = appSource.slice(appSource.indexOf('function FastWallets('), appSource.indexOf('function WalletFeature('));
  assert.doesNotMatch(appSource, /function ExperienceModeOnboarding|fastWalletPreference/);
  assert.doesNotMatch(setupSource, /suggestedFastWallet|createFastWallet/);
  assert.match(setupSource, /const fastChoice = null/);
  assert.match(fastSource, /create_fast_wallet/);
  assert.match(fastSource, /restore_fast_wallet_with_native_seed/);
  assert.match(fastSource, /present_fast_wallet_recovery_seed/);
  assert.match(fastSource, /complete balance and history are rebuilt and verified on this device/);
  assert.match(appSource, /function isFastWalletRegistration/);
  assert.match(appSource, /fast-wallet-badge/);
  assert.match(appSource, /wallet\.kind === 'hardware' \? `Fast Wallet ·/);
});

test('desktop makes Fast Wallet management reachable from saved wallets', () => {
  const walletsSource = appSource.slice(appSource.indexOf('function Wallets('), appSource.indexOf('function LedgerReadOnlySetup('));
  assert.match(walletsSource, /<FastWallets linked=\{linked\} sourceWalletId=\{walletId\} sourceWallet=\{activeWallet\} \/>/);
  assert.match(walletsSource, /Fast Wallet available locally/);
  assert.doesNotMatch(appSource, /Ledger Fast Wallet is not available yet/);
});

test('Ledger read-only setup is reachable through Tauri command permissions', () => {
  for (const command of ['enable_ledger_read_only', 'create_ledger_read_only_from_device', 'registered_wallet_snapshots']) {
    assert.match(tauriBuild, new RegExp(`"${command}"`));
    assert.match(tauriCapability, new RegExp(`"allow-${command.replaceAll('_', '-')}"`));
  }
});

test('unfinished Ledger Fast Wallet fails closed before reading anything from Ledger', () => {
  const hostSource = readFileSync(resolve(desktopRoot, 'src-tauri', 'src', 'lib.rs'), 'utf8');
  const ledgerFastSource = rustFunction(hostSource, 'enable_ledger_fast_wallet');
  assert.match(ledgerFastSource, /release_features::require\(\s*"ledgerFastWallet"/);
  assert.match(ledgerFastSource, /disabled in the safe V1 release/);
  assert.ok(
    ledgerFastSource.indexOf('release_features::require') <
      ledgerFastSource.indexOf('export_hardware_private_view_key'),
  );
});

test('renderer exposes no unfinished Ledger Fast Wallet action', () => {
  const fastSource = appSource.slice(appSource.indexOf('function FastWallets('), appSource.indexOf('function WalletFeature('));
  assert.doesNotMatch(fastSource, /enable_ledger_fast_wallet|ledgerFastScanner|setLedgerViewKeyExportPending/);
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

test('a repeated Ledger view-key action is blocked before another device session starts', () => {
  const hostSource = readFileSync(resolve(desktopRoot, 'src-tauri', 'src', 'lib.rs'), 'utf8');
  const recoverySource = hostSource.slice(hostSource.indexOf('fn create_ledger_read_only_from_device'), hostSource.indexOf('#\[tauri::command\]\nfn wallet_open_requires_password'));
  assert.match(hostSource, /struct LedgerViewKeyExportState/);
  assert.match(hostSource, /ledger\.view-key-export-duplicate-blocked/);
  assert.match(recoverySource, /if ledger_read_only_exists\(&app, &source\.id\)\?/);
  assert.ok(recoverySource.indexOf('ledger_read_only_exists') < recoverySource.indexOf('create_from_device'));
  assert.match(recoverySource, /begin_ledger_view_key_export\(&app, &exports, &source\.id, "recovery-device-session"\)/);
});

test('both desktop Ledger read-only flows keep one instruction dialog open until the native export resolves', () => {
  assert.match(appSource, /function LedgerViewKeyExportOverlay\(\)/);
  assert.match(appSource, /This window closes automatically as soon as the Ledger returns the private view key/);
  assert.match(appSource, /setLedgerViewKeyExportPending\(true\)/);
  assert.match(appSource, /setLedgerViewKeyExportPending\(false\); setBusy\(false\);/);
});

test('desktop uses one app-wide unlock boundary before restoring wallet sessions', () => {
  const hostSource = readFileSync(resolve(desktopRoot, 'src-tauri', 'src', 'lib.rs'), 'utf8');
  for (const command of ['app_protection_status', 'set_app_protection_password', 'verify_app_protection_password', 'set_app_protection_mode', 'verify_system_auth', 'lock_app']) {
    assert.match(tauriBuild, new RegExp(`"${command}"`));
    assert.match(tauriCapability, new RegExp(`"allow-${command.replaceAll('_', '-')}"`));
  }
  assert.match(appSource, /appProtection\?\.locked !== false/);
  assert.match(appSource, /function AppProtectionGate/);
  assert.match(appSource, /t\('protection\.choose'\)/);
  assert.match(appSource, /t\('protection\.biometricPrivacy'\)/);
  assert.match(i18nSource, /Choose the quick system sign-in or your own app password\./);
  assert.match(i18nSource, /Wähle die schnelle Geräte-Anmeldung oder ein eigenes App-Passwort\./);
  assert.match(i18nSource, /Your biometric data stays with the operating system\./);
  assert.match(i18nSource, /Deine biometrischen Daten bleiben beim Betriebssystem\./);
  assert.match(hostSource, /fn lock_app\(/);
  assert.match(hostSource, /FastWalletSessionState/);
  assert.match(hostSource, /MONERO_DESKTOP_APP_PROTECTION locked/);
  assert.match(hostSource, /require_app_unlocked\(&protection\)\?/);
  assert.match(hostSource, /require_fresh_app_authorization/);
  assert.match(secureStoreSource, /Argon2/);
  assert.match(secureStoreSource, /store_app_protection_mode/);
  assert.doesNotMatch(tauriBuild, /"clear_app_protection_password"/);
  assert.doesNotMatch(tauriCapability, /"allow-clear-app-protection-password"/);
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

test('desktop removes a Fast Wallet only after native backup, sync, and zero-balance checks', () => {
  const hostSource = readFileSync(resolve(desktopRoot, 'src-tauri', 'src', 'lib.rs'), 'utf8');
  const removalSource = rustFunction(hostSource, 'remove_fast_wallet');
  assert.match(removalSource, /seed_backup_status != "verified"/);
  assert.match(removalSource, /validate_fast_wallet_removal_snapshot\(&raw\)/);
  assert.ok(
    removalSource.indexOf('validate_fast_wallet_removal_snapshot') <
      removalSource.indexOf('fast_wallet::remove'),
  );
  assert.match(appSource, /invoke<void>\('remove_fast_wallet'/);
  assert.match(appSource, /Remove empty Fast Wallet/);
  assert.match(tauriBuild, /"remove_fast_wallet"/);
  assert.match(tauriCapability, /"allow-remove-fast-wallet"/);
});

test('desktop exposes no per-wallet password command or current settings control', () => {
  const activeSettings = appSource.slice(appSource.indexOf('function LeanSettings('));
  assert.doesNotMatch(activeSettings, /change_wallet_password/);
  assert.doesNotMatch(tauriBuild, /"change_wallet_password"/);
  assert.doesNotMatch(tauriCapability, /"allow-change-wallet-password"/);
});
