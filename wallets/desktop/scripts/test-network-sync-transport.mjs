import assert from 'node:assert/strict';
import test from 'node:test';
import { networkSyncTransportPresentation } from '../../../packages/wallet-shared/src/networkSync.ts';

const active = {
  state: 'fetching-blocks', phase: 'fetching-blocks', chainHeight: 100,
  targetHeight: 200, transportStarts: 1, joinedWallets: 1, stalledWallets: 0,
};

test('only native-confirmed gRPC is green; old byte counters cannot infer a path', () => {
  assert.deepEqual(networkSyncTransportPresentation({ ...active, blockTransport: 'grpc' }),
    { transport: 'grpc', tone: 'success', slowFallback: false });
  for (const extra of [{}, { payloadBytesReceived: 1e8 }, { networkBytesReceived: 1e8 },
    { blockTransport: 'configured-grpc' }]) {
    assert.deepEqual(networkSyncTransportPresentation({ ...active, ...extra }),
      { transport: 'unknown', tone: 'neutral', slowFallback: false });
  }
});

test('RPC fallback is yellow even when fully synchronized and with old gRPC bytes', () => {
  for (const phase of ['fetching-blocks', 'scanning-wallets', 'synced']) {
    assert.deepEqual(networkSyncTransportPresentation({ ...active, state: phase, phase,
      blockTransport: 'rpc', blockTransportReason: 'rpc-fallback', payloadBytesReceived: 1e9 }),
    { transport: 'rpc', tone: 'warning', slowFallback: true });
  }
});

test('deliberately selected standard RPC is not described as a gRPC failure', () => {
  assert.deepEqual(networkSyncTransportPresentation({ ...active,
    blockTransport: 'rpc', blockTransportReason: 'rpc-selected' }),
  { transport: 'rpc', tone: 'warning', slowFallback: false });
});

test('connection and scanner errors override a previously green or yellow path', () => {
  for (const transport of ['grpc', 'rpc']) {
    for (const phase of ['provider-backoff', 'scanner-backoff', 'retrying', 'degraded']) {
      assert.equal(networkSyncTransportPresentation({ ...active, phase,
        blockTransport: transport }).tone, 'error');
    }
  }
});

test('stopped, idle, reconnecting and missing statuses never keep a stale green path', () => {
  for (const phase of ['idle', 'stopped', 'reconnecting']) {
    assert.deepEqual(networkSyncTransportPresentation({ ...active, phase,
      blockTransport: 'grpc' }),
    { transport: 'unknown', tone: 'neutral', slowFallback: false });
  }
  assert.equal(networkSyncTransportPresentation(undefined).tone, 'neutral');
  assert.equal(networkSyncTransportPresentation(null).transport, 'unknown');
});

test('fallback recovery promotes the current native gRPC path, not a historical warning', () => {
  assert.equal(networkSyncTransportPresentation({ ...active,
    blockTransport: 'rpc', blockTransportReason: 'rpc-fallback' }).tone, 'warning');
  assert.deepEqual(networkSyncTransportPresentation({ ...active,
    blockTransport: 'grpc', blockTransportReason: 'rpc-fallback' }),
  { transport: 'grpc', tone: 'success', slowFallback: false });
});
