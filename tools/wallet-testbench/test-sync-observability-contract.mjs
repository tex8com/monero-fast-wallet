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
[SYNC_METRIC] stage=client_scan substage=total blocks=768 outputs=4000 duration_ms=3000
[SYNC_FALLBACK] from=grpc to=bin_rpc reason=chunk_timeout error_class=timeout
`, 3000);
assert.equal(parsed.grpc.payloadBytes, 1572864);
assert.equal(parsed.grpc.endToEndPayloadMiBPerSecond, 0.5);
assert.equal(parsed.binRpc.serialWireMiBPerSecond, 5);
assert.equal(parsed.clientScan.blocksPerSecond, 256);
assert.equal(parsed.queue.backpressureEvents, 1);
assert.deepEqual(parsed.fallback.reasons, { chunk_timeout: 1 });

console.log('Sync observability contract passed.');
