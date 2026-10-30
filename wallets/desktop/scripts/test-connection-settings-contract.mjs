import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const desktopRoot = join(import.meta.dirname, '..');
const app = readFileSync(join(desktopRoot, 'src/App.tsx'), 'utf8');
const native = readFileSync(join(desktopRoot, 'src-tauri/src/lib.rs'), 'utf8');
const walletEngine = readFileSync(
  join(desktopRoot, '../../native/monero-bridge/cpp/WalletEngine.cpp'),
  'utf8',
);
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

test('node cards follow the retained monitor without automatically running more route probes', () => {
  const nodeStatus = app.slice(
    app.indexOf('function DesktopNodeStatus('),
    app.indexOf('function marketChartTimestamp('),
  );
  const polling = nodeStatus.slice(
    nodeStatus.indexOf('const pollConnectivity ='),
    nodeStatus.indexOf('const choosePreset ='),
  );
  assert.match(polling, /invoke<ConnectivityStatus>\('connectivity_status'/);
  assert.match(polling, /window\.setInterval\(pollConnectivity, 1_500\)/);
  assert.match(polling, /cancelled \|\| inFlight \|\| diagnosingRef\.current/);
  assert.match(polling, /!cancelled && !diagnosingRef\.current/);
  assert.match(polling, /diagnosticRequest\.current === request/);
  assert.match(polling, /routeContextRef\.current === routeContext/);
  assert.match(polling, /window\.clearInterval\(timer\)/);
  assert.doesNotMatch(polling, /diagnose_connection_routes|runDiagnostics/);
  assert.doesNotMatch(nodeStatus, /void runDiagnostics\(\)/);
  assert.match(nodeStatus, /saveQueue\.current\.then\(runDiagnostics\)/);
  assert.match(nodeStatus, /\[diagnosing, network, profile, routeContext, saveState\]/);
  assert.match(nodeStatus, /diagnosticRequest\.current !== request \|\| routeContextRef\.current !== routeContext/);
});

test('node cards distinguish a pending or idle monitor from a failed route', () => {
  const nodeStatus = app.slice(
    app.indexOf('function DesktopNodeStatus('),
    app.indexOf('function marketChartTimestamp('),
  );
  assert.match(nodeStatus, /phase === 'starting' \|\| phase === 'checking'/);
  assert.match(nodeStatus, /!checking && phase === 'error' \? 'failed'/);
  assert.match(nodeStatus, /phase === 'error' \? t\('nodeStatus\.failed'\) : t\('nodeStatus\.notChecked'\)/);
});

test('desktop embeds Tor for Onion profiles and keeps direct RPC available', () => {
  assert.match(torTransport, /arti_client/);
  assert.match(torTransport, /TorClientConfigBuilder::from_directories/);
  assert.match(torTransport, /TorClient::with_runtime\(runtime\)/);
  assert.match(torTransport, /create_unbootstrapped_async\(\)/);
  assert.match(torTransport, /start_embedded_tor/);
  assert.match(torTransport, /copy_bidirectional/);
  assert.match(torTransport, /read_socks4_request/);
  assert.match(torTransport, /read_socks5_request/);
  assert.match(torTransport, /SOCKS4a hostname/);
  assert.match(torTransport, /PREFERRED_TOR_SOCKS_ADDRESS/);
  assert.match(torTransport, /StdTcpListener::bind\("127\.0\.0\.1:0"\)/);
  assert.match(torTransport, /socks-port-unavailable/);
  assert.match(torTransport, /format!\("socks5h:\/\/\{\}"/);
  assert.match(native, /tor_transport::start_embedded_tor/);
  assert.match(native, /probe_tor_route/);
  assert.match(native, /probe_clearnet_route/);
  assert.doesNotMatch(
    native,
    /first_party_endpoint_with_dns_fallback\(&profile\.daemon_address\)/,
  );
  assert.match(native, /tor_transport::socks_address\(\)/);
  assert.match(notificationAgent, /connect_through_tor/);
  assert.match(notificationAgent, /client_tls_with_config\(\s*request,\s*transport,/);
  assert.match(updateAdapter, /invoke<string>\('embedded_tor_proxy_uri'\)/);
  assert.match(tauriConfig, /connect-src 'self';/);
  assert.doesNotMatch(tauriConfig, /connect-src[^;]*https:/);
});

test('desktop reserves gRPC for the Monero Fast Node profile', () => {
  const nodeSettings = readFileSync(
    join(desktopRoot, 'src-tauri/src/node_settings.rs'),
    'utf8',
  );
  assert.match(nodeSettings, /profile\.mode == "optimized-grpc" && profile\.grpc_endpoint\.is_empty\(\)/);
  assert.match(nodeSettings, /profile\.mode != "optimized-grpc" && !profile\.grpc_endpoint\.is_empty\(\)/);
  assert.match(native, /profile\.mode == "optimized-grpc"/);
  assert.match(native, /native\.set_grpc_endpoint\(&wallet_id, ""\)/);
  assert.match(native, /if profile\.mode != "optimized-grpc"/);
  assert.match(native, /mfn_grpc_enabled: profile\.mode == "optimized-grpc"/);
  const directDaemonProbe = native.slice(
    native.indexOf('fn probe_direct_monero_daemon_route'),
    native.indexOf('fn probe_monero_daemon_api'),
  );
  assert.match(directDaemonProbe, /probe_monero_daemon_api/);
  assert.doesNotMatch(directDaemonProbe, /probe_grpc_transport/);
  assert.match(app, /mfnGrpcEnabled/);
  assert.match(app, /daemonUsesTor/);
});

test('desktop route LEDs require real Onion daemon and gRPC protocol responses', () => {
  assert.match(native, /GET \/get_height HTTP\/1\.1/);
  assert.match(native, /probe_monero_daemon_api/);
  assert.match(native, /PREFACE_AND_SETTINGS/);
  assert.match(native, /probe_grpc_transport/);
  assert.match(native, /TOR_CONNECTIVITY/);
  assert.match(native, /mfw-tor-health-/);
});

test('desktop supervises its configured daemon route and publishes MFN state separately', () => {
  assert.match(torTransport, /catch_unwind/);
  assert.match(torTransport, /worker-panicked action=restart/);
  assert.match(torTransport, /client\s*\.bootstrap\(\)\s*\.await/);
  assert.match(torTransport, /status_snapshot/);
  assert.match(native, /start_desktop_connectivity_monitor/);
  assert.match(native, /fn connectivity_status/);
  assert.match(app, /connectivity_status/);
  assert.match(capability, /allow-connectivity-status/);
  assert.match(app, /connectivity\?\.daemonUsesTor \? 'Tor' : 'Node'/);
  assert.match(app, /connectivity\?\.mfnGrpcEnabled/);
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

test('node changes never block the UI or overwrite a newer selection', () => {
  assert.match(walletEngine, /try_lock_for\(std::chrono::milliseconds\(250\)\)/);
  assert.match(walletEngine, /network sync is busy; node change must be retried/);
  assert.match(native, /wallet\.node-settings-apply-queued/);
  assert.match(native, /wallet\.node-settings-apply-retrying/);
  assert.match(native, /latest != applied_profile/);
  assert.match(native, /reason", "superseded/);
  const saveCommand = native.slice(
    native.indexOf('async fn save_node_settings'),
    native.indexOf('async fn diagnose_connection_routes'),
  );
  assert.match(saveCommand, /spawn_blocking/);
  assert.doesNotMatch(saveCommand, /\.await\s*\.map_err/);
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
