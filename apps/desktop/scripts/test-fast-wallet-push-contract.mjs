import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FAST_WALLET_PUSH_CONTRACT,
  FAST_WALLET_PUSH_TYPE,
  parseFastWalletPushEvent,
} from '../src/fastWalletNotifications.ts';

const valid = {
  type: FAST_WALLET_PUSH_TYPE,
  contractVersion: FAST_WALLET_PUSH_CONTRACT,
  eventId: 'fwpush_0123456789abcdef0123456789abcdef',
};

test('accepts only the opaque Fast Wallet v3 signal', () => {
  assert.deepEqual(parseFastWalletPushEvent(valid), valid);
  assert.deepEqual(parseFastWalletPushEvent({ data: valid }), valid);
  assert.deepEqual(parseFastWalletPushEvent({ ...valid, eventId: `evt_${'a'.repeat(64)}` }), { ...valid, eventId: `evt_${'a'.repeat(64)}` });
});

test('rejects every payload that exposes wallet or transaction detail', () => {
  for (const field of [
    'address', 'amountAtomic', 'network', 'txId', 'walletId', 'seed',
    'privateViewKey', 'privateSpendKey', 'blockHeight', 'confirmations',
  ]) {
    assert.equal(parseFastWalletPushEvent({ ...valid, [field]: 'secret-or-detail' }), undefined, field);
  }
});

test('rejects unknown fields, old contracts, and malformed event identifiers', () => {
  assert.equal(parseFastWalletPushEvent({ ...valid, unexpected: 'value' }), undefined);
  assert.equal(parseFastWalletPushEvent({ ...valid, contractVersion: 'v1' }), undefined);
  assert.equal(parseFastWalletPushEvent({ ...valid, eventId: 'wallet-specific-id' }), undefined);
});

test('documents the closed-app provider contract used by desktop adapters', () => {
  const providers = new Set(['apns', 'windows-agent', 'linux-agent', 'tauri-local']);
  const deliveries = new Set([
    'disabled',
    'local-while-open',
    'closed-app-apns',
    'background-windows-agent',
    'background-linux-agent',
  ]);
  assert.equal(providers.has('apns'), true);
  assert.equal(providers.has('windows-agent'), true);
  assert.equal(providers.has('linux-agent'), true);
  assert.equal(deliveries.has('background-linux-agent'), true);
  assert.equal(deliveries.has('background-windows-agent'), true);
  assert.equal(deliveries.has('closed-app-apns'), true);
});
