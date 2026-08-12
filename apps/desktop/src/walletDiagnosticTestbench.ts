import { invoke } from '@tauri-apps/api/core';
import {
  MFW_DIAGNOSTIC_REGISTRY_SHA256,
  MFW_PRODUCT_CORE_ABI_VERSION,
  MFW_PRODUCT_CORE_SCHEMA_SHA256,
} from './generated/mfwProductCoreContract';
import { MFW_APP_VAULT_STATE_SCHEMA_SHA256 } from './generated/mfwAppVaultContract';

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
} from '../../../packages/wallet-shared/src/diagnosticTestbench';

export type DesktopDiagnosticProgress = Readonly<{
  completed: number;
  total: number;
  label: string;
}>;

type Network = 'mainnet' | 'testnet' | 'stagenet';
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

type CoreStatus = {
  linked: boolean;
  releaseReady: boolean;
  backend: string;
  productCoreAbi: number;
  productCoreSchemaSha256: string;
  diagnosticRegistrySha256: string;
  appVaultStateSchemaSha256: string;
};
type NodeProfile = {
  mode: 'optimized-grpc' | 'original-rpc' | 'custom';
  network: Network;
  daemonAddress: string;
  grpcEndpoint: string;
};
type NetworkStatus = {
  state: string;
  phase: string;
  providerGeneration: number;
  chainHeight: number;
  targetHeight: number;
  transportStarts: number;
  fetchedBatches: number;
  fetchedBlocks: number;
  decodedBatches: number;
  fanoutDeliveries: number;
  stalledWallets: number;
  scanWorkers: number;
  joinedWallets: number;
  lastNonEmptyBlockFetchMs?: number;
  lastNonEmptyBlockCount?: number;
  lastNonEmptyNetworkBytes?: number;
  lastNonEmptyPayloadBytes?: number;
};
type Snapshot = {
  walletHeight: string;
  daemonHeight: string;
  daemonTargetHeight: string;
  synchronized: boolean;
};
type RegisteredWallet = { id: string };
type FastWallet = {
  id: string;
  assignmentHandle?: string;
};
type FastWalletIntegrity = {
  configuredCount: number;
  hostedCount: number;
  missingCredentialCount: number;
  invalidAssignmentCount: number;
};
type BackendPerformance = {
  available: boolean;
  verified: boolean;
  derivationsPerSecond: number;
};
type DerivationPerformance = {
  cpuWorkers: number;
  cpu: BackendPerformance;
  metal: BackendPerformance;
  cuda: BackendPerformance;
};
type LedgerStatus = {
  supported: boolean;
  available: boolean;
  permissionGranted: boolean;
  transport: string;
  deviceCount: number;
};

