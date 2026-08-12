#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const number = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const fields = line => Object.fromEntries(
  [...line.matchAll(/([a-zA-Z][a-zA-Z0-9_]*)=("[^"]*"|[^\s]+)/g)]
    .map(([, key, value]) => [key, value.replace(/^"|"$/g, '')]),
);

const percentile = (values, quantile) => {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(
    ordered.length - 1,
    Math.max(0, Math.ceil(ordered.length * quantile) - 1),
  )];
};

export function summarizeSyncLog(text, elapsedMs = 0) {
  const summary = {
    grpc: {
      chunks: 0,
      blocks: 0,
      payloadBytes: 0,
      perChunkPayloadMiBPerSecondMedian: 0,
      perChunkPayloadMiBPerSecondP95: 0,
      endToEndPayloadMiBPerSecond: 0,
    },
    binRpc: {
      responses: 0,
      blocks: 0,
      receiveWireBytes: 0,
      serialRequestDurationMs: 0,
      serialWireMiBPerSecond: 0,
    },
    clientScan: {
      batches: 0,
      blocks: 0,
      outputs: 0,
      durationMs: 0,
      blocksPerSecond: 0,
      outputsPerSecond: 0,
      cacheTransactions: {
        transactions: 0,
        durationMs: 0,
        transactionsPerSecond: 0,
      },
      keyDerivation: {
        derivations: 0,
        durationMs: 0,
        derivationsPerSecond: 0,
        engines: {},
      },
      outputScan: {
        outputs: 0,
        durationMs: 0,
        outputsPerSecond: 0,
      },
      chainCommit: {
        blocks: 0,
        durationMs: 0,
        blocksPerSecond: 0,
      },
    },
    pipeline: {
      iterations: 0,
      scanLimitedIterations: 0,
      networkLimitedIterations: 0,
      processMs: 0,
      residualFetchWaitMs: 0,
      wallMs: 0,
    },
    queue: {
      backpressureEvents: 0,
      backpressureWaitMs: 0,
    },
    fallback: {
      count: 0,
      reasons: {},
      errorClasses: {},
    },
  };
  const grpcChunkRates = [];

  for (const line of text.split(/\r?\n/)) {
    if (line.includes('[SYNC_FALLBACK]')) {
      const event = fields(line);
      summary.fallback.count += 1;
      summary.fallback.reasons[event.reason ?? 'unknown'] =
        (summary.fallback.reasons[event.reason ?? 'unknown'] ?? 0) + 1;
      summary.fallback.errorClasses[event.error_class ?? 'unknown'] =
        (summary.fallback.errorClasses[event.error_class ?? 'unknown'] ?? 0) + 1;
      continue;
    }
    if (!line.includes('[SYNC_METRIC]')) continue;
    const event = fields(line);
    if (event.stage === 'network' && event.transport === 'grpc'
        && event.event === 'chunk') {
      summary.grpc.chunks += 1;
      summary.grpc.blocks += number(event.blocks);
      summary.grpc.payloadBytes += number(event.payload_bytes);
      grpcChunkRates.push(number(event.payload_mib_per_s));
    } else if (event.stage === 'network' && event.transport === 'bin_rpc'
        && event.event === 'response') {
      summary.binRpc.responses += 1;
      summary.binRpc.blocks += number(event.blocks);
      summary.binRpc.receiveWireBytes += number(event.rx_wire_bytes);
      summary.binRpc.serialRequestDurationMs += number(event.duration_ms);
    } else if (event.stage === 'client_scan') {
      if (event.substage === 'total') {
        summary.clientScan.batches += 1;
        summary.clientScan.blocks += number(event.blocks);
        summary.clientScan.outputs += number(event.outputs);
        summary.clientScan.durationMs += number(event.duration_ms);
      } else if (event.substage === 'cache_transactions') {
        summary.clientScan.cacheTransactions.transactions +=
          number(event.transactions);
        summary.clientScan.cacheTransactions.durationMs +=
          number(event.duration_ms);
      } else if (event.substage === 'key_derivation') {
        summary.clientScan.keyDerivation.derivations +=
          number(event.derivations);
        summary.clientScan.keyDerivation.durationMs +=
          number(event.duration_ms);
        const engine = event.engine ?? 'unknown';
        summary.clientScan.keyDerivation.engines[engine] =
          (summary.clientScan.keyDerivation.engines[engine] ?? 0) + 1;
      } else if (event.substage === 'scan_outputs') {
        summary.clientScan.outputScan.outputs += number(event.outputs);
        summary.clientScan.outputScan.durationMs += number(event.duration_ms);
      } else if (event.substage === 'chain_commit') {
        summary.clientScan.chainCommit.blocks += number(event.blocks);
        summary.clientScan.chainCommit.durationMs += number(event.duration_ms);
      }
    } else if (event.stage === 'pipeline' && event.event === 'iteration') {
      summary.pipeline.iterations += 1;
      summary.pipeline.processMs += number(event.process_ms);
      summary.pipeline.residualFetchWaitMs +=
        number(event.residual_fetch_wait_ms);
      summary.pipeline.wallMs += number(event.wall_ms);
      if (event.bottleneck === 'client_scan') {
        summary.pipeline.scanLimitedIterations += 1;
      } else if (event.bottleneck === 'network_or_server') {
        summary.pipeline.networkLimitedIterations += 1;
      }
    } else if (event.stage === 'queue' && event.transport === 'grpc'
        && event.event === 'backpressure') {
      summary.queue.backpressureEvents += 1;
      summary.queue.backpressureWaitMs += number(event.enq_wait_ms);
    }
  }

  summary.grpc.perChunkPayloadMiBPerSecondMedian = percentile(grpcChunkRates, 0.5);
  summary.grpc.perChunkPayloadMiBPerSecondP95 = percentile(grpcChunkRates, 0.95);
  if (elapsedMs > 0) {
    summary.grpc.endToEndPayloadMiBPerSecond =
      summary.grpc.payloadBytes / 1024 / 1024 / (elapsedMs / 1000);
  }
  if (summary.binRpc.serialRequestDurationMs > 0) {
    summary.binRpc.serialWireMiBPerSecond =
      summary.binRpc.receiveWireBytes / 1024 / 1024
        / (summary.binRpc.serialRequestDurationMs / 1000);
  }
  if (summary.clientScan.durationMs > 0) {
    summary.clientScan.blocksPerSecond = summary.clientScan.blocks
      / (summary.clientScan.durationMs / 1000);
    summary.clientScan.outputsPerSecond = summary.clientScan.outputs
      / (summary.clientScan.durationMs / 1000);
  }
  const scanRates = [
    ['cacheTransactions', 'transactions', 'transactionsPerSecond'],
    ['keyDerivation', 'derivations', 'derivationsPerSecond'],
    ['outputScan', 'outputs', 'outputsPerSecond'],
    ['chainCommit', 'blocks', 'blocksPerSecond'],
  ];
  for (const [phase, count, rate] of scanRates) {
    const measurement = summary.clientScan[phase];
    if (measurement.durationMs > 0) {
      measurement[rate] = measurement[count]
        / (measurement.durationMs / 1000);
    }
  }
  return summary;
}

if (process.argv[1]
    && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const logPath = process.argv[2];
  if (!logPath) {
    console.error('Usage: summarize-sync-telemetry.mjs <sync.log> [elapsed-ms]');
    process.exit(2);
  }
  const elapsedMs = number(process.argv[3]);
  console.log(JSON.stringify(
    summarizeSyncLog(readFileSync(logPath, 'utf8'), elapsedMs),
    null,
    2,
  ));
}
