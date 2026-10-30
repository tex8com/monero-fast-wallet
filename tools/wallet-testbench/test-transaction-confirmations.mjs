import assert from 'node:assert/strict';
import test from 'node:test';
import { transactionConfirmationProgress as progress } from '../../packages/wallet-shared/src/transactionConfirmations.ts';

test('native counts move from receiving to confirmed at exactly ten', () => {
  for (const current of [0, 1, 3, 9]) {
    assert.deepEqual(progress({ confirmations: current }), { current, required: 10, state: 'confirming' });
  }
  for (const current of [10, 11, 125_000]) {
    assert.deepEqual(progress({ confirmations: String(current) }), { current, required: 10, state: 'confirmed' });
  }
});

test('native reorg counts can go backwards without retaining a confirmed flag', () => {
  assert.equal(progress({ confirmations: 10 }).state, 'confirmed');
  assert.equal(progress({ confirmations: 9 }).state, 'confirming');
  assert.deepEqual(progress({ confirmations: 0, pending: true }), { current: 0, required: 10, state: 'confirming' });
});

test('failed and pending native flags never become confirmed', () => {
  assert.equal(progress({ confirmations: 20, pending: true }).state, 'confirming');
  assert.equal(progress({ confirmations: 20, failed: true }).state, 'failed');
  assert.equal(progress({ confirmations: 20, failed: true, pending: true }).state, 'failed');
});

test('mining rewards require sixty native confirmations', () => {
  assert.deepEqual(progress({ confirmations: 59, coinbase: true }), { current: 59, required: 60, state: 'confirming' });
  assert.equal(progress({ confirmations: 60, coinbase: true }).state, 'confirmed');
});

test('custom block locks extend the target while timestamp locks remain separate', () => {
  const source = { blockHeight: '3700000', unlockTime: '3700020' };
  assert.deepEqual(progress({ ...source, confirmations: '19' }), { current: 19, required: 20, state: 'confirming' });
  assert.equal(progress({ ...source, confirmations: '20' }).state, 'confirmed');
  assert.equal(progress({ ...source, confirmations: 20, coinbase: true }).required, 60);
  assert.equal(progress({ ...source, unlockTime: '1793209000', confirmations: 10 }).required, 10);
});

test('invalid native counts cannot imply a confirmed transaction', () => {
  for (const confirmations of [undefined, NaN, Infinity, -1, 1.5, '', 'x', '-1', '10.5', '9007199254740992']) {
    assert.deepEqual(progress({ confirmations }), { current: 0, required: 10, state: 'confirming' });
  }
});
