import assert from 'node:assert/strict';
import test from 'node:test';
import {
  presentWalletSync,
  updateWalletSyncEta,
  walletIsSpendReady,
} from '../../../packages/wallet-shared/src/walletSync.ts';

test('only the native core may confirm a wallet as synchronized', () => {
  const sync = presentWalletSync({
    walletHeight: 1_000,
    daemonHeight: 1_000,
    daemonTargetHeight: 1_000,
    synchronized: false,
  });

  assert.equal(sync.phase, 'finalizing');
  // Heights alone are not a completion signal. Keep this state indeterminate
  // instead of displaying a synthetic 99% that looks permanently stuck.
  assert.equal(sync.progress, undefined);
  assert.equal(sync.remainingBlocks, 0);
  assert.equal(sync.coreConfirmed, false);
  assert.equal(walletIsSpendReady({
    walletHeight: 1_000,
    daemonHeight: 1_000,
    daemonTargetHeight: 1_000,
    synchronized: false,
  }), false);
});

test('a core-confirmed wallet is shown as synchronized and spend-ready', () => {
  const snapshot = {
    walletHeight: '1000',
    daemonHeight: '1000',
    daemonTargetHeight: '1000',
    synchronized: true,
  };
  const sync = presentWalletSync(snapshot);

  assert.equal(sync.phase, 'synchronized');
  assert.equal(sync.progress, 100);
  assert.equal(sync.coreConfirmed, true);
  assert.equal(walletIsSpendReady(snapshot), true);
});

test('progress is identical for numeric mobile and string desktop snapshots', () => {
  const mobile = presentWalletSync({
    walletHeight: 550,
    daemonHeight: 1_000,
    daemonTargetHeight: 1_000,
    synchronized: false,
  }, { startHeight: 500 });
  const desktop = presentWalletSync({
    walletHeight: '550',
    daemonHeight: '1000',
    daemonTargetHeight: '1000',
    synchronized: false,
  }, { startHeight: 500 });

  assert.deepEqual(desktop, mobile);
  assert.equal(mobile.phase, 'syncing');
  assert.equal(mobile.progress, 10);
});

test('refresh progress is measured from the first live core height', () => {
  const sync = presentWalletSync(
    {
      walletHeight: 3_700_500,
      daemonHeight: 3_701_000,
      daemonTargetHeight: 3_701_000,
      synchronized: false,
    },
    { startHeight: 3_700_000 },
  );

  assert.equal(sync.phase, 'syncing');
  assert.equal(sync.progress, 50);
  assert.equal(sync.coreConfirmed, false);
});

test('no cached height can turn an active 19k-block scan into 99%', () => {
  const sync = presentWalletSync({
    walletHeight: 3_705_094,
    daemonHeight: 3_724_371,
    daemonTargetHeight: 3_724_371,
    synchronized: false,
  });

  assert.equal(sync.phase, 'syncing');
  assert.equal(sync.progress, undefined);
  assert.equal(sync.remainingBlocks, 19_277);
});

test('ETA waits for sustained observed Core progress', () => {
  const initial = updateWalletSyncEta(undefined, 10_000, 0);
  const first = updateWalletSyncEta(initial.state, 9_500, 5_000);
  const idle = updateWalletSyncEta(first.state, 9_500, 10_000);
  const slower = updateWalletSyncEta(idle.state, 9_000, 15_000);
  const reliable = updateWalletSyncEta(slower.state, 8_500, 20_000);

  assert.equal(first.etaSeconds, undefined);
  assert.equal(idle.etaSeconds, undefined);
  assert.equal(idle.state.lastProgressAt, 5_000);
  assert.equal(slower.etaSeconds, undefined);
  assert.equal(reliable.etaSeconds, 114);
});
