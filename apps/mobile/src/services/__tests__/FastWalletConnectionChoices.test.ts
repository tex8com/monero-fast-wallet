import { readFileSync } from 'fs';
import { resolve } from 'path';

import {
  FAST_WALLET_WORKER_DIRECTORY_ADMISSION_PUBLIC_KEY,
  normalizePrivateWorkerDescriptor,
  parseCommunityFastWalletWorkerDirectory,
} from '../../../../../packages/wallet-shared/src/fastWalletWorkerDirectory';
import {
  fixedMainnetNodeConnection,
  FIXED_MAINNET_NODES,
} from '../../../../../packages/wallet-shared/src/nodePresets';

const workerId = '11'.repeat(32);
const mobileRoot = resolve(__dirname, '..', '..', '..');
const nativeSource = (...parts: string[]) =>
  readFileSync(resolve(mobileRoot, ...parts), 'utf8');

function directory(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    sequence: 7,
    generatedAt: 1_800_000_000,
    admissionPublicKey: FAST_WALLET_WORKER_DIRECTORY_ADMISSION_PUBLIC_KEY,
    workers: [
      {
        workerId,
        workerDescriptor: 'aa',
        admissionCertificate: 'bb',
        operatorLabel: 'Approved operator',
        region: 'EU',
        policyUrl: 'https://example.test/privacy',
        maximumAssignments: 500,
        lastSeenAt: 1_800_000_000,
      },
    ],
    ...overrides,
  };
}

describe('Fast Wallet connection choices', () => {
  it('uses MFN acceleration for both pinned clearnet nodes', () => {
    for (const node of ['tex8', 'community'] as const) {
      const preset = fixedMainnetNodeConnection(node, 'clearnet');
      expect(preset).toEqual({
        node,
        transport: 'clearnet',
        mode: 'optimized-grpc',
        daemonAddress: `${FIXED_MAINNET_NODES[node].clearnetHost}:18089`,
        grpcEndpoint: `${FIXED_MAINNET_NODES[node].clearnetHost}:18091`,
        proxyAddress: '',
      });
    }
  });

  it('uses original RPC through the local Tor proxy for onion nodes', () => {
    const preset = fixedMainnetNodeConnection('tex8', 'onion');
    expect(preset.mode).toBe('original-rpc');
    expect(preset.daemonAddress).toBe(
      `${FIXED_MAINNET_NODES.tex8.onionHost}:18089`,
    );
    expect(preset.grpcEndpoint).toBe('');
    expect(preset.proxyAddress).toBe('127.0.0.1:9050');
  });

  it('accepts only the app-pinned Community Worker directory identity', () => {
    expect(parseCommunityFastWalletWorkerDirectory(directory()).workers[0])
      .toMatchObject({ workerId, operatorLabel: 'Approved operator' });
    expect(() =>
      parseCommunityFastWalletWorkerDirectory(
        directory({ admissionPublicKey: '22'.repeat(32) }),
      ),
    ).toThrow('identity does not match');
  });

  it('pins the Community Worker admission key below the React boundary', () => {
    const android = nativeSource(
      'android',
      'app',
      'src',
      'main',
      'java',
      'com',
      'monerowallet',
      'NativeMoneroWalletModule.kt',
    );
    const ios = nativeSource(
      'ios',
      'MoneroWallet',
      'NativeMoneroWallet',
      'RCTNativeMoneroWallet.mm',
    );
    for (const source of [android, ios]) {
      expect(source).toContain(
        FAST_WALLET_WORKER_DIRECTORY_ADMISSION_PUBLIC_KEY,
      );
      expect(source).toContain(
        'Community scan-service directory identity does not match this app',
      );
    }
  });

  it('rejects duplicate Workers and normalizes a private Worker QR value', () => {
    const duplicate = directory();
    duplicate.workers.push({ ...duplicate.workers[0] });
    expect(() => parseCommunityFastWalletWorkerDirectory(duplicate)).toThrow(
      'duplicate worker',
    );
    expect(
      normalizePrivateWorkerDescriptor('tex8-fast-wallet-worker:v1:aabb'),
    ).toBe('aabb');
  });
});
