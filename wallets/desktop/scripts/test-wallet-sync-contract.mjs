import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  displaySyncPercent,
  networkSyncMegabitsPerSecond,
  updateNetworkSyncRateWindow,
  walletSyncDerivationsPerSecond,
} from '../../../packages/wallet-shared/src/networkSync.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ledgerBalanceIsVerified,
  ledgerBalanceSnapshotForDisplay,
  nextWalletPublication,
  nextWalletSyncStartHeight,
  presentWalletSync,
  syncStartHeightForWallet,
  updateWalletSyncEta,
  walletIsSpendReady,
  walletScanBacklog,
  walletSyncSampleIsFresh,
} from '../../../packages/wallet-shared/src/walletSync.ts';

test('rounded progress cannot display 100% before native completion', () => {
  const nearTip = (3_766_295 / 3_766_297) * 100;
  assert.equal(displaySyncPercent(nearTip, false), 99.9);
  assert.equal(displaySyncPercent(100, false), 99.9);
  assert.equal(displaySyncPercent(100, true), 100);
});

test('read-only balance stays visible but new Ledger outputs are provisional after the initial check', () => {
  const snapshot = {
    walletHeight: 1_000,
    daemonHeight: 1_000,
    daemonTargetHeight: 1_000,
    synchronized: true,
    pendingOutputKeyImageCount: '3',
    balanceAtomic: '1000000000000',
  };
  const viewing = nextWalletPublication(undefined, {
    snapshot,
    transactions: [{ direction: 'in' }],
    requiresLedgerVerification: false,
    ledgerVerified: true,
  });
  assert.equal(viewing.publishedSnapshot?.balanceAtomic, snapshot.balanceAtomic);
  assert.equal(ledgerBalanceIsVerified(viewing.publishedSnapshot, true), false);
  assert.equal(ledgerBalanceIsVerified({ ...snapshot, pendingOutputKeyImageCount: 0 }, true), true);
  assert.equal(ledgerBalanceIsVerified({ ...snapshot, pendingOutputKeyImageCount: '0' }, false), false);
});

test('missing or invalid Ledger output counters never establish a verified balance', () => {
  assert.equal(ledgerBalanceIsVerified(undefined, true), false);
  const snapshot = {
    walletHeight: 1_000,
    daemonHeight: 1_000,
    daemonTargetHeight: 1_000,
    synchronized: true,
  };
  assert.equal(ledgerBalanceIsVerified(snapshot, true), false);
  for (const pendingOutputKeyImageCount of [-1, 0.5, 'invalid', Infinity]) {
    assert.equal(ledgerBalanceIsVerified({ ...snapshot, pendingOutputKeyImageCount }, true), false);
  }
});

test('Ledger balance display uses a confirmed publication or a completed viewing scan', () => {
  const detected = {
    walletHeight: '1000', daemonHeight: '1000', daemonTargetHeight: '1000',
    synchronized: true, balanceAtomic: '2071000000000', pendingOutputKeyImageCount: '14',
  };
  const verified = { ...detected, balanceAtomic: '912423089810', pendingOutputKeyImageCount: '0' };
  assert.equal(ledgerBalanceSnapshotForDisplay(verified, detected), verified);
  assert.equal(ledgerBalanceSnapshotForDisplay(undefined, detected), detected);
  assert.equal(ledgerBalanceSnapshotForDisplay(undefined, { ...detected, synchronized: false }), undefined);
  assert.equal(ledgerBalanceSnapshotForDisplay(undefined, { ...detected, daemonTargetHeight: '1001' }), undefined);
  assert.equal(ledgerBalanceSnapshotForDisplay(undefined, { ...detected, daemonHeight: '0', daemonTargetHeight: '0' }), undefined);
});

