#!/usr/bin/env node

import {mkdtemp, mkdir, open, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {
  diagnoseAggregateOutputText,
  verifyAggregateOutputText,
  writeSanitizedReport,
} from './verify-official-ledger-cli-history.mjs';
import {parsePrivateReferenceSummary} from './official-ledger-private-summary.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const runner = process.env.TESTBENCH_REFERENCE_LEDGER_RUNNER;
const daemon = process.env.TESTBENCH_REFERENCE_DAEMON ?? 'xmr.tex8.com:18089';
const grpc = process.env.TESTBENCH_REFERENCE_GRPC ?? 'xmr.tex8.com:18091';
const device = process.env.TESTBENCH_REFERENCE_DEVICE ?? 'Ledger';
const maxSeconds = process.env.TESTBENCH_REFERENCE_MAX_SYNC_SECONDS ?? '7200';
const requireConcurrentSharedSync =
  process.env.TESTBENCH_REFERENCE_REQUIRE_CONCURRENT_SHARED_SYNC ?? '0';
const restoreHeight = '3577876';

if (!runner) {
  throw new Error('TESTBENCH_REFERENCE_LEDGER_RUNNER is required');
}
if (!/^[1-9][0-9]*$/.test(maxSeconds)) {
  throw new Error('TESTBENCH_REFERENCE_MAX_SYNC_SECONDS must be a positive integer');
}
if (!['Ledger', 'Ledger:ble'].includes(device)) {
  throw new Error('TESTBENCH_REFERENCE_DEVICE must be Ledger (USB) or Ledger:ble (BLE)');
}
if (!['0', '1'].includes(requireConcurrentSharedSync)) {
  throw new Error('TESTBENCH_REFERENCE_REQUIRE_CONCURRENT_SHARED_SYNC must be 0 or 1');
}

function section(output, accountIndex) {
  const begin = `reference_account_begin=${accountIndex}\n`;
  const end = `reference_account_end=${accountIndex}`;
  const start = output.indexOf(begin);
  const finish = start < 0 ? -1 : output.indexOf(end, start);
  if (start < 0 || finish < 0) throw new Error('private account output was incomplete');
  return output.slice(start + begin.length, finish);
}

async function writePrivateSummary(file, summary) {
  await mkdir(dirname(file), {recursive: true});
  await writeFile(file, `${JSON.stringify(summary, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
}

function metric(output, name) {
  const match = output.match(new RegExp(`^${name}=([0-9]+|true|false)$`, 'm'));
  if (!match) throw new Error(`missing safe runner metric: ${name}`);
  return match[1];
}

function optionalMetric(output, name) {
  const match = output.match(new RegExp(`^${name}=([0-9]+|true|false)$`, 'm'));
  return match?.[1];
}

function parseCpuMilliseconds(value) {
  const parts = value.trim().split(':');
  if (parts.length < 2 || parts.length > 3 || parts.some(part => !/^\d+(?:\.\d+)?$/.test(part))) {
    return undefined;
  }
  const seconds = Number(parts.at(-1));
  const minutes = Number(parts.at(-2));
  const hours = parts.length === 3 ? Number(parts[0]) : 0;
  return Math.round((hours * 3600 + minutes * 60 + seconds) * 1000);
}

function sampleProcess(pid) {
  return new Promise(resolveSample => {
    const ps = spawn('/bin/ps', ['-o', 'utime=,stime=,rss=', '-p', String(pid)], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const chunks = [];
    ps.stdout.on('data', chunk => chunks.push(chunk));
    ps.on('error', () => resolveSample(undefined));
    ps.on('close', () => {
      const fields = Buffer.concat(chunks).toString('utf8').trim().split(/\s+/);
      if (fields.length !== 3 || !/^\d+$/.test(fields[2])) {
        resolveSample(undefined);
        return;
      }
      const userCpuMs = parseCpuMilliseconds(fields[0]);
      const systemCpuMs = parseCpuMilliseconds(fields[1]);
      if (userCpuMs === undefined || systemCpuMs === undefined) {
        resolveSample(undefined);
        return;
      }
      resolveSample({userCpuMs, systemCpuMs, rssKib: Number(fields[2])});
    });
  });
}

function ratePerSecond(units, milliseconds, scale = 1) {
  const count = Number(units);
  const elapsed = Number(milliseconds);
  if (!Number.isFinite(count) || !Number.isFinite(elapsed) || elapsed <= 0) return null;
  return Number((count * scale * 1000 / elapsed).toFixed(6));
}

function safeFailure(output, stderr) {
  const failureClass = output.match(
    /^reference_sync_failure_class=(ledger-connection|ledger-view-key-export-rejected|ledger-key-image-protocol|ledger-key-image-operation-failed|daemon-rpc|wallet-role|unclassified)$/m,
  )?.[1];
  const failureStage = output.match(
    /^reference_sync_failure_stage=(ledger-transport|account-setup|hardware-wallet-create|view-key-export|view-wallet-create|view-wallet-account-1|observer-wallet-create|node-configuration|observer-node-configuration|shared-refresh|key-images|key-images-noop)$/m,
  )?.[1];
  if (failureClass && failureStage) return {failureClass, failureStage};
  if (/reference sync did not reach the daemon height/.test(stderr)) {
    return {failureClass: 'sync-timeout', failureStage: 'shared-refresh'};
  }
  if (/Ledger Bluetooth|Unable to connect to Ledger|Could not open.*Ledger/i.test(stderr)) {
    return {failureClass: 'ledger-connection', failureStage: 'ledger-transport'};
  }
  return {failureClass: 'runner-failed-before-reference-session', failureStage: 'unavailable'};
}

function referenceMetrics(output) {
  const keyImageMetrics = {
    pending_outputs: metric(output, 'reference_key_image_global_pending'),
    post_pending_outputs: metric(output, 'reference_key_image_post_pending_outputs'),
    verified_outputs: metric(output, 'reference_key_image_global_verified_outputs'),
    derived_outputs: metric(output, 'reference_key_image_global_derived_outputs'),
    spent_status_unspent_outputs: metric(output, 'reference_key_image_global_spent_status_unspent_outputs'),
    spent_status_blockchain_outputs: metric(output, 'reference_key_image_global_spent_status_blockchain_outputs'),
    spent_status_pool_outputs: metric(output, 'reference_key_image_global_spent_status_pool_outputs'),
    derivation_ms: metric(output, 'reference_key_image_global_derivation_ms'),
    spent_status_rpc_ms: metric(output, 'reference_key_image_global_spent_status_rpc_ms'),
    outgoing_rpc_ms: metric(output, 'reference_key_image_global_outgoing_rpc_ms'),
    state_update_ms: metric(output, 'reference_key_image_global_state_update_ms'),
    verification_ms: metric(output, 'reference_key_image_global_verification_ms'),
    store_ms: metric(output, 'reference_key_image_global_store_ms'),
    total_ms: metric(output, 'reference_key_image_global_total_ms'),
  };
  const elapsedMs = metric(output, 'reference_sync_elapsed_ms');
  const blocks = metric(output, 'reference_sync_blocks');
  const payloadBytes = metric(output, 'reference_sync_payload_bytes');
  const networkBytes = metric(output, 'reference_sync_network_bytes');
  const grpcFramedBytes = metric(output, 'reference_sync_grpc_framed_bytes');
  return {
    completed: metric(output, 'reference_sync_completed') === 'true',
    restore_height: restoreHeight,
    ledger_ble_discovery_requested:
      metric(output, 'reference_ledger_ble_discovery_requested') === 'true',
    hardware_wallet_create_ms: metric(output, 'reference_ledger_hardware_wallet_create_ms'),
    elapsed_ms: elapsedMs,
    blocks,
    transport_starts: metric(output, 'reference_sync_transport_starts'),
    payload_bytes: payloadBytes,
    network_bytes: networkBytes,
    grpc_framed_bytes: grpcFramedBytes,
    block_fetch_ms: metric(output, 'reference_sync_block_fetch_ms'),
    client_scan_ms: metric(output, 'reference_sync_client_scan_ms'),
    key_image_elapsed_ms: metric(output, 'reference_key_image_elapsed_ms'),
    key_images: keyImageMetrics,
    rates: {
      blocks_per_second: ratePerSecond(blocks, elapsedMs),
      payload_mib_per_second: ratePerSecond(payloadBytes, elapsedMs, 1 / (1024 * 1024)),
      core_network_bytes_per_second: ratePerSecond(networkBytes, elapsedMs),
      grpc_framed_bytes_per_second: ratePerSecond(grpcFramedBytes, elapsedMs),
      key_image_derivations_per_second: ratePerSecond(
        keyImageMetrics.derived_outputs,
        keyImageMetrics.derivation_ms,
      ),
    },
    server_db_time_available: false,
    second_run_noop: metric(output, 'reference_key_image_second_run_noop') === 'true',
    downloaded_blocks_during_key_images:
      metric(output, 'reference_download_blocks_during_key_images'),
    shared_sync: {
      required: metric(output, 'reference_shared_sync_required') === 'true',
      observer_blocks_during_key_images:
        metric(output, 'reference_observer_blocks_during_key_images'),
      observer_scan_workers_during_key_images:
        metric(output, 'reference_observer_scan_workers_during_key_images'),
      downloaded_blocks_during_key_images:
        metric(output, 'reference_download_blocks_during_key_images'),
      transport_starts_during_reconciliation:
        metric(output, 'reference_key_image_transport_starts_during_reconciliation'),
      no_second_block_downloader:
        metric(output, 'reference_key_image_no_second_block_downloader') === 'true',
      observed: metric(output, 'reference_shared_sync_observed') === 'true',
    },
  };
}

function referencePartialMetrics(output) {
  if (optionalMetric(output, 'reference_sync_partial_metrics_available') !== 'true') {
    return undefined;
  }
  const elapsedMs = metric(output, 'reference_sync_elapsed_ms');
  const blocks = metric(output, 'reference_sync_blocks');
  const payloadBytes = metric(output, 'reference_sync_payload_bytes');
  const networkBytes = metric(output, 'reference_sync_network_bytes');
  const grpcFramedBytes = metric(output, 'reference_sync_grpc_framed_bytes');
  return {
    completed: false,
    restore_height: restoreHeight,
    ledger_ble_discovery_requested:
      metric(output, 'reference_ledger_ble_discovery_requested') === 'true',
    hardware_wallet_create_ms: metric(output, 'reference_ledger_hardware_wallet_create_ms'),
    elapsed_ms: elapsedMs,
    blocks,
    transport_starts: metric(output, 'reference_sync_transport_starts'),
    payload_bytes: payloadBytes,
    network_bytes: networkBytes,
    grpc_framed_bytes: grpcFramedBytes,
    block_fetch_ms: metric(output, 'reference_sync_block_fetch_ms'),
    client_scan_ms: metric(output, 'reference_sync_client_scan_ms'),
    key_image_elapsed_ms: optionalMetric(output, 'reference_key_image_elapsed_ms') ?? null,
    key_images: null,
    rates: {
      blocks_per_second: ratePerSecond(blocks, elapsedMs),
      payload_mib_per_second: ratePerSecond(payloadBytes, elapsedMs, 1 / (1024 * 1024)),
      core_network_bytes_per_second: ratePerSecond(networkBytes, elapsedMs),
      grpc_framed_bytes_per_second: ratePerSecond(grpcFramedBytes, elapsedMs),
      key_image_derivations_per_second: null,
    },
    server_db_time_available: false,
    second_run_noop: false,
    downloaded_blocks_during_key_images: null,
    shared_sync: null,
  };
}

function execute(command, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {stdio: ['ignore', 'pipe', 'pipe']});
    const stdout = [];
    const stderr = [];
    // The native runner emits a fixed phase allow-list. Forward only those
    // lines so a physical operator can act at the requested point while no
    // native diagnostic, wallet data or key material is exposed.
    const safeReferencePhases = new Set([
      'ledger-transport',
      'account-setup',
      'hardware-wallet-create',
      'view-key-export',
      'view-wallet-create',
      'view-wallet-account-1',
      'observer-wallet-create',
      'node-configuration',
      'observer-node-configuration',
      'shared-refresh',
      'key-images',
      'key-images-noop',
    ]);
    let incompleteStdoutLine = '';
    const forwardSafePhaseLines = chunk => {
      const lines = `${incompleteStdoutLine}${chunk.toString('utf8')}`.split('\n');
      incompleteStdoutLine = lines.pop();
      for (const line of lines) {
        const phase = line.match(/^reference_sync_phase=([a-z-]+)$/)?.[1];
        if (phase && safeReferencePhases.has(phase)) {
          process.stdout.write(`reference_sync_phase=${phase}\n`);
        }
      }
    };
    let maxRssKib = 0;
    let latestUserCpuMs = 0;
    let latestSystemCpuMs = 0;
    let sampleCount = 0;
    let sampling = false;
    const sample = async () => {
      if (sampling) return;
      sampling = true;
      try {
        const result = await sampleProcess(child.pid);
        if (result) {
          maxRssKib = Math.max(maxRssKib, result.rssKib);
          latestUserCpuMs = result.userCpuMs;
          latestSystemCpuMs = result.systemCpuMs;
          sampleCount += 1;
        }
      } finally {
        sampling = false;
      }
    };
    const sampleTimer = setInterval(() => { void sample(); }, 500);
    void sample();
    child.stdout.on('data', chunk => {
      stdout.push(chunk);
      forwardSafePhaseLines(chunk);
    });
    child.stderr.on('data', chunk => stderr.push(chunk));
    child.on('error', error => {
      clearInterval(sampleTimer);
      rejectRun(error);
    });
    child.on('close', (code, signal) => {
      clearInterval(sampleTimer);
      forwardSafePhaseLines(Buffer.from('\n'));
      resolveRun({
        code,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        process: sampleCount > 0 ? {
          user_cpu_ms: latestUserCpuMs,
          system_cpu_ms: latestSystemCpuMs,
          peak_rss_kib: maxRssKib,
          samples: sampleCount,
        } : undefined,
      });
    });
  });
}

function hasMacOsLedgerUsbVendor(ioregOutput) {
  // Ledger's USB vendor ID is 0x2c97 (11415 decimal).  Do not accept product
  // names such as "Nano" here: unrelated USB devices can use that word.
  return /"idVendor"\s*=\s*(?:11415|0x2c97)\b/i.test(ioregOutput);
}

async function macOsLedgerUsbAvailable() {
  if (process.platform !== 'darwin') return true;
  const inspection = await execute('/usr/sbin/ioreg', ['-p', 'IOUSB', '-l', '-w', '0']);
  return inspection.code === 0 && hasMacOsLedgerUsbVendor(inspection.stdout);
}

class LedgerUsbPreflightError extends Error {}

const temporaryRoot = await mkdtemp(join(tmpdir(), 'tex8-ledger-reference-'));
const fixtureRoot = join(temporaryRoot, 'fixture');
const reportRoot = join(root, 'build', 'wallet-testbench', 'ledger-reference-reports');
const reportFile = join(reportRoot, `reference-${new Date().toISOString().replace(/[-:.TZ]/g, '')}.json`);
const privateSummaryRoot = join(root, 'build', 'wallet-testbench', 'ledger-reference-private-summaries');
const privateSummaryFile = join(
  privateSummaryRoot,
  `reference-${new Date().toISOString().replace(/[-:.TZ]/g, '')}.json`,
);
const hardwareLockFile = join(root, 'build', 'wallet-testbench', '.ledger-reference-sync.lock');
let result;
let hardwareLock;

try {
  // The reference runner permits one hardware session only. A second
  // invocation exits before it can touch the Nano; stale locks fail closed
  // and require local investigation rather than overlapping device I/O.
  await mkdir(dirname(hardwareLockFile), {recursive: true});
  try {
    hardwareLock = await open(hardwareLockFile, 'wx', 0o600);
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new Error('another Ledger reference session is active or requires local investigation');
    }
    throw error;
  }
  if (device === 'Ledger' && !(await macOsLedgerUsbAvailable())) {
    // This is deliberately before native wallet/device code.  A missing or
    // non-Ledger USB device must never be treated as a reason to open a
    // hardware wallet session, reconnect the Nano or issue an APDU.
    process.stdout.write('ledger_usb_preflight=absent\n');
    throw new LedgerUsbPreflightError();
  }
  if (device === 'Ledger') process.stdout.write('ledger_usb_preflight=ready\n');
  const command = [
    'ledger-reference-sync', 'mainnet', fixtureRoot, restoreHeight,
    daemon, grpc, maxSeconds, device,
  ];
  if (requireConcurrentSharedSync === '1') command.push('shared-observer');
  result = await execute(runner, command);
  if (result.code !== 0) {
    await mkdir(reportRoot, {recursive: true});
    const failure = safeFailure(result.stdout, result.stderr);
    const partialMetrics = referencePartialMetrics(result.stdout);
    writeSanitizedReport(reportFile, {
      schema: 'tex8.official-ledger-cli-history-verification.v2',
      scope: 'accounts-0-and-1',
      reference_sync_started: true,
      reference_sync_completed: false,
      failure: failure.failureClass,
      failure_stage: failure.failureStage,
      reference_metrics_available: Boolean(partialMetrics),
      ...(partialMetrics ? {reference_sync: partialMetrics} : {}),
      ...(result.process ? {reference_process: result.process} : {}),
    });
    process.stdout.write('official_ledger_reference_sync=failed\n');
    process.exitCode = 1;
  } else {
    const metrics = referenceMetrics(result.stdout);
    const finalPendingCleared = metrics.key_images.post_pending_outputs === '0';
    if (!finalPendingCleared ||
        !metrics.second_run_noop ||
        (requireConcurrentSharedSync === '1' &&
         (!metrics.shared_sync.required || !metrics.shared_sync.observed ||
          !metrics.shared_sync.no_second_block_downloader))) {
      await mkdir(reportRoot, {recursive: true});
      writeSanitizedReport(reportFile, {
        schema: 'tex8.official-ledger-cli-history-verification.v2',
        scope: 'accounts-0-and-1',
        reference_sync_started: true,
        reference_sync_completed: false,
        failure: !finalPendingCleared
          ? 'ledger-key-image-final-pending'
          : (!metrics.second_run_noop
            ? 'ledger-key-image-second-run-not-noop'
            : 'shared-sync-observer-not-observed'),
        failure_stage: 'key-images',
        reference_metrics_available: true,
        reference_sync: metrics,
        ...(result.process ? {reference_process: result.process} : {}),
      });
      process.stdout.write('official_ledger_reference_sync=failed\n');
      process.exitCode = 1;
    } else {
      const report = verifyAggregateOutputText(section(result.stdout, 0), section(result.stdout, 1));
      const summary = parsePrivateReferenceSummary(result.stdout);
      report.reference_sync = metrics;
      report.reference_process = result.process;
      await mkdir(reportRoot, {recursive: true});
      writeSanitizedReport(reportFile, report);
      await writePrivateSummary(privateSummaryFile, summary);
      process.stdout.write('official_ledger_reference_sync=pass\n');
      process.stdout.write(`official_ledger_reference_private_summary=${privateSummaryFile}\n`);
    }
  }
} catch (error) {
  let diagnostics;
  let failedRunMetrics;
  const accountSectionsAvailable = result?.stdout?.includes('reference_account_begin=0\n') === true &&
    result.stdout.includes('reference_account_begin=1\n');
  try {
    diagnostics = diagnoseAggregateOutputText(
      section(result?.stdout ?? '', 0), section(result?.stdout ?? '', 1),
    );
  } catch {
    diagnostics = undefined;
  }
  try {
    failedRunMetrics = result?.code === 0
      ? referenceMetrics(result.stdout)
      : referencePartialMetrics(result?.stdout ?? '');
  } catch {
    failedRunMetrics = undefined;
  }
  await mkdir(reportRoot, {recursive: true});
  writeSanitizedReport(reportFile, {
    schema: 'tex8.official-ledger-cli-history-verification.v2',
    scope: 'accounts-0-and-1',
    reference_sync_started: true,
    reference_sync_completed: false,
    failure: error instanceof LedgerUsbPreflightError
      ? 'ledger-connection'
      : 'verification-failed',
    ...(error instanceof LedgerUsbPreflightError
      ? {failure_stage: 'ledger-usb-preflight'}
      : {}),
    runner_exit_code: result?.code ?? null,
    runner_exit_signal: result?.signal ?? null,
    private_account_sections_available: accountSectionsAvailable,
    reference_metrics_available: Boolean(failedRunMetrics),
    ...(failedRunMetrics ? {reference_sync: failedRunMetrics} : {}),
    ...(result?.process ? {reference_process: result.process} : {}),
    ...(diagnostics ? {verification: diagnostics} : {}),
  });
  process.stdout.write('official_ledger_reference_sync=failed\n');
  process.exitCode = 1;
} finally {
  if (hardwareLock) {
    await hardwareLock.close();
    await rm(hardwareLockFile, {force: true});
  }
  // The native command removes each generated encrypted wallet. This removes
  // only its now-empty unique temporary parent; no private bridge output is
  // ever written to disk by this runner.
  await rm(temporaryRoot, {recursive: true, force: true});
}
