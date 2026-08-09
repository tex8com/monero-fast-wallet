#!/usr/bin/env node

import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const repoRoot = resolve(import.meta.dirname, '../..');
const base = join(repoRoot, 'build/wallet-testbench/jan-2026-mainnet');
const matrixId = process.argv[2];
if (!matrixId || !/^[A-Za-z0-9._-]+$/.test(matrixId)) {
  console.error('Usage: summarize-strict-mainnet-sync-matrix.mjs <matrix-id>');
  process.exit(2);
}

const matrixDir = join(base, `strict-matrix-${matrixId}`);
const metadataText = readFileSync(join(matrixDir, 'matrix-metadata.txt'), 'utf8');

function keyValues(text, prefix = '') {
  return Object.fromEntries(text.split(/\r?\n/).flatMap(line => {
    const separator = line.indexOf('=');
    if (separator < 1 || (prefix && !line.startsWith(prefix))) return [];
    return [[line.slice(0, separator), line.slice(separator + 1)]];
  }));
}

function fields(line) {
  return Object.fromEntries(
    [...line.matchAll(/([A-Za-z][A-Za-z0-9_]*)=("[^"]*"|[^\s]+)/g)]
      .map(([, key, value]) => [key, value.replace(/^"|"$/g, '')]),
  );
}

function sum(lines, key) {
  return lines.reduce((total, line) => total + (Number(fields(line)[key]) || 0), 0);
}

function parseTime(text) {
  const match = text.match(/\n\s*([0-9.]+) real\s+([0-9.]+) user\s+([0-9.]+) sys\s*\n/);
  if (!match) throw new Error('missing /usr/bin/time summary');
  return { realSeconds: Number(match[1]), userSeconds: Number(match[2]), sysSeconds: Number(match[3]) };
}

function parseServerTelemetry(archivePath) {
  const temporary = mkdtempSync(join(tmpdir(), 'mfw-strict-matrix-'));
  try {
    execFileSync('tar', ['-xzf', archivePath, '-C', temporary]);
    const system = join(temporary, 'system');
    const statFiles = readdirSync(system)
      .filter(name => /^\d+-\d+\.process-stat$/.test(name))
      .sort((left, right) => Number(left.split('-', 1)[0]) - Number(right.split('-', 1)[0]));
    if (statFiles.length < 2) throw new Error(`too few process-stat samples in ${archivePath}`);

    const parseStat = name => {
      const content = readFileSync(join(system, name), 'utf8').trim();
      const close = content.lastIndexOf(')');
      const values = content.slice(close + 2).trim().split(/\s+/);
      const timestamp = Number(name.match(/^\d+-(\d+)\.process-stat$/)?.[1]);
      return {
        timestamp,
        ticks: Number(values[11]) + Number(values[12]),
      };
    };

    const first = parseStat(statFiles[0]);
    const last = parseStat(statFiles.at(-1));
    const sampleMilliseconds = (last.timestamp - first.timestamp) / 1_000_000;
    const cpuSeconds = (last.ticks - first.ticks) / 100;

    let maxRssKiB = 0;
    for (const name of readdirSync(system).filter(name => name.endsWith('.process-and-memory'))) {
      const values = readFileSync(join(system, name), 'utf8').trim().split(/\s+/);
      maxRssKiB = Math.max(maxRssKiB, Number(values[3]) || 0);
    }
    return {
      samples: statFiles.length,
      sampleMilliseconds,
      cpuSeconds,
      averageCpuPercent: cpuSeconds / (sampleMilliseconds / 1000) * 100,
      maxRssMiB: maxRssKiB / 1024,
    };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

const metadata = keyValues(metadataText);
const restoreHeight = Number(metadata.restore_height);
const frozenTip = Number(metadata.frozen_tip);
if (!Number.isInteger(restoreHeight) || !Number.isInteger(frozenTip) || frozenTip <= restoreHeight) {
  throw new Error('invalid matrix heights');
}
const comparableBlocks = frozenTip - restoreHeight;

const variants = ['original', 'fast', 'scanpack'].map(variant => {
  const runDir = join(base, `strict-${matrixId}-${variant}`);
  const clientText = readFileSync(join(runDir, 'client.log'), 'utf8');
  const clientLines = clientText.split(/\r?\n/);
  const benchmark = keyValues(clientText, 'benchmark_');
  const admission = keyValues(readFileSync(join(runDir, 'admission-check.txt'), 'utf8'));
  if (benchmark.benchmark_synchronized !== 'true') throw new Error(`${variant}: wallet did not synchronize`);
  if (Number(benchmark.benchmark_daemon_height) !== frozenTip) throw new Error(`${variant}: tip mismatch`);
  if (admission.tip_contract !== `pass expected=${frozenTip} observed=${frozenTip}`) {
    throw new Error(`${variant}: admission tip mismatch`);
  }
  if (variant === 'scanpack' && admission.scanpack_hit_observed !== 'true') {
    throw new Error('scanpack: no cache hit admitted');
  }
  if (variant === 'fast' && admission.scanpack_hit_observed !== 'false') {
    throw new Error('fast: unexpected cache hit');
  }

  const elapsedMilliseconds = Number(benchmark.benchmark_elapsed_ms);
  const time = parseTime(clientText);
  const maximumRssMatch = clientText.match(/\n\s*(\d+)\s+maximum resident set size\s*\n/);
  if (!maximumRssMatch) throw new Error(`${variant}: client RSS missing`);

  const grpcChunks = clientLines.filter(line => line.includes('[SYNC_METRIC]')
    && line.includes('stage=network') && line.includes('transport=grpc')
    && line.includes('event=chunk'));
  const binBlocks = clientLines.filter(line => line.startsWith('SYNC_TRACE stage=http_getblocks'));
  const binHashes = clientLines.filter(line => line.startsWith('SYNC_TRACE stage=http_gethashes'));
  const clientScans = clientLines.filter(line => line.startsWith('SYNC_TRACE stage=scan_total')
    || (line.includes('[SYNC_METRIC]') && line.includes('stage=client_scan')
      && line.includes('substage=total')));
  const payloadBytes = variant === 'original'
    ? sum(binBlocks, 'bytes_rx')
    : sum(grpcChunks, 'payload_bytes');
  const clientScanMilliseconds = clientScans.length === 0
    ? null
    : sum(clientScans, clientScans[0].startsWith('SYNC_TRACE') ? 'ms' : 'duration_ms');

  const networkText = readFileSync(join(runDir, 'client-network-accounting.txt'), 'utf8');
  const tcpBytes = Number(networkText.match(/tcp_rx_bytes=(\d+)/)?.[1]);
  const tcpMiBPerSecond = Number(networkText.match(/tcp_rx_mib_per_s=([0-9.]+)/)?.[1]);
  if (!Number.isFinite(tcpBytes) || !Number.isFinite(tcpMiBPerSecond)) {
    throw new Error(`${variant}: TCP accounting missing`);
  }

  const journalLines = readFileSync(join(runDir, 'server-service-journal.log'), 'utf8').split(/\r?\n/);
  const serverRequests = journalLines.filter(line => variant === 'original'
    ? line.includes('[SYNC_TRACE_SERVER_BIN_BLOCKS]')
    : line.includes('[SYNC_TRACE_SERVER]'));
  const serverHashRequests = journalLines.filter(line => line.includes('[SYNC_TRACE_SERVER_BIN_HASH]'));
  const server = parseServerTelemetry(join(runDir, 'server-system.tar.gz'));

  const preflight = readFileSync(join(runDir, 'preflight.txt'), 'utf8');
  const scanPackBytes = Number(preflight.match(/^(\d+)\s+\/var\/lib\/cuprate\/wallet-scan-cache-100k$/m)?.[1]);
  if (!Number.isFinite(scanPackBytes)) throw new Error(`${variant}: ScanPack inventory missing`);

  const clientCpuSeconds = time.userSeconds + time.sysSeconds;
  return {
    variant,
    restoreHeight,
    frozenTip,
    blocks: comparableBlocks,
    elapsedMilliseconds,
    blocksPerSecond: comparableBlocks / (elapsedMilliseconds / 1000),
    blockPayloadBytes: payloadBytes,
    blockPayloadMiBPerSecond: payloadBytes / 1024 / 1024 / (elapsedMilliseconds / 1000),
    hashPayloadBytes: sum(binHashes, 'bytes_rx'),
    tcpReceiveBytes: tcpBytes,
    tcpReceiveMiBPerSecond: tcpMiBPerSecond,
    clientScanMilliseconds,
    clientUserSeconds: time.userSeconds,
    clientSystemSeconds: time.sysSeconds,
    clientCpuSeconds,
    clientAverageCpuPercent: clientCpuSeconds / time.realSeconds * 100,
    clientMaxRssMiB: Number(maximumRssMatch[1]) / 1024 / 1024,
    clientWalletFilesBytes: statSync(join(runDir, 'wallet')).size + statSync(join(runDir, 'wallet.keys')).size,
    serverRequestCount: serverRequests.length,
    serverResponseBlocks: sum(serverRequests, 'n_blocks'),
    serverBlockDbMilliseconds: sum(serverRequests, 'fetch_db_ms'),
    serverIndexDbMilliseconds: sum(serverRequests, 'idx_db_ms'),
    serverCacheReadMilliseconds: variant === 'scanpack' ? sum(serverRequests, 'fetch_ms') : null,
    serverHashRequestCount: serverHashRequests.length,
    serverHashLookupMilliseconds: sum(serverHashRequests, 'chain_lookup_ms'),
    serverCpuSeconds: server.cpuSeconds,
    serverAverageCpuPercent: server.averageCpuPercent,
    serverMaxRssMiB: server.maxRssMiB,
    serverSamples: server.samples,
    scanPackInventoryBytes: scanPackBytes,
  };
});

const byVariant = Object.fromEntries(variants.map(value => [value.variant, value]));
const speedups = {
  fastVsOriginal: byVariant.original.elapsedMilliseconds / byVariant.fast.elapsedMilliseconds,
  scanpackVsOriginal: byVariant.original.elapsedMilliseconds / byVariant.scanpack.elapsedMilliseconds,
  scanpackVsFast: byVariant.fast.elapsedMilliseconds / byVariant.scanpack.elapsedMilliseconds,
};
const result = { matrixId, metadata, comparableBlocks, variants, speedups };

const f = (value, digits = 3) => Number(value).toFixed(digits);
const scan = value => value.clientScanMilliseconds === null
  ? 'nicht separat erfasst'
  : `${f(value.clientScanMilliseconds / 1000)} s`;
const storage = value => value.variant === 'scanpack'
  ? `${f(value.clientWalletFilesBytes / 1024 / 1024)} MiB Wallet + ${f(value.scanPackInventoryBytes / 1024 / 1024 / 1024)} GiB Servercache`
  : `${f(value.clientWalletFilesBytes / 1024 / 1024)} MiB Wallet; 0 B erforderlicher ScanPack-Cache`;
const labels = {
  original: 'Original Monero Wallet',
  fast: 'Monero Fast Wallet',
  scanpack: 'Fast Wallet mit ScanPack-Cache',
};
const tableRows = variants.map(value => `| ${labels[value.variant]} | ${f(value.elapsedMilliseconds / 1000)} s | ${f(value.blocksPerSecond)} | ${f(value.blockPayloadMiBPerSecond)} | ${f(value.tcpReceiveMiBPerSecond)} | ${scan(value)} | Block ${f(value.serverBlockDbMilliseconds / 1000)} s; Index ${f(value.serverIndexDbMilliseconds / 1000)} s${value.serverCacheReadMilliseconds === null ? '' : `; Cache-Read ${f(value.serverCacheReadMilliseconds / 1000)} s`} | ${f(value.clientCpuSeconds)} CPU-s (${f(value.clientAverageCpuPercent, 1)} %) | ${f(value.serverCpuSeconds)} CPU-s (${f(value.serverAverageCpuPercent, 1)} %) | ${f(value.clientMaxRssMiB)} MiB | ${f(value.serverMaxRssMiB)} MiB | ${storage(value)} |`).join('\n');

const markdown = `# Strikte Mainnet-Sync-Matrix ${matrixId}\n\n`
  + `Restore-Höhe: ${restoreHeight}; eingefrorene RPC-Höhe: ${frozenTip}; vergleichbare Blöcke: ${comparableBlocks}. `
  + 'Alle drei Läufe waren seriell, endeten synchronisiert und bestanden den identischen Tip-Vertrag.\n\n'
  + '| Variante | Syncdauer | Blöcke/s | Block-Payload MiB/s | Client-TCP MiB/s | Client-Scanzeit | Server-DB-Zeit (Summe) | Client-CPU | Server-CPU | Client-RAM | Server-RAM | Speicherbedarf |\n'
  + '| --- | ---: | ---: | ---: | ---: | --- | --- | --- | --- | ---: | ---: | --- |\n'
  + `${tableRows}\n\n`
  + `Faktoren: Fast/Original ${f(speedups.fastVsOriginal, 2)}×; ScanPack/Original ${f(speedups.scanpackVsOriginal, 2)}×; ScanPack/Fast ${f(speedups.scanpackVsFast, 2)}×.\n\n`
  + 'Block-Payload ist der vollständige Blockantwort-Payload des jeweiligen Produkttransports; TCP ist der separat gemessene vollständige Prozess-RX-Durchsatz. '
  + 'Die gRPC-Client-Scanphasen erreichten in diesem Runner nur den Monero-Logger und nicht das archivierte stderr; deshalb steht dort ausdrücklich „nicht separat erfasst“. '
  + 'Server-DB-Zeiten sind summierte Request-Zeiten und können bei parallelen gRPC-Requests überlappen. Server-RAM ist ein 1-s-Prozessmaximum; Fast und Original teilen den nach dem Cache-Aus-Neustart erwärmten Serverprozess.\n';

writeFileSync(join(matrixDir, 'strict-summary.json'), `${JSON.stringify(result, null, 2)}\n`);
writeFileSync(join(matrixDir, 'strict-summary.md'), markdown);
console.log(markdown);