test('a Ledger working snapshot cannot publish an intermediate incoming-only balance', () => {
  const intermediate = {
    walletHeight: 1_000,
    daemonHeight: 1_000,
    daemonTargetHeight: 1_000,
    synchronized: true,
    snapshotRevision: 7,
    pendingOutputKeyImageCount: 14,
    balanceAtomic: '2071000000000',
  };
  const blocked = nextWalletPublication(undefined, {
    snapshot: intermediate,
    transactions: [{ direction: 'in' }],
    requiresLedgerVerification: true,
    ledgerVerified: false,
  });

  assert.equal(blocked.phase, 'waiting-ledger');
  assert.equal(blocked.ready, false);
  assert.equal(blocked.publishedSnapshot, undefined);
  assert.deepEqual(blocked.publishedTransactions, []);

  const checking = nextWalletPublication(blocked, {
    snapshot: intermediate,
    transactions: [{ direction: 'in' }],
    requiresLedgerVerification: true,
    ledgerVerified: false,
    ledgerPhase: 'scanning-spend-outputs',
  });
  assert.equal(checking.phase, 'scanning-spend-outputs');
  assert.equal(checking.ready, false);
  assert.equal(checking.publishedSnapshot, undefined);

  const finalSnapshot = {
    ...intermediate,
    snapshotRevision: 8,
    pendingOutputKeyImageCount: 0,
    balanceAtomic: '912423089810',
  };
  const finalHistory = [
    ...Array.from({ length: 12 }, () => ({ direction: 'in' })),
    ...Array.from({ length: 3 }, () => ({ direction: 'out' })),
  ];
  const published = nextWalletPublication(blocked, {
    snapshot: finalSnapshot,
    transactions: finalHistory,
    requiresLedgerVerification: true,
    ledgerVerified: true,
  });
  assert.equal(published.phase, 'ready');
  assert.equal(published.ready, true);
  assert.equal(published.publishedSnapshot?.balanceAtomic, '912423089810');
  assert.equal(published.publishedTransactions.length, 15);
  assert.equal(published.publishedTransactions.filter(item => item.direction === 'out').length, 3);
});

test('the last confirmed wallet state remains published during tip sync and session recovery', () => {
  const ready = nextWalletPublication(undefined, {
    snapshot: {
      walletHeight: 1_000,
      daemonHeight: 1_000,
      daemonTargetHeight: 1_000,
      synchronized: true,
      snapshotRevision: 4,
      pendingOutputKeyImageCount: 0,
      balanceAtomic: '912423089810',
    },
    transactions: [{ direction: 'out' }],
    requiresLedgerVerification: false,
    ledgerVerified: true,
  });
  const refreshing = nextWalletPublication(ready, {
    snapshot: {
      walletHeight: 1_000,
      daemonHeight: 1_001,
      daemonTargetHeight: 1_001,
      synchronized: false,
      snapshotRevision: 5,
      pendingOutputKeyImageCount: 0,
      balanceAtomic: '0',
    },
    transactions: [],
    requiresLedgerVerification: false,
    ledgerVerified: true,
  });
  assert.equal(refreshing.phase, 'wallet-scan');
  assert.equal(refreshing.publishedSnapshot?.balanceAtomic, '912423089810');
  assert.equal(refreshing.publishedTransactions.length, 1);

  const recovering = nextWalletPublication(refreshing, {
    snapshot: null,
    transactions: [],
    requiresLedgerVerification: false,
    ledgerVerified: true,
    sessionRecovering: true,
  });
  assert.equal(recovering.phase, 'recovering-session');
  assert.equal(recovering.publishedSnapshot?.balanceAtomic, '912423089810');
});

test('a new native session generation may publish after its snapshot revision restarts', () => {
  const beforeRecovery = nextWalletPublication(undefined, {
    snapshot: {
      walletHeight: 1_000,
      daemonHeight: 1_000,
      daemonTargetHeight: 1_000,
      synchronized: true,
      snapshotRevision: 99,
      balanceAtomic: '912423089810',
    },
    transactions: [],
    requiresLedgerVerification: false,
    ledgerVerified: true,
    sessionGeneration: 0,
  });
  const afterRecovery = nextWalletPublication(beforeRecovery, {
    snapshot: {
      walletHeight: 1_001,
      daemonHeight: 1_001,
      daemonTargetHeight: 1_001,
      synchronized: true,
      snapshotRevision: 1,
      balanceAtomic: '912423089810',
    },
    transactions: [{ direction: 'out' }],
    requiresLedgerVerification: false,
    ledgerVerified: true,
    sessionGeneration: 1,
  });

  assert.equal(afterRecovery.ready, true);
  assert.equal(afterRecovery.publishedRevision, 1);
  assert.equal(afterRecovery.publishedSessionGeneration, 1);
  assert.equal(afterRecovery.publishedTransactions.length, 1);
});

