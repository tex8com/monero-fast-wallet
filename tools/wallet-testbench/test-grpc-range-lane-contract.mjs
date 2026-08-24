import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const read = path => readFileSync(resolve(repoRoot, path), 'utf8');
const patchName =
  '0071-wallet-bound-global-grpc-range-pool-to-four-lanes.patch';
const patch = read(`third_party/monero-patches/${patchName}`);
const spanPatchName =
  '0072-wallet-reduce-grpc-range-reopen-latency.patch';
const spanPatch = read(`third_party/monero-patches/${spanPatchName}`);
const spanAdditions = spanPatch
  .split(/\r?\n/)
  .filter(line => line.startsWith('+') && !line.startsWith('+++'))
  .join('\n');
const additions = patch
  .split(/\r?\n/)
  .filter(line => line.startsWith('+') && !line.startsWith('+++'))
  .join('\n');
const sharedRangePatch = read(
  'third_party/monero-patches/0026-wallet-share-bounded-gRPC-block-ranges-between-local-wallets.patch',
);
const bridgeCmake = read('native/monero-bridge/CMakeLists.txt');
const networkRunner = read('tools/wallet-testbench/run-r3-network-mainnet.sh');
const series = read('third_party/monero-patches/series')
  .split(/\r?\n/)
  .map(line => line.trim())
  .filter(line => line && !line.startsWith('#'));
const lock = read('third_party/monero-patches/upstream.lock');
const hotPathPatch = read(
  'third_party/monero-patches/0074-wallet-remove-hot-path-diagnostic-clocks.patch',
);
const persistentLanePatchName =
  '0075-wallet-use-persistent-striped-grpc-lanes.patch';
const persistentLanePatch = read(
  `third_party/monero-patches/${persistentLanePatchName}`,
);
const persistentLaneAdditions = persistentLanePatch
  .split(/\r?\n/)
  .filter(line => line.startsWith('+') && !line.startsWith('+++'))
  .join('\n');
const cleanLaneTipPatchName =
  '0078-wallet-accept-clean-persistent-lane-tip.patch';
const cleanLaneTipPatch = read(
  `third_party/monero-patches/${cleanLaneTipPatchName}`,
);
const cleanLaneTipAdditions = cleanLaneTipPatch
  .split(/\r?\n/)
  .filter(line => line.startsWith('+') && !line.startsWith('+++'))
  .join('\n');
const sixLanePatchName =
  '0079-wallet-use-six-persistent-grpc-lanes.patch';
const sixLanePatch = read(
  `third_party/monero-patches/${sixLanePatchName}`,
);
const sixLaneAdditions = sixLanePatch
  .split(/\r?\n/)
  .filter(line => line.startsWith('+') && !line.startsWith('+++'))
  .join('\n');
const serverProto = read(
  'node/mfn-monero-fast-node/binaries/cuprated/proto/cuprate_stream.proto',
);
const serverGrpc = read(
  'node/mfn-monero-fast-node/binaries/cuprated/src/rpc/grpc.rs',
);

test('the authenticated Core retains the measured production patch sequence', () => {
  assert.equal(series.length, 93);
  assert.deepEqual(series.slice(-15), [
    sixLanePatchName,
    '0080-wallet-spill-public-blockstream-overflow-to-bounded-disk.patch',
    '0081-wallet-cli-select-public-and-private-Fast-Wallet-wor.patch',
    '0082-wallet-run-manual-derivation-backends-for-ten-seconds.patch',
    '0083-wallet-expose-exact-per-subaddress-balances.patch',
    '0084-wallet-cli-dispatch-Community-V1-companion.patch',
    '0085-wallet-initialize-keyless-shared-sync-chain.patch',
    '0086-wallet-add-explicit-full-ledger-spend-output-scan.patch',
    '0087-wallet-batch-ledger-history-and-retry-node-only.patch',
    '0088-wallet-cli-fix-debug-option-prefix-ambiguity.patch',
    '0089-wallet-prime-ledger-view-key-before-shared-scan.patch',
    '0090-wallet-prime-ledger-scan-from-view-companion.patch',
    '0091-wallet-add-local-shared-sync-cache-reset.patch',
    '0092-wallet-require-ledger-parse-mode-after-companion-prime.patch',
    '0093-wallet-keep-companion-ledger-derivations-as-device-tokens.patch',
  ]);
  assert.match(lock, /^previous_patch_count=92$/m);
  assert.match(
    lock,
    /^previous_patched_tree=5c0b09ed55682c0f6d60b9cbd4db91d5dacc0388$/m,
  );
  assert.match(
    lock,
    /^patched_tree=0389d585c9c742eda74b5e9912997d2ba5393503$/m,
  );
  assert.match(hotPathPatch, /^-.*process_new_transaction SLOW txid=/m);
  assert.match(hotPathPatch, /^-.*SLOW_TX[^\n]*\n-.*txid=/m);
  assert.match(hotPathPatch, /^-.*HOT_BLOCK/m);
});

