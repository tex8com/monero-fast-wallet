import assert from 'node:assert/strict';
import test from 'node:test';

class WalletScanner {
  constructor(id, restoreHeight, {stallAt = null} = {}) {
    this.id = id;
    this.restoreHeight = restoreHeight;
    this.cursor = 1;
    this.stallAt = stallAt;
    this.checkpoint = 1;
  }

  get target() {
    return Math.max(this.cursor, this.restoreHeight);
  }

  consume(batch) {
    const begin = Math.max(this.target, batch.start);
    if (begin >= batch.end) return 0;
    if (this.stallAt !== null && begin <= this.stallAt && this.stallAt < batch.end) {
      throw new Error(`scanner ${this.id} intentionally stalled`);
    }
    const added = batch.end - begin;
    this.cursor = batch.end;
    return added;
  }
}

class CoordinatorModel {
  constructor(tip, batchSize = 64) {
    this.tip = tip;
    this.batchSize = batchSize;
    this.wallets = [];
    this.provider = null;
    this.transportStarts = 0;
    this.fetches = 0;
    this.decodes = 0;
    this.deliveries = 0;
    this.stalls = 0;
    this.poolFetches = 0;
    this.cacheHits = 0;
    this.cacheMisses = 0;
    this.replayCache = [];
    this.replayCacheCapacity = 128;
    this.coolingScanners = new Set();
  }

  join(wallet) {
    this.wallets.push(wallet);
  }

  leave(walletId) {
    this.wallets = this.wallets.filter(wallet => wallet.id !== walletId);
    this.coolingScanners.delete(walletId);
  }

  run() {
    if (!this.provider) {
      this.provider = Object.freeze({kind: 'keyless-public-transport'});
      this.transportStarts += 1;
    }
    const eligible = () => this.wallets.filter(
      wallet => !this.coolingScanners.has(wallet.id),
    );
    while (eligible().length > 0 &&
           Math.min(...eligible().map(wallet => wallet.target)) < this.tip) {
      const start = Math.min(...eligible().map(wallet => wallet.target));
      let batch = this.replayCache.find(
        candidate => candidate.start <= start && candidate.end > start,
      );
      if (batch) {
        this.cacheHits += 1;
      } else {
        this.cacheMisses += 1;
        batch = Object.freeze({
          start,
          end: Math.min(this.tip, start + this.batchSize),
        });
        this.fetches += 1;
        this.decodes += 1;
        this.replayCache.push(batch);
        if (this.replayCache.length > this.replayCacheCapacity) {
          this.replayCache.shift();
        }
      }
      for (const wallet of eligible()) {
        try {
          wallet.consume(batch);
          this.deliveries += 1;
        } catch {
          this.stalls += 1;
          this.coolingScanners.add(wallet.id);
        }
      }
    }
    this.poolFetches += 1;
  }
}

for (const walletCount of [1, 2, 10, 100]) {
  test(`${walletCount} wallets use one transport and one decode per batch`, () => {
    const coordinator = new CoordinatorModel(1025, 64);
    for (let index = 0; index < walletCount; index += 1) {
      coordinator.join(new WalletScanner(`wallet-${index}`, 1));
    }
    coordinator.run();
    assert.equal(coordinator.transportStarts, 1);
    assert.equal(coordinator.fetches, 16);
    assert.equal(coordinator.decodes, coordinator.fetches);
    assert.equal(coordinator.poolFetches, 1);
    assert.ok(coordinator.wallets.every(wallet => wallet.cursor === 1025));
  });
}

test('mixed restore heights consume the same immutable stream', () => {
  const coordinator = new CoordinatorModel(1001, 100);
  for (const height of [1, 250, 500, 750, 999]) {
    coordinator.join(new WalletScanner(`restore-${height}`, height));
  }
  coordinator.run();
  assert.equal(coordinator.transportStarts, 1);
  assert.equal(coordinator.fetches, coordinator.decodes);
  assert.ok(coordinator.wallets.every(wallet => wallet.cursor === 1001));
});

test('one stalled scanner cannot stop healthy wallets or create a transport', () => {
  const coordinator = new CoordinatorModel(513, 64);
  coordinator.join(new WalletScanner('provider', 1));
  coordinator.join(new WalletScanner('healthy', 128));
  coordinator.join(new WalletScanner('stalled', 1, {stallAt: 200}));
  coordinator.run();
  assert.equal(coordinator.transportStarts, 1);
  assert.equal(coordinator.wallets[0].cursor, 513);
  assert.equal(coordinator.wallets[1].cursor, 513);
  assert.ok(coordinator.stalls > 0);
});

test('checkpoint restart resumes without a second historical download per wallet', () => {
  const first = new CoordinatorModel(257, 64);
  const wallets = [new WalletScanner('a', 1), new WalletScanner('b', 120)];
  wallets.forEach(wallet => first.join(wallet));
  first.run();
  wallets.forEach(wallet => { wallet.checkpoint = wallet.cursor; });

  const resumed = new CoordinatorModel(321, 64);
  wallets.forEach(wallet => resumed.join(wallet));
  resumed.run();
  assert.equal(resumed.transportStarts, 1);
  assert.equal(resumed.fetches, 1);
  assert.ok(wallets.every(wallet => wallet.cursor === 321));
});

test('a late wallet catches up through the retained keyless provider without a second transport', () => {
  const coordinator = new CoordinatorModel(1025, 64);
  const firstWallet = new WalletScanner('first-wallet', 513);
  coordinator.join(firstWallet);
  coordinator.run();
  const fetchesBeforeLateJoin = coordinator.fetches;
  const retainedTransport = coordinator.provider;
  assert.equal(coordinator.transportStarts, 1);
  assert.equal(firstWallet.cursor, 1025);

  const lateWallet = new WalletScanner('late-wallet', 1);
  coordinator.join(lateWallet);
  coordinator.run();

  assert.equal(coordinator.provider, retainedTransport);
  assert.equal(coordinator.provider.kind, 'keyless-public-transport');
  assert.equal(coordinator.transportStarts, 1);
  // The provider originally started at 513, so only the previously unseen
  // lower half is fetched. Every retained upper-half batch is replayed.
  assert.equal(coordinator.fetches - fetchesBeforeLateJoin, 8);
  assert.equal(coordinator.cacheHits, 8);
  assert.equal(lateWallet.cursor, 1025);
});

test('replay retention remains bounded when the stream exceeds its capacity', () => {
  const coordinator = new CoordinatorModel(1025, 1);
  coordinator.join(new WalletScanner('provider', 1));
  coordinator.run();
  assert.equal(coordinator.replayCache.length, 128);
  assert.equal(coordinator.fetches, 1024);
});

test('removing a wallet never creates another public transport or decode', () => {
  const coordinator = new CoordinatorModel(1025, 64);
  const retained = new WalletScanner('retained', 1);
  const removed = new WalletScanner('removed', 513);
  coordinator.join(retained);
  coordinator.join(removed);
  coordinator.run();
  const transport = coordinator.provider;
  const starts = coordinator.transportStarts;
  const fetches = coordinator.fetches;
  const decodes = coordinator.decodes;

  coordinator.leave(removed.id);
  coordinator.tip = 1089;
  coordinator.run();

  assert.equal(coordinator.provider, transport);
  assert.equal(coordinator.transportStarts, starts);
  assert.equal(coordinator.fetches, fetches + 1);
  assert.equal(coordinator.decodes, decodes + 1);
  assert.equal(coordinator.wallets.length, 1);
  assert.equal(retained.cursor, 1089);
});