test('an unchanged terminal revision remains ready without republishing', () => {
  const snapshot = {
    walletHeight: 1_000,
    daemonHeight: 1_000,
    daemonTargetHeight: 1_000,
    synchronized: true,
    snapshotRevision: 7,
    balanceAtomic: '912423089810',
  };
  const first = nextWalletPublication(undefined, {
    snapshot,
    transactions: [{ direction: 'in' }],
    requiresLedgerVerification: false,
    ledgerVerified: true,
  });
  const unchanged = nextWalletPublication(first, {
    snapshot,
    transactions: [{ direction: 'in' }],
    requiresLedgerVerification: false,
    ledgerVerified: true,
  });

  assert.equal(unchanged.phase, 'ready');
  assert.equal(unchanged.ready, true);
  assert.equal(unchanged.publishedRevision, 7);
  assert.equal(unchanged.publishedSnapshot, snapshot);
});

test('a known Ledger key image publishes an externally spent output without another Ledger phase', () => {
  const beforeSpend = nextWalletPublication(undefined, {
    snapshot: {
      walletHeight: 1_000,
      daemonHeight: 1_000,
      daemonTargetHeight: 1_000,
      synchronized: true,
      snapshotRevision: 11,
      pendingOutputKeyImageCount: 0,
      balanceAtomic: '912423089810',
    },
    transactions: [{ direction: 'in' }],
    requiresLedgerVerification: true,
    ledgerVerified: true,
  });
  const afterExternalSpend = nextWalletPublication(beforeSpend, {
    snapshot: {
      walletHeight: 1_001,
      daemonHeight: 1_001,
      daemonTargetHeight: 1_001,
      synchronized: true,
      snapshotRevision: 12,
      pendingOutputKeyImageCount: 0,
      balanceAtomic: '700000000000',
    },
    transactions: [{ direction: 'in' }, { direction: 'out' }],
    requiresLedgerVerification: true,
    ledgerVerified: true,
  });

  assert.equal(afterExternalSpend.phase, 'ready');
  assert.equal(afterExternalSpend.publishedSnapshot?.balanceAtomic, '700000000000');
  assert.equal(afterExternalSpend.publishedTransactions.at(-1)?.direction, 'out');
});

test('the separate Fast Wallet is never gated by Ledger verification', () => {
  const publication = nextWalletPublication(undefined, {
    snapshot: {
      walletHeight: 1_000,
      daemonHeight: 1_000,
      daemonTargetHeight: 1_000,
      synchronized: true,
      snapshotRevision: 1,
      pendingOutputKeyImageCount: 0,
      balanceAtomic: '1000000000000',
    },
    transactions: [],
    requiresLedgerVerification: false,
    ledgerVerified: false,
  });

  assert.equal(publication.ready, true);
  assert.equal(publication.publishedSnapshot?.balanceAtomic, '1000000000000');
});

test('shared live sync rates use native bytes and derivation time', () => {
  assert.equal(networkSyncMegabitsPerSecond({
    state: 'fetching-blocks',
    phase: 'fetching-blocks',
    chainHeight: 10,
    targetHeight: 20,
    transportStarts: 1,
    joinedWallets: 1,
    stalledWallets: 0,
    lastNonEmptyBlockFetchMs: 2_000,
    lastNonEmptyNetworkBytes: 25_000_000,
  }), 100);
  assert.equal(walletSyncDerivationsPerSecond({
    state: 'scanning',
    phase: 'scanning-wallets',
    chainHeight: 10,
    targetHeight: 20,
    transportStarts: 1,
    joinedWallets: 1,
    stalledWallets: 0,
    lastNonEmptyWalletDerivationCount: 24_000,
    lastNonEmptyWalletDerivationUs: 200_000,
  }), 120_000);
});

