import {
  createDiagnosticReport,
  diagnosticErrorSummary,
  formatRate,
  networkThroughputSample,
  registryIdForLegacyQuickProbe,
  validateLegacyQuickDiagnosticProbes,
  type LegacyQuickDiagnosticProbeId,
  type DiagnosticMetric,
  type DiagnosticTestResult,
  type DiagnosticTestStatus,
  type DiagnosticTestbenchReport,
} from '../../../../packages/wallet-shared/src/diagnosticTestbench';
import { measureDerivationPerformance } from './DerivationPerformance';
import { loadActiveNodeConnectionSettings } from './NodeConnectionSettings';
import { requireNativeMoneroWallet } from './NativeMoneroWallet';
import { logWalletEvent } from './WalletLogger';
import { walletService } from './WalletService';
import { isFastWalletRegistration } from './WalletRegistry';
import {
  MFW_DIAGNOSTIC_REGISTRY_SHA256,
  MFW_PRODUCT_CORE_ABI_VERSION,
  MFW_PRODUCT_CORE_SCHEMA_SHA256,
} from '../generated/mfwProductCoreContract';
import { MFW_APP_VAULT_STATE_SCHEMA_SHA256 } from '../generated/mfwAppVaultContract';

export type DiagnosticProgress = Readonly<{
  completed: number;
  total: number;
  label: string;
}>;

type TestOutcome = Readonly<{
  status: DiagnosticTestStatus;
  summary: string;
  metrics?: ReadonlyArray<DiagnosticMetric>;
}>;

type TestDefinition = Readonly<{
  id: LegacyQuickDiagnosticProbeId;
  category: string;
  label: string;
  run: () => Promise<TestOutcome>;
}>;

const TOTAL_TESTS = 12;

/**
 * Executes only bounded, non-destructive checks. It never creates a wallet,
 * reveals a key, submits a watch, changes an assignment, or sends Monero.
 */
