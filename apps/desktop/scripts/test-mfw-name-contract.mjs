import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const namesUi = readFileSync(new URL('../src/MfwNames.tsx', import.meta.url), 'utf8');
const host = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
const registry = readFileSync(new URL('../src-tauri/src/mfw_names.rs', import.meta.url), 'utf8');
const resolver = readFileSync(new URL('../src-tauri/src/mfw_name_resolver.rs', import.meta.url), 'utf8');
const native = readFileSync(
  new URL('../../../native/desktop-bridge/cpp/DesktopWalletCore.cpp', import.meta.url),
  'utf8',
);
const protocolBridge = readFileSync(
  new URL('../../../native/monero-bridge/cpp/FastWalletProtocolBridge.h', import.meta.url),
  'utf8',
);
const build = readFileSync(new URL('../src-tauri/build.rs', import.meta.url), 'utf8');
const capabilities = readFileSync(
  new URL('../src-tauri/capabilities/main.json', import.meta.url),
  'utf8',
);
const releaseManifest = JSON.parse(
  readFileSync(new URL('../../../config/v1-release-features.json', import.meta.url), 'utf8'),
);

test('desktop MFW registration uses the frozen development release contract', () => {
  assert.match(
    app,
    /section === 'mfw' && v1ReleaseFeatures\.mfwNameRegistration && <MfwNames/,
  );
  assert.match(
    app,
    /v1ReleaseFeatures\.mfwNameRegistration \? \[\{ section: 'mfw'/,
  );
  assert.match(host, /release_features::require\(\s*"mfwNameRegistration"/);
  assert.equal(releaseManifest.features.mfwNameRegistration, true);
  assert.equal(releaseManifest.parameters.mfwNameGenesis.network, 'mainnet');
  assert.equal(
    releaseManifest.parameters.mfwNameGenesis.maximumTermYears,
    1_000,
  );
  assert.deepEqual(releaseManifest.parameters.mfwNameResolverOrigins, [
    'http://fastrelayrpcf3hbc4qvykjgbpwpmcuq5dpcsdxoe7gwfh2zxdib3eid.onion',
    'http://quietportrpccujodzxhwcfefbmhftof5i6oiq7rrx5tnzna7rxirhqd.onion',
  ]);
});

test('every desktop MFW command has generated permission and invoke coverage', () => {
  for (const command of [
    'list_mfw_names',
    'resolve_mfw_name_for_payment',
    'check_mfw_name_availability',
    'prepare_mfw_name_registration',
    'prepare_mfw_name_claim',
    'prepare_mfw_name_transition',
    'export_mfw_name_recovery',
    'import_mfw_name_recovery',
    'refresh_mfw_name',
    'remove_mfw_name_local',
  ]) {
    assert.match(build, new RegExp(`"${command}"`));
    assert.match(host, new RegExp(`\\b${command},`));
    assert.match(capabilities, new RegExp(`"allow-${command.replaceAll('_', '-')}"`));
  }
});

test('owner authority stays in secure storage and outside public renderer responses', () => {
  assert.match(host, /store_mfw_name_owner_state/);
  assert.match(host, /load_mfw_owner_state/);
  assert.match(registry, /owner_private_key_hex: String/);
  assert.match(registry, /commit_salt_hex: String/);
  assert.doesNotMatch(
    host.match(/struct MfwPreparedResponse \{[\s\S]*?\n\}/)?.[0] ?? '',
    /owner_private|commit_salt/,
  );
  assert.doesNotMatch(namesUi, /ownerPrivateKeyHex|commitSaltHex/);
});

test('owner recovery remains exportable without blocking development registration', () => {
  assert.doesNotMatch(host, /record\.recovery_exported_at\.is_none\(\)/);
  assert.doesNotMatch(host, /before approving the commit/);
  assert.match(host, /\.create_new\(true\)/);
  assert.match(registry, /tex8_mfw_export_name_recovery_v1/);
  assert.match(registry, /tex8_mfw_import_name_recovery_v1/);
});

test('recovery import derives the public term from verified chain heights', () => {
  assert.match(host, /estimated_term_years\(resolution\.record_height, resolution\.expiry_height\)/);
  assert.match(registry, /const PROTOCOL_YEAR_BLOCKS: u64 = 262_800/);
  assert.match(registry, /term_blocks\.div_ceil\(PROTOCOL_YEAR_BLOCKS\)/);
  assert.match(registry, /const MAX_TERM_YEARS: u32 = 1_000/);
  assert.match(
    registry,
    /\(1\.\.=MAX_TERM_YEARS\)\.contains\(years\)/,
  );
});

test('registration covers local or manual addresses and debounced availability', () => {
  assert.match(namesUi, /loadDesktopWalletAddresses/);
  assert.match(namesUi, /create_subaddress/);
  assert.match(namesUi, /Create & select dedicated subaddress/);
  assert.doesNotMatch(namesUi, /walletChainHeight/);
  assert.match(namesUi, /window\.setTimeout\(\(\) =>/);
  assert.match(namesUi, /}, 450\)/);
  assert.match(namesUi, /wallet\?\.network \?\? 'mainnet'/);
  assert.doesNotMatch(namesUi, /if \(!candidate \|\| !wallet \|\| !walletId\)/);
  assert.match(namesUi, /type="number"/);
  assert.match(namesUi, /addressInputMode === 'manual'/);
  assert.match(namesUi, /validate_recipient_address/);
  assert.match(host, /input\.address_index/);
  assert.doesNotMatch(host, /wallet_address != input\.address\.trim\(\)/);
  assert.match(namesUi, /MONERO_TARGET_BLOCK_TIME_MS = 2 \* 60 \* 1000/);
  assert.match(namesUi, /Estimated valid until/);
  assert.match(namesUi, /Checked chain tip/);
  assert.match(namesUi, /expiry block is authoritative/);
});

test('resolver supports the pinned direct-Onion resolvers and native signature verification', () => {
  assert.match(resolver, /origins\.is_empty\(\) \|\| origins\.len\(\) > 4/);
  assert.match(resolver, /Policy::none\(\)/);
  assert.match(resolver, /deny_unknown_fields/);
  assert.match(resolver, /Independent MFW resolvers disagree/);
  assert.match(resolver, /tex8_mfw_verify_and_encode_name_address_v1/);
  assert.match(resolver, /MIN_CONFIRMATIONS: u64 = 15/);
});

test('ordinary Send resolves .mfw but reviews the verified Monero address', () => {
  assert.match(app, /endsWith\('\.mfw'\)/);
  assert.match(app, /resolve_mfw_name_for_payment/);
  assert.match(host, /\.validate_recipient_address\(&address, network_code\)/);
});

test('every native MFW operation prepares exactly one purpose-bound transaction', () => {
  assert.match(protocolBridge, /extractCanonicalExtraNonceField/);
  assert.match(protocolBridge, /field\[0\] != 0x02/);
  assert.match(protocolBridge, /std::move\(commitExtraNonce\)/);
  assert.match(native, /request\.mfwNameExtraNonce = material\.commitExtraNonce/);
  assert.match(native, /request\.mfwNameExtraNonce = record\.extraNonce/g);
  assert.match(host, /tx_count != 1/);
  assert.match(registry, /tx_ids\.len\(\) != 1/);
});

test('Ledger-backed names prepare and commit through the hardware signing session', () => {
  assert.match(host, /fn mfw_transaction_wallet_id\(/);
  assert.match(
    host,
    /ensure_ledger_hardware_session\(app, state, sessions, &registration, diagnostic_flow\)/,
  );
  assert.match(
    host,
    /\.prepare_mfw_name_registration\(\s*&transaction_wallet_id,/,
  );
  assert.match(host, /\.prepare_mfw_name_claim\(\s*&transaction_wallet_id,/);
  assert.match(
    host,
    /\.prepare_mfw_name_transition\(\s*&transaction_wallet_id,/,
  );
  assert.match(namesUi, /invokeMfwPreparation<PreparedMfw>/);
  assert.match(namesUi, /registrationId: wallet\.id/);
  assert.match(namesUi, /ledgerPreparationActive/);
});

test('secret-bearing C ABI buffers are wiped before release', () => {
  assert.match(native, /invokeSecret\(core/);
  assert.match(native, /secureClear\(result->value\)/);
  assert.match(native, /volatile char\* cursor/);
});
