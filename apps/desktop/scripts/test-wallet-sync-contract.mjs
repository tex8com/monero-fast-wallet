import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  networkSyncMegabitsPerSecond,
  walletSyncDerivationsPerSecond,
} from '../../../packages/wallet-shared/src/networkSync.ts';
import {
  nextWalletPublication,
  presentWalletSync,
  syncStartHeightForWallet,
  updateWalletSyncEta,
  walletIsSpendReady,
} from '../../../packages/wallet-shared/src/walletSync.ts';

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

  assert.equal(blocked.phase, 'scanning-spend-outputs');
  assert.equal(blocked.ready, false);
  assert.equal(blocked.publishedSnapshot, undefined);
  assert.deepEqual(blocked.publishedTransactions, []);

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

test('a configured restore height is the durable percentage baseline', async () => {
  const restoreHeight = 3_549_388;
  const sync = presentWalletSync(
    {
      walletHeight: restoreHeight,
      daemonHeight: 3_724_447,
      daemonTargetHeight: 3_724_447,
      synchronized: false,
    },
    { startHeight: syncStartHeightForWallet(restoreHeight, 3_700_000) },
  );

  assert.equal(sync.phase, 'syncing');
  assert.equal(sync.progress, 0);
  assert.equal(sync.remainingBlocks, 175_059);

  assert.equal(syncStartHeightForWallet(restoreHeight, 3_700_000), restoreHeight);
  assert.equal(syncStartHeightForWallet(undefined, 3_700_000), 3_700_000);

  const desktopApp = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
  assert.match(desktopApp, /syncStartHeightForWallet\(wallet\?\.restoreHeight/);
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

test('Ledger reconciliation is automatic once, manual later, and globally single-flight', async () => {
  const desktopApp = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const verificationPredicate = desktopApp.slice(
    desktopApp.indexOf('function desktopLedgerBalanceNeedsVerification'),
    desktopApp.indexOf('function networkSyncConnected'),
  );
  assert.match(verificationPredicate, /ledgerKeyImagesVerifiedAt/);
  assert.match(verificationPredicate, /pendingOutputKeyImageCount/);

  const activeAutoReconciliation = desktopApp.slice(
    desktopApp.indexOf('const activeLedgerNeedsAutomaticVerification'),
    desktopApp.indexOf('  return <div className="home-stack home-dashboard">'),
  );
  const activeCooldown = activeAutoReconciliation.indexOf(
    'ledgerAutoVerificationAttemptedRef.current.add(wallet.id);',
  );
  const activeDiscovery = activeAutoReconciliation.indexOf("invoke<string>('ledger_transport_status')");
  assert.ok(activeCooldown >= 0 && activeCooldown < activeDiscovery, 'active BLE cooldown must begin before discovery');
  assert.match(activeAutoReconciliation, /ledgerReconciliationInFlightRef\.current = true/);
  assert.match(activeAutoReconciliation, /finally \{\n        ledgerReconciliationInFlightRef\.current = false;/);
  assert.doesNotMatch(activeAutoReconciliation, /setInterval/);

  assert.match(desktopApp, /const ledgerReconciliationInFlightRef = useRef\(false\)/);
  assert.doesNotMatch(desktopApp, /MONERO_DESKTOP_LEDGER_BACKGROUND_RECONCILIATION_START/);
  assert.match(desktopApp, /reconcile_ledger_balance/);
  assert.match(desktopApp, /settings\.recheckLedger/);
  assert.match(desktopApp, /send\.checkingSpendOutputs/);
  assert.doesNotMatch(desktopApp, /title="Verify with your Ledger"/);
});
