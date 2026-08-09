import assert from 'node:assert/strict';
import test from 'node:test';

class SharedBatchPipeline {
  constructor(walletIds, capacity) {
    this.walletIds = new Set(walletIds);
    this.capacity = capacity;
    this.queue = [];
    this.nextBatch = 0;
    this.produced = 0;
    this.released = 0;
  }

  produce() {
    if (this.queue.length >= this.capacity) {
      return false;
    }
    this.queue.push({
      id: this.nextBatch++,
      remaining: new Set(this.walletIds),
    });
    this.produced += 1;
    return true;
  }

  consume(walletId) {
    const batch = this.queue.find(candidate =>
      candidate.remaining.has(walletId));
    if (!batch) {
      return false;
    }
    batch.remaining.delete(walletId);
    while (this.queue[0]?.remaining.size === 0) {
      this.queue.shift();
      this.released += 1;
    }
    return true;
  }
}

class KeyImageLedgerState {
  constructor(outputs) {
    this.outputs = outputs.map(output => ({...output}));
    this.commitGeneration = 0;
    this.chainGeneration = 0;
  }

  pendingSnapshot() {
    return this.outputs
      .filter(output => output.keyImageState === 'pending')
      .map(output => ({id: output.id, blockHeight: output.blockHeight}));
  }

  stage(snapshot, derive, validate = () => true) {
    return snapshot.map(output => ({
      id: output.id,
      keyImage: (() => {
        const keyImage = derive(output);
        assert.equal(validate(keyImage), true, 'key image must be in the valid curve domain');
        return keyImage;
      })(),
      spent: false,
      chainGeneration: this.chainGeneration,
    }));
  }

  commit(staged, spentStates) {
    assert.equal(staged.length, spentStates.length);
    const replacement = this.outputs.map(output => ({...output}));
    let changed = 0;
    for (let index = 0; index < staged.length; index += 1) {
      assert.equal(typeof spentStates[index], 'boolean');
      assert.equal(staged[index].chainGeneration, this.chainGeneration);
      const target = replacement.find(output => output.id === staged[index].id);
      assert.ok(target, 'staged output must still exist at commit time');
      if (target.keyImageState === 'verified') {
        assert.equal(target.keyImage, staged[index].keyImage);
        assert.equal(target.spent, spentStates[index]);
        continue;
      }
      assert.equal(target.keyImageState, 'pending');
      target.keyImage = staged[index].keyImage;
      target.spent = spentStates[index];
      target.keyImageState = 'verified';
      changed += 1;
    }
    if (changed > 0) {
      this.outputs = replacement;
      this.commitGeneration += 1;
    }
    return changed;
  }

  detach(height) {
    this.outputs = this.outputs.filter(output => output.blockHeight < height);
    this.chainGeneration += 1;
  }

  durableSnapshot() {
    return structuredClone({
      outputs: this.outputs,
      commitGeneration: this.commitGeneration,
      chainGeneration: this.chainGeneration,
    });
  }

  static reopen(snapshot) {
    const state = new KeyImageLedgerState(snapshot.outputs);
    state.commitGeneration = snapshot.commitGeneration;
    state.chainGeneration = snapshot.chainGeneration;
    return state;
  }
}

test('key-image work never owns the bounded public-data producer', () => {
  const pipeline = new SharedBatchPipeline(['ledger-view', 'wallet-b'], 3);
  let keyImageWorkActive = true;

  assert.equal(pipeline.produce(), true);
  assert.equal(pipeline.consume('wallet-b'), true);
  assert.equal(keyImageWorkActive, true);

  // The Ledger view is intentionally stalled. The producer still fills its
  // bounded queue and stops only at the memory budget, never on Ledger state.
  assert.equal(pipeline.produce(), true);
  assert.equal(pipeline.produce(), true);
  assert.equal(pipeline.produce(), false);
  assert.equal(pipeline.queue.length, 3);

  keyImageWorkActive = false;
  assert.equal(pipeline.consume('ledger-view'), true);
  assert.equal(pipeline.released, 1);
  assert.equal(pipeline.produce(), true);
});

test('a decoded batch is released only after its final wallet consumer', () => {
  const pipeline = new SharedBatchPipeline(['a', 'b', 'c'], 2);
  assert.equal(pipeline.produce(), true);
  assert.equal(pipeline.consume('a'), true);
  assert.equal(pipeline.consume('c'), true);
  assert.equal(pipeline.released, 0);
  assert.equal(pipeline.consume('b'), true);
  assert.equal(pipeline.released, 1);
  assert.equal(pipeline.queue.length, 0);
});

