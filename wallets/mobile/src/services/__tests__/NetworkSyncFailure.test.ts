import {
  networkSyncFailureCode,
  networkSyncFailureTranslationKey,
  networkSyncStatusAfterReadFailure,
} from '../NetworkSyncFailure';
import type {NetworkSyncStatus} from '../NativeMoneroWallet';
import {networkSyncTransportPresentation} from '../../../../../packages/wallet-shared/src/networkSync';

const status = (lastError: string, state = 'retrying') => ({
  lastError,
  phase: state,
  state,
});

describe('networkSyncFailureCode', () => {
  it('turns native transport errors into a safe, useful user action', () => {
    expect(networkSyncFailureCode(status('socket connection refused'))).toBe(
      'node-unreachable',
    );
    expect(networkSyncFailureTranslationKey('node-unreachable')).toBe(
      'sync.failureNodeUnreachable',
    );
  });

  it('does not pass raw native error text through the user-facing vocabulary', () => {
    expect(
      networkSyncFailureCode(status('unexpected native implementation detail')),
    ).toBe('retrying');
    expect(networkSyncFailureCode(status('timeout while fetching batch'))).toBe(
      'node-timeout',
    );
    expect(networkSyncFailureCode(status('invalid block response'))).toBe(
      'server-response',
    );
    expect(
      networkSyncFailureCode(
        status('encoded chunk exceeds RPC byte limit: 40000000 > 33554432'),
      ),
    ).toBe('server-response');
    expect(
      networkSyncFailureCode(status('resource exhausted: message too large')),
    ).toBe('server-response');
  });

  it('does not invent an error while the shared pipeline is healthy', () => {
    expect(
      networkSyncFailureCode(status('connection refused', 'fetching-blocks')),
    ).toBeUndefined();
  });

  it('does not label a private scanner retry as a node connection failure', () => {
    expect(networkSyncFailureCode(status('', 'scanner-backoff'))).toBe(
      'wallet-scan',
    );
    expect(networkSyncFailureTranslationKey('wallet-scan')).toBe(
      'sync.failureWalletScan',
    );
  });

  it('removes stale gRPC confirmation after an IPC read failure without losing progress', () => {
    const previous = {
      network: 'mainnet', state: 'fetching-blocks', phase: 'fetching-blocks',
      blockTransport: 'grpc', blockTransportReason: 'grpc-stream',
      chainHeight: 150, downloadStartHeight: 100, downloadedHeight: 170,
      targetHeight: 200, transportStarts: 1, joinedWallets: 1,
      stalledWallets: 0, payloadBytesReceived: 12345, providerGeneration: 4,
    } as unknown as NetworkSyncStatus;
    const next = networkSyncStatusAfterReadFailure(previous);
    expect(next).toEqual({...previous, blockTransport: 'unknown', blockTransportReason: 'checking'});
    expect(networkSyncTransportPresentation(next)).toMatchObject({
      transport: 'unknown', tone: 'neutral', slowFallback: false,
    });
    expect(previous.blockTransport).toBe('grpc');
  });

  it('does not invent a transport snapshot when the first status read fails', () => {
    expect(networkSyncStatusAfterReadFailure(undefined)).toBeUndefined();
  });
});
