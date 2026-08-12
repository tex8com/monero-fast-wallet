import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const read = path => readFileSync(resolve(repoRoot, path), 'utf8');
const patchName =
  '0026-wallet-share-bounded-gRPC-block-ranges-between-local-wallets.patch';
const patch = read(`third_party/monero-patches/${patchName}`);
const series = read('third_party/monero-patches/series');
const lock = read('third_party/monero-patches/upstream.lock');

test('the authenticated Monero patch series includes the shared exact-range cache', () => {
  const entries = series
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'));
  assert.ok(entries.includes(patchName));
  assert.ok(entries.includes('0058-wallet-pending-ledger-key-image-queue.patch'));
  assert.ok(entries.includes('0059-ledger-probe-unlocked-app-before-wallet-connect.patch'));
  assert.ok(entries.includes('0075-wallet-use-persistent-striped-grpc-lanes.patch'));
  assert.equal(
    entries.at(-1),
    '0077-wallet-expose-live-sync-throughput-in-every-client.patch',
  );
  assert.ok(entries.includes('0027-wallet-add-shared-multi-wallet-sync-provider.patch'));
  assert.match(lock, /^previous_patch_count=76$/m);
  assert.match(lock, /^previous_patched_tree=[0-9a-f]{40}$/m);
  assert.match(lock, /^patched_tree=[0-9a-f]{40}$/m);
});

test('one bounded process cache replays exact public ranges to independent cursors', () => {
  assert.match(patch, /class shared_range_cache/);
  assert.match(patch, /shared_range_cache& process_range_cache\(\)/);
  assert.match(patch, /std::condition_variable cv_/);
  assert.match(patch, /size_t cursor = 0/);
  assert.match(patch, /cursor < chunks_\.size\(\)/);
  assert.match(patch, /kSharedCacheMaxEntries = 128/);
  assert.match(patch, /kSharedCacheMaxBytes = 96 \* 1024 \* 1024/);
  assert.match(patch, /kSharedCacheTtl = std::chrono::minutes\(2\)/);
});

test('cache identity is network-source and exact-range scoped', () => {
  const keySource = patch.slice(
    patch.indexOf('std::string range_key('),
    patch.indexOf('class shared_range_cache'),
  );
  for (const field of ['target', 'start', 'stop', 'chunk_hint', 'locator']) {
    assert.match(keySource, new RegExp(`\\b${field}\\b`));
  }
  assert.doesNotMatch(keySource, /wallet|view_key|spend_key|address/);
});

test('only deep complete ranges survive for later wallets', () => {
  assert.match(patch, /kStableDepth = 64/);
  assert.match(
    patch,
    /complete_ && error_\.empty\(\)[\s\S]*?chain_tip_ > stop_[\s\S]*?chain_tip_ - stop_ > kStableDepth/,
  );
  assert.match(patch, /map_only && \(!range->retainable\(\) \|\| expired\)/);
  assert.match(patch, /it->second\.use_count\(\) != 1 \|\| !it->second->complete\(\)/);
});

test('every subscriber still receives ordered, gap-checked serialized payloads', () => {
  assert.match(patch, /chunk\.start_height != expected_/);
  assert.match(patch, /shared range gap, overlap, or invalid chunk/);
  assert.match(patch, /shared block range ended before its requested stop height/);
  assert.match(patch, /p_->last_start != p_->next_expected/);
  assert.match(patch, /out = std::move\(chunk\.payload\)/);
});