test('failed Ledger or spent-status work cannot partially mutate live state', () => {
  const state = new KeyImageLedgerState([
    {id: 'a', blockHeight: 100, keyImageState: 'verified', keyImage: 'ki-a'},
    {id: 'b', blockHeight: 110, keyImageState: 'pending'},
    {id: 'c', blockHeight: 120, keyImageState: 'pending'},
  ]);
  const snapshotState = value => ({
    outputs: structuredClone(value.outputs),
    commitGeneration: value.commitGeneration,
  });
  const before = snapshotState(state);
  const snapshot = state.pendingSnapshot();

  assert.throws(() => {
    state.stage(snapshot, output => {
      if (output.id === 'c') {
        throw new Error('simulated Ledger disconnect');
      }
      return `ki-${output.id}`;
    });
  });
  assert.deepEqual(snapshotState(state), before);

  const staged = state.stage(snapshot, output => `ki-${output.id}`);
  assert.throws(() => state.commit(staged, [false]));
  assert.deepEqual(snapshotState(state), before);
});

test('successful reconciliation is incremental, durable and idempotent', () => {
  const state = new KeyImageLedgerState([
    {id: 'a', blockHeight: 100, keyImageState: 'verified', keyImage: 'ki-a'},
    {id: 'b', blockHeight: 110, keyImageState: 'pending'},
    {id: 'c', blockHeight: 120, keyImageState: 'pending'},
  ]);
  const firstSnapshot = state.pendingSnapshot();
  assert.deepEqual(firstSnapshot.map(output => output.id), ['b', 'c']);
  const staged = state.stage(firstSnapshot, output => `ki-${output.id}`);
  assert.equal(state.commit(staged, [false, true]), 2);

  assert.equal(state.commitGeneration, 1);
  assert.deepEqual(state.pendingSnapshot(), []);
  assert.equal(state.outputs.find(output => output.id === 'a').keyImage, 'ki-a');
  assert.equal(state.outputs.find(output => output.id === 'c').spent, true);

  // A second run performs zero hardware derivations.
  assert.deepEqual(state.pendingSnapshot(), []);
  assert.equal(state.commit(staged, [false, true]), 0);
  assert.equal(state.commitGeneration, 1);

  const reopened = KeyImageLedgerState.reopen(state.durableSnapshot());
  assert.deepEqual(reopened.outputs, state.outputs);
  assert.equal(reopened.commitGeneration, 1);
});

test('reorg detach removes affected key-image state and preserves older outputs', () => {
  const state = new KeyImageLedgerState([
    {id: 'a', blockHeight: 100, keyImageState: 'verified', keyImage: 'ki-a'},
    {id: 'b', blockHeight: 110, keyImageState: 'verified', keyImage: 'ki-b'},
    {id: 'c', blockHeight: 120, keyImageState: 'pending'},
  ]);
  state.detach(115);
  assert.deepEqual(state.outputs.map(output => output.id), ['a', 'b']);
  assert.deepEqual(state.pendingSnapshot(), []);
});

test('zero-output reconciliation is a true no-op', () => {
  const state = new KeyImageLedgerState([]);
  let derivations = 0;
  const staged = state.stage(state.pendingSnapshot(), () => {
    derivations += 1;
    return 'unreachable';
  });
  assert.equal(state.commit(staged, []), 0);
  assert.equal(derivations, 0);
  assert.equal(state.commitGeneration, 0);
});

test('invalid key-image domain and malformed spent response are rejected before commit', () => {
  const state = new KeyImageLedgerState([
    {id: 'a', blockHeight: 100, keyImageState: 'pending'},
  ]);
  const before = state.durableSnapshot();
  assert.throws(() => state.stage(
    state.pendingSnapshot(),
    () => 'invalid-point',
    keyImage => keyImage.startsWith('valid-'),
  ));
  assert.deepEqual(state.durableSnapshot(), before);

  const staged = state.stage(
    state.pendingSnapshot(),
    () => 'valid-ki-a',
    keyImage => keyImage.startsWith('valid-'),
  );
  assert.throws(() => state.commit(staged, ['unknown']));
  assert.throws(() => state.commit(staged, []));
  assert.deepEqual(state.durableSnapshot(), before);
});

test('a reorg invalidates an in-flight delta before it can commit', () => {
  const state = new KeyImageLedgerState([
    {id: 'a', blockHeight: 100, keyImageState: 'pending'},
  ]);
  const staged = state.stage(state.pendingSnapshot(), () => 'ki-a');
  state.detach(101);
  const afterDetach = state.durableSnapshot();
  assert.throws(() => state.commit(staged, [false]));
  assert.deepEqual(state.durableSnapshot(), afterDetach);
});

for (const walletCount of [10, 100]) {
  test(`${walletCount} scanners share one bounded producer sequence`, () => {
    const walletIds = Array.from({length: walletCount}, (_, index) => `wallet-${index}`);
    const pipeline = new SharedBatchPipeline(walletIds, 4);
    for (let batch = 0; batch < 12; batch += 1) {
      while (!pipeline.produce()) {
        for (const walletId of walletIds) {
          pipeline.consume(walletId);
        }
      }
    }
    while (pipeline.queue.length > 0) {
      for (const walletId of walletIds) {
        pipeline.consume(walletId);
      }
    }
    assert.equal(pipeline.produced, 12);
    assert.equal(pipeline.released, 12);
  });
}
