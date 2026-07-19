import assert from 'node:assert/strict';
import test from 'node:test';
import {
  presentWalletSync,
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
  assert.equal(sync.progress, 99);
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
  });
  const desktop = presentWalletSync({
    walletHeight: '550',
    daemonHeight: '1000',
    daemonTargetHeight: '1000',
    synchronized: false,
  });

  assert.deepEqual(desktop, mobile);
  assert.equal(mobile.phase, 'syncing');
  assert.equal(mobile.progress, 55);
});