export async function runDesktopWalletDiagnosticTestbench(input: {
  network: Network;
  walletId: string | null;
  onProgress?: (progress: DesktopDiagnosticProgress) => void;
}): Promise<DiagnosticTestbenchReport> {
  const startedAt = Date.now();
  const tests: DiagnosticTestResult[] = [];
  let networkStatus = await loadNetworkStatus(input.network).catch(() => undefined);
  const [profile, registeredWallets, fastWallets] = await Promise.all([
    invoke<NodeProfile>('load_node_settings', { network: input.network }),
    invoke<RegisteredWallet[]>('list_registered_wallets').catch(() => []),
    invoke<FastWallet[]>('list_fast_wallets').catch(() => []),
  ]);

  const definitions: TestDefinition[] = [
    {
      id: 'native-core',
      category: 'Core',
      label: 'Native Monero Core',
      run: async () => {
        const core = await invoke<CoreStatus>('wallet_core_status');
        return {
          status: core.linked && core.releaseReady &&
            core.productCoreAbi === MFW_PRODUCT_CORE_ABI_VERSION &&
            core.productCoreSchemaSha256 === MFW_PRODUCT_CORE_SCHEMA_SHA256 &&
            core.diagnosticRegistrySha256 === MFW_DIAGNOSTIC_REGISTRY_SHA256 &&
            core.appVaultStateSchemaSha256 === MFW_APP_VAULT_STATE_SCHEMA_SHA256
            ? 'pass' : 'fail',
          summary: core.linked
            ? 'The packaged Monero wallet core is linked and callable.'
            : 'The native Monero wallet core is missing.',
          metrics: [
            { label: 'Backend', value: core.backend },
            { label: 'Product Core ABI', value: String(core.productCoreAbi) },
            { label: 'Schema', value: core.productCoreSchemaSha256 },
            { label: 'Diagnostic registry', value: core.diagnosticRegistrySha256 },
            { label: 'AppVault state schema', value: core.appVaultStateSchemaSha256 },
          ],
        };
      },
    },
    {
      id: 'secure-storage',
      category: 'Security',
      label: 'Protected storage round-trip',
      run: async () => {
        const valid = await invoke<boolean>('diagnostic_secure_storage_roundtrip');
        return {
          status: valid ? 'pass' : 'fail',
          summary: valid
            ? 'A temporary AppVault credential was stored, read and deleted.'
            : 'AppVault returned a different diagnostic value.',
        };
      },
    },
    {
      id: 'node-profile',
      category: 'Network',
      label: 'Node configuration',
      run: async () => {
        const optimized = profile.mode === 'optimized-grpc';
        const valid = Boolean(profile.daemonAddress.trim()) &&
          (!optimized || Boolean(profile.grpcEndpoint.trim()));
        return {
          status: valid ? 'pass' : 'fail',
          summary: valid
            ? optimized
              ? 'Cuprate gRPC and daemon endpoints are configured.'
              : 'Original Monero RPC is configured.'
            : 'The active node profile is incomplete.',
          metrics: [
            { label: 'Mode', value: profile.mode },
            { label: 'Network', value: profile.network },
            { label: 'gRPC', value: profile.grpcEndpoint ? 'configured' : 'disabled' },
          ],
        };
      },
    },
    {
      id: 'shared-sync',
      category: 'Network',
      label: 'Shared blockchain connection',
      run: async () => {
        networkStatus = await loadNetworkStatus(input.network);
        if (networkStatus.joinedWallets === 0) {
          return {
            status: 'skipped',
            summary: 'Open at least one wallet to exercise the shared node connection.',
          };
        }
        const failed = ['degraded', 'provider-backoff', 'retrying', 'stopped']
          .includes(networkStatus.state);
        const connected = networkStatus.transportStarts > 0 && networkStatus.targetHeight > 0;
        return {
          status: failed ? 'fail' : connected ? 'pass' : 'warning',
          summary: failed
            ? `The shared connection is ${networkStatus.state}.`
            : connected
              ? 'One process-wide connection supplies every open wallet.'
              : 'The first shared node handshake is still pending.',
          metrics: [
            { label: 'State', value: networkStatus.state },
            { label: 'Phase', value: networkStatus.phase },
            { label: 'Chain height', value: String(networkStatus.chainHeight) },
            { label: 'Target height', value: String(networkStatus.targetHeight) },
            { label: 'Transport starts', value: String(networkStatus.transportStarts) },
            { label: 'Provider generation', value: String(networkStatus.providerGeneration) },
          ],
        };
      },
    },
    {
      id: 'grpc-scanpack',
      category: 'Network',
      label: 'gRPC / ScanPack path',
      run: async () => {
        if (profile.mode !== 'optimized-grpc') {
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
        const representative = sampleBytes >= 1024 * 1024 && sample.elapsedMs >= 100;
        return {
          status: representative ? 'pass' : 'warning',
          summary: representative
            ? 'Measured directly at the Monero node transport.'
            : 'Measured, but the last batch is too small for a stable capacity estimate.',
          metrics: [
            ...(sample.networkMiBPerSecond !== undefined ? [{ label: 'Network throughput', value: formatRate(sample.networkMiBPerSecond), unit: 'MiB/s' }] : []),
            ...(sample.payloadMiBPerSecond !== undefined ? [{ label: 'Payload throughput', value: formatRate(sample.payloadMiBPerSecond), unit: 'MiB/s' }] : []),
            { label: 'Block throughput', value: formatRate(sample.blocksPerSecond), unit: 'blocks/s' },
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
        if (!input.walletId) {
          return { status: 'skipped', summary: 'Open a wallet to test its local Core snapshot.' };
        }
        const snapshot = parseJson<Snapshot>(
          await invoke<string>('wallet_snapshot', { input: { walletId: input.walletId } }),
        );
        const walletHeight = integerString(snapshot.walletHeight);
        const target = Math.max(
          integerString(snapshot.daemonHeight),
          integerString(snapshot.daemonTargetHeight),
        );
        const consistent = target === 0 || walletHeight <= target + 1;
        return {
          status: consistent ? 'pass' : 'fail',
          summary: consistent
            ? 'The active wallet returned a consistent local Core snapshot.'
            : 'The wallet height is inconsistent with the authenticated chain target.',
          metrics: [
            { label: 'Wallet height', value: String(walletHeight) },
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
        return {
          status: networkStatus.stalledWallets > 0 ? 'fail' : 'pass',
          summary: networkStatus.stalledWallets > 0
            ? 'At least one wallet scanner is stalled.'
            : 'Downloaded batches are fanned out to all joined wallet scanners.',
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
        const result = await invoke<FastWalletIntegrity>('diagnostic_fast_wallet_integrity');
        if (result.configuredCount === 0) {
          return { status: 'skipped', summary: 'No Fast Wallet is configured.' };
        }
        const valid = result.missingCredentialCount === 0 && result.invalidAssignmentCount === 0;
        return {
          status: valid ? 'pass' : 'fail',
          summary: valid
            ? 'Every Fast Wallet has protected local credentials and consistent assignment state.'
            : 'Fast Wallet credentials or assignment state are incomplete.',
          metrics: [
            { label: 'Fast Wallets', value: String(result.configuredCount) },
            { label: 'Hosted', value: String(result.hostedCount) },
            { label: 'Missing credentials', value: String(result.missingCredentialCount) },
            { label: 'Invalid assignments', value: String(result.invalidAssignmentCount) },
          ],
        };
      },
    },
    {
      id: 'fast-wallet-hosting',
      category: 'Fast Wallet',
      label: 'Encrypted Fast Wallet hosting',
      run: async () => {
        const hosted = fastWallets.filter(wallet => wallet.assignmentHandle);
        if (hosted.length === 0) {
          return {
            status: 'skipped',
            summary: 'No Fast Wallet currently has hosted encrypted scan data.',
          };
        }
        const verifiedWorkers = await Promise.all(hosted.map(wallet =>
          invoke<string>('diagnostic_fast_wallet_worker', {
            identityId: wallet.id,
          }),
        ));
        return {
          status: 'pass',
          summary: 'Every pinned Worker descriptor and protected assignment was verified without changing it.',
          metrics: [
            { label: 'Hosted assignments', value: String(hosted.length) },
            { label: 'Verified Workers', value: String(verifiedWorkers.length) },
          ],
        };
      },
    },
    {
      id: 'crypto-performance',
      category: 'Performance',
      label: 'Key derivation engine',
      run: async () => {
        const result = await invoke<DerivationPerformance>('diagnostic_derivation_performance');
        return {
          status: result.cpu.verified ? 'pass' : 'fail',
          summary: result.cpu.verified
            ? 'The packaged engine passed the bounded public-vector benchmark.'
            : 'The CPU derivation backend did not return a verified result.',
          metrics: [
            { label: 'CPU workers', value: String(result.cpuWorkers) },
            ...performanceMetrics(result),
          ],
        };
      },
    },
    {
      id: 'ledger-transport',
      category: 'Hardware',
      label: 'Ledger transport',
      run: async () => {
        const status = parseJson<LedgerStatus>(await invoke<string>('ledger_transport_status'));
        if (!status.supported) {
          return { status: 'skipped', summary: 'Ledger is not supported on this platform.' };
        }
        if (!status.available) {
          return {
            status: 'skipped',
            summary: 'No Ledger is connected; no permission dialog was opened.',
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
    input.onProgress?.({ completed: index, total: definitions.length, label: definition.label });
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
    input.onProgress?.({ completed: index + 1, total: definitions.length, label: definition.label });
  }
  return createDiagnosticReport(startedAt, tests);
}

async function loadNetworkStatus(network: Network): Promise<NetworkStatus> {
  return parseJson<NetworkStatus>(
    await invoke<string>('network_sync_status', { networkName: network }),
  );
}

function parseJson<T>(value: string): T {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object') throw new Error('Native diagnostics returned invalid JSON.');
  return parsed as T;
}

function integerString(value: string): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function performanceMetrics(result: DerivationPerformance): DiagnosticMetric[] {
  return ([['CPU', result.cpu], ['Metal', result.metal], ['CUDA', result.cuda]] as const)
    .filter(([, backend]) => backend.verified)
    .map(([label, backend]) => ({
      label,
      value: String(backend.derivationsPerSecond),
      unit: 'derivations/s',
    }));
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${formatRate(bytes / (1024 * 1024))} MiB`;
  if (bytes >= 1024) return `${formatRate(bytes / 1024)} KiB`;
  return `${bytes} B`;
}
