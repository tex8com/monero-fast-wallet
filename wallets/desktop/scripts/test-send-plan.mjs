import assert from 'node:assert/strict';
import test from 'node:test';
import {
  recalledSendPlan,
  isPreparedSendPlan,
  rememberSendPlan,
  selectedSendAvailable,
  SendPlanReleaseGate,
  sendPlanOutcome,
  sendPlanTransactionIds,
  sendSourceOptions,
} from '../../../packages/wallet-shared/src/sendPlan.ts';

const primary = { kind: 'registered', id: 'wallet-a' };
const extra = { kind: 'fast', id: 'wallet-b' };
const source = (ref, unlockedBalanceAtomic = '500000000000') => ({
  source: ref, label: ref.id, network: 'mainnet',
  balanceAtomic: unlockedBalanceAtomic, unlockedBalanceAtomic, ready: true,
});
const plan = overrides => ({
  id: 'opaque-plan', status: 'ok', phase: 'prepared', amountAtomic: '500000000000',
  feeAtomic: '1000000', txCount: 2, txIds: ['tx-a', 'tx-b'], ...overrides,
});

test('extra wallets are explicit, same-network choices; the primary is never offered twice', () => {
  const options = sendSourceOptions([
    source(primary), source(extra), source(extra),
    { ...source({ kind: 'registered', id: 'testnet-wallet' }), network: 'testnet' },
  ], 'mainnet', primary);
  assert.deepEqual(options.map(item => item.source), [extra]);
  assert.equal(selectedSendAvailable('1000000000000', [], options), '1000000000000');
  assert.equal(selectedSendAvailable('1000000000000', [extra], options), '1500000000000');
});

test('selected balances use exact atomic arithmetic and reject unavailable selected sources', () => {
  const options = [source(extra, '1')];
  assert.equal(selectedSendAvailable('900719925474099300000', [extra, extra], options), '900719925474099300001');
  assert.equal(selectedSendAvailable('1', [extra], []), undefined);
  assert.equal(selectedSendAvailable('1', [extra], [{ ...options[0], ready: false }]), undefined);
});

test('a prepared or authorizing plan is never presented as a successful broadcast', () => {
  assert.equal(sendPlanOutcome(plan()), 'not-sent');
  assert.equal(sendPlanOutcome(plan({ phase: 'authorizing' })), 'uncertain');
  assert.equal(sendPlanOutcome(plan({ phase: 'broadcasting' })), 'uncertain');
  assert.equal(sendPlanOutcome(plan({ phase: 'complete', broadcastedTotalsKnown: true })), 'complete');
});

test('partial and unknown receipts never turn into an all-or-nothing retry', () => {
  assert.equal(sendPlanOutcome(plan({ status: 'partial', phase: 'complete', broadcastedTxIds: ['tx-a'], broadcastedAmountAtomic: '250000000000' })), 'partial');
  assert.equal(sendPlanOutcome(plan({ status: 'error', phase: 'complete', broadcastedTxIds: ['tx-a'] })), 'partial');
  assert.equal(sendPlanOutcome(plan({ phase: 'complete', broadcastedTotalsKnown: false, broadcastedAmountAtomic: null })), 'uncertain');
  assert.equal(sendPlanOutcome(plan({ status: 'uncertain', uncertainTxIds: ['tx-b'] })), 'uncertain');
});

test('a proven unattempted empty draft can be released without inventing an amount', () => {
  const empty = plan({ phase: 'cleanup_failed', status: 'error', amountAtomic: null, feeAtomic: null,
    broadcastAttempted: false, broadcastedTotalsKnown: false, txIds: [], txCount: 0 });
  assert.equal(sendPlanOutcome(empty), 'not-sent');
  assert.equal(sendPlanOutcome({ ...empty, phase: 'discarded' }), 'not-sent');
  assert.equal(sendPlanOutcome({ ...empty, broadcastAttempted: undefined }), 'uncertain');
  assert.equal(sendPlanOutcome({ ...empty, phase: 'broadcasting' }), 'uncertain');
  assert.notEqual(sendPlanOutcome({ ...empty, broadcastedTxIds: ['tx-a'] }), 'not-sent');
  assert.notEqual(sendPlanOutcome({ ...empty, uncertainTxIds: ['tx-a'] }), 'not-sent');
});

test('only a positive, complete prepared review can reach Send Now', () => {
  assert.equal(isPreparedSendPlan(plan()), true);
  for (const amountAtomic of [undefined, null, '0', '-1', 'invalid']) {
    assert.equal(isPreparedSendPlan(plan({ amountAtomic })), false);
  }
  for (const feeAtomic of [undefined, null, '0', '-1', 'invalid']) {
    assert.equal(isPreparedSendPlan(plan({ feeAtomic })), false);
  }
});

test('the receipt preserves all broadcasted, uncertain and remaining transaction IDs', () => {
  assert.deepEqual(sendPlanTransactionIds(plan({
    txIds: ['tx-a', 'tx-b', 'tx-c'], broadcastedTxIds: ['tx-a'],
    uncertainTxIds: ['tx-b'], remainingTxIds: ['tx-c'],
  })), ['tx-a', 'tx-b', 'tx-c']);
});

test('failed preview release retains its lease until an explicit successful release', async () => {
  const gate = new SendPlanReleaseGate();
  gate.requireDiscard('old-plan');
  const calls = [];
  await assert.rejects(gate.discardPending(async id => { calls.push(id); throw new Error('offline'); }), /offline/);
  await assert.rejects(gate.discardPending(async id => { calls.push(id); return plan({ id, phase: 'broadcasting' }); }), /could not be released/);
  await gate.discardPending(async id => { calls.push(id); return plan({ id, phase: 'discarded' }); });
  await gate.discardPending(async () => { throw new Error('already released'); });
  assert.deepEqual(calls, ['old-plan', 'old-plan', 'old-plan']);
});

test('authorizing, broadcasting and completed receipts cannot be reviewed as new prepared payments', () => {
  for (const phase of ['authorizing', 'broadcasting', 'complete', 'discarded', 'interrupted']) {
    assert.equal(isPreparedSendPlan(plan({ phase })), false);
  }
});

test('session recovery stores only the opaque plan ID for explicit sources', () => {
  const values = new Map();
  const storage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
  };
  rememberSendPlan(storage, [primary, extra], 'opaque-plan');
  assert.equal(recalledSendPlan(storage, primary), 'opaque-plan');
  assert.deepEqual([...values.values()], ['opaque-plan', 'opaque-plan']);
  rememberSendPlan(storage, [primary, extra], null);
  assert.equal(values.size, 0);
});
