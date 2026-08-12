#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { summarizeSyncLog } from './summarize-sync-telemetry.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const read = relative => readFileSync(path.join(root, relative), 'utf8');

const patch = read(
  'third_party/monero-patches/0032-wallet-log-sync-fallback-and-stage-throughput.patch',
);
const additions = patch
  .split('\n')
  .filter(line => line.startsWith('+') && !line.startsWith('+++'))
  .map(line => line.slice(1))
  .join('\n');
const bridgeHeader = read('native/monero-bridge/cpp/WalletEngine.h');
const bridgeSource = read('native/monero-bridge/cpp/WalletEngine.cpp');
const proofSource = read('native/monero-bridge/proof/main.cpp');
const r3Runner = read('tools/wallet-testbench/run-r3-network-mainnet.sh');

assert.match(additions, /\[SYNC_FALLBACK\] from=grpc to=bin_rpc/);
for (const reason of [
  'daemon_height_preflight_failed',
  'daemon_not_ahead',
  'start_at_or_above_tip',
  'stream_open_failed',
  'chunk_timeout',
  'stream_receive_failed',
  'payload_deserialization_failed',
  'block_output_index_count_mismatch',
  'stream_drift',
]) {
  assert.match(additions, new RegExp(reason), `missing fallback reason ${reason}`);
}

assert.match(
  additions,
  /stage=network transport=grpc event=chunk[\s\S]*?payload_mib_per_s=[\s\S]*?blocks_per_s=/,
  'gRPC receive metrics must contain payload and block throughput',
);
assert.match(additions, /stage=queue transport=grpc event=backpressure/);
assert.match(additions, /stage=delivery transport=grpc event=consumer_pop/);
assert.match(
  additions,
  /stage=network transport=bin_rpc event=response[\s\S]*?rx_wire_bytes=[\s\S]*?wire_mib_per_s=[\s\S]*?blocks_per_s=/,
  'Bin-RPC must use actual client receive-byte counters',
);
assert.match(additions, /stage=client_scan substage=cache_transactions/);
assert.match(additions, /stage=client_scan substage=key_derivation/);
assert.match(additions, /stage=client_scan substage=scan_outputs/);
assert.match(additions, /stage=client_scan substage=chain_commit/);
assert.match(additions, /stage=client_scan substage=total/);
assert.match(additions, /stage=pipeline event=iteration/);
assert.match(bridgeHeader, /enableTestbenchSyncProfiling/);
assert.match(
  bridgeSource,
  /Wallet::init\([\s\S]*?nullLogPath, true\)[\s\S]*?setLogCategories\("wallet\.wallet2:WARNING"\)/,
  'CLI profiling must use a null file sink and the narrow wallet2 category',
);
assert.match(
  proofSource,
  /command == "create-restore-refresh"[\s\S]*?TESTBENCH_SYNC_PROFILE[\s\S]*?enableTestbenchSyncProfiling/,
);
for (const metric of [
  'benchmark_sync_profile_enabled',
  'benchmark_network_block_fetch_ms',
  'benchmark_network_client_scan_ms',
  'benchmark_network_prefetch_ms',
  'benchmark_network_prefetch_wait_ms',
  'benchmark_network_checkpoint_ms',
  'benchmark_network_iteration_ms',
]) assert.match(proofSource, new RegExp(metric));
assert.match(r3Runner, /TESTBENCH_SYNC_PROFILE=1/);
assert.match(r3Runner, /MONERO_LOG_FORMAT='%msg'/);

assert.doesNotMatch(
  additions,
  /stage=delivery[^\n]*mib_per_s/,
  'consumer queue wait must not be mislabeled as network throughput',
);

const parsed = summarizeSyncLog(`
[SYNC_METRIC] stage=network transport=grpc event=chunk blocks=512 payload_bytes=1048576 payload_mib_per_s=50
[SYNC_METRIC] stage=network transport=grpc event=chunk blocks=256 payload_bytes=524288 payload_mib_per_s=25
[SYNC_METRIC] stage=queue transport=grpc event=backpressure enq_wait_ms=12.5
[SYNC_METRIC] stage=network transport=bin_rpc event=response blocks=10 rx_wire_bytes=1048576 duration_ms=200
[SYNC_METRIC] stage=client_scan substage=cache_transactions transactions=2000 duration_ms=200
[SYNC_METRIC] stage=client_scan substage=key_derivation derivations=5000 duration_ms=500 engine=device_cpu workers=10
[SYNC_METRIC] stage=client_scan substage=scan_outputs outputs=4000 duration_ms=100
[SYNC_METRIC] stage=client_scan substage=chain_commit blocks=768 duration_ms=400
[SYNC_METRIC] stage=client_scan substage=total blocks=768 outputs=4000 duration_ms=3000
[SYNC_METRIC] stage=pipeline event=iteration process_ms=3000 residual_fetch_wait_ms=200 wall_ms=3200 bottleneck=client_scan
[SYNC_METRIC] stage=pipeline event=iteration process_ms=100 residual_fetch_wait_ms=300 wall_ms=400 bottleneck=network_or_server
[SYNC_FALLBACK] from=grpc to=bin_rpc reason=chunk_timeout error_class=timeout
`, 3000);
assert.equal(parsed.grpc.payloadBytes, 1572864);
assert.equal(parsed.grpc.endToEndPayloadMiBPerSecond, 0.5);
assert.equal(parsed.binRpc.serialWireMiBPerSecond, 5);
assert.equal(parsed.clientScan.blocksPerSecond, 256);
assert.equal(parsed.clientScan.cacheTransactions.transactionsPerSecond, 10000);
assert.equal(parsed.clientScan.keyDerivation.derivationsPerSecond, 10000);
assert.deepEqual(parsed.clientScan.keyDerivation.engines, {device_cpu: 1});
assert.equal(parsed.clientScan.outputScan.outputsPerSecond, 40000);
assert.equal(parsed.clientScan.chainCommit.blocksPerSecond, 1920);
assert.equal(parsed.pipeline.iterations, 2);
assert.equal(parsed.pipeline.scanLimitedIterations, 1);
assert.equal(parsed.pipeline.networkLimitedIterations, 1);
assert.equal(parsed.pipeline.processMs, 3100);
assert.equal(parsed.pipeline.residualFetchWaitMs, 500);
assert.equal(parsed.queue.backpressureEvents, 1);
assert.deepEqual(parsed.fallback.reasons, { chunk_timeout: 1 });

console.log('Sync observability contract passed.');
