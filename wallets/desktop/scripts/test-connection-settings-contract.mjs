import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const desktopRoot = join(import.meta.dirname, '..');
const app = readFileSync(join(desktopRoot, 'src/App.tsx'), 'utf8');
const native = readFileSync(join(desktopRoot, 'src-tauri/src/lib.rs'), 'utf8');
const torTransport = readFileSync(
  join(desktopRoot, 'src-tauri/src/tor_transport.rs'),
  'utf8',
);
const notificationAgent = readFileSync(
  join(desktopRoot, 'src-tauri/src/bin/monero-fast-walletd.rs'),
  'utf8',
);
const updateAdapter = readFileSync(join(desktopRoot, 'src/appUpdate.ts'), 'utf8');
const tauriConfig = readFileSync(
  join(desktopRoot, 'src-tauri/tauri.conf.json'),
  'utf8',
);
const capability = readFileSync(
  join(desktopRoot, 'src-tauri/capabilities/main.json'),
  'utf8',
);

test('desktop node status manages the global Clearnet sync and Tor wallet routes independently', () => {
  assert.match(app, /fixedMainnetNodeConnection/);
  assert.match(app, /function DesktopNodeStatus/);
  assert.match(app, /fixedMainnetNodeConnection\(node, 'clearnet'\)/);
  assert.match(app, /fixedMainnetNodeConnection\(node, 'onion'\)/);
  assert.match(app, /proxyAddress: '127\.0\.0\.1:9050'/);
  assert.match(app, /diagnose_connection_routes/);
  assert.match(app, /section === 'node'/);
  assert.match(app, /window\.setTimeout\(\(\) => \{/);
  assert.match(app, /}, 550\)/);
  const settings = app.slice(
    app.indexOf('function LeanSettings('),
    app.indexOf('function SensitiveAuthorizationOverlay('),
  );
  assert.doesNotMatch(settings, /load_node_settings|save_node_settings|Node status/);
});

test('desktop embeds Tor and permits only block synchronization on direct Clearnet', () => {
  assert.match(torTransport, /arti_client/);
  assert.match(torTransport, /TorClientConfigBuilder::from_directories/);
  assert.match(torTransport, /TorClient::builder\(\)/);
  assert.match(torTransport, /start_embedded_tor/);
  assert.match(torTransport, /copy_bidirectional/);
  assert.match(torTransport, /read_socks4_request/);
  assert.match(torTransport, /read_socks5_request/);
  assert.match(torTransport, /SOCKS4a hostname/);
  assert.match(torTransport, /socks5h:\/\/127\.0\.0\.1:9050/);
  assert.match(native, /tor_transport::start_embedded_tor/);
  assert.match(native, /probe_tor_route/);
  assert.match(native, /probe_clearnet_route/);
  assert.doesNotMatch(
    native,
    /first_party_endpoint_with_dns_fallback\(&profile\.daemon_address\)/,
  );
  assert.match(native, /proxy_address: tor_transport::TOR_SOCKS_ADDRESS/);
  assert.match(notificationAgent, /connect_through_tor/);
  assert.match(notificationAgent, /client_tls\(request, transport\)/);
  assert.match(updateAdapter, /proxy: 'socks5h:\/\/127\.0\.0\.1:9050'/);
  assert.match(tauriConfig, /connect-src 'self';/);
  assert.doesNotMatch(tauriConfig, /connect-src[^;]*https:/);
});

test('desktop route LEDs require real Onion daemon and gRPC protocol responses', () => {
  assert.match(native, /GET \/get_height HTTP\/1\.1/);
  assert.match(native, /probe_monero_daemon_api/);
  assert.match(native, /PREFACE_AND_SETTINGS/);
  assert.match(native, /probe_grpc_transport/);
  assert.match(native, /TOR_CONNECTIVITY/);
  assert.match(native, /mfw-tor-health-/);
});

test('desktop supervises Tor and publishes two independent live route states', () => {
  assert.match(torTransport, /catch_unwind/);
  assert.match(torTransport, /worker-panicked action=restart/);
  assert.match(torTransport, /client\s*\.bootstrap\(\)\s*\.await/);
  assert.match(torTransport, /status_snapshot/);
  assert.match(native, /start_desktop_connectivity_monitor/);
  assert.match(native, /fn connectivity_status/);
  assert.match(app, /connectivity_status/);
  assert.match(capability, /allow-connectivity-status/);
  assert.match(app, />Tor<\/span>/);
  assert.match(app, />Sync<\/span>/);
});

test('desktop background checks preserve confirmed routes and refresh retained state on focus', () => {
  assert.match(native, /fn mark_connectivity_checking/);
  assert.match(native, /state\.connected && state\.endpoint == endpoint/);
  assert.match(native, /mark_connectivity_checking\(\s*tor_connectivity_routes\(\)/);
  assert.match(native, /mark_connectivity_checking\(\s*connectivity_routes\(\)/);
  assert.match(app, /window\.addEventListener\('focus', pollOnFocus\)/);
  assert.match(app, /document\.addEventListener\('visibilitychange', pollOnVisibility\)/);
  assert.doesNotMatch(app, /setConnectivity\([^)]*connected:\s*false/);
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