test('desktop presents blockchain and wallet progress with distinct native colors', () => {
  const desktopRoot = join(import.meta.dirname, '..');
  const app = readFileSync(join(desktopRoot, 'src/App.tsx'), 'utf8');
  const styles = readFileSync(join(desktopRoot, 'src/styles.css'), 'utf8');
  assert.match(app, /testId="blockchain-progress" variant="blockchain"/);
  assert.match(app, /testId="wallet-progress" variant="wallet"/);
  assert.match(styles, /\.desktop-sync-progress\.wallet \.sync-track span:not\(\.ready\) \{ background: #737381; \}/);
});

test('desktop samples the live gRPC payload and expires stale transfer rates', () => {
  const desktopRoot = join(import.meta.dirname, '..');
  const app = readFileSync(join(desktopRoot, 'src/App.tsx'), 'utf8');
  const hook = app.slice(app.indexOf('function useAggregateNetworkRate('), app.indexOf('function DesktopSyncProgress('));
  assert.match(hook, /updateNetworkSyncRateWindow\(windowRef\.current, status, Date\.now\(\)\)/);
  assert.match(hook, /lastTransferAt \+ NETWORK_SYNC_RATE_WINDOW_MS - Date\.now\(\)/);
  assert.match(hook, /setTimeout\(\(\) => setRate\(undefined\)/);
  assert.doesNotMatch(hook, /networkSyncMegabitsPerSecond/);
});

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

test('restore height remains a fallback, while live session progress takes priority', async () => {
  const restoreHeight = 3_549_388;
  const sync = presentWalletSync(
    {
      walletHeight: restoreHeight,
      daemonHeight: 3_724_447,
      daemonTargetHeight: 3_724_447,
      synchronized: false,
    },
    { startHeight: syncStartHeightForWallet(restoreHeight) },
  );

  assert.equal(sync.phase, 'syncing');
  assert.equal(sync.progress, 0);
  assert.equal(sync.remainingBlocks, 175_059);

  assert.equal(syncStartHeightForWallet(restoreHeight, 3_700_000), 3_700_000);
  assert.equal(syncStartHeightForWallet(undefined, 3_700_000), 3_700_000);

  const desktopApp = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
  assert.match(desktopApp, /nextWalletSyncStartHeight\(/);
  assert.doesNotMatch(desktopApp, /registration\.restoreHeight \|\| syncStartHeightsRef/);
});

test('resumed Ledger scan measures only the session remainder, not old restore history', () => {
  const initial = {
    walletHeight: '3789205', daemonHeight: '3793557',
    daemonTargetHeight: '3793557', synchronized: false,
  };
  const baseline = nextWalletSyncStartHeight(undefined, initial);
  assert.equal(baseline, 3_789_205);
  assert.equal(presentWalletSync(initial, { startHeight: baseline }).progress, 0);
  const scanning = { ...initial, walletHeight: '3790029' };
  const held = nextWalletSyncStartHeight(baseline, scanning);
  assert.equal(held, baseline);
  const progress = presentWalletSync(scanning, { startHeight: held });
  assert.equal(progress.remainingBlocks, 3_528);
  assert.equal(progress.scannedBlocks, 824);
  assert.equal(progress.progress, 18);
  assert.equal(progress.coreConfirmed, false);
});

test('presentation baseline survives retries and resets only on Core completion or rewind', () => {
  const snapshot = {
    walletHeight: 1_000, daemonHeight: 2_000,
    daemonTargetHeight: 2_000, synchronized: false,
  };
  const start = nextWalletSyncStartHeight(undefined, snapshot);
  assert.equal(nextWalletSyncStartHeight(start, { ...snapshot, walletHeight: 1_500 }), 1_000);
  assert.equal(nextWalletSyncStartHeight(start, undefined), 1_000);
  assert.equal(nextWalletSyncStartHeight(start, { ...snapshot, walletHeight: 0 }), 1_000);
  assert.equal(nextWalletSyncStartHeight(start, { ...snapshot, walletHeight: 900 }), 900);
  const ready = { ...snapshot, walletHeight: 2_000, synchronized: true };
  assert.equal(nextWalletSyncStartHeight(start, ready), 2_000);
  const nextStart = nextWalletSyncStartHeight(2_000, { ...snapshot, walletHeight: 2_000, daemonTargetHeight: 2_010 });
  assert.equal(presentWalletSync({ ...snapshot, walletHeight: 2_000, daemonTargetHeight: 2_010 }, { startHeight: nextStart }).progress, 0);
  assert.equal(nextWalletSyncStartHeight(undefined, undefined), undefined);
  assert.equal(nextWalletSyncStartHeight(undefined, { ...snapshot, walletHeight: Number.NaN }), undefined);
});

test('bootstrap Ledger heights cannot create a genesis-sized progress jump', () => {
  const bootstrap = {walletHeight: '1', daemonHeight: '1', daemonTargetHeight: '1',
    refreshFromHeight: '1182748', synchronized: false};
  const start = nextWalletSyncStartHeight(undefined, bootstrap);
  assert.equal(start, 1_182_748);
  const scanning = {...bootstrap, walletHeight: '1183004',
    daemonHeight: '3798589', daemonTargetHeight: '3798589'};
  const healed = nextWalletSyncStartHeight(1, scanning);
  assert.equal(healed, start);
  const result = presentWalletSync(scanning, {startHeight: healed});
  assert.equal(result.progress, 0);
  assert.equal(result.scannedBlocks, 256);
  assert.equal(nextWalletSyncStartHeight(undefined, {...scanning, walletHeight: '3700000'}), 3_700_000);
  assert.equal(nextWalletSyncStartHeight(1, {...scanning, refreshFromHeight: 0}), 1);
});

const rateStatus = (extra = {}) => ({
  state: 'fetching-blocks', phase: 'fetching-blocks', chainHeight: 1,
  targetHeight: 10_000, transportStarts: 1, joinedWallets: 1,
  stalledWallets: 0, providerGeneration: 1, blockTransport: 'grpc',
  payloadBytesReceived: 100_000_000, networkBytesReceived: 1_200,
  lastNonEmptyBlockFetchMs: 1, lastNonEmptyPayloadBytes: 100_000_000,
  ...extra,
});

test('live network rate never uses a prebuffered batch duration or stale RPC controls', () => {
  let window = updateNetworkSyncRateWindow({samples: []}, rateStatus(), 0);
  assert.equal(window.rate, undefined);
  window = updateNetworkSyncRateWindow(window,
    rateStatus({payloadBytesReceived: 145_000_000, networkBytesReceived: 2_400}), 750);
  assert.equal(window.rate, 480);
  window = updateNetworkSyncRateWindow(window,
    rateStatus({payloadBytesReceived: 145_000_000, networkBytesReceived: 3_600}), 1_500);
  assert.equal(window.rate, 240);
  for (const at of [2_250, 3_000, 3_750]) {
    window = updateNetworkSyncRateWindow(window,
      rateStatus({payloadBytesReceived: 145_000_000}), at);
  }
  assert.equal(window.rate, undefined);
});

test('live rate restarts after a paused timer, provider change, source switch or counter rewind', () => {
  const first = updateNetworkSyncRateWindow({samples: []}, rateStatus(), 0);
  const measured = updateNetworkSyncRateWindow(first,
    rateStatus({payloadBytesReceived: 145_000_000}), 750);
  for (const [next, at] of [
    [rateStatus({payloadBytesReceived: 146_000_000}), 30_000],
    [rateStatus({payloadBytesReceived: 146_000_000, providerGeneration: 2}), 1_500],
    [rateStatus({payloadBytesReceived: 146_000_000, network: 'stagenet'}), 1_500],
    [rateStatus({blockTransport: 'rpc'}), 1_500],
    [rateStatus({payloadBytesReceived: 1}), 1_500],
    [rateStatus(), 500],
  ]) {
    const reset = updateNetworkSyncRateWindow(measured, next, at);
    assert.equal(reset.rate, undefined);
    assert.equal(reset.samples.length, 1);
  }
  assert.equal(updateNetworkSyncRateWindow(measured, null, 1_500).rate, undefined);
});

test('Tauri requires the same explicit Ledger restore point as the CLI', async () => {
  const [desktopApp, desktopHost] = await Promise.all([
    readFile(new URL('../src/App.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8'),
  ]);
  assert.match(desktopApp, /mode === 'ledger' && !restoreStartDate\.trim\(\)/);
  assert.match(desktopApp, /setup\.ledgerScanDateHint/);
  assert.match(
    desktopHost,
    /filter\(\|height\| \*height > 1\)[\s\S]*Choose a Ledger scan start date/,
  );
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
  const first = updateWalletSyncEta(initial.state, 9_500, 10_000);
  const idle = updateWalletSyncEta(first.state, 9_500, 15_000);
  const slower = updateWalletSyncEta(idle.state, 9_000, 20_000);
  const reliable = updateWalletSyncEta(slower.state, 8_500, 30_000);

  assert.equal(first.etaSeconds, undefined);
  assert.equal(idle.etaSeconds, undefined);
  assert.equal(idle.state.lastProgressAt, 10_000);
  assert.equal(slower.etaSeconds, undefined);
  assert.equal(reliable.etaSeconds, 170);
});

test('ETA with a few seconds of apparent work remains indeterminate', () => {
  const initial = updateWalletSyncEta(undefined, 1_000, 0);
  const one = updateWalletSyncEta(initial.state, 700, 10_000);
  const two = updateWalletSyncEta(one.state, 400, 20_000);
  const three = updateWalletSyncEta(two.state, 100, 30_000);

  assert.equal(three.etaSeconds, undefined);
});

test('ETA excludes native checkpoint time and cannot jump on one slow batch', () => {
  const initial = updateWalletSyncEta(undefined, 10_000, 0);
  const one = updateWalletSyncEta(initial.state, 9_500, 10_000);
  const two = updateWalletSyncEta(one.state, 9_000, 20_000);
  const three = updateWalletSyncEta(two.state, 8_500, 30_000);
  const checkpoint = updateWalletSyncEta(three.state, 8_500, 50_000, { active: false });
  const resumed = updateWalletSyncEta(checkpoint.state, 8_000, 60_000);

  assert.equal(three.etaSeconds, 170);
  assert.equal(checkpoint.etaSeconds, 170);
  assert.equal(checkpoint.state.activeElapsedMs, 30_000);
  assert.equal(resumed.state.activeElapsedMs, 40_000);
  assert.ok(resumed.etaSeconds <= 170);
});

test('ETA discards throughput measured before a node provider change', () => {
  const initial = updateWalletSyncEta(undefined, 10_000, 0, {
    providerGeneration: 7,
  });
  const first = updateWalletSyncEta(initial.state, 9_500, 10_000, {
    providerGeneration: 7,
  });
  const changed = updateWalletSyncEta(first.state, 9_000, 120_000, {
    providerGeneration: 8,
  });

  assert.equal(changed.etaSeconds, undefined);
  assert.equal(changed.state.progressSamples, 0);
  assert.equal(changed.state.startRemainingBlocks, 9_000);
  assert.equal(changed.state.providerGeneration, 8);
});

test('scan lag compares block heights even when the two progress ranges differ', () => {
  assert.equal(walletScanBacklog(2_440_220, 2_445_084, 1_182_748), 4_864);
  assert.equal(walletScanBacklog(1_182_700, 1_182_758, 1_182_748), 10);
  assert.equal(walletScanBacklog(2_445_100, 2_445_084, 1_182_748), 0);
  assert.equal(walletScanBacklog(1, 2_445_084, undefined), undefined);
  assert.equal(walletScanBacklog(0, 2_445_084, 1_182_748), undefined);
});

test('ETA expires on stale or stalled samples and remeasures after a gap', () => {
  let estimate = updateWalletSyncEta(undefined, 10_000, 0);
  for (let n = 1; n <= 3; n++) {
    estimate = updateWalletSyncEta(estimate.state, 10_000 - n * 500, n * 10_000);
  }
  assert.equal(estimate.etaSeconds, 170);
  assert.equal(walletSyncSampleIsFresh(30_000, 49_999), true);
  assert.equal(walletSyncSampleIsFresh(30_000, 50_000), false);
  assert.equal(updateWalletSyncEta(estimate.state, 8_000, 60_000).etaSeconds, undefined);
  const unchanged = updateWalletSyncEta(estimate.state, 8_500, 40_000);
  const stalled = updateWalletSyncEta(unchanged.state, 8_500, 50_000);
  assert.equal(stalled.etaSeconds, undefined);
  assert.equal(stalled.state.progressSamples, 0);
});

test('Ledger reconciliation is automatic once, manual later, and globally single-flight', async () => {
  const desktopApp = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const verificationPredicate = desktopApp.slice(
    desktopApp.indexOf('function desktopLedgerBalanceNeedsVerification'),
    desktopApp.indexOf('function networkSyncConnected'),
  );
  assert.match(verificationPredicate, /ledgerKeyImagesVerifiedAt/);
  assert.match(verificationPredicate, /pendingOutputKeyImageCount/);

  const dashboardPublication = desktopApp.slice(
    desktopApp.indexOf('const snapshotsByRegistration = useMemo'),
    desktopApp.indexOf('const publishedSnapshot = publication?.publishedSnapshot'),
  );
  assert.equal(
    dashboardPublication.match(/&& !registration\.ledgerKeyImagesVerifiedAt/g)?.length,
    1,
    'wallet cards must require Ledger only for the initial durable verification',
  );
  assert.equal(
    dashboardPublication.match(/&& !wallet\.ledgerKeyImagesVerifiedAt/g)?.length,
    1,
    'the selected wallet must require Ledger only for the initial durable verification',
  );
  assert.doesNotMatch(
    dashboardPublication,
    /pendingOutputCount === 0/,
    'new incoming outputs must not blank a previously verified Ledger balance',
  );

  const activeAutoReconciliation = desktopApp.slice(
    desktopApp.indexOf('const activeLedgerNeedsAutomaticVerification'),
    desktopApp.indexOf('  return <div className="home-stack home-dashboard">'),
  );
  const automaticAttempt = activeAutoReconciliation.slice(
    activeAutoReconciliation.indexOf('const attempt = async () =>'),
  );
  const activeCooldown = automaticAttempt.indexOf(
    'ledgerAutoVerificationAttemptedRef.current.add(wallet.id);',
  );
  const activeDiscovery = automaticAttempt.indexOf("invoke<string>('ledger_transport_status')");
  assert.ok(activeCooldown >= 0 && activeCooldown < activeDiscovery, 'active BLE cooldown must begin before discovery');
  assert.match(activeAutoReconciliation, /ledgerReconciliationInFlightRef\.current = true/);
  assert.match(activeAutoReconciliation, /finally \{\n        ledgerReconciliationInFlightRef\.current = false;/);
  assert.doesNotMatch(activeAutoReconciliation, /setInterval/);

  const manualVerification = activeAutoReconciliation.slice(
    activeAutoReconciliation.indexOf('const verifyLedgerBalance = async () =>'),
    activeAutoReconciliation.indexOf('  useEffect(() =>'),
  );
  assert.ok(
    manualVerification.indexOf("invoke<string>('ledger_transport_status')")
      < manualVerification.indexOf("invoke<WalletOperationResponse>('enable_ledger_read_only'"),
    'manual Ledger verification must establish the transport before opening the wallet',
  );

  assert.match(desktopApp, /const ledgerReconciliationInFlightRef = useRef\(false\)/);
  assert.doesNotMatch(desktopApp, /MONERO_DESKTOP_LEDGER_BACKGROUND_RECONCILIATION_START/);
  assert.match(desktopApp, /reconcile_ledger_balance/);
  assert.match(desktopApp, /settings\.recheckLedger/);
  assert.match(desktopApp, /'prepare_send_plan'/);
  assert.match(desktopApp, /'ledger-operation-progress'/);
  assert.match(desktopApp, /send\.preparing/);
  assert.doesNotMatch(desktopApp, /title="Verify with your Ledger"/);
});
