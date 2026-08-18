import fs from 'node:fs';
import path from 'node:path';

const mobileRoot = path.resolve(__dirname, '..', '..', '..');
const source = (...parts: string[]) =>
  fs.readFileSync(path.join(mobileRoot, ...parts), 'utf8');

describe('process-wide connectivity lifecycle', () => {
  it('owns Tor and Clearnet independently in a persistent Android service', () => {
    const service = source(
      'android',
      'app',
      'src',
      'main',
      'java',
      'com',
      'monerowallet',
      'ConnectivityForegroundService.kt',
    );
    const manifest = source(
      'android',
      'app',
      'src',
      'main',
      'AndroidManifest.xml',
    );
    const activity = source(
      'android',
      'app',
      'src',
      'main',
      'java',
      'com',
      'monerowallet',
      'MainActivity.kt',
    );
    const torManager = source(
      'android',
      'app',
      'src',
      'main',
      'java',
      'com',
      'monerowallet',
      'EmbeddedTorManager.kt',
    );

    expect(service).toContain('START_STICKY');
    expect(service).toContain('Executors.newFixedThreadPool(2)');
    expect(service).toContain('checkTorRoute()');
    expect(service).toContain('checkClearnetRoute()');
    expect(service).toContain('GET /get_height HTTP/1.1');
    expect(service).toContain('response.contains("\\"height\\"")');
    expect(service).toContain('HTTP2_PREFACE');
    expect(service).toContain('EMPTY_HTTP2_SETTINGS');
    expect(service).toContain('probeGrpcApi(endpoint)');
    expect(service).toContain('registerDefaultNetworkCallback');
    expect(service).toContain(
      'onAvailable(network: Network) = requestImmediateCheck(reconnectTor = false)',
    );
    expect(service).toContain('markCheckingUnlessConnected');
    expect(service).toContain('tor_restart_request_ignored');
    expect(service).not.toContain('EmbeddedTorManager.reconnect(applicationContext)');
    expect(torManager).toContain('nativeRuntimeStartCommitted');
    expect(torManager).toContain('duplicate_start_blocked=true');
    expect(torManager).toContain('runtime_failed retained_binding=true restart_blocked=true');
    expect(torManager).not.toContain('unbindService');
    expect(torManager).not.toContain('releaseFailedBinding');
    expect(manifest).toContain('android:foregroundServiceType="specialUse"');
    expect(activity).toContain('override fun onPostResume()');
    expect(activity).toContain('ConnectivityForegroundService.start(this)');
  });

  it('renders two native route LEDs instead of inferring Online from wallet sync', () => {
    const state = source('src', 'services', 'ConnectivityState.tsx');
    const topBar = source('src', 'components', 'AppTopBar.tsx');

    expect(state).toContain('getConnectivityStatus');
    expect(state).toContain("next !== 'active'");
    expect(state).toContain('recheckConnectivity?.(false)');
    expect(state).not.toContain('recheckConnectivity?.(true)');
    expect(state).not.toContain(
      "tor: {...current.tor, phase: 'checking', connected: false}",
    );
    expect(topBar).toContain('connectivity.tor');
    expect(topBar).toContain('connectivity.clearnet');
    expect(topBar).not.toContain('nodeConnectionStatus');
  });

  it('provides the same native snapshot and safe resume probe on iOS', () => {
    const module = source(
      'ios',
      'MoneroWallet',
      'EmbeddedTorModule.m',
    );

    expect(module).toContain('RCT_REMAP_METHOD(startConnectivity');
    expect(module).toContain('RCT_REMAP_METHOD(configureConnectivity');
    expect(module).toContain('RCT_REMAP_METHOD(recheckConnectivity');
    expect(module).toContain('RCT_REMAP_METHOD(getConnectivityStatus');
    expect(module).toContain('MFWConnectivityRuntime');
  });
});