test('the measured Pixel transport uses six persistent disjoint lanes', () => {
  assert.match(sixLaneAdditions, /constexpr size_t kMaxChannels = 6/);
  assert.match(sixLaneAdditions, /Six physical lanes saturate/);
  assert.match(sixLaneAdditions, /while \(stream_channels < 6/);
  assert.match(
    sixLaneAdditions,
    /stream_channels = std::min<size_t>\(6, stream_channels \* 2\)/,
  );
  assert.match(sixLaneAdditions, /stream_channels == 6 \? "pool-6"/);
  assert.doesNotMatch(
    sixLaneAdditions,
    /view_key|spend_key|private_key|mnemonic|seed|is_out_to_acc|is_spent|derivation/,
  );
});

test('persistent lanes accept only a proven clean end above the reported tip', () => {
  assert.match(cleanLaneTipPatch, /client\.stream_ended_ok\(\)/);
  assert.match(cleanLaneTipAdditions, /p\.last_tip > 0/);
  assert.match(cleanLaneTipAdditions, /p\.next_expected > p\.last_tip/);
  assert.match(cleanLaneTipAdditions, /p\.ended_ok = true/);
  assert.match(cleanLaneTipAdditions, /return lane_next_result::end/);
  assert.match(cleanLaneTipAdditions, /empty_one_height_tip_probe/);
  assert.match(cleanLaneTipAdditions, /p\.lane_chunks_consumed == 0/);
  assert.match(cleanLaneTipAdditions, /p\.start_height == p\.stop_height/);
  assert.match(cleanLaneTipAdditions, /p\.next_expected == p\.start_height/);
  assert.match(cleanLaneTipPatch, /persistent lane ended before its next assigned stripe/);
  assert.doesNotMatch(
    cleanLaneTipAdditions,
    /p\.next_expected >= p\.last_tip/,
  );
});

test('persistent striped lanes are capability-safe and bounded', () => {
  assert.match(
    persistentLaneAdditions,
    /rpc StreamBlockLane\(StreamBlocksRequest\) returns \(stream BlockChunk\)/,
  );
  assert.match(persistentLaneAdditions, /stripe_span_blocks = 8/);
  assert.match(persistentLaneAdditions, /lane_index = 9/);
  assert.match(persistentLaneAdditions, /lane_count = 10/);
  assert.match(persistentLaneAdditions, /kLaneStripeBlocks = 512/);
  assert.match(persistentLaneAdditions, /kMaxChunkBlocks = 256/);
  assert.match(persistentLaneAdditions, /kPerLaneQueueCapacity = 1/);
  assert.match(
    persistentLaneAdditions,
    /kLaneMaxChunkBytes = 32 \* 1024 \* 1024/,
  );
  assert.match(persistentLaneAdditions, /kGrpcUnimplemented = 12/);
  assert.match(
    persistentLaneAdditions,
    /p\.lane_chunks_consumed == 0[\s\S]*p\.error_code == kGrpcUnimplemented/,
  );
  assert.match(
    persistentLaneAdditions,
    /FALLBACK from=StreamBlockLane to=StreamBlocks reason=unimplemented before_first_chunk/,
  );
  assert.match(persistentLaneAdditions, /stripe_ordinal % p\.target_channels/);
  assert.match(persistentLaneAdditions, /chunk_end > stripe_stop \+ 1/);
  assert.match(
    persistentLaneAdditions,
    /target_link_libraries\(cuprate_grpc_stream_test PRIVATE "-framework CoreFoundation"\)/,
  );
  assert.doesNotMatch(
    persistentLaneAdditions,
    /view_key|spend_key|private_key|mnemonic|seed/,
  );
});

test('client and server retain the cap and recover with smaller chunks', () => {
  const serverSplitPatch = read(
    'third_party/cuprate-live-overlays/0002-wallet-sync-split-oversized-lane-chunks.patch',
  );
  assert.match(serverSplitPatch, /reduced_chunk_blocks\(actual_blocks\)/);
  assert.match(serverSplitPatch, /task\.abort\(\)/);
  assert.match(serverSplitPatch, /SPLIT_OVERSIZED/);
  assert.match(serverSplitPatch, /next_chunk_blocks = reduced_blocks/);
  assert.match(serverSplitPatch, /continue;/);
  assert.match(serverSplitPatch, /single-block encoded chunk exceeds RPC byte limit/);
  assert.match(serverSplitPatch, /reduced_chunk_blocks\(512\), Some\(256\)/);
});

test('server active-stream telemetry is released by task lifetime', () => {
  const serverGuardPatch = read(
    'third_party/cuprate-live-overlays/0003-wallet-sync-release-active-stream-count-on-all-exits.patch',
  );
  assert.match(serverGuardPatch, /struct ActiveStreamGuard/);
  assert.match(serverGuardPatch, /impl Drop for ActiveStreamGuard/);
  assert.match(serverGuardPatch, /active_stream_guard.*ActiveStreamGuard::acquire/);
  assert.match(serverGuardPatch, /drop\(active_stream_guard\)/);
  assert.match(serverGuardPatch, /saturating_sub\(1\)/);
  assert.doesNotMatch(serverGuardPatch, /view_key|spend_key|private_key|mnemonic|seed/);
});

test('the server validates up to the same measured six-lane ceiling', () => {
  const serverSixLanePatch = read(
    'third_party/cuprate-live-overlays/0004-wallet-sync-allow-six-persistent-lanes.patch',
  );
  const serverLaneProtocolPatch = read(
    'third_party/cuprate-live-overlays/0001-wallet-sync-persistent-striped-grpc-lanes.patch',
  );
  assert.match(serverSixLanePatch, /const MAX_LANE_COUNT: usize = 6/);
  assert.match(
    serverLaneProtocolPatch,
    /lane_count == 0 \|\| lane_count > MAX_LANE_COUNT/,
  );
  assert.doesNotMatch(
    serverSixLanePatch,
    /view_key|spend_key|private_key|mnemonic|seed|derivation/,
  );
});

test('the one MFN source tree implements the persistent-lane protocol', () => {
  assert.match(
    serverProto,
    /rpc StreamBlockLane\(StreamBlocksRequest\) returns \(stream BlockChunk\)/,
  );
  assert.match(serverProto, /stripe_span_blocks = 8/);
  assert.match(serverProto, /lane_index = 9/);
  assert.match(serverProto, /lane_count = 10/);
  assert.match(serverGrpc, /const MAX_LANE_COUNT: u32 = 6/);
  assert.match(serverGrpc, /struct LanePlan/);
  assert.match(serverGrpc, /fn reduced_chunk_blocks/);
  assert.match(serverGrpc, /SPLIT_OVERSIZED/);
  assert.match(serverGrpc, /struct ActiveStreamPermit/);
  assert.match(serverGrpc, /impl Drop for ActiveStreamPermit/);
  assert.match(serverGrpc, /let active_permit = try_acquire_stream\(\)\?/);
  assert.match(serverGrpc, /select_stream_start\(requested_start/);
  assert.match(serverGrpc, /if requested_start > 0/);
  assert.doesNotMatch(
    serverGrpc,
    /private_view_key|private_spend_key|private_key|mnemonic|seed_phrase/,
  );
});

test('the historical base pool was bounded to four process-wide lanes', () => {
  assert.match(additions, /constexpr size_t kMaxChannels = 4/);
  assert.match(
    additions,
    /connect\(const std::string& target, size_t process_channel_lane = 0\)/,
  );
  assert.match(additions, /target \+ "\\n" \+ std::to_string\(process_channel_lane\)/);
  assert.match(additions, /GRPC_ARG_USE_LOCAL_SUBCHANNEL_POOL, 1/);
  assert.match(additions, /local_subchannel_pool=1/);
  assert.match(additions, /client_\.connect\(target_, process_channel_lane_\)/);
  assert.match(additions, /index, reused, p\.error_code, p\.error/);
  assert.match(additions, /while \(stream_channels < 4/);
  assert.doesNotMatch(additions, /plan = stream_channels == 8/);
});

test('transport lanes do not change exact-range cache identity or duplicate data', () => {
  const keySource = sharedRangePatch.slice(
    sharedRangePatch.indexOf('std::string range_key('),
    sharedRangePatch.indexOf('class shared_range_cache'),
  );
  for (const field of ['target', 'start', 'stop', 'chunk_hint', 'locator']) {
    assert.match(keySource, new RegExp(`\\b${field}\\b`));
  }
  assert.doesNotMatch(keySource, /process_channel_lane|wallet|view_key|spend_key/);
  assert.match(patch, /process_range_cache\(\)\.acquire/);
  assert.match(patch, /non-overlapping range/);
});

test('finite range span is decoupled from the bounded server chunk hint', () => {
  assert.match(spanAdditions, /constexpr uint32_t kRangeBlocks = 2048/);
  assert.match(spanAdditions, /constexpr uint32_t kMinChunkBlocks = 16/);
  assert.match(spanAdditions, /constexpr uint32_t kMaxChunkBlocks = 512/);
  assert.match(spanAdditions, /constexpr size_t kPerRangeQueueCapacity = 1/);
  assert.match(spanAdditions, /uint32_t chunk_blocks_hint = 0/);
  assert.match(spanAdditions, /p_->range_blocks = kRangeBlocks/);
  assert.match(spanAdditions, /p_->chunk_blocks_hint = std::max/);
  assert.match(spanAdditions, /p\.chunk_blocks_hint/);
  assert.doesNotMatch(spanAdditions, /process_channel_lane|wallet|view_key|spend_key/);
});

test('QA and CLI binaries relink after any force-loaded Core archive changes', () => {
  assert.match(bridgeCmake, /TEX8_MONERO_STATIC_LINK_DEPENDS/);
  assert.match(bridgeCmake, /MONERO_WALLET_EXTRA_LINK_OPTIONS/);
  assert.match(bridgeCmake, /-Wl,-force_load,/);
  assert.match(bridgeCmake, /IS_ABSOLUTE/);
  assert.match(bridgeCmake, /INTERFACE_LINK_DEPENDS/);
});

test('the live runner measures physical endpoint sockets independently', () => {
  assert.match(networkRunner, /client-sockets\.tsv/);
  assert.match(networkRunner, /lsof -nP -a -p/);
  assert.match(networkRunner, /max_simultaneous_endpoint_sockets/);
  assert.match(networkRunner, /distinct from gRPC Channel handles/);
  assert.match(networkRunner, /client-socket-accounting\.txt/);
  assert.match(networkRunner, /closed sockets disappear from the aggregate/);
  assert.match(networkRunner, /tcp_rx_exact=false/);
  assert.match(networkRunner, /tcp_rx_bytes=%d\\n", peak/);
  assert.doesNotMatch(networkRunner, /carried \+= previous/);
  assert.match(networkRunner, /R3_RUST_DERIVATION_WORKERS/);
  assert.match(networkRunner, /rust_derivation_workers=%s/);
});
