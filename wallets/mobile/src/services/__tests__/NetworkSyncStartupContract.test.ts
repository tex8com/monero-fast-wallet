import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';

const repoRoot = resolve(__dirname, '..', '..', '..', '..', '..');
const walletEngine = readFileSync(
  resolve(repoRoot, 'native', 'monero-bridge', 'cpp', 'WalletEngine.cpp'),
  'utf8',
);

describe('shared network startup contract', () => {
  it('starts a configured gRPC block route without waiting for the Onion daemon', () => {
    const initializationStart = walletEngine.indexOf(
      'if (initializeProvider) {',
    );
    const fetchStart = walletEngine.indexOf(
      'if (!routineTipCheck) {',
      initializationStart,
    );
    const initialization = walletEngine.slice(initializationStart, fetchStart);

    expect(initializationStart).toBeGreaterThanOrEqual(0);
    expect(fetchStart).toBeGreaterThan(initializationStart);
    expect(initialization).toContain(
      'provider->setGrpcStreamEndpoint(grpcEndpoint);',
    );
    expect(initialization).toContain('if (grpcEndpoint.empty()) {');
    expect(initialization).toContain('provider->connectToDaemon()');
    expect(initialization.indexOf('provider->setGrpcStreamEndpoint'))
      .toBeLessThan(initialization.indexOf('provider->connectToDaemon()'));
    expect(initialization).toContain(
      'networkSync.providerDaemonDeferred',
    );
  });
});
