import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { SendSnapshotLoader } from '../src/sendSnapshotLoader.ts';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const tick = () => new Promise(resolve => setImmediate(resolve));

test('timer and notification wakes share one native snapshot request', async () => {
  const loader = new SendSnapshotLoader();
  loader.setScope('wallet-a:0');
  const native = deferred();
  let requests = 0;
  const poll = () => loader.load(() => { requests += 1; return native.promise; });
  const first = poll();
  const wake = poll();
  await tick();
  assert.equal(requests, 1);
  assert.equal(first, wake);
  native.resolve({ unlockedBalanceAtomic: '500000000000' });
  assert.deepEqual(await first, { unlockedBalanceAtomic: '500000000000' });
  assert.deepEqual(await wake, await first);
});

test('preparation reads a fresh snapshot after an already-running poll', async () => {
  const loader = new SendSnapshotLoader();
  loader.setScope('wallet-a:0');
  const poll = deferred();
  const prepare = deferred();
  const order = [];
  const old = loader.load(() => { order.push('poll'); return poll.promise; });
  const fresh = loader.load(() => { order.push('prepare'); return prepare.promise; }, true);
  await tick();
  assert.deepEqual(order, ['poll']);
  poll.resolve({ synchronized: false, unlockedBalanceAtomic: '0' });
  await old;
  await tick();
  assert.deepEqual(order, ['poll', 'prepare']);
  prepare.resolve({ synchronized: true, unlockedBalanceAtomic: '500000000000' });
  assert.equal((await fresh).unlockedBalanceAtomic, '500000000000');
});

test('changing wallet/account discards old results and serializes the new request', async () => {
  const loader = new SendSnapshotLoader();
  const oldNative = deferred();
  loader.setScope('wallet-a:0');
  const old = loader.load(() => oldNative.promise);
  await tick();
  loader.setScope('wallet-a:1');
  let newStarted = false;
  const current = loader.load(async () => {
    newStarted = true;
    return { balanceAtomic: '2000000000000' };
  });
  await tick();
  assert.equal(newStarted, false, 'an uncancellable old IPC must finish first');
  oldNative.resolve({ balanceAtomic: '500000000000' });
  assert.equal(await old, undefined);
  assert.equal((await current).balanceAtomic, '2000000000000');
});

test('queued obsolete accounts are skipped before contacting native Core', async () => {
  const loader = new SendSnapshotLoader();
  const oldNative = deferred();
  loader.setScope('wallet-a:0');
  const old = loader.load(() => oldNative.promise);
  await tick();
  loader.setScope('wallet-b:0');
  let obsoleteCalls = 0;
  const obsolete = loader.load(async () => { obsoleteCalls += 1; return 'wrong'; });
  loader.setScope('wallet-c:0');
  const current = loader.load(async () => 'current');
  oldNative.resolve('old');
  assert.equal(await old, undefined);
  assert.equal(await obsolete, undefined);
  assert.equal(await current, 'current');
  assert.equal(obsoleteCalls, 0);
});

test('late errors after closing Send are ignored; active errors permit a retry', async () => {
  const loader = new SendSnapshotLoader();
  const native = deferred();
  loader.setScope('wallet-a:0');
  const old = loader.load(() => native.promise);
  await tick();
  loader.setScope(null);
  native.reject(new Error('old wallet offline'));
  assert.equal(await old, undefined);
  assert.equal(await loader.load(async () => 'closed'), undefined);
  loader.setScope('wallet-a:0');
  await assert.rejects(loader.load(async () => { throw new Error('retryable'); }), /retryable/);
  assert.equal(await loader.load(async () => 'recovered'), 'recovered');
});

test('Send prepares one native plan across accounts and never retries a commit blindly', () => {
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const send = app.slice(app.indexOf('function Send('), app.indexOf('function Receive('));
  const max = send.slice(send.indexOf('const useMaximum'), send.indexOf('const updateAmount'));
  assert.match(max, /setAmount\(formatAtomicXmr\(availableAtomic, 12\)\)/);
  assert.match(send, /aria-pressed=\{sweepAll\}/);
  assert.match(send, /'wallet_snapshot', \{ input: \{ walletId \} \}/);
  assert.match(send, /'prepare_send_plan'/);
  assert.match(send, /sources: \[primarySource, \.\.\.additionalSources\]/);
  assert.match(send, /primarySourceKind = wallet\?\.kind === 'fast' \? 'fast' : 'registered'/);
  assert.match(send, /amountAtomic: sweepAll \? '' : amountAtomic/);
  assert.doesNotMatch(send, /'prepare_transaction'|'commit_transaction'|'reconcile_ledger_balance'/);
  assert.match(send, /window\.setInterval\(poll, 5_000\)/);
  const commit = send.slice(send.indexOf('const commit = async'), send.indexOf('const finishSuccess'));
  assert.match(commit, /'commit_send_plan'/);
  assert.match(commit, /'send_plan_status'/);
  assert.doesNotMatch(commit, /'prepare_send_plan'/);
  assert.match(send, /receiptTransactionIds\.map\(id/);
  assert.doesNotMatch(send, /txIds\[0\]/);
  assert.match(send, /broadcastedTotalsKnown === false/);
  assert.match(send, /'discard_send_plan'/);
  assert.match(send, /await planReleaseGateRef\.current\.discardPending\(discardNativePlan\)/);
  const fastWallets = app.slice(app.indexOf('function FastWallets('), app.indexOf('function WalletFeature('));
  assert.doesNotMatch(fastWallets, /'prepare_transaction'|'commit_transaction'/);
  assert.match(fastWallets, /onClick=\{\(\) => onSend\(wallet\)\}/);
  assert.match(app, /onSendFastWallet=\{record => openSavedWallet\(fastWalletAsRegistration\(record\), 'send'\)\}/);
});