export async function runWalletDiagnosticTestbench(
  onProgress?: (progress: DiagnosticProgress) => void,
): Promise<DiagnosticTestbenchReport> {
  const startedAt = Date.now();
  const native = requireNativeMoneroWallet();
  const settings = await loadActiveNodeConnectionSettings();
  const tests: DiagnosticTestResult[] = [];

  let networkStatus = await walletService
    .networkSyncStatus(settings.network)
    .catch(() => undefined);
  const registeredWallets = await walletService
    .loadRegisteredWallets()
    .catch(() => []);
  const fastWallets = await walletService
    .loadFastReceiveIdentities()
    .catch(() => []);

  const definitions: TestDefinition[] = [
    {
      id: 'native-core',
      category: 'Core',
      label: 'Native Monero Core',
      run: async () => {
        const linked = await walletService.linkedWithMonero();
        return {
          status: linked ? 'pass' : 'fail',
          summary: linked
            ? 'The packaged Monero wallet core is linked and callable.'
            : 'The native Monero wallet core is missing.',
          metrics: [
            { label: 'Product Core ABI', value: String(MFW_PRODUCT_CORE_ABI_VERSION) },
            { label: 'Product Core schema', value: MFW_PRODUCT_CORE_SCHEMA_SHA256 },
            { label: 'Diagnostic registry', value: MFW_DIAGNOSTIC_REGISTRY_SHA256 },
            { label: 'AppVault state schema', value: MFW_APP_VAULT_STATE_SCHEMA_SHA256 },
          ],
        };
      },
    },
    {
      id: 'secure-storage',
      category: 'Security',
      label: 'Protected storage round-trip',
      run: async () => {
        const suffix = await native.createSecureRandomIdentifier('diagnostic');
        const key = `monero.wallet.diagnostic.${suffix}`.slice(0, 128);
        try {
          await native.ensureWalletSecret(key);
          const stored = await native.walletSecretExists(key);
          return {
            status: stored ? 'pass' : 'fail',
            summary: stored
              ? 'A temporary credential was stored and read back successfully.'
              : 'Protected storage did not return the temporary credential.',
          };
        } finally {
          await native.deleteWalletSecret(key).catch(() => undefined);
        }
      },
    },
    {
      id: 'node-profile',
      category: 'Network',
      label: 'Node configuration',
      run: async () => {
        const optimized = settings.mode === 'optimized-grpc';
        const grpcReady = settings.grpcEndpoint.trim().length > 0;
        const valid = settings.daemon.address.trim().length > 0 &&
          (!optimized || grpcReady);
        return {
          status: valid ? 'pass' : 'fail',
          summary: valid
            ? optimized
              ? 'Monero Fast Node gRPC and daemon endpoints are configured.'
              : 'Original Monero RPC is configured.'
            : 'The active node profile is incomplete.',
          metrics: [
            { label: 'Mode', value: settings.mode },
            { label: 'Network', value: settings.network },
            { label: 'gRPC', value: grpcReady ? 'configured' : 'disabled' },
          ],
        };
      },
    },
    {
      id: 'shared-sync',
      category: 'Network',
      label: 'Shared blockchain connection',
      run: async () => {
        networkStatus = await walletService.networkSyncStatus(settings.network);
        if (!networkStatus || networkStatus.joinedWallets === 0) {
          return {
            status: 'skipped',
            summary: 'Open at least one wallet to exercise the shared node connection.',
          };
        }
        const failed = ['degraded', 'provider-backoff', 'retrying', 'stopped']
          .includes(networkStatus.state);
        const connected = networkStatus.transportStarts > 0 &&
          networkStatus.targetHeight > 0;
        return {
          status: failed ? 'fail' : connected ? 'pass' : 'warning',
          summary: failed
            ? `The shared connection is ${networkStatus.state}.`
            : connected
              ? 'One process-wide connection supplies every open wallet.'
              : 'The shared connection has not completed its first handshake yet.',
          metrics: [
            { label: 'State', value: networkStatus.state },
            { label: 'Phase', value: networkStatus.phase },
            { label: 'Chain height', value: String(networkStatus.chainHeight) },
            { label: 'Target height', value: String(networkStatus.targetHeight) },
            { label: 'Transport starts', value: String(networkStatus.transportStarts) },
          ],
        };
      },
    },
    {
      id: 'grpc-scanpack',
      category: 'Network',
      label: 'gRPC / ScanPack path',
      run: async () => {
        if (settings.mode !== 'optimized-grpc') {
          return {
            status: 'skipped',
            summary: 'The active profile deliberately uses original Monero RPC.',
          };
        }
        if (!networkStatus || networkStatus.fetchedBatches === 0) {
          return {
            status: 'warning',
            summary: 'gRPC is configured, but no authenticated block batch has arrived yet.',
          };
        }
        return {
          status: 'pass',
          summary: 'The optimized transport returned decoded shared block batches.',
          metrics: [
            { label: 'Batches', value: String(networkStatus.fetchedBatches) },
            { label: 'Blocks', value: String(networkStatus.fetchedBlocks) },
            { label: 'Decoded', value: String(networkStatus.decodedBatches) },
          ],
        };
      },
    },
    {
      id: 'network-throughput',
      category: 'Performance',
      label: 'Block download throughput',
      run: async () => {
        const sample = networkStatus
          ? networkThroughputSample(networkStatus)
          : undefined;
        if (!sample) {
          return {
            status: 'skipped',
            summary: 'No non-empty block batch has been downloaded in this app session yet.',
          };
        }
        const sampleBytes = Math.max(sample.networkBytes, sample.payloadBytes);
        const representative = sampleBytes >= 1024 * 1024 &&
          sample.elapsedMs >= 100;
        return {
          status: representative ? 'pass' : 'warning',
          summary: representative
            ? 'Measured directly at the Monero node transport.'
            : 'Measured, but the most recent batch is too small for a stable capacity estimate.',
          metrics: [
            ...(sample.networkMiBPerSecond !== undefined ? [{
              label: 'Network throughput',
              value: formatRate(sample.networkMiBPerSecond),
              unit: 'MiB/s',
            }] : []),
            ...(sample.payloadMiBPerSecond !== undefined ? [{
              label: 'Payload throughput',
              value: formatRate(sample.payloadMiBPerSecond),
              unit: 'MiB/s',
            }] : []),
            {
              label: 'Block throughput',
              value: formatRate(sample.blocksPerSecond),
              unit: 'blocks/s',
            },
            ...(sample.networkBytes > 0 ? [{ label: 'Network sample', value: formatBytes(sample.networkBytes) }] : []),
            ...(sample.payloadBytes > 0 ? [{ label: 'Payload sample', value: formatBytes(sample.payloadBytes) }] : []),
            { label: 'Fetch time', value: String(sample.elapsedMs), unit: 'ms' },
          ],
        };
      },
    },
    {
      id: 'wallet-snapshot',
      category: 'Wallet',
      label: 'Wallet snapshot',
      run: async () => {
        const session = walletService.getActiveSession();
        if (!session) {
          return {
            status: 'skipped',
            summary: 'Open a wallet to test its local balance and height snapshot.',
          };
        }
        const snapshot = await walletService.snapshot(session);
        const target = Math.max(snapshot.daemonHeight, snapshot.daemonTargetHeight);
        const consistent = target === 0 || snapshot.walletHeight <= target + 1;
        return {
          status: consistent ? 'pass' : 'fail',
          summary: consistent
            ? 'The active wallet returned a consistent local Core snapshot.'
            : 'The wallet height is inconsistent with the authenticated chain target.',
          metrics: [
            { label: 'Wallet height', value: String(snapshot.walletHeight) },
            { label: 'Daemon height', value: String(target) },
            { label: 'Synchronized', value: snapshot.synchronized ? 'yes' : 'no' },
          ],
        };
      },
    },
    {
      id: 'multi-wallet-fanout',
      category: 'Wallet',
      label: 'Multi-wallet fan-out',
      run: async () => {
        if (!networkStatus || networkStatus.joinedWallets === 0) {
          return {
            status: 'skipped',
            summary: 'No wallet is currently joined to the shared sync coordinator.',
          };
        }
        const stalled = networkStatus.stalledWallets > 0;
        return {
          status: stalled ? 'fail' : 'pass',
          summary: stalled
            ? 'At least one wallet scanner is stalled.'
            : 'Downloaded batches are fanned out to the joined wallet scanners.',
          metrics: [
            { label: 'Registered wallets', value: String(registeredWallets.length) },
            { label: 'Joined wallets', value: String(networkStatus.joinedWallets) },
            { label: 'Scan workers', value: String(networkStatus.scanWorkers) },
            { label: 'Stalled wallets', value: String(networkStatus.stalledWallets) },
            { label: 'Deliveries', value: String(networkStatus.fanoutDeliveries) },
          ],
        };
      },
    },
    {
      id: 'fast-wallet-local',
      category: 'Fast Wallet',
      label: 'Fast Wallet local integrity',
      run: async () => {
        if (fastWallets.length === 0) {
          return { status: 'skipped', summary: 'No Fast Wallet is configured.' };
        }
        const fastRegistrations = registeredWallets.filter(wallet =>
          isFastWalletRegistration(wallet),
        );
        let missingCredentials = 0;
        let missingRegistrations = 0;
        for (const identity of fastWallets) {
          if (!fastRegistrations.some(wallet => wallet.id === identity.id)) {
            missingRegistrations += 1;
          }
          if (
            !identity.credentialKey ||
            !(await native.walletSecretExists(identity.credentialKey).catch(() => false))
          ) {
            missingCredentials += 1;
          }
        }
        const valid = missingCredentials === 0 && missingRegistrations === 0;
        return {
          status: valid ? 'pass' : 'fail',
          summary: valid
            ? 'Every Fast Wallet has an independent registry entry and protected credential.'
            : 'Fast Wallet registry or protected credential data is incomplete.',
          metrics: [
            { label: 'Fast Wallets', value: String(fastWallets.length) },
            { label: 'Missing credentials', value: String(missingCredentials) },
            { label: 'Missing registrations', value: String(missingRegistrations) },
          ],
        };
      },
    },
    {
      id: 'fast-wallet-hosting',
      category: 'Fast Wallet',
      label: 'Encrypted Fast Wallet hosting',
      run: async () => {
        const hosted = fastWallets.filter(identity => identity.assignmentHandle);
        if (hosted.length === 0) {
          return {
            status: 'skipped',
            summary: 'No Fast Wallet currently has hosted encrypted scan data.',
          };
        }
        const now = Math.floor(Date.now() / 1_000);
        const incomplete = hosted.filter(identity =>
          !/^[0-9a-f]{64}$/.test(identity.assignmentHandle ?? '') ||
          !Number.isSafeInteger(identity.assignmentEpoch) ||
          (identity.assignmentEpoch ?? 0) <= 0 ||
          !Number.isSafeInteger(identity.assignmentExpiresAt) ||
          (identity.assignmentExpiresAt ?? 0) <= now ||
          !identity.watchMessageId ||
          !identity.workerKind,
        );
        const official = hosted.find(identity => identity.workerKind === 'official');
        if (official) {
          await native.loadOfficialFastWalletWorkerDescriptor(
            official.network,
            now,
          );
        }
        return {
          status: incomplete.length === 0 ? 'pass' : 'fail',
          summary: incomplete.length === 0
            ? 'Assignment metadata is complete; the official Worker descriptor was signature-checked when applicable.'
            : 'At least one encrypted assignment is incomplete or expired.',
          metrics: [
            { label: 'Hosted', value: String(hosted.length) },
            { label: 'Official Worker', value: String(hosted.filter(item => item.workerKind === 'official').length) },
            { label: 'Private Worker', value: String(hosted.filter(item => item.workerKind === 'private').length) },
            { label: 'Invalid', value: String(incomplete.length) },
          ],
        };
      },
    },
    {
      id: 'crypto-performance',
      category: 'Performance',
      label: 'Key derivation engine',
      run: async () => {
        const performance = await measureDerivationPerformance();
        return {
          status: performance.cpu.verified ? 'pass' : 'fail',
          summary: performance.cpu.verified
            ? 'The packaged engine passed the bounded public-vector benchmark.'
            : 'The CPU derivation backend did not return a verified result.',
          metrics: [
            { label: 'CPU workers', value: String(performance.cpuWorkers) },
            ...([['CPU', performance.cpu], ['Metal', performance.metal], ['CUDA', performance.cuda]] as const)
              .filter(([, backend]) => backend.verified)
              .map(([label, backend]) => ({
                label,
                value: String(backend.derivationsPerSecond),
                unit: 'derivations/s',
              })),
          ],
        };
      },
    },
    {
      id: 'ledger-transport',
      category: 'Hardware',
      label: 'Ledger transport',
      run: async () => {
        const status = await walletService.getLedgerTransportStatus();
        if (!status.supported) {
          return { status: 'skipped', summary: 'Ledger is not supported on this platform.' };
        }
        if (!status.available) {
          return {
            status: 'skipped',
            summary: 'No Ledger is connected; no permission prompt was opened.',
            metrics: [{ label: 'Transport', value: status.transport || 'none' }],
          };
        }
        return {
          status: status.permissionGranted ? 'pass' : 'warning',
          summary: status.permissionGranted
            ? 'The Ledger transport is available.'
            : 'Ledger is visible, but transport permission is required.',
          metrics: [
            { label: 'Transport', value: status.transport || 'unknown' },
            { label: 'Devices', value: String(status.deviceCount) },
          ],
        };
      },
    },
  ];

  validateLegacyQuickDiagnosticProbes(definitions);

  for (let index = 0; index < definitions.length; index += 1) {
    const definition = definitions[index];
    onProgress?.({ completed: index, total: TOTAL_TESTS, label: definition.label });
    const testStartedAt = Date.now();
    try {
      const outcome = await definition.run();
      tests.push({
        id: definition.id,
        registryId: registryIdForLegacyQuickProbe(definition.id),
        category: definition.category,
        label: definition.label,
        status: outcome.status,
        summary: outcome.summary,
        durationMs: Math.max(0, Date.now() - testStartedAt),
        metrics: outcome.metrics ?? [],
      });
    } catch (error) {
      tests.push({
        id: definition.id,
        registryId: registryIdForLegacyQuickProbe(definition.id),
        category: definition.category,
        label: definition.label,
        status: 'fail',
        summary: diagnosticErrorSummary(error),
        durationMs: Math.max(0, Date.now() - testStartedAt),
        metrics: [],
      });
    }
    onProgress?.({
      completed: index + 1,
      total: TOTAL_TESTS,
      label: definition.label,
    });
  }

  const report = createDiagnosticReport(startedAt, tests);
  logWalletEvent('WalletDiagnosticTestbench', 'complete', {
    durationMs: report.durationMs,
    failed: report.failed,
    passed: report.passed,
    skipped: report.skipped,
    warnings: report.warnings,
  });
  return report;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${formatRate(bytes / (1024 * 1024))} MiB`;
  if (bytes >= 1024) return `${formatRate(bytes / 1024)} KiB`;
  return `${bytes} B`;
}
