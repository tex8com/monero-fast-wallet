import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { checkPermissions, getCurrentPosition, requestPermissions } from '@tauri-apps/plugin-geolocation';
import QRCode from 'qrcode';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  nextWalletPublication,
  presentWalletSync,
  syncStartHeightForWallet,
  updateWalletSyncEta,
  type WalletPublication,
  type WalletSyncEtaState,
} from '../../../packages/wallet-shared/src/walletSync';
import {
  formatNetworkSyncRate,
  formatSyncPercent,
  formatWalletDerivationRate,
  networkSyncByteSample,
  networkSyncMegabitsPerSecond,
  networkSyncWindowMegabitsPerSecond,
  normalizeSyncPercent,
  presentNetworkSync,
  walletSyncDerivationsPerSecond,
} from '../../../packages/wallet-shared/src/networkSync';
import { useI18n } from './i18n';
import { type MarketPoint, type MarketTimeframe, useXmrChart, useXmrPrice } from './marketData';
import { type MoneroNewsCategory, useMoneroNews } from './moneroNews';
import { restoreHeightFromStartDate, todayRestoreDate } from './restoreStart';
import { removeDesktopWalletAddresses, upsertDesktopWalletAddress } from './walletAddressRegistry';
import { loadRecipientContacts, loadRecentRecipients, rememberRecipient, saveRecipientContacts, type RecipientContact } from './recipientAddressBook';
import DesktopRecipientQrScanner from './DesktopRecipientQrScanner';
import { v1ReleaseFeatures } from '../../../packages/wallet-shared/src/v1ReleaseFeatures';
import { DesktopAppUpdateService } from './appUpdate';
import MfwNames from './MfwNames';
import { loadFastWalletPreference, saveFastWalletPreference } from './fastWalletPreference';
import {
  runDesktopWalletDiagnosticTestbench,
  type DesktopDiagnosticProgress,
} from './walletDiagnosticTestbench';
import type {
  DiagnosticTestStatus,
  DiagnosticTestbenchReport,
} from '../../../packages/wallet-shared/src/diagnosticTestbench';
import DesktopIcon, { type DesktopIconName } from './DesktopIcon';
import {
  deriveAppVaultPresentation,
  validateRecoveryPassword,
} from '../../../packages/wallet-shared/src/appVaultStateMachine';

type Section = 'home' | 'wallets' | 'setup' | 'onboarding' | 'send' | 'receive' | 'activity' | 'mfw' | 'enthusiast' | 'community' | 'assistant' | 'settings' | 'menu';
type Network = 'mainnet' | 'testnet' | 'stagenet';
type SetupMode = 'create' | 'restore' | 'ledger';
type WalletCoreStatus = { linked: boolean; releaseReady: boolean; coreTree: string; backend: string; message: string; productCoreAbi: number; productCoreSchemaSha256: string; diagnosticRegistrySha256: string; appVaultStateSchemaSha256: string };
type ComputeBackendPreference = 'auto' | 'cpu' | 'gpu';
type ComputeBackendStatus = { preference: ComputeBackendPreference; activeBackend: string; gpuAvailable: boolean; gpuKind: string; deviceName: string; deviceCount: number; selfTestPassed: boolean; cpuFallback: boolean; lastError: string };
type BackendPerformance = { available: boolean; verified: boolean; derivationsPerSecond: number; sampleCount: number; elapsedMs: number; error: string };
type DerivationPerformance = { schemaVersion: number; cpuWorkers: number; cpu: BackendPerformance; metal: BackendPerformance; cuda: BackendPerformance };
type AppProtectionMode = 'password' | 'system';
type FastWalletTransferStatus = 'idle' | 'transferring' | 'accepted' | 'failed';
type SystemAuthStatus = { available: boolean; label: string; detail: string; requiresRecoveryPassword: boolean };
type AppProtectionStatus = {
  configured: boolean;
  locked: boolean;
  mode: AppProtectionMode | null;
  passwordConfigured: boolean;
  systemAuth: SystemAuthStatus;
};
type AutoLockSettings = { autoLockSeconds: number };
type RegisteredWallet = { id: string; displayName?: string; walletName: string; network: Network; kind: string; seedBackupStatus: 'pending' | 'verified' | 'not-required'; restoreHeight?: number; accountIndex?: number; addressIndex?: number; role?: 'standard' | 'fast'; sourceWalletId?: string; ledgerKeyImagesVerifiedAt?: number; ledgerKeyImagesVerifiedHeight?: number; createdAt: number; lastOpenedAt: number; isOpen?: boolean; isActive?: boolean };
type WalletOperationResponse = { walletId: string; wallet: RegisteredWallet };
type WalletSessionRecoveryResponse = WalletOperationResponse & { sessionGeneration: number; reopenAttempt: number; reopened: boolean };
type RegisteredWalletSnapshot = { registrationId: string; snapshot: string; usesLedgerReadOnly: boolean };
type LedgerTransportStatus = { platform: string; transport: 'ble'; supported: boolean; available: boolean; permissionGranted: boolean; requiresUserAction: boolean; deviceCount: number; message: string };
type SeedRevealRequest = {
  nativeWalletId: string;
  wallet: RegisteredWallet;
};
type RecoverySeedScreen = {
  kind: 'standard' | 'fast';
  nativeWalletId: string;
  registrationId: string;
  label: string;
  seed: string;
};
type NativeSubaddress = { accountIndex: number; addressIndex: number; address: string; label: string };
type NativePreparedTransaction = { id: string; status: string; error: string; amountAtomic: string; dustAtomic: string; feeAtomic: string; txCount: string; txIds: string[]; subaddressAccounts: number[]; subaddressIndices: number[] };
type NativeTransaction = { hash: string; paymentId: string; description: string; label: string; direction: string; pending: boolean; failed: boolean; coinbase: boolean; amountAtomic: string; feeAtomic: string; blockHeight: string; confirmations: string; unlockTime: string; timestamp: string; subaddressAccount: number; subaddressIndices: number[]; transfers: Array<{ amountAtomic: string; address: string }> };
type NativeHardwareWalletStatus = { walletId: string; deviceName: string; deviceType: string; connected: boolean; requiresUserAction: boolean; promptKind: string; promptCode: string; progress: number; indeterminate: boolean };
type NativeWalletSnapshot = { id: string; primaryAddress: string; balanceAtomic: string; unlockedBalanceAtomic: string; walletHeight: string; daemonHeight: string; daemonTargetHeight: string; pendingOutputKeyImageCount?: string; snapshotRevision?: string; synchronized: boolean };
type NetworkSyncStatus = { network: Network; state: string; phase: string; lastError: string; consecutiveFailures: number; phaseSequence: number; providerGeneration: number; phaseElapsedMs: number; lastProviderSelectionMs: number; lastTransportInitializationMs: number; lastBlockFetchMs: number; lastPrefetchMs: number; lastPrefetchWaitMs: number; prefetchedPayloadBytes: number; peakPrefetchedPayloadBytes: number; lastNonEmptyBlockFetchMs: number; lastNonEmptyBlockCount: number; lastNonEmptyNetworkBytes: number; lastNonEmptyPayloadBytes: number; networkBytesReceived: number; payloadBytesReceived: number; grpcFramedBytesReceived: number; spoolBytesBuffered: number; spoolPeakBytes: number; spoolWriteCount: number; spoolReadCount: number; spoolBackpressureCount: number; spoolEnabled: boolean; lastWalletScanMs: number; lastNonEmptyWalletDerivationCount: number; lastNonEmptyWalletDerivationUs: number; totalWalletDerivationCount: number; totalWalletDerivationUs: number; lastMempoolMs: number; lastCheckpointMs: number; lastIterationMs: number; downloadStartHeight: number; downloadedHeight: number; chainHeight: number; targetHeight: number; transportStarts: number; fetchedBatches: number; fetchedBlocks: number; decodedBatches: number; prefetchedBatches: number; prefetchHits: number; fanoutDeliveries: number; poolSnapshots: number; cacheHits: number; cacheMisses: number; replayCachePayloadBytes: number; replayCachePeakPayloadBytes: number; replayCachePayloadLimitBytes: number; stalledWallets: number; scanWorkers: number; joinedWallets: number; queueDepth: number; prefetchQueueDepth: number; prefetchQueueCapacity: number; replayCacheEntries: number; replayCacheCapacity: number };
type CommunityProfile = { identityId: string; displayName: string; bio: string; visible: boolean; radiusKm: number };
type CommunityNearby = CommunityProfile & { approximateDistanceKm: number; relationship: 'none' | 'outgoing' | 'incoming' | 'connected' };
type CommunityContact = CommunityProfile & { status: 'outgoing' | 'incoming' | 'connected' };
type CommunityMessage = { id: string; senderId: string; recipientId: string; body: string; sentAtMs: number };
type MoneroEnthusiastV1Status = { packaged: boolean; ready: boolean; identityExists: boolean; catalogReady: boolean; matrixReady: boolean; reason: string };
type CommunityV1AccountStatus = { identityId: string; suspended: boolean; suspensionCaseId?: string };
type CommunityV1ContentRecord = { publicId: string; revision: number; draft: { kind: 'profile' | 'post' | 'service_listing' | 'product_listing'; title: string; summary: string; roles: string[]; categories: string[]; languages: string[]; coarseRegion?: string; radiusKm?: number; media: unknown[] }; status: string; wordingSuggestion?: string };
type CommunityV1ContactRequest = { requestId: string; requesterId: string; recipientId: string; status: string; createdAtMs: number; respondedAtMs?: number };
type CommunityV1Chat = { peerId: string; matrixUserId: string; roomId: string };
type CommunityV1MatrixMessage = { eventId: string; senderId: string; body: string; timestampMs: number; sentByMe: boolean };
type CommunityV1MessagePage = { messages: CommunityV1MatrixMessage[]; next?: string };
type CommunityV1SelectedMessage = { roomId: string; eventId: string; senderId: string; body: string; timestampMs: number };
type CommunityV1ModerationOutcome = { caseId: string; status: string; decision?: string; decisionReason?: string; resolvedAtMs?: number; appealPending: boolean };
type CommunityV1ContentModerationOutcome = { caseId: string; publicId: string; revision: number; source: string; status: string; decision?: string; decisionReason?: string; resolvedAtMs?: number; appealPending: boolean; affectedAuthor: boolean };
type CommunityV1QuerySuggestion = { queryId: string; displayText: string; language: string; weight: number };
type CommunityV1SearchResult = {
  item: {
    publicId: string;
    ownerPublicId: string;
    kind: 'profile' | 'post' | 'service_listing' | 'product_listing';
    title: string;
    summary: string;
    categories: string[];
    languages: string[];
    coarseRegion?: string;
    sponsored: boolean;
  };
  semanticDistance: number;
  personalAdjustment: number;
  combinedScore: number;
};
type FastWalletRecord = { id: string; label: string; address: string; network: Network; sourceRegistrationId: string; restoreHeight: number; derivationIndex: number; seedBackupStatus: 'pending' | 'verified'; seedBackedUpAt?: number; status: 'local-only' | 'enabled' | 'disabled' | 'registration-error' | 'server-mismatch' | 'legacy-blocked'; scannerStatus: string; scannerUrl: string; scannerCheckedAt?: number; lastScannedHeight?: number; notificationsEnabled: boolean; alertStatus: 'off' | 'setting-up' | 'on' | 'needs-attention'; assignmentHandle?: string; assignmentEpoch?: number; assignmentExpiresAt?: number; watchMessageId?: string; createdAt: number; updatedAt: number };
type FastWalletOpenResponse = { walletId: string; wallet: FastWalletRecord };
type NodeProfile = { mode: 'optimized-grpc' | 'original-rpc' | 'custom'; network: Network; daemonAddress: string; grpcEndpoint: string; trusted: boolean; useSsl: boolean; username: string; proxyAddress: string; passwordStored: boolean; updatedAt: number };
type SettingsDiagnostic = { label: string; value: string; tone?: 'good' | 'warning' | 'neutral' };

type NavigationItem = { id: Section; label: string; icon: DesktopIconName };

function primarySections(t: ReturnType<typeof useI18n>['t']): NavigationItem[] { return [
  { id: 'home', label: t('nav.home'), icon: 'home' },
  { id: 'send', label: t('nav.send'), icon: 'send' },
  { id: 'receive', label: t('nav.receive'), icon: 'receive' },
  { id: 'enthusiast', label: t('nav.community'), icon: 'community-tab' },
  { id: 'menu', label: t('nav.menu'), icon: 'menu' },
]; }
function secondarySections(_t: ReturnType<typeof useI18n>['t']): NavigationItem[] { return []; }

const menuChildSections: ReadonlySet<Section> = new Set(['wallets', 'mfw', 'assistant', 'settings']);
function primaryNavigationSection(section: Section): Section {
  return menuChildSections.has(section) ? 'menu' : section;
}

function statusLabel(status: WalletCoreStatus | null, t: ReturnType<typeof useI18n>['t']) { return !status ? t('shell.coreChecking') : status.linked ? t('shell.coreReady') : t('shell.coreRequired'); }
function errorMessage(reason: unknown, fallback: string) {
  if (reason instanceof Error && reason.message.trim()) return reason.message;
  if (typeof reason === 'string' && reason.trim()) return reason;
  if (reason && typeof reason === 'object' && 'message' in reason) {
    const message = (reason as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message;
  }
  return fallback;
}
function isBackgroundWalletWork(reason: unknown) {
  return errorMessage(reason, '').includes('connecting in the background');
}
function isSessionStale(reason: unknown) {
  return errorMessage(reason, '') === 'session-stale';
}
type WalletUiDiagnosticEvent =
  | 'wallet-list-reload-started'
  | 'wallet-list-reload-completed'
  | 'wallet-list-reload-failed'
  | 'wallet-switch-selected'
  | 'wallet-switch-activate-started'
  | 'wallet-switch-activate-completed'
  | 'wallet-switch-core-open-started'
  | 'wallet-switch-core-open-completed'
  | 'wallet-switch-core-open-failed'
  | 'wallet-switch-ui-rendered'
  | 'wallet-switch-completed'
  | 'wallet-switch-failed';

/** Keep support timing data private: operation names and durations only. */
function recordWalletUiDiagnostic(event: WalletUiDiagnosticEvent, startedAt?: number) {
  const elapsedMs = startedAt === undefined ? undefined : Math.max(0, Math.round(performance.now() - startedAt));
  void invoke('wallet_ui_diagnostic', { input: { event, elapsedMs } }).catch((reason) => {
    console.warn('MONERO_DESKTOP_WALLET_UI_DIAGNOSTIC_FAILED', event, reason);
  });
}
function networkLabel(network: Network) { return network === 'mainnet' ? 'Mainnet' : network === 'testnet' ? 'Testnet' : 'Stagenet'; }
function walletDisplayName(wallet: Pick<RegisteredWallet, 'displayName' | 'walletName'>) { return wallet.displayName?.trim() || wallet.walletName; }
function isFastWalletRegistration(wallet: Pick<RegisteredWallet, 'kind' | 'role'> | null | undefined) { return wallet?.role === 'fast' || wallet?.kind === 'fast'; }
function fastWalletAsRegistration(wallet: FastWalletRecord): RegisteredWallet {
  return {
    id: wallet.id,
    displayName: wallet.label,
    walletName: wallet.label,
    network: wallet.network,
    kind: 'fast',
    role: 'fast',
    sourceWalletId: wallet.sourceRegistrationId,
    seedBackupStatus: wallet.seedBackupStatus,
    restoreHeight: wallet.restoreHeight,
    createdAt: wallet.createdAt,
    lastOpenedAt: wallet.updatedAt,
  };
}
function walletTypeLabel(wallet: RegisteredWallet, t: ReturnType<typeof useI18n>['t']) {
  if (isFastWalletRegistration(wallet)) return wallet.kind === 'hardware' ? `Fast Wallet · ${t('wallets.ledger')}` : 'Fast Wallet';
  if (wallet.kind === 'hardware') return t('wallets.ledger');
  if (wallet.kind === 'view-only') return 'Ledger read-only';
  return t('wallets.software');
}
function parseNativeJson<T>(value: string, fallback: string): T { try { return JSON.parse(value) as T; } catch { throw new Error(fallback); } }
function nativeHeight(value: string | number | undefined) {
  const height = Number(value);
  return Number.isFinite(height) && height > 0 ? Math.floor(height) : undefined;
}
function snapshotPublicationToken(snapshot: NativeWalletSnapshot): string {
  const revision = Number(snapshot.snapshotRevision ?? 0);
  if (Number.isSafeInteger(revision) && revision > 0) return `revision:${revision}`;
  return [
    snapshot.walletHeight,
    snapshot.daemonHeight,
    snapshot.daemonTargetHeight,
    snapshot.balanceAtomic,
    snapshot.unlockedBalanceAtomic,
    snapshot.pendingOutputKeyImageCount ?? '',
    snapshot.synchronized ? '1' : '0',
  ].join(':');
}
function syncLabel(snapshot: NativeWalletSnapshot | null, t?: ReturnType<typeof useI18n>['t'], startHeight?: number) {
  const sync = presentWalletSync(snapshot, { startHeight });
  if (sync.phase === 'synchronized') return `${t ? t('home.syncComplete') : 'Synchronized'} · 100%`;
  // The top bar owns the one process-wide network indicator. Wallet cards
  // report only their private consumer state.
  if (sync.phase === 'waiting-for-node') return t ? t('home.syncUpdating') : 'Waiting for shared blocks';
  if (sync.phase === 'finalizing') return t ? t('home.syncVerifying') : 'Verifying recent transactions';
  return t ? t('home.syncScanning') : 'Scanning blocks';
}
function desktopLedgerBalanceNeedsVerification(wallet: RegisteredWallet, snapshot: NativeWalletSnapshot | undefined, usesLedgerReadOnly: boolean) {
  if (wallet.kind !== 'hardware' || wallet.role === 'fast') return false;
  // The local read-only companion is the authoritative scanner.  A missing
  // companion still needs the explicit setup flow, but must never start an
  // automatic hardware operation.
  if (!usesLedgerReadOnly) return true;
  // Keep the pending-output field in the parity contract, but never use it to
  // wake Ledger periodically. Once the initial import is durable, later
  // outputs wait for Send or the explicit Settings action.
  void snapshot?.pendingOutputKeyImageCount;
  return !wallet.ledgerKeyImagesVerifiedAt;
}
function networkSyncConnected(status: NetworkSyncStatus | null) {
  return Boolean(status && status.transportStarts > 0 && ['fetching-blocks', 'fanout', 'scanning', 'synced'].includes(status.state));
}
function networkSyncFailed(status: NetworkSyncStatus | null) {
  return status?.state === 'retrying' || status?.state === 'provider-backoff';
}
function networkSyncPhaseLabel(status: NetworkSyncStatus | null, t: ReturnType<typeof useI18n>['t']) {
  const sync = presentNetworkSync(status);
  if (sync.failed) return t('home.syncRetrying');
  switch (sync.phase) {
    case 'selecting-provider': return t('home.syncSelectingSource');
    case 'initializing-transport': return t('home.syncStartingConnection');
    case 'reconnecting': return t('home.syncRetrying');
    case 'fetching-blocks':
    case 'waiting-next-batch':
    case 'scanning-wallets': return t('home.syncDownloadingAndScanning');
    case 'checking-mempool': return t('home.syncMempool');
    case 'checkpointing-wallets': return t('home.syncSaving');
    case 'synced': return t('shell.nodeLive');
    case 'degraded': return t('home.syncDegraded');
    default: return t('home.syncConnecting');
  }
}
const ATOMIC_XMR = 1_000_000_000_000n;
function atomicValue(value: string | undefined) { try { return BigInt(value ?? '0'); } catch { return 0n; } }
function formatAtomicXmr(value: string | undefined, fractionDigits = 4) { const atomic = atomicValue(value); const sign = atomic < 0n ? '-' : ''; const absolute = atomic < 0n ? -atomic : atomic; const whole = absolute / ATOMIC_XMR; const fraction = (absolute % ATOMIC_XMR).toString().padStart(12, '0').slice(0, fractionDigits).replace(/0+$/, ''); return `${sign}${whole.toString()}${fraction ? `.${fraction}` : ''}`; }
function FixedAtomicXmr({ value }: { value: string | undefined }) {
  const atomic = atomicValue(value);
  const sign = atomic < 0n ? '-' : '';
  const absolute = atomic < 0n ? -atomic : atomic;
  const fullValue = `${sign}${(absolute / ATOMIC_XMR).toString()}.${(absolute % ATOMIC_XMR).toString().padStart(12, '0')}`;
  const trailingZeroCount = fullValue.match(/0+$/)?.[0].length ?? 0;
  const significantValue = trailingZeroCount ? fullValue.slice(0, -trailingZeroCount) : fullValue;
  const trailingZeros = trailingZeroCount ? '0'.repeat(trailingZeroCount) : '';
  return <span aria-label={`${fullValue} XMR`} className="fixed-xmr-value"><span>{significantValue}</span>{trailingZeros && <span className="trailing-zeroes">{trailingZeros}</span>}<span> XMR</span></span>;
}
function parseXmrToAtomic(value: string) { const normalized = value.trim().replace(',', '.'); if (!/^(?:0|[1-9]\d*)(?:\.\d{1,12})?$/.test(normalized)) return null; const [whole, fraction = ''] = normalized.split('.'); return (BigInt(whole) * ATOMIC_XMR + BigInt(fraction.padEnd(12, '0'))).toString(); }
function atomicXmrNumber(value: string | undefined) { return Number(atomicValue(value)) / Number(ATOMIC_XMR); }
function formatUsd(value: number) { return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value); }
function formatSyncBlockCount(value: number | undefined, locale?: string) {
  return new Intl.NumberFormat(locale).format(Math.max(0, Math.floor(value ?? 0)));
}
function useDesktopSyncEta(sync: ReturnType<typeof presentWalletSync>, networkSync?: NetworkSyncStatus | null) {
  const sampleRef = useRef<WalletSyncEtaState | undefined>(undefined);
  const [etaSeconds, setEtaSeconds] = useState<number | undefined>();

  useEffect(() => {
    if (sync.phase !== 'syncing' || sync.remainingBlocks === undefined || sync.remainingBlocks <= 0 || sync.scannedBlocks === undefined) {
      sampleRef.current = undefined;
      setEtaSeconds(undefined);
      return;
    }

    const estimate = updateWalletSyncEta(
      sampleRef.current,
      sync.remainingBlocks,
      Date.now(),
      {
        active:
          !networkSync ||
          ['fetching-blocks', 'scanning-wallets', 'waiting-next-batch'].includes(networkSync.phase),
      },
    );
    sampleRef.current = estimate.state;
    setEtaSeconds(estimate.etaSeconds);
  }, [networkSync?.phase, sync.phase, sync.remainingBlocks, sync.scannedBlocks]);

  return etaSeconds;
}
function formatDesktopSyncEta(seconds: number | undefined, t: ReturnType<typeof useI18n>['t']) {
  if (!seconds) return t('home.syncEtaCalculating');
  if (seconds < 60) return t('home.syncEtaSeconds', { count: seconds });
  if (seconds < 3_600) return t('home.syncEtaMinutes', { count: Math.ceil(seconds / 60) });
  return t('home.syncEtaHours', { count: Math.ceil(seconds / 3_600) });
}
function shortHash(value: string) { return value.length > 20 ? `${value.slice(0, 10)}…${value.slice(-8)}` : value; }
function transactionTimestamp(value: string) { const timestamp = Number(value); return Number.isFinite(timestamp) && timestamp > 0 ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(timestamp * 1000)) : 'Time not available'; }
function approximateAreaForCoordinates(latitude: number, longitude: number) { const alphabet = '0123456789bcdefghjkmnpqrstuvwxyz'; let latitudeRange: [number, number] = [-90, 90]; let longitudeRange: [number, number] = [-180, 180]; let bits = 0; let value = 0; let useLongitude = true; let result = ''; while (result.length < 5) { const range = useLongitude ? longitudeRange : latitudeRange; const coordinate = useLongitude ? longitude : latitude; const midpoint = (range[0] + range[1]) / 2; value = value * 2 + (coordinate >= midpoint ? 1 : 0); if (coordinate >= midpoint) range[0] = midpoint; else range[1] = midpoint; useLongitude = !useLongitude; bits += 1; if (bits === 5) { result += alphabet[value]; bits = 0; value = 0; } } return result; }
function communityTimestamp(value: number) { return Number.isFinite(value) && value > 0 ? new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value)) : 'Time not available'; }

export default function App() {
  const { t } = useI18n();
  const [section, setSection] = useState<Section>('home');
  const [addressManagementRequest, setAddressManagementRequest] = useState<{ walletId: string; nonce: number } | null>(null);
  const [activeWalletId, setActiveWalletId] = useState<string | null>(null);
  const [activeWallet, setActiveWallet] = useState<RegisteredWallet | null>(null);
  const [wallets, setWallets] = useState<RegisteredWallet[]>([]);
  // Fast Wallets have a deliberately separate secure registry, but the user
  // must see one coherent wallet list. Keep the registry data at the app
  // level so the Wallets page never has to guess whether its empty state is
  // really empty.
  const [fastWallets, setFastWallets] = useState<FastWalletRecord[]>([]);
  const managedWallets = useMemo(() => {
    const registeredIds = new Set(wallets.map(wallet => wallet.id));
    return [
      // A Ledger read-only registration is the encrypted local read side of
      // its parent Ledger, not another user wallet. React Native embeds the
      // same data on one registration; keep the desktop UI equally simple.
      ...wallets.filter(wallet => wallet.kind !== 'view-only'),
      ...fastWallets
        .filter(wallet => !registeredIds.has(wallet.id))
        .map(fastWalletAsRegistration),
    ];
  }, [fastWallets, wallets]);
  const [seedRevealRequest, setSeedRevealRequest] = useState<SeedRevealRequest | null>(null);
  const [recoverySeedScreen, setRecoverySeedScreen] = useState<RecoverySeedScreen | null>(null);
  const [fastWalletTransferStatus, setFastWalletTransferStatus] =
    useState<FastWalletTransferStatus>('idle');
  const [seedAuthorizationPassword, setSeedAuthorizationPassword] = useState('');
  const [seedRevealBusy, setSeedRevealBusy] = useState(false);
  const seedRevealInFlightRef = useRef(false);
  const walletSwitchGenerationRef = useRef(0);
  const walletRecoveryInFlightRef = useRef(new Map<string, Promise<WalletSessionRecoveryResponse>>());
  const fastWalletTransferTimerRef = useRef<number | null>(null);
  // A Fast Wallet is independent from the normal wallet and therefore gets a
  // separate recovery seed.  Keep the optional follow-up only in memory until
  // the normal wallet's words have been explicitly confirmed.
  const pendingFastWalletSourceRef = useRef<WalletOperationResponse | null>(null);
  const [status, setStatus] = useState<WalletCoreStatus | null>(null);
  const [networkSync, setNetworkSync] = useState<NetworkSyncStatus | null>(null);
  const [appProtection, setAppProtection] = useState<AppProtectionStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [appProtectionRetrying, setAppProtectionRetrying] = useState(false);
  const [autoLockSeconds, setAutoLockSeconds] = useState(1800);
  const primaryNavigation = useMemo(() => primarySections(t), [t]);
  const secondaryNavigation = useMemo(() => secondarySections(t), [t]);
  const active = useMemo(() => [...primaryNavigation, ...secondaryNavigation].find((item) => item.id === section), [primaryNavigation, secondaryNavigation, section]);

  useEffect(() => DesktopAppUpdateService.initialize(), []);

  const reloadFastWallets = useCallback(async () => {
    try {
      setFastWallets(await invoke<FastWalletRecord[]>('list_fast_wallets'));
    } catch (reason) {
      console.warn('MONERO_DESKTOP_FAST_WALLET_LIST_FAILED', reason);
      setFastWallets([]);
    }
  }, []);

  useEffect(() => {
    if (!appProtection?.configured || appProtection.locked) {
      setFastWallets([]);
      return;
    }
    void reloadFastWallets();
  }, [appProtection?.configured, appProtection?.locked, reloadFastWallets]);

  useEffect(() => () => {
    if (fastWalletTransferTimerRef.current !== null) {
      window.clearTimeout(fastWalletTransferTimerRef.current);
    }
  }, []);

  useEffect(() => {
    if (!activeWallet || appProtection?.locked !== false) {
      setNetworkSync(null);
      return;
    }
    let cancelled = false;
    const poll = () => {
      void invoke<string>('network_sync_status', { networkName: activeWallet.network })
        .then((raw) => {
          if (!cancelled) setNetworkSync(parseNativeJson<NetworkSyncStatus>(raw, 'Invalid network sync status.'));
        })
        .catch((reason) => {
          if (!cancelled && !isBackgroundWalletWork(reason)) {
            console.warn('MONERO_DESKTOP_NETWORK_SYNC_STATUS_FAILED', reason);
          }
        });
    };
    poll();
    const timer = window.setInterval(poll, 750);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [activeWallet, appProtection?.locked]);

  useEffect(() => {
    void invoke<AutoLockSettings>('auto_lock_settings')
      .then((settings) => setAutoLockSeconds(settings.autoLockSeconds))
      .catch((reason) => console.error('MONERO_DESKTOP_AUTO_LOCK settings-load-failed', reason));
  }, []);

  useEffect(() => {
    let lastReportedAt = 0;
    const reportUserActivity = () => {
      const currentTime = Date.now();
      if (currentTime - lastReportedAt < 5_000) return;
      lastReportedAt = currentTime;
      void invoke<void>('record_app_user_activity').catch((reason) =>
        console.error('MONERO_DESKTOP_AUTO_LOCK activity-report-failed', reason),
      );
    };
    const activityEvents: Array<keyof WindowEventMap> = ['pointerdown', 'keydown', 'wheel', 'touchstart'];
    activityEvents.forEach((event) => window.addEventListener(event, reportUserActivity, { passive: true }));
    return () => activityEvents.forEach((event) => window.removeEventListener(event, reportUserActivity));
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<boolean>('app-lock-state-changed', (event) => {
      if (!event.payload) return;
      console.info('MONERO_DESKTOP_AUTO_LOCK locked-after-inactivity');
      setActiveWalletId(null);
      setActiveWallet(null);
      setSeedRevealRequest(null);
      setSection('home');
      setAppProtection((current) => current ? { ...current, configured: true, locked: true } : current);
    }).then((dispose) => { unlisten = dispose; });
    return () => unlisten?.();
  }, []);

  const reloadWallets = useCallback(async () => {
    const started = performance.now();
    recordWalletUiDiagnostic('wallet-list-reload-started');
    try {
      const refreshed = await invoke<RegisteredWallet[]>('list_registered_wallets');
      setWallets(refreshed);
      setActiveWallet(current =>
        current ? refreshed.find(wallet => wallet.id === current.id) ?? current : current,
      );
      recordWalletUiDiagnostic('wallet-list-reload-completed', started);
    }
    catch (reason) {
      recordWalletUiDiagnostic('wallet-list-reload-failed', started);
      setError(errorMessage(reason, 'The local wallet list could not be loaded.'));
    }
  }, []);

  const loadAppProtection = useCallback(async (explicitRetry = false) => {
    setAppProtectionRetrying(explicitRetry);
    if (explicitRetry) {
      console.info('MONERO_DESKTOP_APP_PROTECTION status-retry-requested');
      setError(null);
    }
    try {
      const value = await invoke<AppProtectionStatus>(
        explicitRetry ? 'retry_app_protection_status' : 'app_protection_status',
      );
      setAppProtection(value);
      setError(null);
      if (!value.locked) void reloadWallets();
    } catch (reason) {
      const message = errorMessage(
        reason,
        'App protection could not read secure storage.',
      );
      console.error(
        explicitRetry
          ? 'MONERO_DESKTOP_APP_PROTECTION status-retry-failed'
          : 'MONERO_DESKTOP_APP_PROTECTION status-load-failed',
        message,
      );
      setError(message);
    } finally {
      setAppProtectionRetrying(false);
    }
  }, [reloadWallets]);

  useEffect(() => {
    invoke<WalletCoreStatus>('wallet_core_status').then(setStatus).catch(() => setError('The desktop host could not verify the native wallet core.'));
    void loadAppProtection();
  }, [loadAppProtection]);

  const activateWallet = useCallback(async (result: WalletOperationResponse) => {
    const started = performance.now();
    setActiveWalletId(result.walletId); setActiveWallet(result.wallet); setSeedRevealRequest(null); setError(null); setSection('home');
    requestAnimationFrame(() => recordWalletUiDiagnostic('wallet-switch-ui-rendered', started));
    void reloadWallets();
    recordWalletUiDiagnostic('wallet-switch-completed', started);
  }, [reloadWallets]);
  const recoverWalletSession = useCallback(async (wallet: RegisteredWallet) => {
    const existing = walletRecoveryInFlightRef.current.get(wallet.id);
    if (existing) return existing;
    const switchGeneration = walletSwitchGenerationRef.current;
    const recovery = invoke<WalletSessionRecoveryResponse>('recover_registered_wallet_session', {
      input: { registrationId: wallet.id },
    }).then((result) => {
      if (switchGeneration === walletSwitchGenerationRef.current) {
        setActiveWalletId(result.walletId);
        setActiveWallet(result.wallet);
        setError(null);
      }
      return result;
    }).finally(() => {
      walletRecoveryInFlightRef.current.delete(wallet.id);
    });
    walletRecoveryInFlightRef.current.set(wallet.id, recovery);
    return recovery;
  }, []);
  useEffect(() => {
    if (!activeWallet || !activeWalletId || appProtection?.locked !== false || section === 'home') return;
    let cancelled = false;
    const validate = async () => {
      try {
        await invoke<string>('wallet_snapshot', {
          input: { walletId: activeWalletId, accountIndex: activeWallet.accountIndex ?? 0 },
        });
      } catch (reason) {
        if (!cancelled && isSessionStale(reason)) {
          await recoverWalletSession(activeWallet).catch(() => undefined);
        }
      }
    };
    // Home already brackets snapshot/history reads. Other screens still need
    // one cheap selected-session watchdog so Activity, Send, Receive and
    // Settings cannot retain a natively closed handle indefinitely.
    void validate();
    const timer = window.setInterval(() => void validate(), 5_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [activeWallet, activeWalletId, appProtection?.locked, recoverWalletSession, section]);
  // The native background lock runs independently while the window is hidden.
  // Never leave a stale renderer state to turn a wallet click into a dead-end
  // banner: a direct wallet action refreshes the authoritative native state and,
  // for the selected system method, opens the one Touch ID prompt itself.
  const unlockForWalletAction = useCallback(async (): Promise<boolean> => {
    try {
      const current = await invoke<AppProtectionStatus>('app_protection_status');
      setAppProtection(current);
      if (!current.configured || !current.mode) return false;
      if (!current.locked) return true;
      if (current.mode !== 'system') return false;
      const unlocked = await invoke<AppProtectionStatus>('verify_system_auth');
      setAppProtection(unlocked);
      setError(null);
      await reloadWallets();
      return !unlocked.locked;
    } catch (reason) {
      setError(errorMessage(reason, 'The app could not be unlocked with system authentication.'));
      return false;
    }
  }, [reloadWallets]);
  const activateOpenWallet = async (wallet: RegisteredWallet, retriedAfterUnlock = false) => {
    const started = performance.now();
    recordWalletUiDiagnostic('wallet-switch-activate-started');
    try {
      const result = await invoke<WalletOperationResponse>('activate_registered_wallet', { walletId: wallet.id });
      recordWalletUiDiagnostic('wallet-switch-activate-completed', started);
      await activateWallet(result);
      void invoke<void>('queue_registered_wallet_sync', { walletId: wallet.id });
    }
    catch (reason) {
      recordWalletUiDiagnostic('wallet-switch-failed', started);
      if (isSessionStale(reason)) {
        try {
          const recovered = await recoverWalletSession(wallet);
          await activateWallet(recovered);
          return;
        } catch (recoveryReason) {
          setError(errorMessage(recoveryReason, 'The wallet session could not be restored.'));
          return;
        }
      }
      const message = errorMessage(reason, 'The wallet could not be made active.');
      if (!retriedAfterUnlock && message === 'Unlock Monero Fast Wallet before opening wallets.' && await unlockForWalletAction()) {
        await activateOpenWallet(wallet, true);
        return;
      }
      setError(message);
    }
  };
  const startSetup = () => {
    void (async () => {
      if (!await unlockForWalletAction()) return;
      setSection('setup');
    })();
  };
  const openSavedWallet = (wallet: RegisteredWallet, destination: Section = 'home') => {
    const generation = ++walletSwitchGenerationRef.current;
    const resolvedDestination = wallet.kind === 'fast' ? 'receive' : destination;
    // Selection is a renderer-only transition first. Native Core opening and
    // synchronization finish behind that view and stale results are discarded
    // with the generation guard below.
    if (wallet.kind !== 'hardware') {
      setActiveWallet(wallet);
      setActiveWalletId(null);
      setError(null);
      setSection(resolvedDestination);
      requestAnimationFrame(() => recordWalletUiDiagnostic('wallet-switch-ui-rendered'));
    }
    void (async () => {
      recordWalletUiDiagnostic('wallet-switch-selected');
      if (!await unlockForWalletAction()) return;
      if (wallet.kind === 'fast') {
        const started = performance.now();
        recordWalletUiDiagnostic('wallet-switch-core-open-started');
        try {
          const opened = await invoke<FastWalletOpenResponse>('open_fast_wallet', {
            input: { identityId: wallet.id },
          });
          recordWalletUiDiagnostic('wallet-switch-core-open-completed', started);
          if (generation !== walletSwitchGenerationRef.current) return;
          setActiveWalletId(opened.walletId);
          setActiveWallet(fastWalletAsRegistration(opened.wallet));
          setError(null);
          setSection('receive');
          void reloadFastWallets();
          recordWalletUiDiagnostic('wallet-switch-completed', started);
        } catch (reason) {
          recordWalletUiDiagnostic('wallet-switch-core-open-failed', started);
          if (generation === walletSwitchGenerationRef.current) {
            setError(errorMessage(reason, 'The Fast Wallet could not be opened.'));
          }
        }
        return;
      }
      const currentWallets = await invoke<RegisteredWallet[]>('list_registered_wallets');
      const selected = currentWallets.find(candidate => candidate.id === wallet.id) ?? wallet;
      if (selected.isOpen) {
        if (generation === walletSwitchGenerationRef.current) await activateOpenWallet(selected);
        return;
      }
      // Show the selected wallet immediately. There is no second "Open wallet"
      // screen and no extra click: the app-wide unlock already authorized this
      // action.
      setActiveWallet(selected);
      setActiveWalletId(null);
      setError(null);
      setSection(resolvedDestination);
      const started = performance.now();
      recordWalletUiDiagnostic('wallet-switch-core-open-started');
      try {
        const result = await invoke<WalletOperationResponse>('open_wallet', {
          input: {
            walletName: selected.walletName,
            password: '',
            network: selected.network,
            restoreHeight: selected.restoreHeight,
            deferSync: true,
          },
        });
        recordWalletUiDiagnostic('wallet-switch-core-open-completed', started);
        if (generation === walletSwitchGenerationRef.current) {
          await activateWallet(result);
        }

        if (generation === walletSwitchGenerationRef.current) {
          void invoke<void>('queue_registered_wallet_sync', { walletId: selected.id });
          void reloadWallets();
        }
      } catch (reason) {
        recordWalletUiDiagnostic('wallet-switch-core-open-failed', started);
        if (generation === walletSwitchGenerationRef.current) {
          setError(errorMessage(reason, 'The wallet could not be opened.'));
        }
      }
    })();
  };
  const createFastWalletAfterBackup = useCallback(async (source: WalletOperationResponse) => {
    if (source.wallet.kind !== 'software') return;
    try {
      const created = await invoke<FastWalletRecord>('create_fast_wallet', {
        input: {
          sourceWalletId: source.walletId,
          sourceRegistrationId: source.wallet.id,
          label: 'Fast Wallet',
          password: '',
          restoreHeight: source.wallet.restoreHeight,
        },
      });
      const opened = await invoke<FastWalletOpenResponse>('open_fast_wallet', {
        input: { identityId: created.id },
      });
      await reloadFastWallets();
      const seed = await invoke<string>('present_fast_wallet_recovery_seed', {
        input: {
          walletId: opened.walletId,
          registrationId: created.id,
          appPassword: '',
        },
      });
      setRecoverySeedScreen({ kind: 'fast', nativeWalletId: opened.walletId, registrationId: created.id, label: created.label, seed });
      // Show the dedicated Fast Wallet card straight away; the in-app backup
      // page stays in front until the words have been saved.
      setSection('receive');
    } catch (reason) {
      setError(errorMessage(reason, 'The optional Fast Wallet could not be created. Your normal wallet is ready and safe.'));
    }
  }, [reloadFastWallets]);
  const presentRecoverySeedRequest = async (request: SeedRevealRequest, appPassword = ''): Promise<boolean> => {
    if (!appProtection?.mode || (appProtection.mode === 'password' && !appPassword) || seedRevealInFlightRef.current) return false;
    seedRevealInFlightRef.current = true;
    setSeedRevealBusy(true);
    try {
      const seed = await invoke<string>('present_recovery_seed', {
        input: {
          walletId: request.nativeWalletId,
          registrationId: request.wallet.id,
          appPassword,
        },
      });
      setSeedAuthorizationPassword('');
      setSeedRevealRequest(null);
      setRecoverySeedScreen({ kind: 'standard', nativeWalletId: request.nativeWalletId, registrationId: request.wallet.id, label: walletDisplayName(request.wallet), seed });
      return true;
    } catch (reason) {
      pendingFastWalletSourceRef.current = null;
      setSeedAuthorizationPassword('');
      setError(errorMessage(reason, 'The trusted recovery-seed view could not be opened.'));
      return false;
    } finally {
      seedRevealInFlightRef.current = false;
      setSeedRevealBusy(false);
    }
  };
  const requestRecoverySeed = async (request: SeedRevealRequest): Promise<boolean> => {
    setSeedAuthorizationPassword('');
    // Match React Native: on macOS and Windows the user's click goes straight
    // to the native Touch ID / Windows Hello prompt. A renderer password modal
    // is only valid when password protection was actually selected. Linux may
    // retain the small chooser because its system-auth path can expose an
    // explicit recovery-password fallback.
    if (appProtection?.mode === 'system') {
      return presentRecoverySeedRequest(request);
    }
    setSeedRevealRequest(request);
    return false;
  };
  const revealRecoverySeed = async (wallet = activeWallet, walletId = activeWalletId) => {
    if (!wallet || !walletId) return;
    requestRecoverySeed({ nativeWalletId: walletId, wallet });
  };
  const createdWallet = async (
    result: WalletOperationResponse,
    createFastWallet = false,
    requiresPrimarySeedBackup = true,
  ) => {
    await activateWallet(result);
    if (createFastWallet) {
      if (requiresPrimarySeedBackup) {
        pendingFastWalletSourceRef.current = result;
      } else {
        await createFastWalletAfterBackup(result);
      }
    }
    if (requiresPrimarySeedBackup) {
      await requestRecoverySeed({ nativeWalletId: result.walletId, wallet: result.wallet });
    }
  };
  const presentRecoverySeed = async () => {
    if (!seedRevealRequest) return;
    await presentRecoverySeedRequest(seedRevealRequest, seedAuthorizationPassword);
  };
  const completeRecoverySeedBackup = async () => {
    const screen = recoverySeedScreen;
    if (!screen || seedRevealBusy) return;
    setSeedRevealBusy(true);
    try {
      await invoke<void>(screen.kind === 'fast' ? 'confirm_fast_wallet_recovery_seed_backup' : 'confirm_recovery_seed_backup', {
        input: { walletId: screen.nativeWalletId, registrationId: screen.registrationId },
      });
      // Do not keep recovery words resident once the user has finished the
      // backup. Clearing this state also blanks the view before it unmounts.
      setRecoverySeedScreen(null);
      await Promise.all([reloadWallets(), reloadFastWallets()]);
      if (screen.kind === 'standard') {
        const pendingFastWalletSource = pendingFastWalletSourceRef.current;
        pendingFastWalletSourceRef.current = null;
        if (pendingFastWalletSource) await createFastWalletAfterBackup(pendingFastWalletSource);
      } else if (v1ReleaseFeatures.officialWorker) {
        try {
          setFastWalletTransferStatus('transferring');
          await invoke<FastWalletRecord>('enable_encrypted_fast_wallet_alerts', {
            input: {
              identityId: screen.registrationId,
              worker: 'official',
              appPassword: '',
            },
          });
          setFastWalletTransferStatus('accepted');
          fastWalletTransferTimerRef.current = window.setTimeout(() => {
            setFastWalletTransferStatus('idle');
            fastWalletTransferTimerRef.current = null;
          }, 1800);
        } catch (reason) {
          setFastWalletTransferStatus('failed');
          fastWalletTransferTimerRef.current = window.setTimeout(() => {
            setFastWalletTransferStatus('idle');
            fastWalletTransferTimerRef.current = null;
          }, 2600);
          setError(errorMessage(
            reason,
            'The Fast Wallet is safe on this device, but its encrypted payment-alert setup failed.',
          ));
          setSection('wallets');
        }
      }
    } catch (reason) {
      setError(errorMessage(reason, 'The recovery-word backup could not be confirmed.'));
    } finally {
      setSeedRevealBusy(false);
    }
  };
  const closeActiveWallet = useCallback(async () => {
    if (!activeWalletId) return;
    const walletToUnlock = activeWallet;
    try {
      if (activeWallet?.kind === 'fast') {
        await invoke<void>('close_fast_wallet', { input: { identityId: activeWallet.id } });
      } else {
        await invoke<void>('close_wallet', { input: { walletId: activeWalletId } });
      }
      setActiveWalletId(null); setActiveWallet(null); setSeedRevealRequest(null);
      await Promise.all([reloadWallets(), reloadFastWallets()]);
      // Closing only releases the native session. The wallet remains in the
      // normal list and the next click opens it directly without an
      // intermediate setup screen.
      setSection(walletToUnlock ? 'wallets' : 'home');
    } catch (reason) { setError(errorMessage(reason, 'The wallet could not be locked.')); }
  }, [activeWallet, activeWalletId, reloadFastWallets, reloadWallets]);
  const lockDesktopApp = useCallback(async () => {
    try {
      await invoke<void>('lock_app');
      setActiveWalletId(null); setActiveWallet(null); setSeedRevealRequest(null);
      setSection('home'); setAppProtection(current => current ? { ...current, configured: true, locked: true } : current);
      await reloadWallets();
    } catch (reason) { setError(errorMessage(reason, 'Monero Fast Wallet could not be locked.')); }
  }, [reloadWallets]);
  const setAppProtectionMode = useCallback(async (mode: AppProtectionMode, password = '', currentPassword = '') => {
    const result = await invoke<AppProtectionStatus>('set_app_protection_mode', { input: { mode, password, currentPassword } });
    setAppProtection(result);
    await invoke<void>('record_app_user_activity');
  }, []);
  const updateAutoLockTimeout = useCallback(async (value: number) => {
    const settings = await invoke<AutoLockSettings>('set_auto_lock_timeout', {
      input: { autoLockSeconds: value },
    });
    setAutoLockSeconds(settings.autoLockSeconds);
  }, []);
  const removeWallet = useCallback(async (wallet: RegisteredWallet) => {
    const removingActiveWallet = activeWallet?.id === wallet.id;
    try {
      if (wallet.kind === 'fast') {
        const record = fastWallets.find(item => item.id === wallet.id);
        if (!record) throw new Error('The Fast Wallet is no longer available on this device.');
        const metadataOnly = record.status === 'legacy-blocked' || record.seedBackupStatus === 'pending';
        if (!metadataOnly) {
          await invoke<FastWalletOpenResponse>('open_fast_wallet', { input: { identityId: wallet.id } });
        }
        await invoke<void>(metadataOnly ? 'remove_fast_wallet_entry' : 'remove_fast_wallet', {
          input: { identityId: wallet.id },
        });
      } else {
        await invoke<void>('remove_registered_wallet', { input: { walletId: wallet.id } });
      }
      removeDesktopWalletAddresses(wallet.id);
      if (removingActiveWallet) {
        setActiveWalletId(null);
        setActiveWallet(null);
        setSeedRevealRequest(null);
      }
      await Promise.all([reloadWallets(), reloadFastWallets()]);
    } catch (reason) {
      setError(errorMessage(reason, 'The wallet could not be removed from this app.'));
      throw reason;
    }
  }, [activeWallet?.id, fastWallets, reloadFastWallets, reloadWallets]);
  const linked = Boolean(status?.linked);
  const nodeConnected = networkSyncConnected(networkSync);
  const nodeFailed = networkSyncFailed(networkSync);
  const networkPresentation = presentNetworkSync(networkSync);
  const connectionText = !activeWallet
    ? linked ? t('shell.coreOnline') : status ? t('shell.coreRequired') : t('shell.coreChecking')
    : networkSync
      ? networkSyncPhaseLabel(networkSync, t)
      : nodeConnected
        ? t('shell.nodeLive')
        : nodeFailed
          ? t('shell.nodeRetrying')
          : t('home.syncConnecting');
  const connectionTitle = activeWallet
    ? `${networkLabel(activeWallet.network)} · ${networkSync?.state ?? 'idle'}`
    : statusLabel(status, t);
  const connectionTone =
    networkPresentation.ready || networkPresentation.connected || (!activeWallet && linked)
      ? 'ready'
      : !nodeFailed && (networkPresentation.busy || Boolean(activeWallet))
        ? 'connecting'
        : 'offline';

  if (!appProtection) return <main className="app-shell app-protection-loading">
    <section className="app-protection-card" role={error ? 'alert' : 'status'}>
      <img src="/monero-mark.png" alt="" />
      <p className="eyebrow">Monero Fast Wallet</p>
      <h1>{error ? 'Secure storage is unavailable' : t('protection.preparing')}</h1>
      <p>{error ?? t('protection.preparing')}</p>
      {error && <button className="primary" disabled={appProtectionRetrying} onClick={() => void loadAppProtection(true)} type="button">{appProtectionRetrying ? 'Retrying…' : 'Retry'}</button>}
    </section>
  </main>;
  if (!appProtection.configured) return <AppProtectionGate status={appProtection} onUnlocked={(value) => { setAppProtection(value); void invoke<void>('record_app_user_activity'); void reloadWallets(); }} />;
  if (appProtection.mode === null) return <main className="app-shell app-protection-loading">
    <section className="app-protection-card" role="alert">
      <img src="/monero-mark.png" alt="" />
      <p className="eyebrow">Monero Fast Wallet</p>
      <h1>App protection needs attention</h1>
      <p>The saved protection method is missing. For safety, no wallet or password prompt was opened.</p>
      <button className="primary" disabled={appProtectionRetrying} onClick={() => void loadAppProtection(true)} type="button">{appProtectionRetrying ? 'Retrying…' : 'Retry secure storage'}</button>
    </section>
  </main>;
  if (appProtection.locked) return <AppProtectionGate status={appProtection} onUnlocked={(value) => { setAppProtection(value); void invoke<void>('record_app_user_activity'); void reloadWallets(); }} />;
  const activeProtectionMode = appProtection.mode;
  return <main className="app-shell">
    <aside className="sidebar" aria-label="Main navigation">
      <div className="brand"><img className="brand-mark" src="/monero-mark.png" alt="" /><div><strong>Monero<span>Fast Wallet</span></strong><small>{t('shell.desktop')}</small></div></div>
      <nav>{primaryNavigation.map((item) => <NavItem item={item} active={primaryNavigationSection(section)} onSelect={setSection} key={item.id} />)}</nav>
      {secondaryNavigation.length > 0 && <><div className="sidebar-divider" /><nav>{secondaryNavigation.map((item) => <NavItem item={item} active={section} onSelect={setSection} key={item.id} />)}</nav></>}
      <p className="sidebar-note">Developed with <span aria-label="love">❤️</span> by <a href="https://solutions.tex8.com/en" target="_blank" rel="noreferrer">TEX8</a></p>
    </aside>
    <section className="content">
      {section !== 'setup' && section !== 'onboarding' && <header className="topbar"><div><p className="eyebrow">{active?.label ?? t('common.wallet')}</p><h1>{section === 'home' ? t('shell.homeTitle') : active?.label}</h1></div><div className="topbar-actions"><DesktopWalletSwitcher wallets={managedWallets} activeWallet={activeWallet} onSelect={openSavedWallet} onManage={() => setSection('wallets')} /><div className="topbar-connection" title={connectionTitle}><div aria-label={connectionText} className={`core-status ${connectionTone}`}><span /></div></div></div></header>}
      {!linked && <section className="notice" role="status"><div className="notice-icon"><img src="/monero-mark.png" alt="" /></div><div><h2>{t('shell.noticeEngineTitle')}</h2><p>{error ?? status?.message ?? t('shell.noticeEngineVerifying')}</p></div></section>}
      {linked && error && <section className="notice compact-notice" role="alert"><div><h2>{t('shell.noticeActionNeeded')}</h2><p>{error}</p></div></section>}
      {section === 'home' && <Home linked={linked} walletId={activeWalletId} wallet={activeWallet} savedWallets={managedWallets} networkSync={networkSync} onSetup={startSetup} onWallets={() => setSection('wallets')} onSelectWallet={openSavedWallet} onBackup={() => void revealRecoverySeed()} onLock={() => void closeActiveWallet()} onSend={() => setSection('send')} onReceive={() => setSection('receive')} onActivity={() => setSection('activity')} onWalletsChanged={reloadWallets} onRecoverSession={recoverWalletSession} />}
      {section === 'wallets' && <Wallets linked={linked} walletId={activeWalletId} wallets={managedWallets} activeWallet={activeWallet} onSetup={startSetup} onOpen={openSavedWallet} onManageAddresses={(wallet) => { setAddressManagementRequest({ walletId: wallet.id, nonce: Date.now() }); openSavedWallet(wallet, 'receive'); }} onRenamed={() => void reloadWallets()} onRemove={removeWallet} onActivity={() => setSection('activity')} />}
      {section === 'setup' && <Setup linked={linked} wallets={wallets} onSelectSaved={openSavedWallet} onOpened={(result) => void activateWallet(result)} onCreated={(result, createFastWallet, requiresPrimarySeedBackup) => void createdWallet(result, createFastWallet, requiresPrimarySeedBackup)} />}
      {section === 'send' && <Send linked={linked} walletId={activeWalletId} wallet={activeWallet} appProtection={appProtection} onWalletsChanged={reloadWallets} />}
      {section === 'receive' && <><Receive linked={linked} walletId={activeWalletId} wallet={activeWallet} wallets={managedWallets} manageAddressesRequest={addressManagementRequest} onSelectWallet={(wallet) => openSavedWallet(wallet, 'receive')} onSetup={startSetup} onActivity={() => setSection('activity')} /><FastWalletReceive appProtection={appProtection} /></>}
      {section === 'activity' && <Activity linked={linked} walletId={activeWalletId} wallet={activeWallet} />}
      {section === 'mfw' && <MfwNames linked={linked} walletId={activeWalletId} wallet={activeWallet} appProtection={appProtection} />}
      {section === 'community' && v1ReleaseFeatures.legacyCommunity && <Community />}
      {section === 'enthusiast' && <MoneroEnthusiastV1 />}
      {section === 'assistant' && <Assistant wallet={activeWallet} walletId={activeWalletId} onNavigate={setSection} />}
      {section === 'settings' && <LeanSettings status={status} walletId={activeWalletId} wallet={activeWallet} onRevealSeed={() => void revealRecoverySeed()} onCloseWallet={() => void closeActiveWallet()} onWalletsChanged={reloadWallets} autoLockSeconds={autoLockSeconds} onSetAutoLockSeconds={updateAutoLockTimeout} appProtection={appProtection} onSetAppProtectionMode={setAppProtectionMode} onLockApp={lockDesktopApp} />}
      {section === 'menu' && <DesktopMenu wallet={activeWallet} walletId={activeWalletId} onNavigate={setSection} />}
      {seedRevealRequest && <SensitiveAuthorizationOverlay title="Show recovery words" description={activeProtectionMode === 'system' ? `Confirm with ${appProtection.systemAuth.label}, then your recovery words will open here in Monero Fast Wallet.` : 'Enter your app password, then your recovery words will open here in Monero Fast Wallet.'} password={seedAuthorizationPassword} mode={activeProtectionMode} systemLabel={appProtection.systemAuth.label} allowPasswordFallback={appProtection.passwordConfigured} busy={seedRevealBusy} onPasswordChange={setSeedAuthorizationPassword} onConfirm={() => void presentRecoverySeed()} onDismiss={() => { pendingFastWalletSourceRef.current = null; setSeedAuthorizationPassword(''); setSeedRevealRequest(null); }} />}
      {recoverySeedScreen && <RecoverySeedBackupScreen label={recoverySeedScreen.label} seed={recoverySeedScreen.seed} fastWallet={recoverySeedScreen.kind === 'fast'} busy={seedRevealBusy} onConfirm={() => void completeRecoverySeedBackup()} onDismiss={() => setRecoverySeedScreen(null)} />}
      {fastWalletTransferStatus !== 'idle' && <FastWalletTransferOverlay status={fastWalletTransferStatus} />}
    </section>
  </main>;
}

function NavItem({ item, active, onSelect }: { item: NavigationItem; active: Section; onSelect: (section: Section) => void }) { return <button className={item.id === active ? 'nav-item active' : 'nav-item'} onClick={() => onSelect(item.id)} type="button"><span><DesktopIcon name={item.icon} /></span>{item.label}</button>; }

function AppProtectionGate({ status, onUnlocked }: { status: AppProtectionStatus; onUnlocked: (status: AppProtectionStatus) => void }) {
  const { t } = useI18n();
  const setup = !status.configured;
  const [welcomeAcknowledged, setWelcomeAcknowledged] = useState(!setup);
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [mode, setMode] = useState<AppProtectionMode>(
    status.configured ? status.mode ?? 'password' : status.systemAuth.available ? 'system' : 'password',
  );
  const [useRecoveryPassword, setUseRecoveryPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const automaticSystemUnlockAttemptedRef = useRef(false);
  const unlock = async () => {
    const needsPassword = setup || mode === 'password' || useRecoveryPassword;
    if (!status.configured && needsPassword && password !== confirmation) {
      setError(t('protection.passwordMismatch'));
      return;
    }
    if (!status.configured && needsPassword) {
      try { validateRecoveryPassword(password); }
      catch { setError(t('protection.passwordMinimum')); return; }
    }
    setBusy(true); setError(null);
    try {
      const nextStatus = !status.configured
        ? await invoke<AppProtectionStatus>('set_app_protection_mode', { input: { mode, password } })
        : status.mode === 'system' && !useRecoveryPassword
          ? await invoke<AppProtectionStatus>('verify_system_auth')
          : await invoke<AppProtectionStatus>('verify_app_protection_password', { input: { password } });
      setPassword(''); setConfirmation(''); onUnlocked(nextStatus);
    } catch (reason) { setPassword(''); setConfirmation(''); setError(errorMessage(reason, 'The app could not be unlocked.')); }
    finally { setBusy(false); }
  };
  // Keep desktop behaviour aligned with React Native: returning to a locked
  // biometric app presents exactly one system-auth request. If it is cancelled,
  // the ordinary unlock button remains available; it never loops.
  useEffect(() => {
    if (setup || status.mode !== 'system' || automaticSystemUnlockAttemptedRef.current) return;
    automaticSystemUnlockAttemptedRef.current = true;
    queueMicrotask(() => { void unlock(); });
  }, [setup, status.mode]);
  const passwordForm = setup || mode === 'password' || (!setup && useRecoveryPassword);
  const presentation = deriveAppVaultPresentation({
    stateVersion: 1,
    ready: true,
    onboardingComplete: welcomeAcknowledged,
    configured: status.configured,
    protectionMode: status.configured ? status.mode : null,
    sessionAuthorized: status.configured && !status.locked,
    migrationState: 0,
    failedAttempts: 0,
    autoLockSeconds: 1800,
    blockedUntilUnixSeconds: 0,
    lastActivityMonotonicMs: 0,
  }, Math.floor(Date.now() / 1000));
  const primaryLabel = busy
    ? setup ? 'Protecting…' : 'Unlocking…'
    : setup
      ? mode === 'system' ? `Set up ${status.systemAuth.label}` : 'Use app password'
      : status.mode === 'system' && !useRecoveryPassword ? `${t('protection.unlock')} · ${status.systemAuth.label}` : t('protection.unlock');
  if (presentation === 'welcome') return <main className="app-protection-gate">
    <section className="app-protection-card" role="dialog" aria-modal="true" aria-labelledby="app-welcome-title">
      <img src="/monero-mark.png" alt="" />
      <p className="eyebrow">Monero Fast Wallet</p>
      <h1 id="app-welcome-title">{t('protection.welcomeTitle')}</h1>
      <p>{t('protection.welcomeBody')}</p>
      <button className="primary" onClick={() => setWelcomeAcknowledged(true)} type="button">{t('protection.getStarted')}</button>
      <small>{t('protection.welcomePrivacy')}</small>
    </section>
  </main>;
  return <main className="app-protection-gate">
    <section className="app-protection-card" role="dialog" aria-modal="true" aria-labelledby="app-protection-title">
      <img src="/monero-mark.png" alt="" />
      <p className="eyebrow">Monero Fast Wallet</p>
      <h1 id="app-protection-title">{setup ? t('protection.protectTitle') : t('protection.unlockTitle')}</h1>
      <p>{setup
        ? t('protection.choose')
        : status.mode === 'system' ? t('protection.unlockSystem', { system: status.systemAuth.label }) : t('protection.unlockPassword')}
      </p>
      {setup && <div className="protection-mode-choices" role="radiogroup" aria-label="App protection">
        <button className={mode === 'system' ? 'selected' : ''} disabled={!status.systemAuth.available || busy} onClick={() => { setMode('system'); setPassword(''); setConfirmation(''); setError(null); }} role="radio" aria-checked={mode === 'system'} type="button">
          <span>◎</span><strong>{status.systemAuth.label}</strong><small>{status.systemAuth.available ? `${t('protection.recommended')} · ${status.systemAuth.detail}` : status.systemAuth.detail}</small>
        </button>
        <button className={mode === 'password' ? 'selected' : ''} disabled={busy} onClick={() => { setMode('password'); setError(null); }} role="radio" aria-checked={mode === 'password'} type="button">
          <span>•••</span><strong>{t('protection.appPassword')}</strong><small>{t('protection.appPasswordHint')}</small>
        </button>
      </div>}
      <form onSubmit={(event) => { event.preventDefault(); void unlock(); }}>
        {passwordForm && <label>
          {mode === 'system' ? t('protection.recoveryPassword') : t('protection.appPassword')}
          <input autoFocus autoComplete={setup ? 'new-password' : 'current-password'} minLength={setup ? 12 : undefined} onChange={(event) => setPassword(event.target.value)} type="password" value={password} />
        </label>}
        {setup && passwordForm && <label>
          {t('protection.confirmPassword')}
          <input autoComplete="new-password" minLength={12} onChange={(event) => setConfirmation(event.target.value)} type="password" value={confirmation} />
        </label>}
        <button className="primary" disabled={busy || (passwordForm && (!password || (setup && !confirmation)))} type="submit">
          {primaryLabel}
        </button>
      </form>
      {!setup && status.mode === 'system' && status.passwordConfigured && <button className="quiet-button protection-fallback" disabled={busy} onClick={() => { setUseRecoveryPassword(value => !value); setPassword(''); setError(null); }} type="button">
        {useRecoveryPassword ? `Use ${status.systemAuth.label}` : 'Use recovery app password instead'}
      </button>}
      {error && <p className="setup-message">{error}</p>}
      <small>{t('protection.biometricPrivacy')}</small>
    </section>
  </main>;
}

function DesktopWalletSwitcher({ wallets, activeWallet, onSelect, onManage }: { wallets: RegisteredWallet[]; activeWallet: RegisteredWallet | null; onSelect: (wallet: RegisteredWallet) => void; onManage: () => void }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const selected = activeWallet ?? wallets.find((wallet) => wallet.isActive) ?? wallets[0] ?? null;
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, []);
  const manage = () => { setOpen(false); onManage(); };
  const selectWallet = (wallet: RegisteredWallet) => { setOpen(false); onSelect(wallet); };

  return <div className="desktop-wallet-switcher-wrap">
    <button className="desktop-wallet-switcher" aria-expanded={open} aria-haspopup="menu" onClick={() => wallets.length ? setOpen((value) => !value) : manage()} type="button">
      <img src="/monero-mark.png" alt="" />
      <span><strong>{selected ? walletDisplayName(selected) : t('home.addWallet')}</strong><small>{selected ? `${walletTypeLabel(selected, t)} · ${networkLabel(selected.network)}` : t('home.noWallets')}</small></span>
      <em aria-hidden="true">⌄</em>
    </button>
    {open && <div className="desktop-wallet-menu" role="menu" aria-label={t('wallets.saved')}>
      <header><strong>{t('wallets.saved')}</strong><button className="quiet-button" onClick={manage} type="button">{t('home.manageWallets')}</button></header>
      <div className="desktop-wallet-menu-list">{wallets.map((wallet) => {
        const isActive = wallet.id === activeWallet?.id;
        const action = isActive
          ? t('wallets.active')
          : wallet.isOpen
            ? t('wallets.use')
            : isFastWalletRegistration(wallet)
              ? 'Open Fast Wallet'
            : wallet.kind === 'hardware'
              ? t('wallets.connectLedger')
              : t('setup.open');
        return <button className={isActive ? 'desktop-wallet-menu-row active' : 'desktop-wallet-menu-row'} key={wallet.id} onClick={() => selectWallet(wallet)} role="menuitem" type="button">
          <span className="desktop-wallet-menu-mark"><img src="/monero-mark.png" alt="" /></span>
          <span className="desktop-wallet-menu-copy"><strong>{walletDisplayName(wallet)}{isFastWalletRegistration(wallet) && <b className="fast-wallet-badge">FAST</b>}</strong><small>{walletTypeLabel(wallet, t)} · {networkLabel(wallet.network)}</small></span>
          <em>{action}</em>
        </button>;
      })}</div>
      <button className="desktop-wallet-add" onClick={manage} type="button"><span>＋</span>{t('home.addWallet')}</button>
    </div>}
  </div>;
}

function DesktopMenu({ wallet, walletId, onNavigate }: { wallet: RegisteredWallet | null; walletId: string | null; onNavigate: (section: Section) => void }) {
  const { t } = useI18n();
  const [address, setAddress] = useState<string | null>(null);
  useEffect(() => {
    let mounted = true;
    if (!walletId) { setAddress(null); return () => { mounted = false; }; }
    void invoke<string>('wallet_address', { input: { walletId, accountIndex: wallet?.accountIndex ?? 0 } })
      .then((value) => { if (mounted) setAddress(value); })
      .catch(() => { if (mounted) setAddress(null); });
    return () => { mounted = false; };
  }, [wallet?.accountIndex, walletId]);
  const items: Array<{ section: Section; icon: DesktopIconName; title: string; hint: string }> = [
    { section: 'wallets', icon: 'wallet', title: t('menu.wallets'), hint: t('menu.walletsHint') },
    { section: 'mfw', icon: 'key', title: 'MFW Names', hint: 'Register and manage public .mfw recipient names' },
    { section: 'enthusiast', icon: 'community-menu', title: t('communityV1.title'), hint: t('communityV1.menuHint') },
    { section: 'settings', icon: 'settings', title: t('menu.settings'), hint: t('menu.settingsHint') },
    { section: 'assistant', icon: 'sparkles', title: t('menu.assistant'), hint: t('menu.assistantHint') },
    { section: 'settings', icon: 'globe', title: t('menu.node'), hint: t('menu.nodeHint') },
  ];
  const addressLabel = address ? `${address.slice(0, 6)}…${address.slice(-5)}` : wallet ? t('menu.openWallet') : t('menu.noWallet');
  return <section className="desktop-menu-page"><header className="desktop-menu-profile"><img src="/monero-mark.png" alt="" /><div><h2>{wallet ? walletDisplayName(wallet) : t('menu.title')}</h2><code>{addressLabel}</code></div></header><div className="desktop-menu-list">{items.map((item, index) => <button key={`${item.section}-${index}`} onClick={() => onNavigate(item.section)} type="button"><span className="desktop-menu-icon"><DesktopIcon name={item.icon} size={20} /></span><span><strong>{item.title}</strong><small>{item.hint}</small></span><em><DesktopIcon name="chevron-right" size={19} /></em></button>)}</div><a className="desktop-menu-footer" href="https://solutions.tex8.com/en" target="_blank" rel="noreferrer">Made with <span aria-label="love">❤️</span> by <strong>TEX8</strong></a></section>;
}

function marketChartTimestamp(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(timestamp));
}

function MarketChart({ points, positive, onRetry }: { points: MarketPoint[]; positive: boolean; onRetry: () => void }) {
  const { t } = useI18n();
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const geometry = useMemo(() => {
    if (points.length < 2) return null;
    const width = 960;
    const height = 248;
    const padding = 8;
    const prices = points.map((point) => point.price);
    const minimum = Math.min(...prices) * 0.998;
    const maximum = Math.max(...prices) * 1.002;
    const range = maximum - minimum || 1;
    const step = (width - padding * 2) / (points.length - 1);
    const yFor = (value: number) => padding + (height - padding * 2) - ((value - minimum) / range) * (height - padding * 2);
    let line = '';
    let area = '';
    points.forEach((point, index) => {
      const x = padding + index * step;
      const y = yFor(point.price);
      if (index === 0) {
        line = `M${x} ${y}`;
        area = `M${x} ${height}L${x} ${y}`;
        return;
      }
      const previousX = padding + (index - 1) * step;
      const previousY = yFor(points[index - 1].price);
      const curve = `C${previousX + step * 0.4} ${previousY} ${x - step * 0.4} ${y} ${x} ${y}`;
      line += curve;
      area += curve;
    });
    const finalX = padding + (points.length - 1) * step;
    return { area: `${area}L${finalX} ${height}Z`, line, x: finalX, y: yFor(points.at(-1)?.price ?? 0), yFor };
  }, [points]);

  if (!geometry) return <div className="market-chart-empty"><span>{t('home.chartUnavailable')}</span><button className="quiet-button" onClick={onRetry} type="button">{t('home.chartRetry')}</button></div>;
  const color = positive ? '#00d68f' : '#ff5c76';
  const activeIndex = Math.min(hoverIndex ?? points.length - 1, points.length - 1);
  const activePoint = points[activeIndex];
  const activeX = 8 + ((960 - 16) * activeIndex) / (points.length - 1);
  const activeY = geometry.yFor(activePoint.price);
  const tooltipPosition = Math.min(92, Math.max(8, (activeX / 960) * 100));
  const selectPoint = (clientX: number, bounds: DOMRect) => setHoverIndex(Math.min(points.length - 1, Math.max(0, Math.round(((clientX - bounds.left) / bounds.width) * (points.length - 1)))));
  return <div className="market-chart-interactive"><svg className="market-chart" viewBox="0 0 960 248" preserveAspectRatio="none" role="img" aria-label={t('home.chartAria')}><defs><linearGradient id="market-chart-area" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={color} stopOpacity="0.24" /><stop offset="1" stopColor={color} stopOpacity="0" /></linearGradient></defs><path d={geometry.area} fill="url(#market-chart-area)" /><path d={geometry.line} fill="none" stroke={color} strokeWidth="3" vectorEffect="non-scaling-stroke" /><rect x="0" y="0" width="960" height="248" fill="transparent" onPointerMove={(event) => selectPoint(event.clientX, event.currentTarget.getBoundingClientRect())} onPointerLeave={() => setHoverIndex(null)} />{hoverIndex !== null && <><line x1={activeX} x2={activeX} y1="0" y2="248" stroke="#d7d0e4" strokeOpacity="0.38" strokeWidth="1" vectorEffect="non-scaling-stroke" /><circle cx={activeX} cy={activeY} r="5.5" fill="#171322" stroke={color} strokeWidth="3" vectorEffect="non-scaling-stroke" /></>}<circle cx={geometry.x} cy={geometry.y} r="5" fill={color} /></svg>{hoverIndex !== null && <div className="market-chart-tooltip" style={{ left: `${tooltipPosition}%` }} role="status"><strong>{formatUsd(activePoint.price)}</strong><span>{marketChartTimestamp(activePoint.timestamp)}</span></div>}</div>;
}

function useAggregateNetworkRate(status: NetworkSyncStatus | null) {
  const samplesRef = useRef<
    NonNullable<ReturnType<typeof networkSyncByteSample>>[]
  >([]);
  const [rate, setRate] = useState<number | undefined>();

  useEffect(() => {
    const sample = networkSyncByteSample(status, Date.now());
    if (!sample) return;
    const prior = samplesRef.current.at(-1);
    if (
      prior &&
      (prior.source !== sample.source || prior.totalBytes > sample.totalBytes)
    ) {
      samplesRef.current = [];
    }
    samplesRef.current.push(sample);
    const cutoff = sample.observedAt - 3_000;
    while (
      samplesRef.current.length > 2 &&
      samplesRef.current[1].observedAt <= cutoff
    ) {
      samplesRef.current.shift();
    }
    const aggregate = networkSyncWindowMegabitsPerSecond(
      samplesRef.current[0],
      sample,
    );
    if (aggregate !== undefined) setRate(aggregate);
  }, [status]);

  return rate ?? networkSyncMegabitsPerSecond(status);
}

function DesktopSyncProgress({ locale, network, networkStatus, onRefresh, readinessPhase, sync, syncEtaSeconds, t, walletName, walletOpened, walletReady }: { locale: string; network: ReturnType<typeof presentNetworkSync>; networkStatus: NetworkSyncStatus | null; onRefresh: () => void; readinessPhase?: WalletPublication<NativeWalletSnapshot, NativeTransaction>['phase']; sync: ReturnType<typeof presentWalletSync>; syncEtaSeconds: number | undefined; t: ReturnType<typeof useI18n>['t']; walletName: string; walletOpened: boolean; walletReady: boolean }) {
  // A selected wallet can already have a cache at the chain tip while the
  // process-wide downloader is filling an older shared range for another
  // wallet. Wallet synchronization therefore cannot promote blockchain data
  // to 100%; only the authoritative shared-download cursors may do that.
  const blockchainPercent = network.ready ? 100 : network.progress ?? 0;
  const blockchainCurrent = network.downloadedHeight && network.downloadedHeight > 0 ? network.downloadedHeight : network.chainHeight;
  const blockchainDetail = blockchainPercent === 100 ? t('home.syncComplete') : networkSyncPhaseLabel(networkStatus, t);
  const networkRate = useAggregateNetworkRate(networkStatus);
  const walletDerivationRate = walletSyncDerivationsPerSecond(networkStatus);
  const walletPercent = sync.coreConfirmed ? 100 : sync.phase === 'finalizing' ? 99 : sync.progress ?? 0;
  const connected = network.ready || network.connected;
  const connecting = !connected && !network.failed;
  const connectionPhaseActive =
    network.phase === 'selecting-provider' ||
    network.phase === 'initializing-transport';
  const connectionElapsedSeconds = Math.max(
    0,
    Math.floor((networkStatus?.phaseElapsedMs ?? 0) / 1_000),
  );
  const connectionDetail = connectionPhaseActive
    ? t('home.syncStartingConnectionElapsed', {
        seconds: connectionElapsedSeconds,
      })
    : undefined;
  const showWalletSync = connected && walletOpened;
  const fullySynced = showWalletSync && network.ready && sync.coreConfirmed && walletReady && !network.failed;
  const [expanded, setExpanded] = useState(() => !fullySynced);
  const previousSyncState = useRef({ fullySynced, walletName });
  const compactStatus = network.failed
    ? t('home.syncRetrying')
    : fullySynced
      ? t('home.syncComplete')
      : readinessPhase === 'recovering-session'
        ? t('home.sessionRecovering')
        : readinessPhase === 'recoverable-error'
          ? t('home.sessionRecoveryFailed')
        : readinessPhase === 'scanning-spend-outputs'
          ? t('home.spendOutputsChecking')
      : !network.ready
        ? blockchainDetail
        : sync.phase === 'finalizing'
          ? t('home.syncVerifying')
          : t('home.syncScanning');

  useEffect(() => {
    const previous = previousSyncState.current;
    if (previous.walletName !== walletName) {
      setExpanded(!fullySynced);
    } else if (!previous.fullySynced && fullySynced) {
      // Collapse once after completion. Routine tip checks keep the owner's
      // chosen panel state and therefore cannot make the dashboard jump.
      setExpanded(false);
    }
    previousSyncState.current = { fullySynced, walletName };
  }, [fullySynced, walletName]);

  return <section className={`desktop-sync-status-card ${expanded ? 'expanded' : 'collapsed'}`} data-testid="sync-status-popup">
    <header className="desktop-sync-status-head">
      <strong>{walletName}</strong>
      <button
        aria-expanded={expanded}
        aria-label={expanded ? t('home.syncHideDetails') : t('home.syncShowDetails')}
        className="desktop-sync-status-toggle"
        data-testid="sync-status-toggle"
        onClick={() => setExpanded(current => !current)}
        type="button"
      >
        <small className={fullySynced ? 'ready' : network.failed ? 'failed' : ''}>{compactStatus}</small>
        <span aria-hidden="true" className={`sync-led ${connected ? 'ready' : network.failed ? 'failed' : connecting ? 'connecting' : ''}`} />
        <span aria-hidden="true" className="sync-toggle-chevron">{expanded ? '−' : '+'}</span>
      </button>
    </header>
    {expanded && <div className="primary-wallet-sync" data-testid="sync-status-details">
        <DesktopSyncProgressRow detail={blockchainDetail} extra={connectionDetail} height={network.targetHeight !== undefined ? t('home.syncHeight', { current: formatSyncBlockCount(blockchainCurrent, locale), target: formatSyncBlockCount(network.targetHeight, locale) }) : undefined} label={t('home.blockchainData')} percent={blockchainPercent} rate={networkRate === undefined ? undefined : t('home.syncNetworkRate', { rate: formatNetworkSyncRate(networkRate, locale) })} testId="blockchain-progress" />
        {showWalletSync && <DesktopSyncProgressRow detail={readinessPhase === 'recovering-session' ? t('home.sessionRecovering') : readinessPhase === 'recoverable-error' ? t('home.sessionRecoveryFailed') : readinessPhase === 'scanning-spend-outputs' ? t('home.spendOutputsChecking') : sync.phase === 'synchronized' ? t('home.syncComplete') : sync.phase === 'finalizing' ? t('home.syncVerifying') : sync.phase === 'waiting-for-node' ? t('home.syncUpdating') : t('home.syncScanning')} extra={sync.phase === 'finalizing' ? t('home.syncConfirming') : sync.phase === 'syncing' ? formatDesktopSyncEta(syncEtaSeconds, t) : undefined} height={sync.targetHeight !== undefined ? t('home.syncHeight', { current: formatSyncBlockCount(sync.walletHeight, locale), target: formatSyncBlockCount(sync.targetHeight, locale) }) : undefined} label={readinessPhase === 'scanning-spend-outputs' ? t('home.spendOutputs') : t('home.walletScan')} onRefresh={onRefresh} percent={readinessPhase === 'scanning-spend-outputs' || readinessPhase === 'recovering-session' || readinessPhase === 'recoverable-error' ? undefined : walletPercent} rate={walletDerivationRate === undefined ? undefined : t('home.syncDerivationRate', { rate: formatWalletDerivationRate(walletDerivationRate, locale) })} testId="wallet-progress" />}
      </div>}
  </section>;
}

function DesktopSyncProgressRow({ detail, extra, height, label, onRefresh, percent, rate, testId }: { detail: string; extra?: string; height?: string; label: string; onRefresh?: () => void; percent?: number; rate?: string; testId: string }) {
  const normalized = percent === undefined ? undefined : normalizeSyncPercent(percent);
  return <section className="desktop-sync-progress" data-testid={testId}><div className="sync-reading"><strong><b>{label}</b><small>{detail}</small></strong>{onRefresh && <button className="sync-refresh" aria-label="Refresh" onClick={onRefresh} title="Refresh" type="button">↻</button>}<em className={normalized === 100 ? 'ready' : ''}>{normalized === undefined ? '—' : `${formatSyncPercent(normalized)}%`}</em></div><div className="sync-track"><span className={normalized === 100 ? 'ready' : ''} style={{ width: `${normalized ?? 0}%` }} /></div>{(height || rate || extra) && <div className="sync-metrics"><div className="sync-metrics-primary">{height && <span>{height}</span>}{rate && <span>{rate}</span>}</div>{extra && <span className="sync-metrics-extra">{extra}</span>}</div>}</section>;
}

function Home({ linked, walletId, wallet, savedWallets, networkSync, onSetup, onWallets, onSelectWallet, onBackup, onLock, onSend, onReceive, onActivity, onWalletsChanged, onRecoverSession }: { linked: boolean; walletId: string | null; wallet: RegisteredWallet | null; savedWallets: RegisteredWallet[]; networkSync: NetworkSyncStatus | null; onSetup: () => void; onWallets: () => void; onSelectWallet: (wallet: RegisteredWallet) => void; onBackup: () => void; onLock: () => void; onSend: () => void; onReceive: () => void; onActivity: () => void; onWalletsChanged: () => Promise<void>; onRecoverSession: (wallet: RegisteredWallet) => Promise<WalletSessionRecoveryResponse> }) {
  const { language, t } = useI18n();
  const locale = language === 'de' ? 'de-DE' : 'en-US';
  const [timeframe, setTimeframe] = useState<MarketTimeframe>('24H');
  const [newsCategory, setNewsCategory] = useState<'all' | MoneroNewsCategory>('all');
  const [snapshot, setSnapshot] = useState<NativeWalletSnapshot | null>(null);
  const [registeredSnapshots, setRegisteredSnapshots] = useState<RegisteredWalletSnapshot[]>([]);
  const [transactions, setTransactions] = useState<NativeTransaction[]>([]);
  const [walletStateSample, setWalletStateSample] = useState<{ snapshot: NativeWalletSnapshot; transactions: NativeTransaction[] } | null>(null);
  const publicationsByRegistrationRef = useRef(new Map<string, WalletPublication<NativeWalletSnapshot, NativeTransaction>>());
  const cardPublicationsByRegistrationRef = useRef(new Map<string, WalletPublication<NativeWalletSnapshot, never>>());
  const sessionGenerationsByRegistrationRef = useRef(new Map<string, number>());
  const [publication, setPublication] = useState<WalletPublication<NativeWalletSnapshot, NativeTransaction> | undefined>();
  const [publishedCardSnapshots, setPublishedCardSnapshots] = useState(new Map<string, NativeWalletSnapshot>());
  const [sessionGeneration, setSessionGeneration] = useState(0);
  const [sessionRecovering, setSessionRecovering] = useState(false);
  const [sessionRecoveryFailed, setSessionRecoveryFailed] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [ledgerVerificationPhase, setLedgerVerificationPhase] = useState<string | null>(null);
  const snapshotRefreshInFlight = useRef(false);
  const ledgerAutoVerificationAttemptedRef = useRef(new Set<string>());
  // This is intentionally acquired before asking the native transport for its
  // status: status can start a BLE discovery.  The one marker covers both the
  // selected wallet and every background wallet, so no two flows can discover
  // or reconcile the same physical Ledger concurrently.
  const ledgerReconciliationInFlightRef = useRef(false);
  // A wallet can be selected repeatedly while it is already scanning. Keep a
  // per-wallet live baseline only for wallets without a user-chosen scan
  // start. Imported and Ledger wallets must instead use their durable restore
  // height: the percentage then describes exactly the range the owner chose,
  // not the full chain or an arbitrary first UI snapshot.
  const syncStartHeightsRef = useRef(new Map<string, number>());
  const { price, change24h, loading: priceLoading } = useXmrPrice();
  const { points, loading: chartLoading, refresh: refreshChart } = useXmrChart(timeframe);
  const { items: newsItems, loading: newsLoading, unavailable: newsUnavailable, refresh: refreshNews } = useMoneroNews(v1ReleaseFeatures.news);

  const recoverStaleSession = useCallback(async (reason: unknown) => {
    if (!wallet || !isSessionStale(reason)) return false;
    setSessionRecovering(true);
    setSessionRecoveryFailed(false);
    setMessage(null);
    try {
      const recovered = await onRecoverSession(wallet);
      sessionGenerationsByRegistrationRef.current.set(wallet.id, recovered.sessionGeneration);
      setSessionGeneration(recovered.sessionGeneration);
      return true;
    } catch (recoveryReason) {
      setMessage(errorMessage(recoveryReason, 'The wallet session could not be restored.'));
      setSessionRecoveryFailed(true);
      return true;
    } finally {
      setSessionRecovering(false);
    }
  }, [onRecoverSession, wallet]);

  useEffect(() => {
    setSessionGeneration(wallet?.id
      ? sessionGenerationsByRegistrationRef.current.get(wallet.id) ?? 0
      : 0);
    setSessionRecoveryFailed(false);
  }, [wallet?.id]);

  const accountIndex = wallet?.accountIndex ?? 0;
  const legacyLedgerAccountScoped = Boolean(
    wallet?.kind === 'hardware'
      && (wallet.role === 'fast'
        || savedWallets.some((candidate) =>
          candidate.kind === 'hardware'
          && candidate.role === 'fast'
          && candidate.sourceWalletId === wallet.id)),
  );
  const snapshotAccountIndex = legacyLedgerAccountScoped
    ? accountIndex
    : undefined;
  const loadSnapshot = useCallback(async (startRefresh = false) => {
    if (!walletId) return;
    if (snapshotRefreshInFlight.current) return;
    snapshotRefreshInFlight.current = true;
    try {
      const configuredStartHeight = syncStartHeightForWallet(wallet?.restoreHeight);
      if (startRefresh && !configuredStartHeight) {
        // Do not reuse a cached UI height as a progress baseline. The first
        // snapshot after the native Core refresh owns this range only when
        // no scan start was configured by the owner.
        syncStartHeightsRef.current.delete(walletId);
      }
      if (startRefresh) await invoke<void>('start_wallet_refresh', { input: { walletId } });
      const raw = await invoke<string>('wallet_snapshot', {
        input: {
          walletId,
          ...(snapshotAccountIndex === undefined
            ? {}
            : { accountIndex: snapshotAccountIndex }),
        },
      });
      const nextSnapshot = parseNativeJson<NativeWalletSnapshot>(raw, 'The native wallet snapshot was invalid.');
      const nextHeight = nativeHeight(nextSnapshot.walletHeight);
      if (!configuredStartHeight && nextHeight && (nextSnapshot.synchronized || !syncStartHeightsRef.current.has(walletId))) {
        syncStartHeightsRef.current.set(walletId, nextHeight);
      }
      setSnapshot(nextSnapshot);
      setMessage(startRefresh ? 'Local wallet refresh started.' : null);
      return nextSnapshot;
    } catch (reason) {
      // A node handshake may be slow, but it must not blank the wallet or
      // replace a useful previous balance with an alarming error. Keep the
      // current view and let the next lightweight poll retry.
      if (!await recoverStaleSession(reason) && !isBackgroundWalletWork(reason)) setMessage(errorMessage(reason, 'Could not read wallet state.'));
      return undefined;
    }
    finally { snapshotRefreshInFlight.current = false; }
  }, [recoverStaleSession, snapshotAccountIndex, wallet?.restoreHeight, walletId]);
  const loadTransactions = useCallback(async () => {
    if (!walletId || !wallet) return;
    try {
      const raw = await invoke<string>('registered_wallet_transactions', { input: { registrationId: wallet.id } });
      const nextTransactions = parseNativeJson<NativeTransaction[]>(raw, 'The native transaction history was invalid.');
      setTransactions(nextTransactions);
      return nextTransactions;
    } catch (reason) {
      if (!await recoverStaleSession(reason) && !isBackgroundWalletWork(reason)) setMessage(errorMessage(reason, 'Could not read wallet activity.'));
      return undefined;
    }
  }, [recoverStaleSession, wallet, walletId]);
  const loadRegisteredSnapshots = useCallback(async () => {
    try {
      const loaded = await invoke<RegisteredWalletSnapshot[]>('registered_wallet_snapshots');
      for (const item of loaded) {
        const registration = savedWallets.find(walletItem => walletItem.id === item.registrationId);
        if (!registration || registration.restoreHeight || syncStartHeightsRef.current.has(item.registrationId)) continue;
        try {
          const itemSnapshot = parseNativeJson<NativeWalletSnapshot>(item.snapshot, 'Invalid native wallet snapshot.');
          const firstHeight = nativeHeight(itemSnapshot.walletHeight);
          if (firstHeight) syncStartHeightsRef.current.set(item.registrationId, firstHeight);
        } catch {
          // Ignore one malformed cached snapshot; the next native poll retries.
        }
      }
      setRegisteredSnapshots(loaded);
    }
    catch (reason) {
      // This bulk command covers every warmed registration, but its safe
      // error does not identify which registration owns a stale handle.
      // The selected wallet's direct poll performs the targeted recovery.
      if (!isBackgroundWalletWork(reason) && !isSessionStale(reason)) {
        setMessage(errorMessage(reason, 'Could not update saved wallet states.'));
      }
    }
  }, [savedWallets]);
  const loadWalletState = useCallback(async (startRefresh = false) => {
    const beforeHistory = await loadSnapshot(startRefresh);
    if (!beforeHistory) return;
    const nextTransactions = await loadTransactions();
    if (!nextTransactions) return;
    const afterHistory = await loadSnapshot();
    if (!afterHistory) return;
    // Snapshot and history are separate legacy FFI calls. Bracket the history
    // read with the native monotonic revision so a block or Ledger mutation
    // between calls can only defer publication to the next poll; it can never
    // combine a balance from one state with transactions from another.
    if (snapshotPublicationToken(beforeHistory) === snapshotPublicationToken(afterHistory)) {
      setWalletStateSample({ snapshot: afterHistory, transactions: nextTransactions });
      setSessionRecoveryFailed(false);
    }
  }, [loadSnapshot, loadTransactions]);
  const refreshWallet = async () => { await loadWalletState(true); };

  useEffect(() => {
    if (!walletId) { setSnapshot(null); setTransactions([]); setWalletStateSample(null); void loadRegisteredSnapshots(); return; }
    // Opening/creating a wallet already queues exactly one native sync worker.
    // Read its state here without issuing a second start-refresh command: that
    // duplicate used to queue behind daemon initialization and amplify every
    // quick wallet switch into another long native-lock wait.
    setWalletStateSample(null);
    void loadWalletState();
    void loadRegisteredSnapshots();
    const walletStateTimer = window.setInterval(() => void loadWalletState(), 5_000);
    const registeredSnapshotTimer = window.setInterval(() => void loadRegisteredSnapshots(), 5_000);
    return () => { window.clearInterval(walletStateTimer); window.clearInterval(registeredSnapshotTimer); };
  }, [loadRegisteredSnapshots, loadWalletState, walletId]);

  const positive = timeframe === '24H' ? change24h >= 0 : points.length < 2 || points.at(-1)!.price >= points[0].price;
  const changePercent = timeframe === '24H' ? change24h : points.length >= 2 ? ((points.at(-1)!.price - points[0].price) / points[0].price) * 100 : 0;
  const changeUsd = price > 0 ? Math.abs((changePercent / 100) * price) : 0;
  const snapshotsByRegistration = useMemo(() => {
    const next = new Map<string, NativeWalletSnapshot>(registeredSnapshots.flatMap((item) => {
      try { return [[item.registrationId, parseNativeJson<NativeWalletSnapshot>(item.snapshot, 'Invalid native wallet snapshot.')]] as const; }
      catch { return []; }
    }));
    if (wallet?.id && snapshot && !next.has(wallet.id)) next.set(wallet.id, snapshot);
    return next;
  }, [registeredSnapshots, snapshot, wallet?.id]);
  const ledgerReadOnlySnapshots = useMemo(
    () => new Set(registeredSnapshots.filter(item => item.usesLedgerReadOnly).map(item => item.registrationId)),
    [registeredSnapshots],
  );
  useEffect(() => {
    const published = new Map<string, NativeWalletSnapshot>();
    for (const registration of savedWallets) {
      const candidate = snapshotsByRegistration.get(registration.id);
      const requiresLedgerVerification = registration.kind === 'hardware' && registration.role !== 'fast';
      const pendingOutputCount = Number(candidate?.pendingOutputKeyImageCount ?? 0);
      const next = nextWalletPublication(
        cardPublicationsByRegistrationRef.current.get(registration.id),
        {
          snapshot: candidate,
          transactions: [],
          requiresLedgerVerification,
          ledgerVerified: !requiresLedgerVerification || Boolean(
            ledgerReadOnlySnapshots.has(registration.id)
            && registration.ledgerKeyImagesVerifiedAt
            && Number.isFinite(pendingOutputCount)
            && pendingOutputCount === 0,
          ),
          sessionGeneration: sessionGenerationsByRegistrationRef.current.get(registration.id) ?? 0,
        },
      );
      cardPublicationsByRegistrationRef.current.set(registration.id, next);
      if (next.publishedSnapshot) published.set(registration.id, next.publishedSnapshot);
    }
    setPublishedCardSnapshots(published);
  }, [ledgerReadOnlySnapshots, savedWallets, snapshotsByRegistration]);
  const selectedSnapshot = wallet?.id
    ? snapshotsByRegistration.get(wallet.id) ?? snapshot
    : snapshot;
  useEffect(() => {
    if (!wallet?.id) {
      setPublication(undefined);
      return;
    }
    const prior = publicationsByRegistrationRef.current.get(wallet.id);
    const candidate = walletStateSample?.snapshot;
    const pendingOutputCount = Number(candidate?.pendingOutputKeyImageCount ?? 0);
    const requiresLedgerVerification = wallet.kind === 'hardware' && wallet.role !== 'fast';
    const ledgerVerified = !requiresLedgerVerification || Boolean(
      ledgerReadOnlySnapshots.has(wallet.id)
      && wallet.ledgerKeyImagesVerifiedAt
      && Number.isFinite(pendingOutputCount)
      && pendingOutputCount === 0,
    );
    const next = nextWalletPublication(prior, {
      snapshot: candidate,
      transactions: walletStateSample?.transactions ?? [],
      requiresLedgerVerification,
      ledgerVerified,
      ledgerPhase: ledgerVerificationPhase ? 'scanning-spend-outputs' : undefined,
      sessionRecovering,
      recoverableError: sessionRecoveryFailed,
      sessionGeneration,
    });
    publicationsByRegistrationRef.current.set(wallet.id, next);
    setPublication(next);
  }, [ledgerReadOnlySnapshots, ledgerVerificationPhase, sessionGeneration, sessionRecovering, sessionRecoveryFailed, wallet, walletStateSample]);
  const publishedSnapshot = publication?.publishedSnapshot;
  const publishedTransactions = publication?.publishedTransactions ?? [];
  // The dashboard is the selected wallet's balance. Do not sum every local
  // registration: Ledger Fast Wallet entries and historical registrations can
  // refer to the same wallet/account and would double-count the same outputs.
  const hasUnverifiedLedgerBalance = Boolean(
    wallet && desktopLedgerBalanceNeedsVerification(wallet, selectedSnapshot ?? undefined, ledgerReadOnlySnapshots.has(wallet.id)),
  );
  const balanceAtomic = atomicValue(publishedSnapshot?.balanceAtomic).toString();
  const unlockedAtomic = atomicValue(publishedSnapshot?.unlockedBalanceAtomic).toString();
  const lockedAtomic = atomicValue(balanceAtomic) - atomicValue(unlockedAtomic);
  const balanceXmr = formatAtomicXmr(balanceAtomic);
  const lockedXmr = formatAtomicXmr(lockedAtomic.toString());
  const balanceUsd = price > 0 ? formatUsd(atomicXmrNumber(balanceAtomic) * price) : '—';
  const hasPublishedBalance = Boolean(publishedSnapshot);
  const syncStartHeight = syncStartHeightForWallet(
    wallet?.restoreHeight,
    walletId ? syncStartHeightsRef.current.get(walletId) : undefined,
  );
  const sync = presentWalletSync(selectedSnapshot, { startHeight: syncStartHeight });
  const sharedSync = presentNetworkSync(networkSync);
  const showSharedSync = sharedSync.busy || sharedSync.failed;
  // Keep the same two persistent progress measurements as mobile: public
  // blockchain download and the selected wallet's private scan.
  const showPrimaryWalletCard = Boolean(walletId);
  const syncEtaSeconds = useDesktopSyncEta(sync, networkSync);
  const visibleNews = newsCategory === 'all'
    ? newsItems
    : newsItems.filter((item) => item.category === newsCategory);
  const routeToWalletAction = (action: () => void) => {
    if (walletId && linked) { action(); return; }
    if (savedWallets.length) { onWallets(); return; }
    onSetup();
  };
  const activeLedgerNeedsVerification = Boolean(
    wallet?.kind === 'hardware'
      && wallet.role !== 'fast'
      && desktopLedgerBalanceNeedsVerification(wallet, selectedSnapshot ?? undefined, ledgerReadOnlySnapshots.has(wallet.id)),
  );
  const activeLedgerHasReadOnly = Boolean(
    wallet?.id && ledgerReadOnlySnapshots.has(wallet.id),
  );
  const activeLedgerNeedsAutomaticVerification =
    activeLedgerNeedsVerification && activeLedgerHasReadOnly && !wallet?.ledgerKeyImagesVerifiedAt;
  const verifyLedgerBalance = async () => {
    if (!walletId || !wallet || wallet.kind !== 'hardware' || ledgerVerificationPhase) return;
    setLedgerVerificationPhase('Confirm once on your Ledger…');
    try {
      const companion = await invoke<WalletOperationResponse>('enable_ledger_read_only', {
        input: {
          sourceWalletId: walletId,
          sourceRegistrationId: wallet.id,
          restoreHeight: wallet.restoreHeight,
        },
      });
      setLedgerVerificationPhase('Reading your Ledger balance…');
      await invoke<void>('queue_registered_wallet_sync', { walletId: companion.wallet.id }).catch(() => undefined);

      let verified = false;
      let lastReason: unknown;
      for (let attempt = 0; attempt < 300; attempt += 1) {
        await new Promise(resolve => window.setTimeout(resolve, 1_000));
        let candidate: NativeWalletSnapshot | undefined;
        try {
          const loaded = await invoke<RegisteredWalletSnapshot[]>('registered_wallet_snapshots');
          setRegisteredSnapshots(loaded);
          const source = loaded.find(item => item.registrationId === wallet.id);
          if (source) candidate = parseNativeJson<NativeWalletSnapshot>(source.snapshot, 'Invalid Ledger balance state.');
        } catch (reason) {
          lastReason = reason;
          continue;
        }
        const progress = presentWalletSync(candidate ?? null, {
          startHeight: syncStartHeightForWallet(wallet.restoreHeight),
        });
        if (progress.progress !== undefined && progress.progress < 100) {
          setLedgerVerificationPhase(`Reading your Ledger balance… ${Math.max(0, Math.floor(progress.progress))}%`);
        }
        if (!candidate?.synchronized) continue;
        try {
          await invoke<string>('reconcile_ledger_balance', {
            input: { sourceRegistrationId: wallet.id },
          });
          verified = true;
          break;
        } catch (reason) {
          lastReason = reason;
          const detail = errorMessage(reason, 'Ledger balance verification is not ready.');
          if (!/synchron|height|background|busy/i.test(detail)) throw reason;
        }
      }
      if (!verified) throw lastReason ?? new Error('Ledger balance verification timed out.');
      await Promise.all([onWalletsChanged(), loadRegisteredSnapshots(), loadWalletState()]);
    } catch (reason) {
      // Reconciliation is an internal integrity step.  Keep failures in the
      // diagnostic log rather than adding a persistent dashboard warning.
      console.warn('MONERO_DESKTOP_LEDGER_RECONCILIATION_FAILED', errorMessage(reason, 'The Ledger balance could not be loaded.'));
    } finally {
      setLedgerVerificationPhase(null);
    }
  };

  useEffect(() => {
    if (
      !wallet?.id ||
      !walletId ||
      !activeLedgerNeedsAutomaticVerification ||
      !selectedSnapshot?.synchronized ||
      ledgerVerificationPhase
    ) return;

    let cancelled = false;
    const attempt = async () => {
      if (cancelled || ledgerVerificationPhase) return;
      if (ledgerAutoVerificationAttemptedRef.current.has(wallet.id)) return;
      if (ledgerReconciliationInFlightRef.current) return;

      // Record the cooldown before the status call. On macOS that call may
      // begin BLE discovery, so recording it afterwards would permit repeated
      // discovery windows while no Ledger is available.
      ledgerAutoVerificationAttemptedRef.current.add(wallet.id);
      ledgerReconciliationInFlightRef.current = true;
      try {
        const raw = await invoke<string>('ledger_transport_status');
        const transport = parseNativeJson<LedgerTransportStatus>(raw, 'The Ledger connection state was invalid.');
        if (!transport.supported || !transport.available || !transport.permissionGranted || transport.deviceCount < 1) return;
        await verifyLedgerBalance();
      } catch (reason) {
        console.warn('MONERO_DESKTOP_LEDGER_AUTO_VERIFICATION_FAILED', errorMessage(reason, 'Ledger verification failed.'));
      } finally {
        ledgerReconciliationInFlightRef.current = false;
      }
    };
    void attempt();
    return () => {
      cancelled = true;
    };
  }, [
    activeLedgerNeedsAutomaticVerification,
    ledgerVerificationPhase,
    selectedSnapshot?.synchronized,
    wallet?.id,
    walletId,
  ]);

  return <div className="home-stack home-dashboard">
    {showPrimaryWalletCard && <DesktopSyncProgress locale={locale} network={sharedSync} networkStatus={networkSync} onRefresh={() => void refreshWallet()} readinessPhase={publication?.phase} sync={sync} syncEtaSeconds={syncEtaSeconds} t={t} walletName={wallet ? walletDisplayName(wallet) : t('common.wallet')} walletOpened={Boolean(walletId)} walletReady={publication?.ready === true} />}

    <section className="market-card">
      <div className="market-card-head"><div><p className="eyebrow">{t('home.liveMarket')}</p><h2>{priceLoading ? t('home.priceLoading') : price > 0 ? formatUsd(price) : t('home.marketUnavailable')}</h2>{price > 0 && <p className={positive ? 'market-change positive' : 'market-change negative'}><span>{positive ? '▲' : '▼'} {Math.abs(changePercent).toFixed(2)}%</span><span>{positive ? '+' : '-'}{formatUsd(changeUsd)}</span></p>}</div><img className="market-mark" src="/monero-mark.png" alt="Monero" /></div>
      <div className="market-chart-wrap">{chartLoading && points.length < 2 ? <div className="market-chart-empty">{t('home.chartLoading')}</div> : <MarketChart points={points} positive={positive} onRetry={refreshChart} />}</div>
      <div className="market-timeframes" aria-label="Market chart timeframe">{(['24H', '7D', '1M', '1Y', 'Max'] as MarketTimeframe[]).map((item) => <button className={timeframe === item ? 'selected' : ''} onClick={() => setTimeframe(item)} key={item} type="button">{item}</button>)}</div>
    </section>

    {showPrimaryWalletCard && <section className={`${selectedSnapshot?.synchronized && !showSharedSync ? 'wallet-sync-card ready' : 'wallet-sync-card'} home-primary-wallet balance-only`}>
      <div className="primary-wallet-balance">
        <div><p className="eyebrow">{t('home.totalBalance')}</p><h2>{hasPublishedBalance ? `${balanceXmr} XMR` : '— XMR'}</h2><strong>{hasPublishedBalance ? balanceUsd : '—'}</strong></div>
        <div className="primary-wallet-meta"><strong>{wallet ? walletDisplayName(wallet) : t('common.wallet')}</strong><small>{wallet ? `${networkLabel(wallet.network)} · ${wallet.kind === 'hardware' ? t('common.ledger') : t('wallets.software')}` : ''}</small>{lockedAtomic > 0n && !hasUnverifiedLedgerBalance && <span className="wallet-locked"><i />{lockedXmr} XMR locked</span>}</div>
      </div>
    </section>}

    {v1ReleaseFeatures.news && <section className="official-updates" aria-label={t('home.newsTitle')}>
      <header><div><p className="eyebrow">{t('home.newsSource')}</p><h2>{t('home.newsTitle')}</h2></div><a href="https://www.getmonero.org/blog/" target="_blank" rel="noreferrer">{t('home.newsSourceLink')} ↗</a></header>
      <div className="news-filters" aria-label={t('home.newsTitle')}>{(['all', 'network', 'wallet', 'ecosystem'] as const).map((category) => <button className={newsCategory === category ? 'selected' : ''} key={category} onClick={() => setNewsCategory(category)} type="button">{category === 'all' ? t('home.newsAll') : category === 'network' ? t('home.newsNetwork') : category === 'wallet' ? t('home.newsWallet') : t('home.newsEcosystem')}</button>)}</div>
      {newsLoading && newsItems.length === 0 ? <p className="official-updates-status">{t('home.newsLoading')}</p> : newsUnavailable && newsItems.length === 0 ? <div className="official-updates-status"><span>{t('home.newsUnavailable')}</span><button className="quiet-button" onClick={refreshNews} type="button">{t('home.chartRetry')}</button></div> : visibleNews.length === 0 ? <p className="official-updates-status">{t('home.newsEmpty')}</p> : <div className="official-updates-list">{visibleNews.slice(0, 8).map((item) => <a href={item.url} key={item.id} target="_blank" rel="noreferrer"><span><b>{item.category === 'network' ? t('home.newsNetwork') : item.category === 'wallet' ? t('home.newsWallet') : t('home.newsEcosystem')}</b><strong>{item.title}</strong><small>{item.summary}</small></span><time>{new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(item.publishedAt))}</time><em>›</em></a>)}</div>}
    </section>}

    <section className="home-quick-actions" aria-label="Wallet actions"><button onClick={() => routeToWalletAction(onSend)} type="button"><span>↑</span><strong>{t('nav.send')}</strong><small>{t('home.sendDetail')}</small></button><button onClick={() => routeToWalletAction(onReceive)} type="button"><span>↓</span><strong>{t('nav.receive')}</strong><small>{t('home.receiveDetail')}</small></button></section>

    <section className="home-wallets"><header><div><p className="eyebrow">{t('home.allWallets')}</p><h2>{t('home.yourWallets')}</h2></div><button className="quiet-button" onClick={onWallets} type="button">{t('home.manageWallets')}</button></header>{savedWallets.length ? <div className="wallet-strip">{savedWallets.map((item) => { const active = item.id === wallet?.id; const fast = isFastWalletRegistration(item); const itemSnapshot = snapshotsByRegistration.get(item.id); const publishedItemSnapshot = publishedCardSnapshots.get(item.id); const itemStartHeight = syncStartHeightForWallet(item.restoreHeight, syncStartHeightsRef.current.get(item.id)); const itemSync = presentWalletSync(itemSnapshot ?? null, { startHeight: itemStartHeight }); const itemSyncPercent = itemSync.coreConfirmed ? 100 : itemSync.phase === 'finalizing' ? 99 : itemSync.progress ?? 0; return <button className={`${active ? 'wallet-mini-card active' : 'wallet-mini-card'}${fast ? ' fast' : ''}`} onClick={() => onSelectWallet(item)} key={item.id} type="button"><span>{walletDisplayName(item)}</span><small>{fast ? item.kind === 'hardware' ? 'FAST WALLET · LEDGER' : 'FAST WALLET' : item.kind === 'hardware' ? 'LEDGER' : networkLabel(item.network).toUpperCase()}</small><strong>{publishedItemSnapshot ? `${formatAtomicXmr(publishedItemSnapshot.balanceAtomic)} XMR` : item.isOpen ? '— XMR' : fast ? 'Open Fast Wallet' : t('home.openToCheck')}</strong><div className="wallet-mini-sync"><span><b>{syncLabel(itemSnapshot ?? null, t, itemStartHeight)}</b><em>{itemSyncPercent}%</em></span><i><i className={itemSyncPercent === 100 ? 'ready' : ''} style={{ width: `${itemSyncPercent}%` }} /></i>{itemSnapshot && itemSync.remainingBlocks !== undefined && <small>{t('home.syncRemaining', { count: formatSyncBlockCount(itemSync.remainingBlocks, locale) })}</small>}</div></button>; })}<button className="wallet-mini-card add" onClick={onSetup} type="button"><span>＋</span><strong>{t('home.addWallet')}</strong></button></div> : <div className="home-empty"><p>{t('home.noWallets')}</p><button className="primary" onClick={onSetup} type="button">{t('home.addWallet')}</button></div>}</section>
    <RecentTransactions hasOpenWallet={Boolean(walletId)} items={[...publishedTransactions]} onActivity={() => routeToWalletAction(onActivity)} />

    {wallet?.seedBackupStatus === 'pending' && walletId && <section className="backup-warning"><div><p className="eyebrow">{t('home.securityStep')}</p><h2>{t('home.backupSeed')}</h2><p>{t('home.backupNote')}</p></div><button className="primary" onClick={onBackup} type="button">{t('home.showSeed')}</button></section>}
    {walletId && <div className="home-lock-row"><button className="quiet-button" onClick={onLock} type="button">{t('home.lock', { name: wallet ? walletDisplayName(wallet) : t('common.wallet') })}</button>{message && <p className="setup-message">{message}</p>}</div>}
  </div>;
}

function RecentTransactions({ hasOpenWallet, items, onActivity }: { hasOpenWallet: boolean; items: NativeTransaction[]; onActivity: () => void }) {
  const { t } = useI18n();
  return <section className="home-transactions recent-transactions"><header><div><p className="eyebrow">{t('home.activity')}</p><h2>{t('home.transactions')}</h2></div><button className="quiet-button" onClick={onActivity} type="button">{t('home.viewMore')}</button></header>{hasOpenWallet && items.length ? <div className="home-transaction-list">{items.slice(0, 3).map((item) => <button className="home-transaction-row" key={`${item.hash}-${item.direction}-${item.timestamp}`} onClick={onActivity} type="button"><span className={item.direction === 'in' ? 'home-transaction-icon incoming' : 'home-transaction-icon'}>{item.direction === 'in' ? '↓' : '↑'}</span><span><strong>{item.direction === 'in' ? t('home.received') : t('home.sent')} · {item.direction === 'in' ? '+' : '-'}{formatAtomicXmr(item.amountAtomic)} XMR</strong><small>{shortHash(item.hash)} · {transactionTimestamp(item.timestamp)}</small></span><em>{item.failed ? t('home.failed') : item.pending ? t('home.pending') : t('home.confirmed')}</em></button>)}</div> : <div className="home-empty"><p>{hasOpenWallet ? t('home.noTransactions') : t('home.openForActivity')}</p></div>}</section>;
}

function Wallets({ linked, walletId, wallets, activeWallet, onSetup, onOpen, onManageAddresses, onRenamed, onRemove, onActivity }: { linked: boolean; walletId: string | null; wallets: RegisteredWallet[]; activeWallet: RegisteredWallet | null; onSetup: () => void; onOpen: (wallet: RegisteredWallet) => void; onManageAddresses: (wallet: RegisteredWallet) => void; onRenamed: () => void; onRemove: (wallet: RegisteredWallet) => Promise<void>; onActivity: () => void }) {
  const { t } = useI18n();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [removalCandidate, setRemovalCandidate] = useState<RegisteredWallet | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [transactions, setTransactions] = useState<NativeTransaction[]>([]);
  const loadTransactions = useCallback(async () => {
    if (!walletId || !activeWallet) { setTransactions([]); return; }
    try {
      const raw = await invoke<string>('registered_wallet_transactions', { input: { registrationId: activeWallet.id } });
      setTransactions(parseNativeJson<NativeTransaction[]>(raw, 'The native wallet transaction history was invalid.'));
    } catch (reason) { setMessage(errorMessage(reason, 'Could not read wallet activity.')); }
  }, [activeWallet, walletId]);
  useEffect(() => {
    if (!linked || !walletId) return;
    void loadTransactions();
    const timer = window.setInterval(() => void loadTransactions(), 10_000);
    return () => window.clearInterval(timer);
  }, [linked, loadTransactions, walletId]);
  const startRename = (wallet: RegisteredWallet) => { setEditingId(wallet.id); setDisplayName(walletDisplayName(wallet)); setMessage(null); };
  const saveRename = async () => {
    if (!editingId || renaming) return;
    setRenaming(true); setMessage(null);
    try {
      await invoke<RegisteredWallet>('rename_wallet', { input: { walletId: editingId, displayName } });
      setEditingId(null); setDisplayName(''); onRenamed();
    } catch (reason) { setMessage(errorMessage(reason, 'The wallet name could not be updated.')); }
    finally { setRenaming(false); }
  };
  const remove = async (wallet: RegisteredWallet) => {
    if (removingId) return;
    setRemovingId(wallet.id); setMessage(null);
    try {
      await onRemove(wallet);
      if (editingId === wallet.id) { setEditingId(null); setDisplayName(''); }
      setRemovalCandidate(null);
    } catch (reason) { setMessage(errorMessage(reason, t('wallets.removeFailed'))); }
    finally { setRemovingId(null); }
  };
  const walletSection = wallets.length > 0
    ? <><header><div><h2>{t('wallets.saved')}</h2><p>Add, switch, and remove private or Fast Wallets.</p></div><button className="primary" onClick={onSetup} type="button">{t('home.addWallet')}</button></header><div className="wallet-list">{wallets.map((wallet) => { const fast = isFastWalletRegistration(wallet); return <div className="wallet-row-wrap" key={wallet.id}><article className={`${activeWallet?.id === wallet.id ? 'wallet-row active' : 'wallet-row'}${fast ? ' fast-wallet-row' : ''}`}><div className="wallet-row-mark">{fast ? <span className="fast-wallet-mark">⚡</span> : <img src="/monero-mark.png" alt="" />}</div><div className="wallet-row-copy"><div><h3>{walletDisplayName(wallet)}{fast && <b className="fast-wallet-badge">FAST</b>}</h3><span className={wallet.seedBackupStatus === 'pending' ? 'wallet-chip warning' : 'wallet-chip'}>{wallet.seedBackupStatus === 'pending' ? t('wallets.backupNeeded') : fast ? 'Ready to receive' : wallet.isOpen ? t('home.openLocal') : wallet.kind === 'hardware' ? t('wallets.ledgerRequired') : t('wallets.available')}</span></div><p>{fast ? 'Receive quickly' : wallet.kind === 'hardware' ? walletTypeLabel(wallet, t) : networkLabel(wallet.network)}</p></div><div className="wallet-row-actions">{wallet.seedBackupStatus !== 'pending' && <button className="quiet-button" disabled={!linked || Boolean(removingId)} onClick={() => onManageAddresses(wallet)} type="button">{t('receive.manageAddresses')}</button>}{wallet.kind !== 'fast' && <button className="quiet-button" disabled={Boolean(removingId)} onClick={() => startRename(wallet)} type="button">{t('wallets.rename')}</button>}<button className="secondary" disabled={!linked || Boolean(removingId)} onClick={() => onOpen(wallet)} type="button">{fast ? 'Use wallet' : wallet.isOpen ? t('wallets.use') : wallet.kind === 'hardware' ? t('wallets.connectLedger') : t('setup.open')}</button><button className="danger-button" disabled={Boolean(removingId)} onClick={() => { setRemovalCandidate(wallet); setEditingId(null); setDisplayName(''); setMessage(null); }} type="button">{removingId === wallet.id ? t('wallets.removing') : t('wallets.remove')}</button></div></article>{editingId === wallet.id && <div className="wallet-rename"><input autoFocus value={displayName} maxLength={64} onChange={(event) => setDisplayName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void saveRename(); if (event.key === 'Escape') setEditingId(null); }} placeholder={t('wallets.namePlaceholder')} /><div><button className="quiet-button" disabled={renaming || Boolean(removingId)} onClick={() => { setEditingId(null); setMessage(null); }} type="button">{t('common.cancel')}</button><button className="secondary" disabled={renaming || Boolean(removingId)} onClick={() => void saveRename()} type="button">{renaming ? t('wallets.saving') : t('wallets.saveName')}</button></div></div>}</div>; })}</div></>
    : <><header><div><h2>{t('wallets.saved')}</h2><p>Add, switch, and remove private or Fast Wallets.</p></div><button className="primary" onClick={onSetup} type="button">{t('home.addWallet')}</button></header><div className="home-empty wallet-list-empty-inline"><p>{linked ? t('wallets.emptyText') : t('wallets.protectedText')}</p><button className="primary" onClick={onSetup} type="button">{t('wallets.openSetup')}</button></div></>;
  const removalIsFast = isFastWalletRegistration(removalCandidate);
  return <section className="wallet-list-page">{walletSection}{message && <p className="setup-message wallet-list-message" role="alert">{message}</p>}{removalCandidate && <div className="seed-overlay" role="dialog" aria-modal="true" aria-labelledby="remove-wallet-title"><section className="seed-dialog wallet-remove-dialog"><p className="eyebrow">Remove wallet</p><h2 id="remove-wallet-title">Remove {walletDisplayName(removalCandidate)}?</h2><p>{removalIsFast && removalCandidate.seedBackupStatus === 'pending' ? 'The recovery words have not been backed up. Remove this wallet from the app? Its encrypted recovery data stays on this device, so no funds are erased.' : 'Remove this wallet from the app? Its recovery words and funds are not erased.'}</p><div className="dialog-actions"><button className="quiet-button" disabled={Boolean(removingId)} onClick={() => setRemovalCandidate(null)} type="button">{t('common.cancel')}</button><button className="danger-button" disabled={Boolean(removingId)} onClick={() => void remove(removalCandidate)} type="button">{removingId === removalCandidate.id ? t('wallets.removing') : t('wallets.remove')}</button></div></section></div>}<RecentTransactions hasOpenWallet={Boolean(walletId)} items={transactions} onActivity={onActivity} /></section>;
}

/** The only action is on the Ledger. Closing this prompt would hide a pending
 * device approval, so it unmounts solely when the native export resolves. */
function LedgerViewKeyExportOverlay({ title = 'Approve on your Ledger', detail = 'Waiting for the Ledger…' }: { title?: string; detail?: string } = {}) {
  return <div className="seed-overlay ledger-view-key-overlay" role="dialog" aria-modal="true" aria-labelledby="ledger-view-key-title"><section className="seed-dialog ledger-view-key-dialog"><img src="/monero-mark.png" alt="" /><p className="eyebrow">Ledger Nano</p><h2 id="ledger-view-key-title">{title}</h2><p>Keep the Ledger unlocked with the Monero app open. If it asks, approve <strong>Export view key</strong> once. Your spend key never leaves the Ledger.</p><div className="ledger-view-key-wait"><span aria-hidden="true" /><strong>{detail}</strong></div></section></div>;
}

function Setup({ linked, wallets, onSelectSaved, onOpened, onCreated }: { linked: boolean; wallets: RegisteredWallet[]; onSelectSaved: (wallet: RegisteredWallet) => void; onOpened: (result: WalletOperationResponse) => void; onCreated: (result: WalletOperationResponse, createFastWallet: boolean, requiresPrimarySeedBackup: boolean) => void }) {
  const { t } = useI18n();
  const [mode, setMode] = useState<SetupMode>('create');
  const [restoreStartDate, setRestoreStartDate] = useState('');
  const [createFastWallet, setCreateFastWallet] = useState(
    () => loadFastWalletPreference() === 'enabled',
  );
  const [ledgerTransport, setLedgerTransport] = useState<'usb' | 'ble'>('usb');
  const [ledgerStatus, setLedgerStatus] = useState<LedgerTransportStatus | null>(null);
  const [persistLedgerViewOnly, setPersistLedgerViewOnly] = useState(true);
  const [ledgerViewKeyExportPending, setLedgerViewKeyExportPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const network: Network = 'mainnet';
  const label = mode === 'create' ? t('setup.create') : mode === 'restore' ? t('setup.import') : t('setup.ledger');
  const description = mode === 'create'
    ? t('setup.createDescription')
    : mode === 'restore'
      ? t('setup.restoreDescription')
      : t('setup.ledgerDescription');
  const checkLedgerBluetooth = async () => {
    if (!linked || busy) return;
    setLedgerTransport('ble'); setBusy(true); setMessage(null);
    try {
      const raw = await invoke<string>('ledger_transport_status');
      const status = parseNativeJson<LedgerTransportStatus>(raw, t('setup.bluetoothInvalid'));
      setLedgerStatus(status); setMessage(status.message);
    } catch (reason) { setMessage(errorMessage(reason, t('setup.bluetoothFailed'))); }
    finally { setBusy(false); }
  };
  const chooseMode = (next: SetupMode) => {
    setMode(next); setMessage(null);
    if (next === 'ledger' && ledgerTransport === 'ble') void checkLedgerBluetooth();
  };
  const changeFastWallet = (enabled: boolean) => {
    setCreateFastWallet(enabled);
    saveFastWalletPreference(enabled ? 'enabled' : 'disabled');
  };
  const submit = async () => {
    if (!linked || busy) return;
    if (mode === 'ledger' && !restoreStartDate.trim()) {
      setMessage(t('setup.ledgerScanDateRequired'));
      return;
    }
    let restoreHeight: number | undefined;
    try {
      restoreHeight = (mode === 'restore' || mode === 'ledger')
        ? restoreHeightFromStartDate(restoreStartDate, network)
        : undefined;
    } catch { setMessage(t('setup.dateInvalid')); return; }
    if (mode === 'ledger' && ledgerTransport === 'ble' && (!ledgerStatus?.supported || !ledgerStatus.available || !ledgerStatus.permissionGranted || ledgerStatus.deviceCount < 1)) { await checkLedgerBluetooth(); return; }
    setBusy(true); setMessage(null);
    try {
      const input = mode === 'ledger'
        ? { walletName: '', password: '', network, deviceName: ledgerTransport === 'ble' ? 'Ledger:ble' : 'Ledger', restoreHeight, accountIndex: 0, role: 'standard', createFast: createFastWallet, deferSync: persistLedgerViewOnly }
        : { walletName: '', password: '', network, ...(mode === 'create' ? { language: 'English' } : {}), ...(mode === 'restore' ? { restoreHeight } : {}) };
      const command = mode === 'create' ? 'create_wallet' : mode === 'restore' ? 'restore_wallet_with_native_seed' : 'create_hardware_wallet';
      let result = await invoke<WalletOperationResponse>(command, { input });
      if (mode === 'ledger' && persistLedgerViewOnly) {
        setLedgerViewKeyExportPending(true);
        try {
          result = await invoke<WalletOperationResponse>('enable_ledger_read_only', {
            input: {
              sourceWalletId: result.walletId,
              sourceRegistrationId: result.wallet.id,
              restoreHeight: result.wallet.restoreHeight,
            },
          });
        } finally {
          setLedgerViewKeyExportPending(false);
        }
      }
      if (mode === 'create' || (mode === 'restore' && createFastWallet)) {
        onCreated(result, createFastWallet, mode === 'create');
      } else {
        onOpened(result);
      }
    } catch (reason) {
      const detail = errorMessage(reason, t('setup.operationFailed'));
      setMessage(detail);
    } finally { setBusy(false); }
  };
  const ledgerNeedsSearch = ledgerTransport === 'ble' && (!ledgerStatus?.supported || !ledgerStatus.available || !ledgerStatus.permissionGranted || ledgerStatus.deviceCount < 1);
  const actionLabel = busy ? t('setup.working') : !linked ? t('setup.coreRequired') : mode === 'ledger' ? ledgerNeedsSearch ? t('setup.searchLedger') : t('setup.createLedger') : mode === 'create' ? t('setup.create') : t('setup.import');
  const choices: Array<{ id: SetupMode; title: string; detail: string }> = [{ id: 'create', title: t('setup.create'), detail: t('setup.createDetail') }, { id: 'ledger', title: t('setup.ledger'), detail: t('setup.ledgerDetail') }, { id: 'restore', title: t('setup.import'), detail: t('setup.importDetail') }];
  const scanDate = <><label>{t('setup.scanStart')} <small>{mode === 'ledger' ? t('common.required') : t('common.optional')}</small><input value={restoreStartDate} onChange={(event) => setRestoreStartDate(event.target.value)} type="date" max={todayRestoreDate()} required={mode === 'ledger'} /></label><small className="restore-start-hint">{t(mode === 'ledger' ? 'setup.ledgerScanDateHint' : 'setup.scanDateHint')}</small></>;
  const fastChoice = <label className="setup-preference-row"><span className="setup-preference-copy"><b>Fast Wallet</b><small>{mode === 'ledger' ? 'Also reserve Ledger account 1 as a separate Fast Wallet address.' : 'Also create a separate local wallet with its own recovery words. No server scanning or alerts are enabled here.'}</small></span><input aria-label="Fast Wallet" checked={createFastWallet} disabled={busy} onChange={(event) => changeFastWallet(event.target.checked)} role="switch" type="checkbox" /></label>;
  const ledgerViewKeyChoice = mode === 'ledger' ? <label className="setup-preference-row"><span className="setup-preference-copy"><b>Remember Ledger for viewing</b><small>Keep an encrypted, read-only wallet on this device. You can view balances and receive without reconnecting Ledger; sending still requires Ledger.</small></span><input aria-label="Remember Ledger for viewing" checked={persistLedgerViewOnly} disabled={busy} onChange={(event) => setPersistLedgerViewOnly(event.target.checked)} role="switch" type="checkbox" /></label> : null;
  return <section className="setup-grid simple-setup"><header><p className="eyebrow">{t('setup.eyebrow')}</p><h2>{t('setup.title')}</h2><p>{t('setup.subtitle')}</p></header>{wallets.length > 0 && <section className="setup-saved-wallets"><strong>{t('home.yourWallets')}</strong><div>{wallets.map(wallet => <button key={wallet.id} onClick={() => onSelectSaved(wallet)} type="button"><img src="/monero-mark.png" alt="" /><span><b>{walletDisplayName(wallet)}</b><small>{walletTypeLabel(wallet, t)}</small></span></button>)}</div></section>}<div className="setup-choices" role="tablist" aria-label={t('setup.eyebrow')}>{choices.map((item) => <button className={item.id === mode ? 'selected' : ''} onClick={() => chooseMode(item.id)} type="button" key={item.id}><span>{item.id === 'create' ? '＋' : item.id === 'ledger' ? '⌁' : '⇣'}</span><strong>{item.title}</strong><small>{item.detail}</small></button>)}</div><article className="setup-option simple-setup-form"><img src="/monero-mark.png" alt="" /><div><p className="eyebrow">{t('common.mainnet')}</p><h2>{label}</h2><p>{description}</p><div className="wallet-form">{mode === 'restore' && <><p className="native-seed-notice">Your 25 recovery words are entered in a separate protected system window after you continue.</p>{scanDate}</>}{mode === 'ledger' && <><div className="setup-transport"><button className={ledgerTransport === 'usb' ? 'selected' : ''} onClick={() => { setLedgerTransport('usb'); setMessage(null); }} type="button">USB</button><button className={ledgerTransport === 'ble' ? 'selected' : ''} onClick={() => void checkLedgerBluetooth()} type="button">Bluetooth</button></div><p className={ledgerStatus?.available && ledgerStatus.deviceCount > 0 ? 'ledger-status ready' : 'ledger-status'}>{ledgerTransport === 'usb' ? t('setup.usbHint') : ledgerStatus?.message ?? t('setup.bluetoothHint')}</p>{scanDate}{ledgerViewKeyChoice}</>}{fastChoice}</div><button className="primary" onClick={() => void submit()} disabled={!linked || busy || (mode === 'ledger' && !restoreStartDate.trim())} type="button">{actionLabel}</button>{message && <p className="setup-message">{message}</p>}</div></article>{ledgerViewKeyExportPending && <LedgerViewKeyExportOverlay title="Save your Ledger view key" detail="Waiting for Ledger approval…" />}</section>;
}

function FastWallets({ linked, sourceWalletId, sourceWallet, appProtection }: { linked: boolean; sourceWalletId: string | null; sourceWallet: RegisteredWallet | null; appProtection: AppProtectionStatus }) {
  const [wallets, setWallets] = useState<FastWalletRecord[]>([]);
  const [setupMode, setSetupMode] = useState<'create' | 'restore'>('create');
  const [label, setLabel] = useState('Fast Wallet');
  const [restoreNetwork, setRestoreNetwork] = useState('mainnet');
  const [restoreHeight, setRestoreHeight] = useState('');
  const [backupPassword, setBackupPassword] = useState('');
  const [backupSeedScreen, setBackupSeedScreen] = useState<{ walletId: string; registrationId: string; label: string; seed: string } | null>(null);
  const [removalCandidate, setRemovalCandidate] = useState<FastWalletRecord | null>(null);
  const [removalError, setRemovalError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [openIdentityId, setOpenIdentityId] = useState<string | null>(null);
  const [openWalletId, setOpenWalletId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<NativeWalletSnapshot | null>(null);
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [review, setReview] = useState<NativePreparedTransaction | null>(null);
  const [authorizationPassword, setAuthorizationPassword] = useState('');
  const [alertsAuthorizationPassword, setAlertsAuthorizationPassword] = useState('');
  const [privateWorkerQr, setPrivateWorkerQr] = useState('');
  const [showPrivateWorker, setShowPrivateWorker] = useState(false);
  const systemAuthorization = appProtection.mode === 'system';
  const passwordAuthorization = appProtection.mode === 'password';

  const load = useCallback(async () => {
    try {
      setWallets(await invoke<FastWalletRecord[]>('list_fast_wallets'));
    } catch (reason) {
      setMessage(errorMessage(reason, 'The Fast Wallet list could not be loaded.'));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const create = async () => {
    if (!sourceWalletId || !sourceWallet || sourceWallet.kind !== 'software') return;
    const height = restoreHeight.trim() ? Number(restoreHeight) : undefined;
    if (height !== undefined && (!Number.isSafeInteger(height) || height < 0)) {
      setMessage('Scan height must be a non-negative whole number.');
      return;
    }
    setBusy(true); setMessage(null);
    try {
      const created = await invoke<FastWalletRecord>('create_fast_wallet', {
        input: {
          sourceWalletId,
          sourceRegistrationId: sourceWallet.id,
          label,
          password: '',
          restoreHeight: height,
        },
      });
      setWallets(items => [...items, created]);
      setMessage('Fast Wallet created locally. Back up its recovery words before using the address.');
    } catch (reason) {
      setMessage(errorMessage(reason, 'The Fast Wallet could not be created.'));
    } finally {
      setBusy(false);
    }
  };

  const restore = async () => {
    const height = restoreHeight.trim() ? Number(restoreHeight) : undefined;
    if (height !== undefined && (!Number.isSafeInteger(height) || height < 0)) {
      setMessage('Scan height must be a non-negative whole number.');
      return;
    }
    setBusy(true); setMessage(null);
    try {
      const opened = await invoke<FastWalletOpenResponse>('restore_fast_wallet_with_native_seed', {
        input: {
          label,
          network: restoreNetwork,
          restoreHeight: height,
        },
      });
      const raw = await invoke<string>('wallet_snapshot', {
        input: { walletId: opened.walletId },
      });
      setWallets(items => [...items, opened.wallet]);
      setOpenIdentityId(opened.wallet.id);
      setOpenWalletId(opened.walletId);
      setSnapshot(parseNativeJson<NativeWalletSnapshot>(raw, 'The Fast Wallet snapshot was invalid.'));
      setMessage('Fast Wallet restored. Its full history is now being rebuilt locally.');
    } catch (reason) {
      setMessage(errorMessage(reason, 'The Fast Wallet could not be restored.'));
    } finally {
      setBusy(false);
    }
  };

  const openLocal = async (identityId: string): Promise<FastWalletOpenResponse | null> => {
    setBusy(true); setMessage(null);
    try {
      if (openIdentityId && openIdentityId !== identityId) {
        await invoke<void>('close_fast_wallet', { input: { identityId: openIdentityId } });
      }
      const opened = await invoke<FastWalletOpenResponse>('open_fast_wallet', {
        input: { identityId },
      });
      const raw = await invoke<string>('wallet_snapshot', {
        input: { walletId: opened.walletId },
      });
      setOpenIdentityId(opened.wallet.id);
      setOpenWalletId(opened.walletId);
      setSnapshot(parseNativeJson<NativeWalletSnapshot>(raw, 'The Fast Wallet snapshot was invalid.'));
      setMessage('Fast Wallet is open and synchronizing locally.');
      return opened;
    } catch (reason) {
      setMessage(errorMessage(reason, 'The Fast Wallet could not be opened.'));
      return null;
    } finally {
      setBusy(false);
    }
  };

  const backup = async (wallet: FastWalletRecord) => {
    let walletId = openIdentityId === wallet.id ? openWalletId : null;
    if (!walletId) {
      const opened = await openLocal(wallet.id);
      walletId = opened?.walletId ?? null;
    }
    if (!walletId) return;
    setBusy(true); setMessage(null);
    try {
      const seed = await invoke<string>('present_fast_wallet_recovery_seed', {
        input: {
          walletId,
          registrationId: wallet.id,
          appPassword: backupPassword,
        },
      });
      setBackupPassword('');
      setBackupSeedScreen({ walletId, registrationId: wallet.id, label: wallet.label, seed });
    } catch (reason) {
      setBackupPassword('');
      setMessage(errorMessage(reason, 'The recovery words could not be shown.'));
    } finally {
      setBusy(false);
    }
  };

  const confirmBackupSeed = async () => {
    const seedScreen = backupSeedScreen;
    if (!seedScreen) return;
    setBusy(true);
    try {
      await invoke<void>('confirm_fast_wallet_recovery_seed_backup', {
        input: { walletId: seedScreen.walletId, registrationId: seedScreen.registrationId },
      });
      setBackupSeedScreen(null);
      await load();
      try {
        const updated = await invoke<FastWalletRecord>('enable_encrypted_fast_wallet_alerts', {
          input: {
            identityId: seedScreen.registrationId,
            worker: 'official',
            appPassword: backupPassword,
          },
        });
        setWallets(items => items.map(item => item.id === updated.id ? updated : item));
        setMessage('Recovery words confirmed and encrypted payment alerts are on.');
      } catch (reason) {
        setMessage(errorMessage(
          reason,
          'Recovery words are confirmed, but the encrypted payment-alert setup failed.',
        ));
      } finally {
        setBackupPassword('');
      }
    } catch (reason) {
      setMessage(errorMessage(reason, 'The recovery-word backup could not be confirmed.'));
    } finally {
      setBusy(false);
    }
  };

  const refreshLocal = async () => {
    if (!openWalletId) return;
    setBusy(true);
    try {
      await invoke<void>('start_wallet_refresh', { input: { walletId: openWalletId } });
      const raw = await invoke<string>('wallet_snapshot', { input: { walletId: openWalletId } });
      setSnapshot(parseNativeJson<NativeWalletSnapshot>(raw, 'The Fast Wallet snapshot was invalid.'));
      setMessage('Fast Wallet refresh started.');
    } catch (reason) {
      setMessage(errorMessage(reason, 'The Fast Wallet could not be refreshed.'));
    } finally {
      setBusy(false);
    }
  };

  const closeLocal = async () => {
    if (!openIdentityId) return;
    setBusy(true);
    try {
      await invoke<void>('close_fast_wallet', { input: { identityId: openIdentityId } });
      setOpenIdentityId(null); setOpenWalletId(null); setSnapshot(null);
      setMessage('Fast Wallet closed locally.');
    } catch (reason) {
      setMessage(errorMessage(reason, 'The Fast Wallet could not be closed.'));
    } finally {
      setBusy(false);
    }
  };

  const removeLocal = async (wallet: FastWalletRecord) => {
    if (wallet.status === 'legacy-blocked' || wallet.seedBackupStatus !== 'verified') {
      setRemovalError(null);
      setRemovalCandidate(wallet);
      return;
    }
    if (openIdentityId !== wallet.id || !openWalletId || !snapshot?.synchronized) {
      setMessage('Open this Fast Wallet and wait for local synchronization before removing it.');
      return;
    }
    let balance: bigint;
    try {
      balance = BigInt(snapshot.balanceAtomic);
    } catch {
      setMessage('The Fast Wallet balance could not be verified.');
      return;
    }
    if (balance !== 0n) {
      setMessage('Send the remaining balance before removing this Fast Wallet.');
      return;
    }
    setRemovalError(null);
    setRemovalCandidate(wallet);
  };

  const confirmRemoveLocal = async () => {
    const wallet = removalCandidate;
    if (!wallet) return;
    setBusy(true); setMessage(null);
    try {
      const metadataOnly = wallet.status === 'legacy-blocked' || wallet.seedBackupStatus !== 'verified';
      await invoke<void>(metadataOnly ? 'remove_fast_wallet_entry' : 'remove_fast_wallet', { input: { identityId: wallet.id } });
      setRemovalCandidate(null);
      setRemovalError(null);
      setOpenIdentityId(null); setOpenWalletId(null); setSnapshot(null);
      setReview(null); setRecipient(''); setAmount('');
      await load();
      setMessage(metadataOnly ? 'Fast Wallet removed from this list. Encrypted wallet data was kept for recovery.' : 'Fast Wallet removed from this device.');
    } catch (reason) {
      setRemovalError(errorMessage(reason, 'The Fast Wallet was not removed. Open it, finish the backup and synchronization steps, then try again.'));
    } finally { setBusy(false); }
  };

  const prepareSend = async () => {
    if (!openWalletId || !snapshot?.synchronized) {
      setMessage('Wait until the Fast Wallet is fully synchronized.');
      return;
    }
    const address = recipient.trim();
    const amountAtomic = parseXmrToAtomic(amount);
    const fastWallet = wallets.find(item => item.id === openIdentityId);
    if (!address || !fastWallet) {
      setMessage('Enter a valid Monero recipient address.');
      return;
    }
    if (!amountAtomic || atomicValue(amountAtomic) <= 0n) {
      setMessage('Enter a valid amount.');
      return;
    }
    if (atomicValue(amountAtomic) > atomicValue(snapshot.unlockedBalanceAtomic)) {
      setMessage('The available balance is too low.');
      return;
    }
    setBusy(true); setMessage(null);
    try {
      const validatedAddress = await invoke<string>('validate_recipient_address', {
        input: { address, network: fastWallet.network },
      });
      const raw = await invoke<string>('prepare_transaction', {
        input: {
          walletId: openWalletId,
          address: validatedAddress,
          amountAtomic,
          priority: 'low',
          accountIndex: 0,
        },
      });
      const prepared = parseNativeJson<NativePreparedTransaction>(
        raw,
        'The transaction could not be prepared.',
      );
      if (prepared.status !== 'ok') {
        throw new Error(prepared.error || 'The transaction could not be prepared.');
      }
      setReview(prepared);
    } catch (reason) {
      setMessage(errorMessage(reason, 'The transaction could not be prepared.'));
    } finally {
      setBusy(false);
    }
  };

  const commitSend = async () => {
    if (!openWalletId || !review) return;
    setBusy(true); setMessage(null);
    try {
      const raw = await invoke<string>('commit_transaction', {
        input: {
          walletId: openWalletId,
          pendingId: review.id,
          appPassword: authorizationPassword,
        },
      });
      const result = parseNativeJson<NativePreparedTransaction>(
        raw,
        'The transaction could not be sent.',
      );
      if (result.status !== 'ok') {
        throw new Error(result.error || 'The transaction could not be sent.');
      }
      setRecipient('');
      setAmount('');
      setReview(null);
      setAuthorizationPassword('');
      setMessage('Transaction sent.');
      await refreshLocal();
    } catch (reason) {
      setAuthorizationPassword('');
      setMessage(errorMessage(reason, 'The transaction could not be sent.'));
    } finally {
      setBusy(false);
    }
  };

  const enableAlerts = async (wallet: FastWalletRecord, worker: 'official' | 'private') => {
    setBusy(true); setMessage(null);
    try {
      const updated = await invoke<FastWalletRecord>('enable_encrypted_fast_wallet_alerts', {
        input: {
          identityId: wallet.id,
          worker,
          appPassword: alertsAuthorizationPassword,
        },
      });
      setAlertsAuthorizationPassword('');
      setWallets(items => items.map(item => item.id === updated.id ? updated : item));
      setMessage('Incoming-payment alerts are on. Open the wallet to verify every notification locally.');
    } catch (reason) {
      setAlertsAuthorizationPassword('');
      await load();
      setMessage(errorMessage(reason, 'Payment alerts could not be enabled.'));
    } finally {
      setBusy(false);
    }
  };

  const pairPrivateWorker = async (network: Network) => {
    if (!privateWorkerQr.trim()) {
      setMessage('Scan or paste the QR code from your private scan service.');
      return;
    }
    setBusy(true); setMessage(null);
    try {
      const paired = await invoke<{ fingerprint: string }>('pair_private_fast_wallet_worker', {
        input: {
          workerQr: privateWorkerQr,
          network,
          appPassword: alertsAuthorizationPassword,
        },
      });
      setPrivateWorkerQr('');
      setAlertsAuthorizationPassword('');
      setMessage(`Private scan service ${paired.fingerprint} paired. You can now turn alerts on.`);
    } catch (reason) {
      setAlertsAuthorizationPassword('');
      setMessage(errorMessage(reason, 'The private scan service could not be paired.'));
    } finally {
      setBusy(false);
    }
  };

  const turnOffAlerts = async () => {
    if (!window.confirm('Turn off all Fast Wallet alerts on this device? Your wallets and hosted scan data stay unchanged.')) return;
    setBusy(true); setMessage(null);
    try {
      const updated = await invoke<FastWalletRecord[]>('turn_off_fast_wallet_alerts', {
        input: { appPassword: alertsAuthorizationPassword },
      });
      setAlertsAuthorizationPassword('');
      setWallets(updated);
      setMessage('All payment alerts are off. Your local wallets and hosted scan data are unchanged.');
    } catch (reason) {
      setAlertsAuthorizationPassword('');
      setMessage(errorMessage(reason, 'Payment alerts could not be turned off safely.'));
    } finally {
      setBusy(false);
    }
  };

  const deleteHostedData = async (wallet: FastWalletRecord) => {
    if (!window.confirm(`Delete the hosted scan data for ${wallet.label}? The local wallet and its recovery words stay on this device.`)) return;
    setBusy(true); setMessage(null);
    try {
      const updated = await invoke<FastWalletRecord>('delete_hosted_fast_wallet_data', {
        input: {
          identityId: wallet.id,
          appPassword: alertsAuthorizationPassword,
        },
      });
      setAlertsAuthorizationPassword('');
      setWallets(items => items.map(item => item.id === updated.id ? updated : item));
      setMessage('Hosted scan data deleted. The local Fast Wallet is unchanged.');
    } catch (reason) {
      setAlertsAuthorizationPassword('');
      setMessage(errorMessage(reason, 'Hosted scan data could not be deleted.'));
    } finally {
      setBusy(false);
    }
  };

  if (!linked) {
    return <WalletFeature linked={linked} title="Fast Wallet" text="Fast Wallet needs the native Monero core." />;
  }

  const remoteAlertsAvailable = v1ReleaseFeatures.officialWorker || v1ReleaseFeatures.privateWorkerPairing;
  const anyAlertsOn = wallets.some(wallet => wallet.notificationsEnabled);

  return <section className="fast-wallet-page">
    <header><div><p className="eyebrow">Separate local wallet</p><h2>Fast Wallet</h2><p>A Fast Wallet is an independent software wallet with its own recovery words. Its complete balance and history are rebuilt and verified on this device.</p></div><div className="button-row"><button className="secondary" disabled={busy} onClick={() => void load()} type="button">Refresh list</button>{remoteAlertsAvailable && anyAlertsOn && <button className="quiet-button" disabled={busy || (passwordAuthorization && !alertsAuthorizationPassword)} onClick={() => void turnOffAlerts()} type="button">Turn all alerts off</button>}</div></header>
    <div className="setup-transport"><button className={setupMode === 'create' ? 'selected' : ''} onClick={() => setSetupMode('create')} type="button">Create new</button><button className={setupMode === 'restore' ? 'selected' : ''} onClick={() => setSetupMode('restore')} type="button">Restore</button></div>
    {setupMode === 'restore' ? <article className="fast-wallet-create"><div><h3>Restore a Fast Wallet</h3><p>Your recovery words are entered only in a separate protected system window. The app then scans the blockchain locally to rebuild the complete history.</p></div><div className="fast-wallet-form"><label>Label<input value={label} onChange={event => setLabel(event.target.value)} maxLength={80} /></label><label>Network<select value={restoreNetwork} onChange={event => setRestoreNetwork(event.target.value)}><option value="mainnet">Mainnet</option><option value="stagenet">Stagenet</option><option value="testnet">Testnet</option></select></label><label>Scan from height (optional)<input value={restoreHeight} onChange={event => setRestoreHeight(event.target.value)} inputMode="numeric" placeholder="0 scans the complete blockchain" /></label></div><button className="primary" disabled={busy} onClick={() => void restore()} type="button">{busy ? 'Working…' : 'Enter recovery words securely'}</button></article> : sourceWallet?.kind === 'hardware' ? <article className="fast-wallet-notice"><h3>Open a software wallet</h3><p>Fast Wallet is deliberately not derived from a Ledger account. Create it from an open software-wallet session.</p></article> : !sourceWalletId || !sourceWallet ? <article className="fast-wallet-notice"><h3>Open a software wallet first</h3><p>The open wallet supplies only the network and scan context. The new Fast Wallet uses fresh random entropy and a separate protected credential.</p></article> : <article className="fast-wallet-create"><div><h3>Create a Fast Wallet</h3><p>Creation is manual. Nothing is uploaded and no notification service is enabled.</p></div><div className="fast-wallet-form"><label>Label<input value={label} onChange={event => setLabel(event.target.value)} maxLength={80} /></label><label>Scan from height (optional)<input value={restoreHeight} onChange={event => setRestoreHeight(event.target.value)} inputMode="numeric" placeholder={sourceWallet.restoreHeight ? String(sourceWallet.restoreHeight) : 'Native estimate'} /></label></div><button className="primary" disabled={busy} onClick={() => void create()} type="button">{busy ? 'Working…' : 'Create Fast Wallet locally'}</button></article>}
    <section className="fast-wallet-list"><h3>Your Fast Wallets</h3>{wallets.length === 0 ? <p className="community-empty">No Fast Wallet yet.</p> : wallets.map(wallet => {
      const backedUp = wallet.seedBackupStatus === 'verified';
      const legacy = wallet.status === 'legacy-blocked';
      const opened = openIdentityId === wallet.id;
      return <article className="fast-wallet-row" key={wallet.id}>
        <div className="fast-wallet-row-head"><div><strong>{wallet.label}</strong><span className={legacy || !backedUp ? 'wallet-chip warning' : 'wallet-chip'}>{legacy ? 'Old wallet · disabled' : backedUp ? 'Ready' : 'Backup required'}</span></div><small>{networkLabel(wallet.network)} · local only</small></div>
        <code className="address-output">{backedUp ? wallet.address : 'Address hidden until recovery words are backed up'}</code>
        <p>Independent wallet {wallet.derivationIndex} · scan from {wallet.restoreHeight}</p>
        {!backedUp && !legacy && <div className="fast-wallet-form">{systemAuthorization ? <p className="transaction-note">{appProtection.systemAuth.label} will confirm before the recovery words are shown.</p> : <label>App password<input value={backupPassword} onChange={event => setBackupPassword(event.target.value)} type="password" autoComplete="current-password" /></label>}<button className="primary" disabled={busy || (passwordAuthorization && !backupPassword)} onClick={() => void backup(wallet)} type="button">{systemAuthorization ? `Back up with ${appProtection.systemAuth.label}` : 'Back up recovery words'}</button></div>}
        {remoteAlertsAvailable && backedUp && <section className="fast-wallet-alerts"><div><strong>Incoming-payment alerts</strong><span className={wallet.alertStatus === 'needs-attention' ? 'wallet-chip warning' : 'wallet-chip'}>{wallet.alertStatus === 'on' ? 'Alerts on' : wallet.alertStatus === 'setting-up' ? 'Setting up' : wallet.alertStatus === 'needs-attention' ? 'Needs attention' : 'Off'}</span><p>The selected scan service can recognize incoming payments to this Fast Wallet, but it cannot spend them. The app verifies every alert locally.</p></div>{systemAuthorization ? <p className="transaction-note">Sensitive changes are confirmed with {appProtection.systemAuth.label}.</p> : <label>App password<input value={alertsAuthorizationPassword} onChange={event => setAlertsAuthorizationPassword(event.target.value)} type="password" autoComplete="current-password" /></label>}<div className="button-row">{v1ReleaseFeatures.officialWorker && !wallet.notificationsEnabled && <button className="primary" disabled={busy || (passwordAuthorization && !alertsAuthorizationPassword)} onClick={() => void enableAlerts(wallet, 'official')} type="button">Use recommended TEX8 scan service</button>}{v1ReleaseFeatures.privateWorkerPairing && <button className="quiet-button" disabled={busy} onClick={() => setShowPrivateWorker(value => !value)} type="button">{showPrivateWorker ? 'Hide private setup' : 'Use my own scan service'}</button>}{wallet.assignmentHandle && <button className="danger-button" disabled={busy || (passwordAuthorization && !alertsAuthorizationPassword)} onClick={() => void deleteHostedData(wallet)} type="button">Delete hosted scan data</button>}</div>{v1ReleaseFeatures.privateWorkerPairing && showPrivateWorker && <div className="fast-wallet-form"><p className="transaction-note">Advanced: scan or paste the signed QR code shown by your private service. Its identity is checked in the native app before you approve it.</p><label>Private scan-service QR code<textarea value={privateWorkerQr} onChange={event => setPrivateWorkerQr(event.target.value)} autoCapitalize="none" autoCorrect="off" spellCheck="false" /></label><div className="button-row"><button className="secondary" disabled={busy || !privateWorkerQr.trim() || (passwordAuthorization && !alertsAuthorizationPassword)} onClick={() => void pairPrivateWorker(wallet.network)} type="button">Pair privately</button>{!wallet.notificationsEnabled && <button className="primary" disabled={busy || (passwordAuthorization && !alertsAuthorizationPassword)} onClick={() => void enableAlerts(wallet, 'private')} type="button">Turn on with paired service</button>}</div></div>}</section>}
        {opened && <div className="fast-wallet-live"><strong>Local wallet open</strong><span>{syncLabel(snapshot)}</span><span>{snapshot ? `${formatAtomicXmr(snapshot.balanceAtomic, 12)} XMR · ${formatAtomicXmr(snapshot.unlockedBalanceAtomic, 12)} XMR available` : 'Loading native wallet state…'}</span><p>The local Native Monero Core is the only authority for balance, spent outputs and transactions.</p>{backedUp && snapshot?.synchronized && <div className="fast-wallet-form"><h4>Send from this Fast Wallet</h4><label>Recipient address<input value={recipient} onChange={event => { setRecipient(event.target.value); setReview(null); }} autoComplete="off" spellCheck="false" /></label><label>Amount in XMR<input value={amount} onChange={event => { setAmount(event.target.value); setReview(null); }} inputMode="decimal" /></label>{review ? <><p>Amount: {formatAtomicXmr(review.amountAtomic, 12)} XMR<br />Network fee: {formatAtomicXmr(review.feeAtomic, 12)} XMR</p>{systemAuthorization ? <p className="transaction-note">You will confirm this payment with {appProtection.systemAuth.label}.</p> : <label>App password<input value={authorizationPassword} onChange={event => setAuthorizationPassword(event.target.value)} type="password" autoComplete="current-password" /></label>}<button className="primary" disabled={busy || (passwordAuthorization && !authorizationPassword)} onClick={() => void commitSend()} type="button">{systemAuthorization ? `Confirm with ${appProtection.systemAuth.label} & send` : 'Review securely & send'}</button><button className="quiet-button" disabled={busy} onClick={() => setReview(null)} type="button">Change</button></> : <button className="primary" disabled={busy} onClick={() => void prepareSend()} type="button">Review transaction</button>}</div>}</div>}
        <div className="button-row">{opened ? <><button className="secondary" disabled={busy} onClick={() => void refreshLocal()} type="button">Refresh local wallet</button><button className="quiet-button" disabled={busy} onClick={() => void closeLocal()} type="button">Close Fast Wallet</button><button className="danger-button" disabled={busy || !snapshot?.synchronized || snapshot.balanceAtomic !== '0'} onClick={() => void removeLocal(wallet)} type="button">{wallet.seedBackupStatus === 'verified' ? 'Remove empty Fast Wallet' : 'Remove from list'}</button></> : <><button className="secondary" disabled={busy || wallet.status === 'legacy-blocked'} onClick={() => void openLocal(wallet.id)} type="button">{wallet.status === 'legacy-blocked' ? 'Unavailable' : 'Open locally'}</button>{(wallet.status === 'legacy-blocked' || !backedUp) && <button className="danger-button" disabled={busy} onClick={() => void removeLocal(wallet)} type="button">Remove from list</button>}</>}</div>
      </article>;
    })}</section>
    {message && <p className="setup-message">{message}</p>}
    {removalCandidate && <div className="seed-overlay" role="dialog" aria-modal="true" aria-labelledby="remove-fast-wallet-title"><section className="seed-dialog wallet-remove-dialog"><p className="eyebrow">{removalCandidate.status === 'legacy-blocked' ? 'Remove old Fast Wallet' : 'Remove Fast Wallet'}</p><h2 id="remove-fast-wallet-title">Remove {removalCandidate.label}?</h2><p>{removalCandidate.status === 'legacy-blocked' ? 'This is an old disabled Fast Wallet from an earlier build. Remove it from this app’s list? Its encrypted wallet files are kept for recovery.' : removalCandidate.seedBackupStatus !== 'verified' ? 'The recovery words are not backed up yet. Remove this wallet from the app’s list? Its encrypted wallet file and recovery data will be kept, so no funds are deleted.' : 'This removes only the local wallet from this app. Its recovery words and any funds are not deleted. For safety, the wallet must be open, fully synchronized, and have a zero balance before it can be removed.'}</p>{removalError && <p className="setup-message wallet-list-message" role="alert">{removalError}</p>}<div className="dialog-actions"><button className="quiet-button" disabled={busy} onClick={() => { setRemovalCandidate(null); setRemovalError(null); }} type="button">Cancel</button><button className="danger-button" disabled={busy} onClick={() => void confirmRemoveLocal()} type="button">{busy ? 'Removing…' : removalCandidate.status === 'legacy-blocked' || removalCandidate.seedBackupStatus !== 'verified' ? 'Remove from list' : 'Remove wallet'}</button></div></section></div>}
    {backupSeedScreen && <RecoverySeedBackupScreen label={backupSeedScreen.label} seed={backupSeedScreen.seed} fastWallet busy={busy} onConfirm={() => void confirmBackupSeed()} onDismiss={() => setBackupSeedScreen(null)} />}
  </section>;
}

function WalletFeature({ linked, title, text }: { linked: boolean; title: string; text: string }) { return <section className="empty-state"><img className="empty-mark" src="/monero-mark.png" alt="" /><h2>{title}</h2><p>{text}</p>{!linked && <p className="feature-lock">Available when the local Monero engine is linked.</p>}</section>; }

type SendStep = 'recipient-choice' | 'manual-recipient' | 'address-book' | 'amount' | 'review';

function Send({ linked, walletId, wallet, appProtection, onWalletsChanged }: { linked: boolean; walletId: string | null; wallet: RegisteredWallet | null; appProtection: AppProtectionStatus; onWalletsChanged: () => Promise<void> }) {
  const { t } = useI18n();
  const [address, setAddress] = useState('');
  const [amount, setAmount] = useState('');
  const [step, setStep] = useState<SendStep>('recipient-choice');
  const [sweepAll, setSweepAll] = useState(false);
  const [snapshot, setSnapshot] = useState<NativeWalletSnapshot | null>(null);
  const [review, setReview] = useState<NativePreparedTransaction | null>(null);
  const [authorizationPassword, setAuthorizationPassword] = useState('');
  const [useAuthorizationPasswordFallback, setUseAuthorizationPasswordFallback] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [contacts, setContacts] = useState<RecipientContact[]>(() => loadRecipientContacts());
  const [recentContacts, setRecentContacts] = useState<RecipientContact[]>(() => loadRecentRecipients());
  const [contactLabel, setContactLabel] = useState('');
  const [contactAddress, setContactAddress] = useState('');
  const [scannerOpen, setScannerOpen] = useState(false);
  const accountIndex = wallet?.accountIndex ?? 0;

  const loadSnapshot = useCallback(async (refresh = false) => {
    if (!walletId) return;
    if (refresh) await invoke<void>('start_wallet_refresh', { input: { walletId } });
    const raw = await invoke<string>('wallet_snapshot', { input: { walletId, accountIndex } });
    const next = parseNativeJson<NativeWalletSnapshot>(raw, t('send.preparationFailed'));
    setSnapshot(next);
    return next;
  }, [accountIndex, t, walletId]);
  useEffect(() => {
    if (!linked || !walletId) return;
    void loadSnapshot();
  }, [linked, loadSnapshot, walletId]);

  const validateAndUseRecipient = async (candidate: string) => {
    if (!wallet) { setMessage(t('send.openWallet')); return; }
    try {
      const recipient = candidate.trim();
      const validated = recipient.toLowerCase().endsWith('.mfw')
        ? await invoke<string>('resolve_mfw_name_for_payment', {
            input: { name: recipient, network: wallet.network },
          })
        : await invoke<string>('validate_recipient_address', {
            input: { address: recipient, network: wallet.network },
          });
      setAddress(validated);
      setReview(null);
      setMessage(null);
      setStep('amount');
    } catch (reason) {
      setMessage(errorMessage(reason, t('send.invalidRecipient')));
    }
  };
  const selectRecipient = (contact: RecipientContact) => {
    void validateAndUseRecipient(contact.address);
  };
  const saveContact = async () => {
    const label = contactLabel.trim();
    const recipient = contactAddress.trim();
    if (!label || !recipient) { setMessage('Enter a name and a Monero address.'); return; }
    if (!wallet) { setMessage(t('send.openWallet')); return; }
    let validated: string;
    try {
      validated = await invoke<string>('validate_recipient_address', {
        input: { address: recipient, network: wallet.network },
      });
    } catch {
      setMessage(t('send.invalidRecipient'));
      return;
    }
    const updated = saveRecipientContacts([...contacts, { id: `contact:${Date.now()}`, label, address: validated }]);
    setContacts(updated);
    setContactLabel('');
    setContactAddress('');
    setMessage(null);
  };

  const prepare = async () => {
    if (!walletId) { setMessage(t('send.openWallet')); return; }
    if (!snapshot || !snapshot.synchronized) { setMessage(t('send.waitForSync')); return; }
    const recipient = address.trim();
    if (!recipient) { setMessage(t('send.recipientRequired')); return; }
    if (!wallet) { setMessage(t('send.openWallet')); return; }
    const amountAtomic = parseXmrToAtomic(amount);
    if ((!sweepAll && (!amountAtomic || atomicValue(amountAtomic) <= 0n)) || (sweepAll && atomicValue(snapshot?.unlockedBalanceAtomic) <= 0n)) { setMessage(t('send.validAmount')); return; }
    if (!sweepAll && snapshot && atomicValue(amountAtomic ?? undefined) > atomicValue(snapshot.unlockedBalanceAtomic)) { setMessage(t('send.insufficient')); return; }
    setBusy(true); setMessage(null);
    try {
      let spendSnapshot = snapshot;
      const requiresLedgerRecheck = wallet.kind === 'hardware'
        && wallet.role !== 'fast'
        && (!wallet.ledgerKeyImagesVerifiedAt
          || Number(snapshot.pendingOutputKeyImageCount ?? 0) > 0);
      if (requiresLedgerRecheck) {
        setMessage(t('send.checkingSpendOutputs'));
        await invoke<string>('reconcile_ledger_balance', {
          input: { sourceRegistrationId: wallet.id },
        });
        await onWalletsChanged();
        const refreshedSnapshot = await loadSnapshot();
        if (!refreshedSnapshot?.synchronized
          || Number(refreshedSnapshot.pendingOutputKeyImageCount ?? 0) > 0) {
          throw new Error(t('send.waitForSync'));
        }
        spendSnapshot = refreshedSnapshot;
      }
      const validatedRecipient = await invoke<string>('validate_recipient_address', {
        input: { address: recipient, network: wallet.network },
      });
      if (!sweepAll && atomicValue(amountAtomic ?? undefined) > atomicValue(spendSnapshot?.unlockedBalanceAtomic)) {
        throw new Error(t('send.insufficient'));
      }
      // Keep the normal path identical to mobile: low priority, with the
      // actual fee always calculated by the native wallet before confirmation.
      const raw = await invoke<string>('prepare_transaction', { input: { walletId, registrationId: wallet.id, address: validatedRecipient, amountAtomic: sweepAll ? '' : amountAtomic ?? '', priority: 'low', accountIndex } });
      const prepared = parseNativeJson<NativePreparedTransaction>(raw, t('send.preparationFailed'));
      if (prepared.status !== 'ok') throw new Error(prepared.error || t('send.preparationFailed'));
      setReview(prepared);
      setAuthorizationPassword('');
      setUseAuthorizationPasswordFallback(false);
      if (sweepAll) setAmount(formatAtomicXmr(prepared.amountAtomic, 12));
      setStep('review');
    } catch (reason) { setMessage(errorMessage(reason, t('send.preparationFailed'))); }
    finally { setBusy(false); }
  };

  const commit = async () => {
    if (!walletId || !review) return;
    setBusy(true); setMessage(null);
    try {
      const raw = await invoke<string>('commit_transaction', { input: { walletId, registrationId: wallet?.id, pendingId: review.id, appPassword: authorizationPassword } });
      const result = parseNativeJson<NativePreparedTransaction>(raw, t('send.broadcastFailed'));
      if (result.status !== 'ok') throw new Error(result.error || t('send.broadcastFailed'));
      let ledgerRefreshPending = false;
      if (wallet?.kind === 'hardware' && wallet.role !== 'fast') {
        try {
          await invoke<string>('reconcile_ledger_balance', {
            input: { sourceRegistrationId: wallet.id },
          });
          await onWalletsChanged();
        } catch {
          // Broadcasting already succeeded. Never turn a post-send companion
          // refresh failure into a send failure that could tempt a duplicate
          // payment; retain the last published state and offer manual retry.
          ledgerRefreshPending = true;
        }
      }
      setReview(null); setAuthorizationPassword(''); setUseAuthorizationPasswordFallback(false); setAmount(''); setSweepAll(false); setMessage(t('send.sent')); setStep('recipient-choice');
      setRecentContacts(rememberRecipient(address.trim(), contacts));
      setAddress('');
      if (ledgerRefreshPending) {
        setMessage(t('send.sentLedgerRefreshPending'));
      } else {
        await loadSnapshot(true);
      }
    } catch (reason) { setAuthorizationPassword(''); setMessage(errorMessage(reason, t('send.broadcastFailed'))); }
    finally { setBusy(false); }
  };

  const useMaximum = () => {
    if (!snapshot) return;
    // An empty amount is the native Core's sweep signal. It returns the real
    // spendable amount after the real network fee, never a guessed balance.
    setAmount('');
    setSweepAll(true);
    setReview(null); setMessage(null);
  };
  const enterAmountKey = (key: string) => {
    let next = amount;
    if (key === 'backspace') next = amount.slice(0, -1);
    else if (key === '.') {
      if (amount.includes('.')) return;
      next = amount ? `${amount}.` : '0.';
    } else if (amount === '0') next = key;
    else next = `${amount}${key}`;
    const [, fraction = ''] = next.split('.');
    if (fraction.length > 12 || next.length > 24) return;
    setAmount(next);
    setSweepAll(false);
    setReview(null);
    setMessage(null);
  };
  const pasteRecipient = async () => {
    try {
      const pasted = await navigator.clipboard.readText();
      if (pasted.trim()) {
        setAddress(pasted.trim());
        setReview(null);
        setMessage(null);
      }
    } catch { setMessage(t('send.scanPasteFallback')); }
  };
  const amountAtomic = parseXmrToAtomic(amount) ?? '0';
  const totalAtomic = review ? atomicValue(review.amountAtomic) + atomicValue(review.feeAtomic) + atomicValue(review.dustAtomic) : 0n;

  if (!linked || !walletId) return <WalletFeature linked={linked} title={t('send.title')} text={t('send.openWallet')} />;
  return <section className="transaction-form transaction-page">
    {step === 'recipient-choice' && <><header className="send-screen-header"><p className="eyebrow">{t('send.from')}</p><h2>{t('send.title')}</h2><p>{t('send.subtitle')}</p></header><section className="send-choice-stack"><button className="send-choice-card primary-choice" onClick={() => setScannerOpen(true)} type="button"><span className="send-choice-icon" aria-hidden="true">⌗</span><span><strong>{t('send.scanAddress')}</strong><small>{t('send.scanHint')}</small></span><b aria-hidden="true">›</b></button><div className="send-choice-or"><span />{t('send.or')}<span /></div><button className="send-choice-card" onClick={() => setStep('manual-recipient')} type="button"><span className="send-choice-icon" aria-hidden="true">✎</span><span><strong>{t('send.manualRecipient')}</strong><small>{t('send.manualRecipientHint')}</small></span><b aria-hidden="true">›</b></button><button className="send-choice-card" onClick={() => setStep('address-book')} type="button"><span className="send-choice-icon" aria-hidden="true">◎</span><span><strong>{t('send.addressBook')}</strong><small>Choose a saved recipient.</small></span><b aria-hidden="true">›</b></button>{recentContacts.length > 0 && <section className="send-quick-recipients"><header><strong>{t('send.recentContacts')}</strong><button className="quiet-button" onClick={() => setStep('address-book')} type="button">{t('send.viewMore')}</button></header><div className="recipient-chips">{recentContacts.map((contact) => <button className="recipient-chip" key={contact.id} onClick={() => selectRecipient(contact)} type="button"><b>{contact.label}</b><small>{shortHash(contact.address)}</small></button>)}</div></section>}</section></>}
    {step === 'manual-recipient' && <><button className="quiet-button step-back" onClick={() => { setMessage(null); setStep('recipient-choice'); }} type="button">‹ {t('common.back')}</button><header><h2>{t('send.recipient')}</h2><p>{t('send.manualRecipientHint')}</p></header><label>{t('send.recipient')}<span className="recipient-address-input"><input value={address} onChange={(event) => { setAddress(event.target.value); setReview(null); setMessage(null); }} placeholder={t('send.recipientPlaceholder')} autoComplete="off" spellCheck="false" /><button className="paste-button" onClick={() => void pasteRecipient()} type="button">{t('common.paste')}</button></span></label><section className="recipient-picker" aria-label={t('send.addressBook')}>{contacts.length > 0 && <div><strong>{t('send.addressBook')}</strong><div className="recipient-chips">{contacts.slice(0, 3).map((contact) => <button className={contact.donor ? 'recipient-chip donor' : 'recipient-chip'} key={contact.id} onClick={() => selectRecipient(contact)} type="button"><b>{contact.label}</b><small>{shortHash(contact.address)}</small></button>)}</div><button className="quiet-button address-book-link" onClick={() => setStep('address-book')} type="button">{t('send.viewMore')} ›</button></div>}{recentContacts.length > 0 && <div><strong>{t('send.recentContacts')}</strong><div className="recipient-chips">{recentContacts.map((contact) => <button className="recipient-chip" key={contact.id} onClick={() => selectRecipient(contact)} type="button"><b>{contact.label}</b><small>{shortHash(contact.address)}</small></button>)}</div></div>}</section><button className="primary" onClick={() => { if (!address.trim()) { setMessage(t('send.recipientRequired')); return; } void validateAndUseRecipient(address); }} type="button">{t('common.continue')}</button></>}
    {step === 'address-book' && <><button className="quiet-button step-back" onClick={() => { setMessage(null); setStep('recipient-choice'); }} type="button">‹ {t('common.back')}</button><header><h2>{t('send.addressBook')}</h2><p>Choose a saved recipient. Donation stays first when configured for this release.</p></header><section className="address-book-panel">{contacts.length > 0 ? <div className="address-book-list">{contacts.map((contact) => <button className={contact.donor ? 'address-book-entry donor' : 'address-book-entry'} key={contact.id} onClick={() => selectRecipient(contact)} type="button"><span>{contact.donor ? '♥' : '◎'}</span><div><strong>{contact.label}</strong><small>{shortHash(contact.address)}</small></div><b>›</b></button>)}</div> : <p className="community-empty">No saved addresses yet. Add one below or paste an address instead.</p>}{recentContacts.length > 0 && <div className="address-book-recents"><strong>{t('send.recentContacts')}</strong><div className="recipient-chips">{recentContacts.map((contact) => <button className="recipient-chip" key={contact.id} onClick={() => selectRecipient(contact)} type="button"><b>{contact.label}</b><small>{shortHash(contact.address)}</small></button>)}</div></div>}<div className="address-book-add"><strong>Add address</strong><label>Name<input value={contactLabel} onChange={(event) => setContactLabel(event.target.value)} maxLength={80} /></label><label>{t('send.recipient')}<input value={contactAddress} onChange={(event) => setContactAddress(event.target.value)} autoComplete="off" spellCheck="false" placeholder={t('send.recipientPlaceholder')} /></label><button className="secondary" onClick={saveContact} type="button">Save address</button></div></section></>}
    {step === 'amount' && <><button className="quiet-button step-back" onClick={() => setStep('manual-recipient')} type="button">‹ {t('common.back')}</button><header className="send-screen-header"><h2>{t('send.title')}</h2><p>{t('send.available')}: {snapshot ? `${formatAtomicXmr(snapshot.unlockedBalanceAtomic, 12)} XMR` : t('common.loading')}</p></header><section className="recipient-summary"><span>{t('send.recipient')}</span><strong>{shortHash(address.trim())}</strong><button className="quiet-button" onClick={() => setStep('manual-recipient')} type="button">{t('common.change')}</button></section><section className="send-amount-card"><header><strong>{t('send.amount')}</strong><button className="quiet-button" disabled={!snapshot || busy} onClick={useMaximum} type="button">{t('send.max')}</button></header><output>{amount || '0.0000'}</output><b>XMR</b><div className="send-keypad">{['1', '2', '3', '4', '5', '6', '7', '8', '.', '9', '0', 'backspace'].map(key => <button aria-label={key === 'backspace' ? 'Delete' : key} key={key} onClick={() => enterAmountKey(key)} type="button">{key === 'backspace' ? '⌫' : key}</button>)}</div></section>{sweepAll && <p className="transaction-note">{t('send.sweepAll')}</p>}<button className="primary send-review-button" disabled={busy} onClick={() => void prepare()} type="button">{busy ? t('send.preparing') : t('send.review')}</button></>}
    {step === 'review' && review && <><button className="quiet-button step-back" disabled={busy} onClick={() => { setReview(null); setAuthorizationPassword(''); setUseAuthorizationPasswordFallback(false); setStep('amount'); }} type="button">‹ {t('common.back')}</button><section className="review-card"><header><strong>{t('send.reviewTitle')}</strong><p>{t('send.reviewSubtitle')}</p></header><code>{address.trim()}</code><dl className="review-details"><div><dt>{t('send.amount')}</dt><dd>{formatAtomicXmr(review.amountAtomic, 12)} XMR</dd></div><div><dt>{t('send.networkFee')}</dt><dd>{formatAtomicXmr(review.feeAtomic, 12)} XMR</dd></div><div><dt>{t('send.total')}</dt><dd>{formatAtomicXmr(totalAtomic.toString(), 12)} XMR</dd></div></dl>{appProtection.mode === 'password' || useAuthorizationPasswordFallback ? <label>{appProtection.mode === 'system' ? 'Recovery app password' : 'App password'}<input value={authorizationPassword} onChange={(event) => setAuthorizationPassword(event.target.value)} type="password" autoComplete="current-password" placeholder="Required for final approval" /></label> : <p className="transaction-note">You will confirm this payment with {appProtection.systemAuth.label}.</p>}{appProtection.mode === 'system' && appProtection.passwordConfigured && <button className="quiet-button protection-fallback" disabled={busy} onClick={() => { setUseAuthorizationPasswordFallback(value => !value); setAuthorizationPassword(''); }} type="button">{useAuthorizationPasswordFallback ? `Use ${appProtection.systemAuth.label}` : 'Use recovery app password instead'}</button>}<p className="transaction-note">The operating system will show this exact recipient, amount, and fee once more before broadcast.</p>{wallet?.kind === 'hardware' && <p className="transaction-note">{t('send.ledgerHint')}</p>}{review.error && <p className="setup-message">{review.error}</p>}<button className="primary" disabled={busy || ((appProtection.mode === 'password' || useAuthorizationPasswordFallback) && !authorizationPassword)} onClick={() => void commit()} type="button">{busy ? t('send.sending') : appProtection.mode === 'system' && !useAuthorizationPasswordFallback ? `Confirm with ${appProtection.systemAuth.label}` : t('send.confirm')}</button></section></>}
    {message && <p className="setup-message">{message}</p>}
    {amount && !review && parseXmrToAtomic(amount) && <small className="amount-preview">{formatAtomicXmr(amountAtomic, 12)} XMR</small>}
    <DesktopRecipientQrScanner open={scannerOpen} onClose={() => setScannerOpen(false)} onScanned={(scannedAddress) => { setScannerOpen(false); void validateAndUseRecipient(scannedAddress); }} />
  </section>;
}

function Receive({ linked, walletId, wallet, wallets, manageAddressesRequest, onSelectWallet, onSetup, onActivity }: { linked: boolean; walletId: string | null; wallet: RegisteredWallet | null; wallets: RegisteredWallet[]; manageAddressesRequest: { walletId: string; nonce: number } | null; onSelectWallet: (wallet: RegisteredWallet) => void; onSetup: () => void; onActivity: () => void }) {
  const { t } = useI18n();
  const [address, setAddress] = useState<string | null>(null);
  const [addressIndex, setAddressIndex] = useState(wallet?.addressIndex ?? 0);
  const [label, setLabel] = useState('');
  const [subaddresses, setSubaddresses] = useState<NativeSubaddress[]>([]);
  const [transactions, setTransactions] = useState<NativeTransaction[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showAddressTools, setShowAddressTools] = useState(false);
  const accountIndex = wallet?.accountIndex ?? 0;

  useEffect(() => {
    if (manageAddressesRequest?.walletId === wallet?.id) setShowAddressTools(true);
  }, [manageAddressesRequest, wallet?.id]);

  const load = useCallback(async () => {
    if (!walletId) return;
    setBusy(true);
    try {
      const raw = await invoke<string>('list_subaddresses', { input: { walletId, accountIndex } });
      const nativeAddresses = parseNativeJson<NativeSubaddress[]>(raw, t('receive.addressUnavailable'));
      if (nativeAddresses.length === 0) throw new Error(t('receive.addressUnavailable'));
      const preferredIndex = wallet?.addressIndex ?? 0;
      const selected = nativeAddresses.find((item) => item.addressIndex === preferredIndex) ?? nativeAddresses[0];
      setAddress(selected.address); setAddressIndex(selected.addressIndex);
      nativeAddresses.forEach((item) => upsertDesktopWalletAddress({ walletId, accountIndex: item.accountIndex, addressIndex: item.addressIndex, address: item.address, label: item.label || (item.addressIndex === 0 ? t('receive.primaryAddress') : `Address ${item.addressIndex + 1}`) }));
      setSubaddresses(nativeAddresses);
      setMessage(null);
    }
    catch (reason) { setMessage(errorMessage(reason, t('receive.addressUnavailable'))); }
    finally { setBusy(false); }
  }, [accountIndex, t, wallet?.addressIndex, walletId]);
  const loadTransactions = useCallback(async () => {
    if (!walletId || !wallet?.id) { setTransactions([]); return; }
    const raw = await invoke<string>('registered_wallet_transactions', { input: { registrationId: wallet.id } });
    setTransactions(parseNativeJson<NativeTransaction[]>(raw, t('receive.addressUnavailable')));
  }, [t, wallet?.id, walletId]);

  useEffect(() => { if (linked && walletId) void load(); }, [linked, load, walletId]);
  useEffect(() => {
    if (!linked || !walletId) return;
    const refreshTransactions = () => void loadTransactions().catch((reason) => setMessage(errorMessage(reason, t('receive.addressUnavailable'))));
    refreshTransactions();
    const timer = window.setInterval(refreshTransactions, 10_000);
    return () => window.clearInterval(timer);
  }, [linked, loadTransactions, t, walletId]);
  useEffect(() => {
    let mounted = true;
    if (!address) { setQrCode(null); return () => { mounted = false; }; }
    QRCode.toDataURL(address, { errorCorrectionLevel: 'M', margin: 2, width: 300, color: { dark: '#08070d', light: '#ffffff' } })
      .then((image) => { if (mounted) setQrCode(image); })
      .catch(() => { if (mounted) setMessage(t('receive.addressUnavailable')); });
    return () => { mounted = false; };
  }, [address, t]);

  const copy = async () => {
    if (!address) return;
    try { await navigator.clipboard.writeText(address); setMessage(t('receive.copied')); }
    catch { setMessage(t('receive.copyFailed')); }
  };
  const share = async () => {
    if (!address) return;
    try {
      if (navigator.share) {
        await navigator.share({ title: 'Monero address', text: address });
        setMessage(t('receive.shared'));
      } else {
        await navigator.clipboard.writeText(address);
        setMessage(t('receive.copied'));
      }
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === 'AbortError') return;
      setMessage(t('receive.shareFailed'));
    }
  };
  const subaddress = async () => {
    if (!walletId) return;
    setBusy(true);
    try {
      const raw = await invoke<string>('create_subaddress', { input: { walletId, label: label.trim(), accountIndex } });
      const created = parseNativeJson<NativeSubaddress>(raw, t('receive.subaddressFailed'));
      setAddress(created.address); setAddressIndex(created.addressIndex);
      upsertDesktopWalletAddress({ walletId, accountIndex: created.accountIndex, addressIndex: created.addressIndex, address: created.address, label: created.label || label.trim() });
      const listedRaw = await invoke<string>('list_subaddresses', { input: { walletId, accountIndex } });
      setSubaddresses(parseNativeJson<NativeSubaddress[]>(listedRaw, t('receive.subaddressFailed')));
      setLabel('');
      setMessage(t('receive.subaddressCreated', { account: created.accountIndex, index: created.addressIndex }));
    } catch (reason) { setMessage(errorMessage(reason, t('receive.subaddressFailed'))); }
    finally { setBusy(false); }
  };
  const showOnLedger = async () => {
    if (!walletId) return;
    setBusy(true);
    try {
      const raw = await invoke<string>('show_hardware_wallet_address', { input: { walletId, accountIndex, addressIndex } });
      const status = parseNativeJson<NativeHardwareWalletStatus>(raw, t('receive.ledgerFailed'));
      setMessage(status.connected ? t('receive.ledgerConfirm') : t('receive.ledgerDisconnected'));
    } catch (reason) { setMessage(errorMessage(reason, t('receive.ledgerFailed'))); }
    finally { setBusy(false); }
  };

  return <section className="transaction-form transaction-page receive-page">
    <header><p className="eyebrow">{wallet ? walletDisplayName(wallet) : t('common.wallet')}</p><h2>{t('receive.title')}</h2><p>{t('receive.subtitle')}</p></header>
    <div className="wallet-strip receive-wallet-strip">{wallets.map((item) => <button className={`${item.id === wallet?.id ? 'wallet-mini-card active' : 'wallet-mini-card'}${isFastWalletRegistration(item) ? ' fast' : ''}`} key={item.id} onClick={() => onSelectWallet(item)} type="button"><span>{walletDisplayName(item)}</span><small>{isFastWalletRegistration(item) ? 'FAST WALLET' : item.kind === 'hardware' ? 'LEDGER' : networkLabel(item.network).toUpperCase()}</small><strong>{item.id === wallet?.id && walletId ? t('wallets.use') : item.isOpen ? t('home.openLocal') : t('home.openToCheck')}</strong></button>)}<button className="wallet-mini-card add" onClick={onSetup} type="button"><span>＋</span><strong>{t('home.addWallet')}</strong></button></div>
    {!linked || !walletId ? <WalletFeature linked={linked} title={t('receive.title')} text={t('send.openWallet')} /> : !address ? <button className="primary" disabled={busy} onClick={() => void load()} type="button">{busy ? t('common.loading') : t('receive.showAddress')}</button> : <><section className="receive-simple-card"><div className="receive-qr"><div>{qrCode ? <img src={qrCode} alt="QR code for the displayed Monero receive address" /> : <span>{t('common.loading')}</span>}</div></div><div className="simple-address-row"><code title={address}>{shortHash(address)}</code><button className="copy-icon-button" aria-label={t('receive.copyAddress')} onClick={() => void copy()} title={t('receive.copyAddress')} type="button">⧉</button></div><p>{wallet?.kind === 'hardware' ? t('receive.ledgerHint') : t('receive.qrHint')}</p></section><RecentTransactions hasOpenWallet items={transactions} onActivity={onActivity} /><button className="quiet-button address-tools-toggle" onClick={() => setShowAddressTools((visible) => !visible)} type="button">{showAddressTools ? t('receive.hideAddressTools') : t('receive.manageAddresses')}</button>{showAddressTools && <section className="address-tools"><div className="receive-actions"><button className="secondary" onClick={() => void share()} type="button">{t('receive.shareAddress')}</button>{wallet?.kind === 'hardware' && <button className="secondary" disabled={busy} onClick={() => void showOnLedger()} type="button">{t('receive.verifyLedger')}</button>}</div><section className="subaddress-section"><div><strong>{t('receive.newSubaddress')}</strong><p>{t('receive.qrHint')}</p></div><label>{t('receive.subaddressLabel')}<input value={label} onChange={(event) => setLabel(event.target.value)} placeholder={t('receive.subaddressPlaceholder')} maxLength={80} /></label><button className="secondary" disabled={busy} onClick={() => void subaddress()} type="button">{t('receive.createSubaddress')}</button></section>{subaddresses.some((item) => item.address !== address) && <section className="subaddress-list">{subaddresses.filter((item) => item.address !== address).map((item) => <button key={`${item.accountIndex}-${item.addressIndex}`} onClick={() => { setAddress(item.address); setAddressIndex(item.addressIndex); setMessage(null); }} type="button"><span><strong>{item.label || `${t('receive.primaryAddress')} ${item.accountIndex}/${item.addressIndex}`}</strong><small>{shortHash(item.address)}</small></span><em>{item.accountIndex}/{item.addressIndex}</em></button>)}</section>}</section>}</>}
    {message && <p className="setup-message">{message}</p>}
  </section>;
}

function FastWalletReceive({ appProtection }: { appProtection: AppProtectionStatus }) {
  const [wallets, setWallets] = useState<FastWalletRecord[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [transferStatus, setTransferStatus] = useState<{
    walletId: string;
    status: 'transferring' | 'accepted' | 'failed';
  } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [seedScreen, setSeedScreen] = useState<{ walletId: string; registrationId: string; label: string; seed: string } | null>(null);
  const load = useCallback(async () => {
    try { setWallets(await invoke<FastWalletRecord[]>('list_fast_wallets')); }
    catch (reason) { setMessage(errorMessage(reason, 'Fast Wallets could not be loaded.')); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const copy = async (address: string) => {
    try { await navigator.clipboard.writeText(address); setMessage('Address copied.'); }
    catch { setMessage('The address could not be copied.'); }
  };
  const backUp = async (wallet: FastWalletRecord) => {
    setBusyId(wallet.id); setMessage(null);
    try {
      const opened = await invoke<FastWalletOpenResponse>('open_fast_wallet', { input: { identityId: wallet.id } });
      const seed = await invoke<string>('present_fast_wallet_recovery_seed', {
        input: { walletId: opened.walletId, registrationId: wallet.id, appPassword: '' },
      });
      setSeedScreen({ walletId: opened.walletId, registrationId: wallet.id, label: wallet.label, seed });
    } catch (reason) {
      setMessage(errorMessage(reason, `Could not back up ${wallet.label}.`));
    } finally {
      setBusyId(null);
    }
  };
  const confirmBackup = async () => {
    const current = seedScreen;
    if (!current) return;
    setBusyId(current.registrationId);
    try {
      await invoke<void>('confirm_fast_wallet_recovery_seed_backup', { input: { walletId: current.walletId, registrationId: current.registrationId } });
      setSeedScreen(null);
      setTransferStatus({ walletId: current.registrationId, status: 'transferring' });
      await invoke<FastWalletRecord>('enable_encrypted_fast_wallet_alerts', {
        input: {
          identityId: current.registrationId,
          worker: 'official',
          appPassword: '',
        },
      });
      setTransferStatus({ walletId: current.registrationId, status: 'accepted' });
      await load();
      setMessage('Your Fast Wallet is ready to receive. Cuprate accepted its encrypted viewing data.');
    } catch (reason) {
      setTransferStatus({ walletId: current.registrationId, status: 'failed' });
      setMessage(errorMessage(reason, 'The recovery-word backup could not be confirmed.'));
    } finally {
      setBusyId(null);
    }
  };
  if (wallets.length === 0 && !message) return null;
  return <section className="fast-wallet-receive">
    <header><div><p className="eyebrow">Optional</p><h2>Fast Wallet addresses</h2><p>Use a separate address for faster receiving. Your normal wallet remains private and independent.</p></div></header>
    <div className="fast-wallet-receive-list">{wallets.map((wallet) => {
      const ready = wallet.seedBackupStatus === 'verified';
      const transfer = transferStatus?.walletId === wallet.id ? transferStatus.status : null;
      return <article key={wallet.id}><div><span className={ready ? 'wallet-chip' : 'wallet-chip warning'}>{ready ? 'Ready' : 'One step left'}</span><h3>{wallet.label}</h3><p>{ready ? 'This separate address is ready to receive Monero.' : 'First, safely write down the recovery words.'}</p>{transfer && <div className={`fast-wallet-inline-transfer ${transfer}`} role="status" aria-live="polite"><span aria-hidden="true" /><strong>{transfer === 'accepted' ? 'Cuprate accepted the encrypted view key.' : transfer === 'failed' ? 'Cuprate did not accept the encrypted view key.' : 'Sending encrypted view key to Cuprate…'}</strong></div>}</div>{ready ? <div className="simple-address-row"><code title={wallet.address}>{shortHash(wallet.address)}</code><button className="copy-icon-button" aria-label="Copy Fast Wallet address" onClick={() => void copy(wallet.address)} title="Copy address" type="button">⧉</button></div> : <button className="primary" disabled={busyId === wallet.id} onClick={() => void backUp(wallet)} type="button">{busyId === wallet.id ? 'Opening…' : `Back up with ${appProtection.mode === 'system' ? appProtection.systemAuth.label : 'app password'}`}</button>}</article>;
    })}</div>
    {message && <p className="setup-message">{message}</p>}
    {seedScreen && <RecoverySeedBackupScreen label={seedScreen.label} seed={seedScreen.seed} fastWallet busy={busyId === seedScreen.registrationId} onConfirm={() => void confirmBackup()} onDismiss={() => setSeedScreen(null)} />}
  </section>;
}

function HardwareWalletCard({ walletId }: { walletId: string }) {
  const [status, setStatus] = useState<NativeHardwareWalletStatus | null>(null); const [message, setMessage] = useState<string | null>(null);
  const load = useCallback(async () => { try { const raw = await invoke<string>('wallet_hardware_status', { input: { walletId } }); setStatus(parseNativeJson<NativeHardwareWalletStatus>(raw, 'The Ledger status response was invalid.')); } catch (reason) { setMessage(errorMessage(reason, 'Could not read the Ledger connection status.')); } }, [walletId]);
  useEffect(() => { void load(); }, [load]);
  const reconnect = async () => { try { const raw = await invoke<string>('reconnect_hardware_wallet', { input: { walletId } }); setStatus(parseNativeJson<NativeHardwareWalletStatus>(raw, 'The Ledger reconnect response was invalid.')); setMessage(null); } catch (reason) { setMessage(errorMessage(reason, 'Ledger could not reconnect. Unlock it and open the Monero app, then try again.')); } };
  return <section className="hardware-card"><div><p className="eyebrow">Hardware wallet</p><h2>{status?.deviceName || 'Ledger'}</h2><p>{status ? status.connected ? `Connected · ${status.promptKind || 'ready'}` : 'Disconnected. Unlock it and open the Monero app.' : 'Checking the native hardware-wallet state.'}</p></div><button className="secondary" onClick={() => void reconnect()} type="button">Reconnect Ledger</button>{message && <p className="setup-message">{message}</p>}</section>;
}

function Activity({ linked, walletId, wallet }: { linked: boolean; walletId: string | null; wallet: RegisteredWallet | null }) {
  const { t } = useI18n();
  const [items, setItems] = useState<NativeTransaction[]>([]); const [message, setMessage] = useState<string | null>(null); const [selected, setSelected] = useState<NativeTransaction | null>(null);
  const load = useCallback(async () => { if (!walletId || !wallet?.id) return; try { const raw = await invoke<string>('registered_wallet_transactions', { input: { registrationId: wallet.id } }); setItems(parseNativeJson<NativeTransaction[]>(raw, 'The native transaction history was invalid.')); setMessage(null); } catch (reason) { setMessage(errorMessage(reason, 'Could not load activity.')); } }, [wallet?.id, walletId]);
  useEffect(() => {
    if (!linked || !walletId) return;
    void load();
    const timer = window.setInterval(() => void load(), 10_000);
    return () => window.clearInterval(timer);
  }, [linked, walletId, load]);
  if (!linked || !walletId) return <WalletFeature linked={linked} title={t('activity.title')} text={t('home.openForActivity')} />;
  return <section className="activity-page"><header><div><h2>{t('activity.title')}</h2><p>{t('activity.subtitle')}</p></div></header>{items.length === 0 ? <div className="activity-empty">{t('activity.empty')}</div> : <div className="transaction-list">{items.map((item) => <button className={selected === item ? 'transaction-row selected' : 'transaction-row'} key={`${item.hash}-${item.direction}-${item.timestamp}`} onClick={() => setSelected(item)} type="button"><span className={item.direction === 'in' ? 'tx-direction incoming' : 'tx-direction'}>{item.direction === 'in' ? '↓' : '↑'}</span><div><strong>{item.direction === 'in' ? t('activity.received') : t('activity.sent')} · {formatAtomicXmr(item.amountAtomic, 12)} XMR</strong><small>{item.hash} · {item.confirmations} {t('activity.confirmations').toLowerCase()}{item.label ? ` · ${item.label}` : ''}</small></div><em>{item.failed ? t('activity.failed') : item.pending ? t('activity.pending') : t('activity.confirmed')}</em></button>)}</div>}{selected && <article className="transaction-detail"><header><div><p className="eyebrow">{t('activity.detail')}</p><h2>{selected.direction === 'in' ? t('activity.receivedMonero') : t('activity.sentMonero')}</h2></div><button className="quiet-button" onClick={() => setSelected(null)} type="button">{t('common.close')}</button></header><dl className="transaction-detail-grid"><div><dt>{t('activity.status')}</dt><dd>{selected.failed ? t('activity.failed') : selected.pending ? t('activity.pending') : t('activity.confirmed')}</dd></div><div><dt>{t('activity.amount')}</dt><dd><FixedAtomicXmr value={selected.amountAtomic} /></dd></div><div><dt>{t('activity.fee')}</dt><dd><FixedAtomicXmr value={selected.feeAtomic} /></dd></div><div><dt>{t('activity.confirmations')}</dt><dd>{selected.confirmations}</dd></div><div><dt>{t('activity.blockHeight')}</dt><dd>{selected.blockHeight || t('activity.notIncluded')}</dd></div><div><dt>{t('activity.time')}</dt><dd>{transactionTimestamp(selected.timestamp)}</dd></div><div><dt>{t('activity.account')}</dt><dd>{selected.subaddressAccount}</dd></div><div><dt>{t('activity.indices')}</dt><dd>{selected.subaddressIndices.length ? selected.subaddressIndices.join(', ') : t('activity.notSpecified')}</dd></div></dl>{selected.label && <p><strong>{t('activity.label')}:</strong> {selected.label}</p>}{selected.description && <p><strong>{t('activity.description')}:</strong> {selected.description}</p>}{selected.paymentId && <p><strong>{t('activity.paymentId')}:</strong> <code>{selected.paymentId}</code></p>}<div className="transaction-hash"><strong>{t('activity.hash')}</strong><code>{selected.hash}</code></div>{selected.transfers.length > 0 && <div className="transaction-transfers"><strong>{selected.direction === 'in' ? t('activity.incoming') : t('activity.recipients')}</strong>{selected.transfers.map((transfer, index) => <p key={`${transfer.address}-${index}`}><code>{transfer.address}</code><span>{formatAtomicXmr(transfer.amountAtomic, 12)} XMR</span></p>)}</div>}</article>}{message && <p className="setup-message">{message}</p>}</section>;
}

type AssistantMessage = { id: string; sender: 'assistant' | 'user'; text: string; destination?: Section };
function assistantReply(input: string, wallet: RegisteredWallet | null, walletId: string | null, fastWallets: FastWalletRecord[]): Omit<AssistantMessage, 'id' | 'sender'> {
  const normalized = input.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (/(ledger|nano|hardware|device)/.test(normalized)) return { text: wallet?.kind === 'hardware' && walletId ? 'The open wallet is Ledger-backed. Use the native reconnect and address-confirmation controls; signing authority stays on the Ledger.' : 'Connect and unlock the Ledger Nano, open its Monero app, then use Wallet Setup. Desktop uses the native USB/HID path.', destination: 'setup' };
  if (/(fast|hosted|scanner|view key|viewkey|notification)/.test(normalized)) { return { text: `Fast Wallet is optional. ${fastWallets.length} separate local wallet${fastWallets.length === 1 ? ' exists' : 's exist'}. This device rebuilds the complete history and determines which funds were received or spent. No spending information is uploaded.`, destination: 'wallets' }; }
  if (/(send|pay|transfer|zahlung)/.test(normalized)) return { text: walletId ? 'Send uses a two-step native review and explicit commit. Review the recipient and fee before committing.' : 'Open a wallet first, then Send can prepare and review a native Monero transaction.', destination: 'send' };
  if (/(receive|address|qr|empfang)/.test(normalized)) return { text: walletId ? 'Receive can show the verified local address, create a subaddress, and render its QR locally.' : 'Open a wallet first to read a verified receive address from the native wallet.', destination: 'receive' };
  if (/(community|enthusiast|nearby|meet|treffen)/.test(normalized)) return {
    text: 'Monero Enthusiast is optional. Search and personalization stay on this device, and Community identity remains separate from every wallet.',
    destination: 'enthusiast',
  };
  if (/(privacy|seed|spend|key|private)/.test(normalized)) return { text: 'Seeds, wallet files, private spend keys, and the main wallet private view key remain local. Only the explicit recovery-seed backup view can disclose a seed to this device’s user.', destination: 'settings' };
  return { text: `I can help route Wallet, Send, Receive, Ledger, Fast Wallet, privacy, and Monero Enthusiasts. ${wallet ? `Current wallet: ${walletDisplayName(wallet)} on ${networkLabel(wallet.network)}.` : 'No wallet is currently open.'}` };
}
function Assistant({ wallet, walletId, onNavigate }: { wallet: RegisteredWallet | null; walletId: string | null; onNavigate: (section: Section) => void }) {
  const [input, setInput] = useState(''); const [fastWallets, setFastWallets] = useState<FastWalletRecord[]>([]); const [messages, setMessages] = useState<AssistantMessage[]>([{ id: 'welcome', sender: 'assistant', text: 'Tex8 Assistant can route local wallet features. It never receives wallet keys, seeds, passwords, or transaction authority.' }]);
  useEffect(() => { void invoke<FastWalletRecord[]>('list_fast_wallets').then(setFastWallets).catch(() => undefined); }, []);
  const send = (value: string) => { const text = value.trim(); if (!text) return; const answer = assistantReply(text, wallet, walletId, fastWallets); setMessages((items) => [...items, { id: `user-${Date.now()}`, sender: 'user', text }, { id: `assistant-${Date.now()}`, sender: 'assistant', ...answer }]); setInput(''); };
  const prompts = ['Ledger Nano status', 'Fast Wallet privacy', 'Receive address', 'Send XMR', 'Monero enthusiasts'];
  return <section className="assistant-page"><header><div><p className="eyebrow">Tex8 Shared · local routing</p><h2>Assistant</h2><p>Answers use only the visible desktop state and provide navigation. No prompt is sent to a remote model by this feature.</p></div></header><div className="assistant-messages">{messages.map((message) => <article className={message.sender === 'user' ? 'assistant-message user' : 'assistant-message'} key={message.id}><p>{message.text}</p>{message.destination && <button className="secondary" onClick={() => onNavigate(message.destination!)} type="button">Open {message.destination === 'setup' ? 'Wallet Setup' : message.destination[0].toUpperCase() + message.destination.slice(1)}</button>}</article>)}</div><div className="assistant-prompts">{prompts.map((prompt) => <button className="quiet-button" onClick={() => send(prompt)} key={prompt} type="button">{prompt}</button>)}</div><div className="assistant-composer"><textarea value={input} onChange={(event) => setInput(event.target.value)} placeholder="Ask about wallet features…" maxLength={1000} /><button className="primary" disabled={!input.trim()} onClick={() => send(input)} type="button">Ask</button></div></section>;
}

/**
 * New V1 surface. It is deliberately independent of the legacy Community
 * renderer and receives public readiness flags only.
 */
function MoneroEnthusiastV1() {
  const { language, t } = useI18n();
  const [status, setStatus] = useState<MoneroEnthusiastV1Status | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [account, setAccount] = useState<CommunityV1AccountStatus | null>(null);
  const [content, setContent] = useState<CommunityV1ContentRecord[]>([]);
  const [pending, setPending] = useState<CommunityV1ContactRequest[]>([]);
  const [contacts, setContacts] = useState<CommunityV1Chat[]>([]);
  const [profileName, setProfileName] = useState('');
  const [profileSummary, setProfileSummary] = useState('');
  const [productTitle, setProductTitle] = useState('');
  const [productDescription, setProductDescription] = useState('');
  const [productCategories, setProductCategories] = useState('');
  const [chat, setChat] = useState<CommunityV1Chat | null>(null);
  const [chatMessages, setChatMessages] = useState<CommunityV1MatrixMessage[]>([]);
  const [chatBody, setChatBody] = useState('');
  const [reportPreview, setReportPreview] = useState<CommunityV1SelectedMessage | null>(null);
  const [reportReason, setReportReason] = useState('');
  const [moderationOutcome, setModerationOutcome] = useState<CommunityV1ModerationOutcome | null>(null);
  const [appealReason, setAppealReason] = useState('');
  const [contentOutcomes, setContentOutcomes] = useState<CommunityV1ContentModerationOutcome[]>([]);
  const [contentAppealReason, setContentAppealReason] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchSuggestions, setSearchSuggestions] = useState<CommunityV1QuerySuggestion[]>([]);
  const [searchResults, setSearchResults] = useState<CommunityV1SearchResult[]>([]);
  const [searched, setSearched] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      setStatus(await invoke<MoneroEnthusiastV1Status>('enthusiast_v1_status'));
    } catch (reason) {
      setStatus(null);
      setMessage(errorMessage(reason, t('communityV1.notReady')));
    } finally {
      setLoading(false);
    }
  }, [t]);
  useEffect(() => { void load(); }, [load]);
  const loadPrivateData = useCallback(async () => {
    if (!status?.identityExists || !status.matrixReady) return;
    try {
      const [nextAccount, nextContent, nextPending, nextContacts, nextOutcomes] = await Promise.all([
        invoke<CommunityV1AccountStatus>('enthusiast_v1_account_status'),
        invoke<CommunityV1ContentRecord[]>('enthusiast_v1_list_content'),
        invoke<CommunityV1ContactRequest[]>('enthusiast_v1_pending_contacts'),
        invoke<CommunityV1Chat[]>('enthusiast_v1_accepted_contacts'),
        invoke<CommunityV1ContentModerationOutcome[]>('enthusiast_v1_content_moderation_outcomes'),
      ]);
      setAccount(nextAccount); setContent(nextContent); setPending(nextPending); setContacts(nextContacts); setContentOutcomes(nextOutcomes);
      if (nextAccount.suspensionCaseId) {
        setModerationOutcome(await invoke<CommunityV1ModerationOutcome>('enthusiast_v1_chat_report_outcome', { caseId: nextAccount.suspensionCaseId }));
      } else {
        setModerationOutcome(null);
      }
      const profile = nextContent.find((item) => item.draft.kind === 'profile');
      if (profile) { setProfileName(profile.draft.title); setProfileSummary(profile.draft.summary); }
    } catch (reason) {
      setMessage(errorMessage(reason, t('communityV1.loadFailed')));
    }
  }, [status?.identityExists, status?.matrixReady, t]);
  useEffect(() => { void loadPrivateData(); }, [loadPrivateData]);
  useEffect(() => {
    const prefix = searchQuery.trim();
    if (!status?.catalogReady || prefix.length < 2) {
      setSearchSuggestions([]);
      return;
    }
    const timer = window.setTimeout(() => {
      void invoke<CommunityV1QuerySuggestion[]>('enthusiast_v1_suggestions', {
        input: { prefix, language, limit: 6 },
      }).then(setSearchSuggestions).catch((reason) => {
        console.warn('MONERO_DESKTOP_COMMUNITY suggestions-failed', errorMessage(reason, t('communityV1.suggestionsFailed')));
        setSearchSuggestions([]);
      });
    }, 180);
    return () => window.clearTimeout(timer);
  }, [language, searchQuery, status?.catalogReady, t]);
  const ready = status?.ready === true;
  const begin = async () => {
    setLoading(true); setMessage(null);
    try {
      const command = status?.identityExists ? 'enthusiast_v1_start' : 'enthusiast_v1_initialize';
      setStatus(await invoke<MoneroEnthusiastV1Status>(command));
    } catch (reason) {
      setMessage(errorMessage(reason, t('communityV1.notReady')));
    } finally {
      setLoading(false);
    }
  };
  const saveProfile = async () => {
    setLoading(true); setMessage(null);
    try {
      const existing = content.find((item) => item.draft.kind === 'profile');
      const input = { kind: 'profile', title: profileName.trim(), summary: profileSummary.trim(), roles: [], categories: [], languages: ['en'], coarseRegion: null, radiusKm: null, media: [] };
      if (existing) await invoke('enthusiast_v1_resubmit_content', { publicId: existing.publicId, input });
      else await invoke('enthusiast_v1_submit_content', { input });
      setMessage(t('communityV1.profileSubmitted'));
      await loadPrivateData();
    } catch (reason) {
      setMessage(errorMessage(reason, t('communityV1.profileFailed')));
    } finally {
      setLoading(false);
    }
  };
  const submitProductListing = async () => {
    const categories = Array.from(new Set(productCategories.split(',').map((value) => value.trim()).filter(Boolean))).slice(0, 16);
    if (categories.some((value) => value.length > 64)) {
      setMessage(t('communityV1.productCategoriesInvalid'));
      return;
    }
    setLoading(true); setMessage(null);
    try {
      const input = {
        kind: 'product_listing',
        title: productTitle.trim(),
        summary: productDescription.trim(),
        roles: [],
        categories,
        languages: ['en'],
        coarseRegion: null,
        radiusKm: null,
        media: [],
      };
      await invoke('enthusiast_v1_submit_content', { input });
      setProductTitle(''); setProductDescription(''); setProductCategories('');
      setMessage(t('communityV1.productSubmitted'));
      await loadPrivateData();
    } catch (reason) {
      setMessage(errorMessage(reason, t('communityV1.productFailed')));
    } finally {
      setLoading(false);
    }
  };
  const answerContact = async (requestId: string, accept: boolean) => {
    setLoading(true); setMessage(null);
    try {
      await invoke('enthusiast_v1_respond_contact', { requestId, accept });
      await loadPrivateData();
    } catch (reason) {
      setMessage(errorMessage(reason, t('communityV1.contactFailed')));
    } finally {
      setLoading(false);
    }
  };
  const searchLocalCatalog = async (suggested?: string) => {
    const query = (suggested ?? searchQuery).trim();
    if (!query) return;
    setLoading(true); setMessage(null); setSearchQuery(query); setSearchSuggestions([]);
    try {
      const results = await invoke<CommunityV1SearchResult[]>('enthusiast_v1_search', {
        input: {
          query,
          language,
          limit: 20,
          kinds: [],
          coarseRegion: null,
          includeAdvertising: false,
        },
      });
      setSearchResults(results); setSearched(true);
      void invoke('enthusiast_v1_contribute_query', { query, language }).catch((reason) => {
        console.warn('MONERO_DESKTOP_COMMUNITY query-contribution-failed', errorMessage(reason, 'Query contribution failed.'));
      });
    } catch (reason) {
      setSearchResults([]); setSearched(true);
      setMessage(errorMessage(reason, t('communityV1.searchFailed')));
    } finally {
      setLoading(false);
    }
  };
  const requestSearchContact = async (peerId: string) => {
    setLoading(true); setMessage(null);
    try {
      await invoke('enthusiast_v1_request_contact', { peerId });
      setMessage(t('communityV1.contactRequested'));
      await loadPrivateData();
    } catch (reason) {
      setMessage(errorMessage(reason, t('communityV1.contactFailed')));
    } finally {
      setLoading(false);
    }
  };
  const clearSearchHistory = async () => {
    try {
      await invoke('enthusiast_v1_clear_search_history');
      setSearchSuggestions([]); setMessage(t('communityV1.searchHistoryCleared'));
    } catch (reason) {
      setMessage(errorMessage(reason, t('communityV1.searchHistoryFailed')));
    }
  };
  const enableCommunityNotifications = async () => {
    setLoading(true); setMessage(null);
    try {
      await invoke('enthusiast_v1_enable_notifications', { locale: navigator.language });
      setMessage(t('communityV1.notificationsEnabled'));
    } catch (reason) {
      setMessage(errorMessage(reason, t('communityV1.notificationsFailed')));
    } finally {
      setLoading(false);
    }
  };
  const openChat = async (peerId: string) => {
    setLoading(true); setMessage(null);
    try {
      const descriptor = await invoke<CommunityV1Chat>('enthusiast_v1_open_chat', { peerId });
      setChat(descriptor);
      const page = await invoke<CommunityV1MessagePage>('enthusiast_v1_messages', { roomId: descriptor.roomId, from: null, limit: 50 });
      setChatMessages(page.messages);
    } catch (reason) {
      setMessage(errorMessage(reason, t('communityV1.chatFailed')));
    } finally {
      setLoading(false);
    }
  };
  const refreshChat = async () => {
    if (!chat) return;
    const page = await invoke<CommunityV1MessagePage>('enthusiast_v1_messages', { roomId: chat.roomId, from: null, limit: 50 });
    setChatMessages(page.messages);
  };
  const sendChat = async () => {
    if (!chat || !chatBody.trim()) return;
    setLoading(true); setMessage(null);
    try {
      await invoke('enthusiast_v1_send_message', { roomId: chat.roomId, body: chatBody.trim() });
      setChatBody(''); await refreshChat();
    } catch (reason) {
      setMessage(errorMessage(reason, t('communityV1.sendFailed')));
    } finally {
      setLoading(false);
    }
  };
  const previewReport = async (eventId: string) => {
    if (!chat) return;
    try {
      setReportPreview(await invoke<CommunityV1SelectedMessage>('enthusiast_v1_report_preview', { roomId: chat.roomId, eventId }));
      setReportReason('');
    } catch (reason) {
      setMessage(errorMessage(reason, t('communityV1.reportFailed')));
    }
  };
  const submitReport = async () => {
    if (!chat || !reportPreview || !reportReason.trim()) return;
    setLoading(true);
    try {
      await invoke('enthusiast_v1_report_message', { peerId: chat.peerId, roomId: reportPreview.roomId, eventId: reportPreview.eventId, reason: reportReason.trim(), illegalContentNotice: false, confirmedExactMessage: true });
      setReportPreview(null); setReportReason(''); setMessage(t('communityV1.reportSent'));
    } catch (reason) {
      setMessage(errorMessage(reason, t('communityV1.reportFailed')));
    } finally {
      setLoading(false);
    }
  };
  const blockChat = async () => {
    if (!chat || !window.confirm(t('communityV1.blockConfirm'))) return;
    setLoading(true);
    try {
      await invoke('enthusiast_v1_block_contact', { peerId: chat.peerId });
      setChat(null); setChatMessages([]); await loadPrivateData();
    } catch (reason) {
      setMessage(errorMessage(reason, t('communityV1.blockFailed')));
    } finally {
      setLoading(false);
    }
  };
  const submitAppeal = async () => {
    if (!account?.suspensionCaseId || !appealReason.trim()) return;
    setLoading(true);
    try {
      await invoke('enthusiast_v1_appeal_chat_report', { caseId: account.suspensionCaseId, reason: appealReason.trim() });
      setAppealReason(''); setMessage(t('communityV1.appealSent')); await loadPrivateData();
    } catch (reason) {
      setMessage(errorMessage(reason, t('communityV1.appealFailed')));
    } finally {
      setLoading(false);
    }
  };
  const submitContentAppeal = async (caseId: string) => {
    if (!contentAppealReason.trim()) return;
    setLoading(true);
    try {
      await invoke('enthusiast_v1_appeal_content_moderation', { caseId, reason: contentAppealReason.trim() });
      setContentAppealReason(''); setMessage(t('communityV1.appealSent')); await loadPrivateData();
    } catch (reason) {
      setMessage(errorMessage(reason, t('communityV1.appealFailed')));
    } finally {
      setLoading(false);
    }
  };
  const remove = async () => {
    if (!window.confirm(t('communityV1.deleteConfirm'))) return;
    setLoading(true); setMessage(null);
    try {
      await invoke<void>('enthusiast_v1_delete_identity');
      await load();
    } catch (reason) {
      setMessage(errorMessage(reason, t('communityV1.deleteFailed')));
      setLoading(false);
    }
  };
  return <section className="enthusiast-v1-page">
    <header>
      <div><p className="eyebrow">{t('communityV1.optional')}</p><h2>{t('communityV1.title')}</h2><p>{t('communityV1.subtitle')}</p></div>
      <span className={ready ? 'enthusiast-v1-badge ready' : 'enthusiast-v1-badge'}>{loading ? t('common.loading') : ready ? t('communityV1.ready') : t('communityV1.preparing')}</span>
    </header>
    <article className="enthusiast-v1-separation"><strong>{t('communityV1.walletSeparate')}</strong><p>{t('communityV1.walletSeparateText')}</p></article>
    <div className="enthusiast-v1-features">
      <article><span>⌕</span><div><strong>{t('communityV1.localSearch')}</strong><p>{t('communityV1.localSearchText')}</p></div></article>
      <article><span>◎</span><div><strong>{t('communityV1.privateChat')}</strong><p>{t('communityV1.privateChatText')}</p></div></article>
      <article><span>◌</span><div><strong>{t('communityV1.yourChoice')}</strong><p>{t('communityV1.yourChoiceText')}</p></div></article>
    </div>
    <article className="enthusiast-v1-status">
      <header><strong>{t('communityV1.status')}</strong><button className="secondary" disabled={loading} onClick={() => void load()} type="button">{t('common.refresh')}</button></header>
      <p><span>{t('communityV1.catalog')}</span><b className={status?.catalogReady ? 'ready' : ''}>{status?.catalogReady ? t('communityV1.ready') : t('communityV1.preparing')}</b></p>
      <p><span>{t('communityV1.privateMessages')}</span><b className={status?.matrixReady ? 'ready' : ''}>{status?.matrixReady ? t('communityV1.ready') : t('communityV1.preparing')}</b></p>
      {!ready && <small>{message ?? status?.reason ?? t('communityV1.notReady')}</small>}
      {status?.packaged && !ready && <button className="primary" disabled={loading} onClick={() => void begin()} type="button">{status.identityExists ? t('communityV1.openPrivateChat') : t('communityV1.createProfile')}</button>}
      {status?.identityExists && <button className="danger-button" disabled={loading} onClick={() => void remove()} type="button">{t('communityV1.deleteProfile')}</button>}
    </article>
    {status?.identityExists && status.matrixReady && <div className="enthusiast-v1-workspace">
      {account?.suspended && <article className="feature-lock"><strong>{t('communityV1.suspended')}</strong><p>{t('communityV1.suspendedText')}</p>{moderationOutcome?.decisionReason && <p><strong>{t('communityV1.reason')}:</strong> {moderationOutcome.decisionReason}</p>}{moderationOutcome?.appealPending ? <p>{t('communityV1.appealPending')}</p> : <><label>{t('communityV1.appealReason')}<textarea value={appealReason} onChange={(event) => setAppealReason(event.target.value)} maxLength={2000} /></label><button className="secondary" disabled={loading || !appealReason.trim()} onClick={() => void submitAppeal()} type="button">{t('communityV1.sendAppeal')}</button></>}</article>}
      <article className="enthusiast-v1-search">
        <header><div><strong>{t('communityV1.discovery')}</strong><p>{t('communityV1.discoveryText')}</p></div><button className="quiet-button" disabled={loading} onClick={() => void clearSearchHistory()} type="button">{t('communityV1.clearSearchHistory')}</button></header>
        <form onSubmit={(event) => { event.preventDefault(); void searchLocalCatalog(); }}>
          <input aria-label={t('communityV1.searchLabel')} value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} maxLength={160} placeholder={t('communityV1.searchPlaceholder')} />
          <button className="primary" disabled={loading || !status?.catalogReady || !searchQuery.trim()} type="submit">{t('communityV1.search')}</button>
        </form>
        {searchSuggestions.length > 0 && <div className="enthusiast-v1-suggestions">{searchSuggestions.map((suggestion) => <button className="quiet-button" key={suggestion.queryId} onClick={() => void searchLocalCatalog(suggestion.displayText)} type="button">{suggestion.displayText}</button>)}</div>}
        {searched && (searchResults.length === 0 ? <p className="enthusiast-v1-empty">{t('communityV1.noSearchResults')}</p> : <div className="enthusiast-v1-results">{searchResults.map((result) => <article key={`${result.item.publicId}-${result.item.ownerPublicId}`}><div><small>{result.item.kind === 'profile' ? t('communityV1.kindProfile') : result.item.kind === 'post' ? t('communityV1.kindPost') : result.item.kind === 'service_listing' ? t('communityV1.kindService') : t('communityV1.kindProduct')}</small><strong>{result.item.title}</strong><p>{result.item.summary}</p>{result.item.categories.length > 0 && <span>{result.item.categories.join(' · ')}</span>}</div><button className="secondary" disabled={loading || account?.suspended} onClick={() => void requestSearchContact(result.item.ownerPublicId)} type="button">{t('communityV1.connect')}</button></article>)}</div>)}
      </article>
      <article className="enthusiast-v1-editor">
        <header><div><strong>{t('communityV1.publicProfile')}</strong><p>{t('communityV1.publicProfileText')}</p></div>{content.find((item) => item.draft.kind === 'profile') && <span>{content.find((item) => item.draft.kind === 'profile')?.status.replaceAll('_', ' ')}</span>}</header>
        <label>{t('communityV1.publicName')}<input value={profileName} onChange={(event) => setProfileName(event.target.value)} maxLength={120} /></label>
        <label>{t('communityV1.publicAbout')}<textarea value={profileSummary} onChange={(event) => setProfileSummary(event.target.value)} maxLength={2000} /></label>
        <button className="primary" disabled={loading || account?.suspended || !profileName.trim() || !profileSummary.trim()} onClick={() => void saveProfile()} type="button">{t('communityV1.submitReview')}</button>
        {(() => {
          const profile = content.find((item) => item.draft.kind === 'profile');
          const outcome = profile && contentOutcomes.find((item) => item.publicId === profile.publicId);
          if (!outcome?.decisionReason) return null;
          const canAppeal = outcome.affectedAuthor && ['reject', 'hide', 'remove'].includes(outcome.decision ?? '');
          return <div className="enthusiast-v1-outcome"><strong>{t('communityV1.moderationDecision')}</strong><p>{outcome.decisionReason}</p>{outcome.appealPending ? <small>{t('communityV1.appealPending')}</small> : canAppeal ? <><textarea value={contentAppealReason} onChange={(event) => setContentAppealReason(event.target.value)} maxLength={2000} placeholder={t('communityV1.appealReason')} /><button className="secondary" disabled={loading || !contentAppealReason.trim()} onClick={() => void submitContentAppeal(outcome.caseId)} type="button">{t('communityV1.sendAppeal')}</button></> : null}</div>;
        })()}
      </article>
      <article className="enthusiast-v1-editor">
        <header><div><strong>{t('communityV1.productListing')}</strong><p>{t('communityV1.productListingText')}</p></div></header>
        <label>{t('communityV1.productTitle')}<input value={productTitle} onChange={(event) => setProductTitle(event.target.value)} maxLength={120} /></label>
        <label>{t('communityV1.productDescription')}<textarea value={productDescription} onChange={(event) => setProductDescription(event.target.value)} maxLength={2000} /></label>
        <label>{t('communityV1.productCategories')}<input value={productCategories} onChange={(event) => setProductCategories(event.target.value)} maxLength={512} /><small>{t('communityV1.productCategoriesHint')}</small></label>
        <button className="primary" disabled={loading || account?.suspended || !productTitle.trim() || !productDescription.trim()} onClick={() => void submitProductListing()} type="button">{t('communityV1.submitProduct')}</button>
        {content.filter((item) => item.draft.kind === 'product_listing').map((listing) => <div className="enthusiast-v1-outcome" key={listing.publicId}><strong>{listing.draft.title}</strong><p>{listing.draft.summary}</p><small>{t('communityV1.reviewStatus')}: {listing.status.replaceAll('_', ' ')}</small></div>)}
      </article>
      <section className="enthusiast-v1-contacts">
        <header><div><h3>{t('communityV1.contacts')}</h3><p>{t('communityV1.notificationsText')}</p></div><button className="secondary" disabled={loading} onClick={() => void enableCommunityNotifications()} type="button">{t('communityV1.enableNotifications')}</button></header>
        {pending.length > 0 && <div>{pending.map((request) => <article key={request.requestId}><div><strong>{t('communityV1.contactRequest')}</strong><p>{t('communityV1.contactRequestText')}</p></div><div><button className="quiet-button" disabled={loading} onClick={() => void answerContact(request.requestId, false)} type="button">{t('communityV1.decline')}</button><button className="secondary" disabled={loading} onClick={() => void answerContact(request.requestId, true)} type="button">{t('communityV1.accept')}</button></div></article>)}</div>}
        {contacts.length === 0 ? <p>{t('communityV1.noContacts')}</p> : contacts.map((contact) => <article key={contact.peerId}><div><strong>{t('communityV1.privateContact')}</strong><p>{t('communityV1.privateContactText')}</p></div><button className="secondary" disabled={loading} onClick={() => void openChat(contact.peerId)} type="button">{t('communityV1.openChat')}</button></article>)}
      </section>
      {chat && <article className="enthusiast-v1-chat">
        <header><div><strong>{t('communityV1.privateConversation')}</strong><p>{t('communityV1.chatSafety')}</p></div><button className="quiet-button" onClick={() => { setChat(null); setReportPreview(null); }} type="button">{t('common.close')}</button></header>
        <div className="enthusiast-v1-message-list">{chatMessages.length === 0 ? <p>{t('communityV1.noMessages')}</p> : chatMessages.map((item) => <article className={item.sentByMe ? 'own' : ''} key={item.eventId}><p>{item.body}</p><div><small>{item.sentByMe ? t('communityV1.you') : t('communityV1.contact')}</small>{!item.sentByMe && <button className="quiet-button" onClick={() => void previewReport(item.eventId)} type="button">{t('communityV1.report')}</button>}</div></article>)}</div>
        <textarea value={chatBody} onChange={(event) => setChatBody(event.target.value)} maxLength={2000} placeholder={t('communityV1.messagePlaceholder')} />
        <div className="dialog-actions"><button className="secondary" disabled={loading} onClick={() => void refreshChat()} type="button">{t('common.refresh')}</button><button className="primary" disabled={loading || !chatBody.trim()} onClick={() => void sendChat()} type="button">{t('communityV1.send')}</button></div>
        <button className="danger-button" disabled={loading} onClick={() => void blockChat()} type="button">{t('communityV1.block')}</button>
      </article>}
      {reportPreview && <article className="enthusiast-v1-report" role="dialog" aria-modal="true">
        <strong>{t('communityV1.reviewReport')}</strong><p>{t('communityV1.reviewReportText')}</p><blockquote>{reportPreview.body}</blockquote>
        <label>{t('communityV1.reportReason')}<textarea value={reportReason} onChange={(event) => setReportReason(event.target.value)} maxLength={2000} /></label>
        <div className="dialog-actions"><button className="quiet-button" onClick={() => setReportPreview(null)} type="button">{t('common.cancel')}</button><button className="danger-button" disabled={loading || !reportReason.trim()} onClick={() => void submitReport()} type="button">{t('communityV1.confirmReport')}</button></div>
      </article>}
    </div>}
    <p className="enthusiast-v1-safety">{t('communityV1.safety')}</p>
    {message && <p className="setup-message">{message}</p>}
  </section>;
}

function CommunityConversation({ peer, ownIdentityId, onClose, onBlocked }: { peer: CommunityContact; ownIdentityId: string; onClose: () => void; onBlocked: () => void }) {
  const [messages, setMessages] = useState<CommunityMessage[]>([]); const [body, setBody] = useState(''); const [message, setMessage] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const load = useCallback(async () => { try { setMessages(await invoke<CommunityMessage[]>('community_list_messages', { input: { peerId: peer.identityId, afterMs: 0 } })); setMessage(null); } catch (reason) { setMessage(errorMessage(reason, 'Could not load the private conversation.')); } }, [peer.identityId]);
  useEffect(() => { void load(); }, [load]);
  const send = async () => { if (!body.trim()) return; setBusy(true); try { await invoke<CommunityMessage>('community_send_message', { input: { peerId: peer.identityId, body } }); setBody(''); await load(); } catch (reason) { setMessage(errorMessage(reason, 'Could not send the message.')); } finally { setBusy(false); } };
  const block = async () => { try { await invoke<void>('community_block_profile', { input: { peerId: peer.identityId } }); onBlocked(); } catch (reason) { setMessage(errorMessage(reason, 'Could not block this profile.')); } };
  return <article className="community-conversation"><header><div><p className="eyebrow">Private Community chat</p><h2>{peer.displayName}</h2></div><button className="quiet-button" onClick={onClose} type="button">Close chat</button></header><p className="community-chat-note">Messages are Community content only. Never share a recovery seed, private key, wallet password, or wallet address here.</p><div className="community-messages">{messages.length === 0 ? <p>No messages yet. Say hello when you are ready.</p> : messages.map((item) => <article className={item.senderId === ownIdentityId ? 'community-message own' : 'community-message'} key={item.id}><p>{item.body}</p><small>{item.senderId === ownIdentityId ? 'You' : peer.displayName} · {communityTimestamp(item.sentAtMs)}</small></article>)}</div><div className="community-composer"><textarea value={body} onChange={(event) => setBody(event.target.value)} maxLength={1200} placeholder="Message" /><div><button className="secondary" onClick={() => void load()} type="button">Refresh</button><button className="primary" disabled={busy || !body.trim()} onClick={() => void send()} type="button">{busy ? 'Sending…' : 'Send'}</button></div></div><button className="danger-button" onClick={() => void block()} type="button">Block profile</button>{message && <p className="setup-message">{message}</p>}</article>;
}

function Community() {
  const { t } = useI18n();
  const [profile, setProfile] = useState<CommunityProfile | null>(null); const [nearby, setNearby] = useState<CommunityNearby[]>([]); const [contacts, setContacts] = useState<CommunityContact[]>([]); const [displayName, setDisplayName] = useState(''); const [bio, setBio] = useState(''); const [radiusKm, setRadiusKm] = useState(10); const [areaId, setAreaId] = useState<string | null>(null); const [message, setMessage] = useState<string | null>(null); const [busy, setBusy] = useState(false); const [chatPeer, setChatPeer] = useState<CommunityContact | null>(null); const [reportPeer, setReportPeer] = useState<CommunityProfile | null>(null); const [reportReason, setReportReason] = useState('');
  const locationRefreshStarted = useRef(false);
  // The Community server correctly rejects a nearby lookup until a profile
  // has explicitly opted into one coarse area.  Mobile follows this same
  // rule: loading an anonymous, non-visible profile is a valid empty state,
  // never an offline-server condition.
  const refresh = useCallback(async (activeAreaId = areaId) => { setBusy(true); try { const nextProfile = await invoke<CommunityProfile>('community_load_profile'); const [nextNearby, nextContacts] = await Promise.all([nextProfile.visible && activeAreaId ? invoke<CommunityNearby[]>('community_list_nearby', { input: { radiusKm: nextProfile.radiusKm } }) : Promise.resolve<CommunityNearby[]>([]), invoke<CommunityContact[]>('community_list_contacts')]); setProfile(nextProfile); setDisplayName(nextProfile.displayName); setBio(nextProfile.bio); setRadiusKm(nextProfile.radiusKm); setNearby(nextNearby); setContacts(nextContacts); setMessage(nextProfile.visible && !activeAreaId ? 'Visibility needs a fresh approximate location after every desktop restart.' : null); } catch (reason) { console.warn('Community refresh failed', errorMessage(reason, t('community.offline'))); setMessage(t('community.offline')); } finally { setBusy(false); } }, [areaId, t]);
  useEffect(() => { void refresh(); }, [refresh]);
  // Keep the desktop lifecycle identical to React Native: entering Community
  // asks the OS for one fresh, low-accuracy location. Radius changes never
  // touch GPS. Only the rounded five-character area survives this function.
  useEffect(() => {
    if (locationRefreshStarted.current) return;
    locationRefreshStarted.current = true;
    let active = true;
    void (async () => {
      setBusy(true);
      try {
        let permissions = await checkPermissions();
        if (permissions.location !== 'granted') permissions = await requestPermissions(['location']);
        if (permissions.location !== 'granted') throw new Error('Approximate location permission is required before Community can update its area.');
        const position = await getCurrentPosition({ enableHighAccuracy: false, timeout: 10_000, maximumAge: 0 });
        const approximateArea = approximateAreaForCoordinates(position.coords.latitude, position.coords.longitude);
        if (!active) return;
        setAreaId(approximateArea);
        const current = await invoke<CommunityProfile>('community_load_profile');
        if (current.visible) {
          const updated = await invoke<CommunityProfile>('community_update_profile', { input: { displayName: current.displayName, bio: current.bio, areaId: approximateArea, visible: true, radiusKm: current.radiusKm } });
          if (!active) return;
          setProfile(updated);
          const [nextNearby, nextContacts] = await Promise.all([
            invoke<CommunityNearby[]>('community_list_nearby', { input: { radiusKm: updated.radiusKm } }),
            invoke<CommunityContact[]>('community_list_contacts'),
          ]);
          if (!active) return;
          setNearby(nextNearby); setContacts(nextContacts);
        }
        setMessage(null);
      } catch (reason) {
        if (active) setMessage(errorMessage(reason, 'Approximate location could not be used. Community remains private until location access is allowed.'));
      } finally {
        if (active) setBusy(false);
      }
    })();
    return () => { active = false; };
  }, []);
  const saveProfile = async (visible: boolean, nextAreaId: string | null) => { setBusy(true); try { const next = await invoke<CommunityProfile>('community_update_profile', { input: { displayName, bio, areaId: visible ? nextAreaId : null, visible, radiusKm } }); setProfile(next); if (!visible) setAreaId(null); await refresh(visible ? nextAreaId : null); } catch (reason) { console.warn('Community profile update failed', errorMessage(reason, 'Could not update the Community profile.')); setMessage(errorMessage(reason, 'Could not update the Community profile.')); } finally { setBusy(false); } };
  const enableVisibility = async () => { setBusy(true); try { let permissions = await checkPermissions(); if (permissions.location !== 'granted') permissions = await requestPermissions(['location']); if (permissions.location !== 'granted') throw new Error('Approximate location permission is required before you can become visible.'); const position = await getCurrentPosition({ enableHighAccuracy: false, timeout: 10_000, maximumAge: 60_000 }); const approximateArea = approximateAreaForCoordinates(position.coords.latitude, position.coords.longitude); setAreaId(approximateArea); await saveProfile(true, approximateArea); setMessage('Visible in one broad approximate area. Exact coordinates were discarded.'); } catch (reason) { setMessage(errorMessage(reason, 'Approximate location could not be used.')); } finally { setBusy(false); } };
  const requestContact = async (person: CommunityNearby) => { try { if (person.relationship === 'incoming') await invoke<void>('community_accept_contact', { input: { peerId: person.identityId } }); else await invoke<void>('community_request_contact', { input: { peerId: person.identityId } }); await refresh(); } catch (reason) { setMessage(errorMessage(reason, 'Could not update the connection request.')); } };
  const submitReport = async () => { if (!reportPeer) return; try { await invoke<void>('community_report_profile', { input: { peerId: reportPeer.identityId, reason: reportReason } }); setReportPeer(null); setReportReason(''); setMessage('Report sent to the Community service.'); } catch (reason) { setMessage(errorMessage(reason, 'Could not send the report.')); } };
  if (chatPeer && profile) return <CommunityConversation peer={chatPeer} ownIdentityId={profile.identityId} onClose={() => setChatPeer(null)} onBlocked={() => { setChatPeer(null); void refresh(); }} />;
  return <section className="community-page"><header><div><p className="eyebrow">Optional private discovery</p><h2>Monero enthusiasts</h2><p>Only an anonymous profile and one broad five-character area are sent to the Community service. Wallet addresses, balances, transactions, seeds, and exact coordinates are never included.</p></div><button className="secondary" disabled={busy} onClick={() => void refresh()} type="button">{busy ? 'Working…' : 'Refresh'}</button></header><article className="community-profile-card"><div><h3>Visible nearby</h3><p>{profile?.visible && areaId ? 'Visible in this desktop session within a broad area.' : profile?.visible ? 'Previously visible. Share a fresh approximate area to renew visibility.' : 'Not visible to others.'}</p></div><button className={profile?.visible && areaId ? 'secondary' : 'primary'} disabled={busy} onClick={() => { if (profile?.visible && areaId) void saveProfile(false, null); else void enableVisibility(); }} type="button">{profile?.visible && areaId ? 'Stop visibility' : 'Use approximate location'}</button></article><article className="community-settings"><label>Your public alias<input value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength={80} /></label><label>Short public bio (optional)<textarea value={bio} onChange={(event) => setBio(event.target.value)} maxLength={280} /></label><label>Search area<select value={radiusKm} onChange={(event) => setRadiusKm(Number(event.target.value))}><option value={5}>5 km</option><option value={10}>10 km</option><option value={25}>25 km</option></select></label><button className="secondary" disabled={busy || (profile?.visible === true && !areaId)} onClick={() => void saveProfile(Boolean(profile?.visible && areaId), areaId)} type="button">Save public profile</button>{profile?.visible && !areaId && <p className="feature-lock">Share approximate location again before changing a visible profile.</p>}</article><section className="community-section"><h3>Connections</h3>{contacts.length === 0 ? <p className="community-empty">No accepted contacts yet.</p> : <div className="community-people">{contacts.map((person) => <article key={person.identityId}><div><strong>{person.displayName}</strong><p>{person.status === 'connected' ? 'Accepted contact' : person.status === 'incoming' ? 'Wants to connect' : 'Request sent'}</p></div>{person.status === 'connected' ? <button className="secondary" onClick={() => setChatPeer(person)} type="button">Chat</button> : person.status === 'incoming' ? <button className="secondary" onClick={() => void requestContact({ ...person, approximateDistanceKm: 0, relationship: 'incoming' })} type="button">Accept</button> : null}</article>)}</div>}</section><section className="community-section"><h3>Nearby</h3>{nearby.length === 0 ? <p className="community-empty">No one nearby yet. People appear only when they choose the same broad approximate area.</p> : <div className="community-people">{nearby.map((person) => <article key={person.identityId}><div><strong>{person.displayName}</strong><p>About {person.approximateDistanceKm} km away · {person.relationship === 'connected' ? 'Accepted contact' : person.relationship === 'incoming' ? 'Wants to connect' : person.relationship === 'outgoing' ? 'Request sent' : 'New profile'}</p></div><div className="community-actions">{person.relationship === 'connected' ? <button className="secondary" onClick={() => setChatPeer({ ...person, status: 'connected' })} type="button">Chat</button> : person.relationship === 'outgoing' ? null : <button className="secondary" onClick={() => void requestContact(person)} type="button">{person.relationship === 'incoming' ? 'Accept' : 'Connect'}</button>}<button className="quiet-button" onClick={() => setReportPeer(person)} type="button">Report</button></div></article>)}</div>}</section>{reportPeer && <article className="community-report"><h3>Report {reportPeer.displayName}</h3><textarea value={reportReason} onChange={(event) => setReportReason(event.target.value)} maxLength={500} placeholder="Why are you reporting this profile?" /><div><button className="quiet-button" onClick={() => setReportPeer(null)} type="button">Cancel</button><button className="danger-button" disabled={!reportReason.trim()} onClick={() => void submitReport()} type="button">Send report</button></div></article>}<article className="community-delete"><div><h3>Delete Community profile</h3><p>This removes the anonymous profile, contacts, and messages from the Community server. It never affects wallet files or wallet data.</p></div><button className="danger-button" disabled={busy || !profile} onClick={() => { if (window.confirm('Delete the anonymous Community profile, contacts, and messages?')) void invoke<void>('community_delete_identity').then(() => { setProfile(null); setNearby([]); setContacts([]); setAreaId(null); setDisplayName(''); setBio(''); setMessage('Community profile deleted.'); }).catch((reason) => setMessage(errorMessage(reason, 'Could not delete the Community profile.'))); }} type="button">Delete profile</button></article>{message && <p className="setup-message">{message}</p>}</section>;
}

function settingsProfileSignature(profile: NodeProfile | null) { return profile ? JSON.stringify({ mode: profile.mode, network: profile.network, daemonAddress: profile.daemonAddress, grpcEndpoint: profile.grpcEndpoint, trusted: profile.trusted, useSsl: profile.useSsl, username: profile.username, proxyAddress: profile.proxyAddress, passwordStored: profile.passwordStored }) : ''; }
function defaultNodeProfile(network: Network, mode: NodeProfile['mode'] = 'optimized-grpc'): NodeProfile { const ports: Record<Network, { daemon: number; rpc: number; grpc: number }> = { mainnet: { daemon: 18089, rpc: 18081, grpc: 18091 }, testnet: { daemon: 28089, rpc: 28081, grpc: 28091 }, stagenet: { daemon: 38089, rpc: 38081, grpc: 38091 } }; const values = ports[network]; return { mode, network, daemonAddress: `xmr.tex8.com:${mode === 'original-rpc' ? values.rpc : values.daemon}`, grpcEndpoint: mode === 'original-rpc' ? '' : `xmr.tex8.com:${values.grpc}`, trusted: true, useSsl: false, username: '', proxyAddress: '', passwordStored: false, updatedAt: 0 }; }
function Settings({ status, walletId, wallet, onRevealSeed, onCloseWallet, autoLockEnabled, onAutoLockChange }: { status: WalletCoreStatus | null; walletId: string | null; wallet: RegisteredWallet | null; onRevealSeed: () => void; onCloseWallet: () => void; autoLockEnabled: boolean; onAutoLockChange: (value: boolean) => void }) {
  const [network, setNetwork] = useState<Network>(wallet?.network ?? 'mainnet'); const [profile, setProfile] = useState<NodeProfile | null>(null); const [savedProfile, setSavedProfile] = useState<NodeProfile | null>(null); const [password, setPassword] = useState(''); const [clearPassword, setClearPassword] = useState(false); const [message, setMessage] = useState<string | null>(null); const [busy, setBusy] = useState(false); const [diagnostics, setDiagnostics] = useState<SettingsDiagnostic[]>([]); const [diagnosing, setDiagnosing] = useState(false); const [newPassword, setNewPassword] = useState(''); const [confirmPassword, setConfirmPassword] = useState(''); const [changingPassword, setChangingPassword] = useState(false);
  useEffect(() => { if (wallet?.network) setNetwork(wallet.network); }, [wallet?.network]);
  const load = useCallback(async () => { try { const saved = await invoke<NodeProfile>('load_node_settings', { network }); setProfile(saved); setSavedProfile(saved); setPassword(''); setClearPassword(false); } catch (reason) { setMessage(errorMessage(reason, 'Could not load saved node settings.')); } }, [network]);
  useEffect(() => { void load(); }, [load]);
  const changed = settingsProfileSignature(profile) !== settingsProfileSignature(savedProfile) || Boolean(password) || clearPassword;
  const changeMode = (mode: NodeProfile['mode']) => { if (!profile) return; if (mode === 'custom') { setProfile({ ...profile, mode }); return; } const defaults = defaultNodeProfile(profile.network, mode); setProfile({ ...profile, ...defaults, username: profile.username, proxyAddress: profile.proxyAddress, passwordStored: profile.passwordStored }); };
  const reset = () => { setProfile(defaultNodeProfile(network)); setPassword(''); setClearPassword(false); };
  const save = async () => { if (!profile) return; setBusy(true); try { const appliesToOpenWallet = wallet?.network === profile.network ? walletId : null; const saved = await invoke<NodeProfile>('save_node_settings', { input: { walletId: appliesToOpenWallet, mode: profile.mode, network: profile.network, daemonAddress: profile.daemonAddress, grpcEndpoint: profile.grpcEndpoint, trusted: profile.trusted, useSsl: profile.useSsl, username: profile.username, password, proxyAddress: profile.proxyAddress, clearPassword } }); setProfile(saved); setSavedProfile(saved); setPassword(''); setClearPassword(false); setMessage(appliesToOpenWallet ? 'Node profile saved and applied to the open wallet.' : `Node profile for ${networkLabel(saved.network)} saved.`); } catch (reason) { setPassword(''); setMessage(errorMessage(reason, 'Could not save node settings.')); } finally { setBusy(false); } };
  const runDiagnostics = async () => { setDiagnosing(true); try { const [core, fastWallets] = await Promise.all([invoke<WalletCoreStatus>('wallet_core_status'), invoke<FastWalletRecord[]>('list_fast_wallets').catch(() => [])]); let sync = 'No wallet open'; if (walletId) { try { sync = syncLabel(parseNativeJson<NativeWalletSnapshot>(await invoke<string>('wallet_snapshot', { input: { walletId } }), 'Invalid wallet snapshot.')); } catch { sync = 'Wallet snapshot unavailable'; } } setDiagnostics([{ label: 'Native wallet core', value: core.linked ? 'Linked' : 'Not linked', tone: core.linked ? 'good' : 'warning' }, { label: 'Active wallet', value: wallet ? `${wallet.walletName} · ${networkLabel(wallet.network)}` : 'None', tone: wallet ? 'good' : 'neutral' }, { label: 'Sync', value: sync, tone: sync.startsWith('Synchronized') ? 'good' : 'neutral' }, { label: 'Node', value: profile ? `${profile.mode} · ${profile.daemonAddress}` : 'Loading', tone: profile ? 'good' : 'warning' }, { label: 'gRPC', value: profile?.grpcEndpoint || 'Disabled', tone: profile?.grpcEndpoint ? 'good' : 'neutral' }, { label: 'Fast Wallet identities', value: String(fastWallets.length), tone: 'neutral' }, { label: 'Secrets', value: 'macOS Keychain', tone: 'good' }]); } catch (reason) { setMessage(errorMessage(reason, 'Could not run diagnostics.')); } finally { setDiagnosing(false); } };
  const saveNewPassword = async () => { if (!walletId || !newPassword) { setMessage('Open a wallet and choose a new password first.'); return; } if (newPassword !== confirmPassword) { setMessage('The new passwords do not match.'); return; } setChangingPassword(true); try { await invoke<void>('change_wallet_password', { input: { walletId, newPassword } }); setNewPassword(''); setConfirmPassword(''); setMessage('Wallet password changed. The new password is not stored by the desktop app.'); } catch (reason) { setMessage(errorMessage(reason, 'Could not change the wallet password.')); } finally { setChangingPassword(false); } };
  const torEnabled = profile?.proxyAddress === '127.0.0.1:9050';
  return <section className="settings-page"><header className="settings-header"><img src="/monero-mark.png" alt="" /><div><p className="eyebrow">Monero Fast Wallet</p><h2>Settings</h2><p>Desktop wallet controls mirror the mobile app while keeping keys and credentials local.</p></div><span>Desktop</span></header><section className="settings-section"><header><h3>Wallet</h3><small>{wallet ? `${wallet.walletName} · ${networkLabel(wallet.network)} · ${wallet.kind}` : 'No wallet open'}</small></header><article className="settings-panel settings-wallet-actions"><div><div><strong>Recovery seed</strong><p>{wallet?.kind === 'hardware' ? 'The recovery seed remains on the Ledger device.' : 'Reveal only while this local wallet is open.'}</p></div></div><button className="secondary" disabled={!walletId || wallet?.kind === 'hardware'} onClick={onRevealSeed} type="button">Show recovery seed</button></article><article className="settings-panel password-change"><div><strong>Change wallet password</strong><p>Changing the password requires the wallet to be open. The new password is never saved by this app.</p></div><div className="password-fields"><input value={newPassword} onChange={(event) => setNewPassword(event.target.value)} type="password" autoComplete="new-password" placeholder="New wallet password" /><input value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} type="password" autoComplete="new-password" placeholder="Confirm new password" /><button className="secondary" disabled={!walletId || changingPassword || !newPassword || !confirmPassword} onClick={() => void saveNewPassword()} type="button">{changingPassword ? 'Changing…' : 'Change password'}</button></div></article></section><section className="settings-section"><header><h3>Security</h3><small>Local controls</small></header><article className="settings-panel settings-toggle-row"><div><strong>Auto-lock after 5 minutes</strong><p>Locks the open wallet after the desktop app has been in the background for five minutes.</p></div><label className="toggle"><input checked={autoLockEnabled} onChange={(event) => onAutoLockChange(event.target.checked)} type="checkbox" /><span /></label></article><article className="settings-panel settings-info-row"><div><strong>Secure storage</strong><p>Node credentials and Fast Wallet scanner credentials stay in macOS Keychain. Recovery seeds and spend keys are never stored in this settings view.</p></div><span className="status-good">Keychain</span></article></section><section className="settings-section"><header><h3>Node</h3><small>{changed ? 'Unsaved changes' : savedProfile ? 'Saved' : 'Loading'}</small></header><article className="settings-panel node-settings"><p>{wallet ? `${wallet.walletName} uses its ${networkLabel(wallet.network)} profile when you save that network.` : 'Configure a network profile before opening a wallet.'}</p>{profile && <><div className="settings-field"><span>Network</span><div className="node-mode">{(['mainnet', 'testnet', 'stagenet'] as Network[]).map((item) => <button className={network === item ? 'selected' : ''} onClick={() => setNetwork(item)} key={item} type="button">{networkLabel(item)}</button>)}</div></div><div className="settings-field"><span>Connection</span><div className="node-mode">{([['optimized-grpc', 'Optimized'], ['original-rpc', 'Original RPC'], ['custom', 'Custom']] as const).map(([mode, label]) => <button className={profile.mode === mode ? 'selected' : ''} onClick={() => changeMode(mode)} key={mode} type="button">{label}</button>)}</div></div><div className="node-hint">{profile.mode === 'original-rpc' ? 'Original Monero daemon RPC. gRPC is disabled for this profile.' : profile.mode === 'optimized-grpc' ? 'Optimized Cuprate gRPC profile, matching the mobile default.' : 'Custom node endpoints remain local to this device.'}</div><div className="settings-form-grid"><label>Daemon address<input value={profile.daemonAddress} onChange={(event) => setProfile({ ...profile, daemonAddress: event.target.value })} placeholder="node.example:18089" autoComplete="off" /></label>{profile.mode !== 'original-rpc' && <label>Cuprate gRPC endpoint<input value={profile.grpcEndpoint} onChange={(event) => setProfile({ ...profile, grpcEndpoint: event.target.value })} placeholder="node.example:18091" autoComplete="off" /></label>}<label>Node username <small>Optional</small><input value={profile.username} onChange={(event) => setProfile({ ...profile, username: event.target.value })} autoComplete="off" /></label><label>Node password <small>Optional · Keychain only</small><input value={password} onChange={(event) => { setPassword(event.target.value); setClearPassword(false); }} type="password" autoComplete="new-password" placeholder={profile.passwordStored ? 'Password stored in Keychain' : 'Stored only in Keychain'} /></label><label>SOCKS5 proxy <small>Optional</small><input value={profile.proxyAddress} onChange={(event) => setProfile({ ...profile, proxyAddress: event.target.value })} placeholder="127.0.0.1:9050" autoComplete="off" /></label></div><div className="settings-checkboxes"><label className="checkbox"><input checked={profile.trusted} onChange={(event) => setProfile({ ...profile, trusted: event.target.checked })} type="checkbox" />Trusted node</label><label className="checkbox"><input checked={profile.useSsl} onChange={(event) => setProfile({ ...profile, useSsl: event.target.checked })} type="checkbox" />Use SSL/TLS for daemon RPC</label><label className="checkbox"><input checked={torEnabled} onChange={(event) => setProfile({ ...profile, proxyAddress: event.target.checked ? '127.0.0.1:9050' : '' })} type="checkbox" />Use Tor via local SOCKS5</label>{profile.passwordStored && <label className="checkbox"><input checked={clearPassword} onChange={(event) => setClearPassword(event.target.checked)} type="checkbox" />Forget stored node password</label>}</div><div className="settings-actions"><button className="secondary" onClick={reset} type="button">Reset defaults</button><button className="primary" disabled={busy || !changed} onClick={() => void save()} type="button">{busy ? 'Saving…' : wallet?.network === profile.network && walletId ? 'Save & apply node' : 'Save node profile'}</button></div></>}</article></section><section className="settings-section"><header><h3>Diagnostics</h3><small>{diagnosing ? 'Running…' : diagnostics.length ? 'Updated' : 'Ready'}</small></header><article className="settings-panel">{diagnostics.length > 0 && <div className="settings-diagnostics">{diagnostics.map((item) => <div key={item.label}><span>{item.label}</span><strong className={item.tone ?? 'neutral'}>{item.value}</strong></div>)}</div>}<button className="primary" disabled={diagnosing} onClick={() => void runDiagnostics()} type="button">{diagnosing ? 'Running diagnostics…' : 'Run diagnostics'}</button></article></section><section className="settings-section settings-about"><header><h3>About</h3><small>Local desktop build</small></header><article className="settings-panel"><div><strong>Privacy by design</strong><p>The packaged interface contains no remote web content. Wallet keys, passwords, transaction signing, and recovery seeds remain in the native Monero core.</p></div><div><strong>Market display</strong><p>Dashboard values use XMR/USD, the same default display as the mobile wallet.</p></div><div><strong>Open-source components</strong><p>Built with Tauri, React, Rust, and the pinned fork of Monero libwallet_api.</p></div></article></section><button className="danger-button settings-lock" disabled={!walletId} onClick={onCloseWallet} type="button">Close wallet</button>{message && <p className="setup-message">{message}</p>}</section>;
}

function LeanSettings({ status, walletId, wallet, onRevealSeed, onCloseWallet, onWalletsChanged, autoLockSeconds, onSetAutoLockSeconds, appProtection, onSetAppProtectionMode, onLockApp }: { status: WalletCoreStatus | null; walletId: string | null; wallet: RegisteredWallet | null; onRevealSeed: () => void; onCloseWallet: () => void; onWalletsChanged: () => Promise<void>; autoLockSeconds: number; onSetAutoLockSeconds: (seconds: number) => Promise<void>; appProtection: AppProtectionStatus; onSetAppProtectionMode: (mode: AppProtectionMode, password?: string, currentPassword?: string) => Promise<void>; onLockApp: () => Promise<void> }) {
  const { language, setLanguage, t } = useI18n();
  const [network, setNetwork] = useState<Network>(wallet?.network ?? 'mainnet');
  const [profile, setProfile] = useState<NodeProfile | null>(null);
  const [savedProfile, setSavedProfile] = useState<NodeProfile | null>(null);
  const [nodePassword, setNodePassword] = useState('');
  const [clearPassword, setClearPassword] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [appPassword, setAppPassword] = useState('');
  const [appPasswordConfirm, setAppPasswordConfirm] = useState('');
  const [currentAppPassword, setCurrentAppPassword] = useState('');
  const [appProtectionBusy, setAppProtectionBusy] = useState(false);
  const [autoLockBusy, setAutoLockBusy] = useState(false);
  const [protectionMode, setProtectionMode] = useState<AppProtectionMode>(appProtection.mode ?? 'password');
  const [shareCommunitySearches, setShareCommunitySearches] = useState(true);
  const [computeStatus, setComputeStatus] = useState<ComputeBackendStatus | null>(null);
  const [computeBusy, setComputeBusy] = useState(false);
  const [derivationPerformance, setDerivationPerformance] = useState<DerivationPerformance | null>(null);
  const [performanceMeasuring, setPerformanceMeasuring] = useState(true);
  const [diagnosticReport, setDiagnosticReport] = useState<DiagnosticTestbenchReport | null>(null);
  const [diagnosticProgress, setDiagnosticProgress] = useState<DesktopDiagnosticProgress | null>(null);
  const [diagnosing, setDiagnosing] = useState(false);
  const [ledgerRechecking, setLedgerRechecking] = useState(false);

  useEffect(() => { if (wallet?.network) setNetwork(wallet.network); }, [wallet?.network]);
  useEffect(() => { if (appProtection.mode) setProtectionMode(appProtection.mode); }, [appProtection.mode]);
  const load = useCallback(async () => {
    try {
      const loaded = await invoke<NodeProfile>('load_node_settings', { network });
      setProfile(loaded); setSavedProfile(loaded); setNodePassword(''); setClearPassword(false);
    } catch (reason) { setMessage(errorMessage(reason, t('settings.nodeLoadFailed'))); }
  }, [network, t]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    let mounted = true;
    void invoke<boolean>('enthusiast_v1_query_contribution_enabled')
      .then((enabled) => { if (mounted) setShareCommunitySearches(enabled); })
      .catch(() => undefined);
    return () => { mounted = false; };
  }, []);
  useEffect(() => {
    let mounted = true;
    void invoke<ComputeBackendStatus>('compute_backend_status')
      .then((loaded) => { if (mounted) setComputeStatus(loaded); })
      .catch((reason) => { if (mounted) setMessage(errorMessage(reason, t('settings.computeLoadFailed'))); });
    return () => { mounted = false; };
  }, [t]);
  useEffect(() => {
    let mounted = true;
    void invoke<DerivationPerformance>('derivation_performance')
      .then((measured) => { if (mounted) setDerivationPerformance(measured); })
      .catch(() => undefined)
      .finally(() => { if (mounted) setPerformanceMeasuring(false); });
    return () => { mounted = false; };
  }, []);

  const changed = profile ? settingsProfileSignature(profile) !== settingsProfileSignature(savedProfile) || Boolean(nodePassword) || clearPassword : false;
  const useMode = (mode: NodeProfile['mode']) => {
    if (!profile) return;
    if (mode === 'custom') { setProfile({ ...profile, mode }); return; }
    const defaults = defaultNodeProfile(profile.network, mode);
    setProfile({ ...profile, ...defaults, username: profile.username, proxyAddress: profile.proxyAddress, passwordStored: profile.passwordStored });
  };
  const save = async () => {
    if (!profile) return;
    setBusy(true); setMessage(null);
    try {
      const saved = await invoke<NodeProfile>('save_node_settings', { input: {
        walletId: wallet?.network === profile.network ? walletId : null,
        mode: profile.mode, network: profile.network, daemonAddress: profile.daemonAddress,
        grpcEndpoint: profile.grpcEndpoint, trusted: profile.trusted, useSsl: profile.useSsl,
        username: profile.username, password: nodePassword, proxyAddress: profile.proxyAddress, clearPassword,
      } });
      setProfile(saved); setSavedProfile(saved); setNodePassword(''); setClearPassword(false);
      setMessage(wallet?.network === saved.network && walletId ? t('settings.nodeApplied') : t('settings.nodeSaved', { network: networkLabel(saved.network) }));
    } catch (reason) { setNodePassword(''); setMessage(errorMessage(reason, t('settings.nodeSaveFailed'))); }
    finally { setBusy(false); }
  };
  const saveAppProtection = async () => {
    const needsPassword = protectionMode === 'password';
    if (needsPassword && appPassword !== appPasswordConfirm) { setMessage('The two app passwords do not match.'); return; }
    if (needsPassword && appPassword.length < 12) { setMessage('Use an app password with at least 12 characters.'); return; }
    if (appProtection.mode === 'password' && !currentAppPassword) { setMessage('Enter your current app password first.'); return; }
    setAppProtectionBusy(true); setMessage(null);
    try { await onSetAppProtectionMode(protectionMode, appPassword, currentAppPassword); setAppPassword(''); setAppPasswordConfirm(''); setCurrentAppPassword(''); setMessage(protectionMode === 'system' ? `${appProtection.systemAuth.label} now protects this app.` : 'Your app password now protects this app.'); }
    catch (reason) { setCurrentAppPassword(''); setMessage(errorMessage(reason, 'App protection could not be changed.')); }
    finally { setAppProtectionBusy(false); }
  };
  const updateCommunitySearchSharing = async (enabled: boolean) => {
    setShareCommunitySearches(enabled);
    try {
      setShareCommunitySearches(await invoke<boolean>('enthusiast_v1_set_query_contribution_enabled', { enabled }));
    } catch (reason) {
      setShareCommunitySearches(!enabled);
      setMessage(errorMessage(reason, t('settings.shareSearchesFailed')));
    }
  };
  const updateComputeBackend = async (preference: ComputeBackendPreference) => {
    setComputeBusy(true); setMessage(null);
    try {
      setComputeStatus(await invoke<ComputeBackendStatus>('set_compute_backend', { preference }));
    } catch (reason) {
      setMessage(errorMessage(reason, t('settings.computeSaveFailed')));
    } finally {
      setComputeBusy(false);
    }
  };
  const updateAutoLock = async (seconds: number) => {
    setAutoLockBusy(true); setMessage(null);
    try {
      await onSetAutoLockSeconds(seconds);
      setMessage(`The app will lock after ${seconds < 3600 ? `${seconds / 60} minutes` : `${seconds / 3600} hours`} without user activity.`);
    } catch (reason) {
      setMessage(errorMessage(reason, 'The inactivity timeout could not be changed.'));
    } finally {
      setAutoLockBusy(false);
    }
  };
  const runDiagnosticTestbench = async () => {
    setDiagnosing(true);
    setDiagnosticReport(null);
    setDiagnosticProgress({ completed: 0, total: 12, label: 'Starting diagnostic testbench' });
    setMessage(null);
    try {
      const report = await runDesktopWalletDiagnosticTestbench({
        network,
        walletId,
        onProgress: setDiagnosticProgress,
      });
      setDiagnosticReport(report);
      setMessage(report.failed > 0
        ? `Diagnostics found ${report.failed} failed test${report.failed === 1 ? '' : 's'}.`
        : 'The diagnostic testbench completed.');
    } catch (reason) {
      setMessage(errorMessage(reason, 'The diagnostic testbench could not be completed.'));
    } finally {
      setDiagnosing(false);
      setDiagnosticProgress(null);
    }
  };
  const recheckLedgerSpendOutputs = async () => {
    if (!wallet || wallet.kind !== 'hardware' || wallet.role === 'fast') return;
    setLedgerRechecking(true);
    setMessage(null);
    try {
      await invoke<string>('reconcile_ledger_balance', {
        input: { sourceRegistrationId: wallet.id },
      });
      await onWalletsChanged();
      setMessage(t('settings.recheckLedgerComplete'));
    } catch (reason) {
      setMessage(errorMessage(reason, t('settings.recheckLedgerFailed')));
    } finally {
      setLedgerRechecking(false);
    }
  };
  return <section className="settings-page">
    <header className="settings-header"><img src="/monero-mark.png" alt="" /><div><p className="eyebrow">Monero Fast Wallet</p><h2>{t('settings.title')}</h2><p>{t('settings.subtitle')}</p></div><span>{status?.linked ? t('settings.ready') : t('settings.checking')}</span></header>
    <section className="settings-section"><header><h3>{t('settings.language')}</h3><small>{t('settings.languageHint')}</small></header>
      <article className="settings-panel settings-language"><button className={language === 'de' ? 'selected' : ''} onClick={() => setLanguage('de')} type="button">Deutsch</button><button className={language === 'en' ? 'selected' : ''} onClick={() => setLanguage('en')} type="button">English</button></article>
    </section>
    <section className="settings-section"><header><h3>{t('settings.performance')}</h3><small>{computeBusy ? t('settings.computeChecking') : computeStatus?.gpuAvailable ? t('settings.computeGpuReady') : t('settings.computeCpuReady')}</small></header>
      <article className="settings-panel"><div><strong>{t('settings.computeBackend')}</strong><p>{t('settings.computeHint')}</p></div><div className="node-mode">{([['auto', t('settings.computeAuto')], ['cpu', t('settings.computeCpu')], ['gpu', t('settings.computeGpu')]] as const).map(([preference, label]) => <button className={computeStatus?.preference === preference ? 'selected' : ''} disabled={computeBusy} onClick={() => void updateComputeBackend(preference)} key={preference} type="button">{label}</button>)}</div><p>{computeStatus?.gpuAvailable ? t('settings.computeDevice', { device: computeStatus.deviceName || computeStatus.gpuKind.toUpperCase() }) : t('settings.computeFallback')}</p></article>
      <article className="settings-panel"><div><strong>{t('settings.scanPerformance')}</strong><p>{t('settings.scanPerformanceHint')}</p></div><div className="settings-diagnostics">{([['CPU', derivationPerformance?.cpu], ['Metal', derivationPerformance?.metal], ['CUDA', derivationPerformance?.cuda]] as const).map(([label, measured]) => <div key={label}><span>{label}</span><strong className={measured?.verified ? 'good' : 'neutral'}>{performanceMeasuring ? t('settings.performanceMeasuring') : measured?.verified ? t('settings.derivationsPerSecond', { rate: new Intl.NumberFormat(language === 'de' ? 'de-DE' : 'en-US').format(measured.derivationsPerSecond) }) : t('settings.performanceUnavailable')}</strong></div>)}</div></article>
    </section>
    <section className="settings-section"><header><h3>{t('settings.communityPrivacy')}</h3><small>{shareCommunitySearches ? t('settings.notificationsReady') : t('settings.notificationsOff')}</small></header>
      <article className="settings-panel settings-toggle-row"><div><strong>{t('settings.shareSearches')}</strong><p>{t('settings.shareSearchesHint')}</p></div><label className="toggle"><input checked={shareCommunitySearches} onChange={(event) => void updateCommunitySearchSharing(event.target.checked)} type="checkbox" /><span /></label></article>
    </section>
    <section className="settings-section"><header><h3>{t('settings.wallet')}</h3><small>{wallet ? `${walletDisplayName(wallet)} · ${networkLabel(wallet.network)}` : t('settings.noWalletOpen')}</small></header>
      <article className="settings-panel settings-wallet-actions"><div><strong>{t('settings.recoverySeed')}</strong><p>{wallet?.kind === 'hardware' ? t('settings.seedHardware') : t('settings.seedHint')}</p></div><button className="secondary" disabled={!walletId || wallet?.kind === 'hardware'} onClick={onRevealSeed} type="button">{t('settings.showRecoverySeed')}</button></article>
      {wallet?.kind === 'hardware' && wallet.role !== 'fast' && <article className="settings-panel settings-wallet-actions"><div><strong>{t('settings.recheckLedger')}</strong><p>{t('settings.recheckLedgerHint')}</p></div><button className="secondary" disabled={!walletId || ledgerRechecking} onClick={() => void recheckLedgerSpendOutputs()} type="button">{ledgerRechecking ? t('settings.recheckingLedger') : t('settings.recheckLedger')}</button></article>}
      <article className="settings-panel settings-info-row"><div><strong>{t('settings.unlock')}</strong><p>{t('settings.unlockHint')}</p></div><span className="status-good">{t('settings.keychain')}</span></article>
    </section>
    <section className="settings-section"><header><h3>{t('settings.security')}</h3><small>{t('settings.localDevice')}</small></header>
      <article className="settings-panel app-protection-settings">
        <div><strong>App lock</strong><p>Choose one secure way to unlock this app before selecting saved wallets.</p></div>
        <div className="settings-actions"><button className="secondary" disabled={appProtectionBusy} onClick={() => void onLockApp()} type="button">Lock app now</button></div>
        <div className="protection-mode-choices compact">
          <button className={protectionMode === 'system' ? 'selected' : ''} disabled={!appProtection.systemAuth.available || appProtectionBusy} onClick={() => { setProtectionMode('system'); setAppPassword(''); setAppPasswordConfirm(''); }} type="button"><span>◎</span><strong>{appProtection.systemAuth.label}</strong><small>{appProtection.systemAuth.available ? 'Recommended · quick and protected by your device' : appProtection.systemAuth.detail}</small></button>
          <button className={protectionMode === 'password' ? 'selected' : ''} disabled={appProtectionBusy} onClick={() => { setProtectionMode('password'); setAppPassword(''); setAppPasswordConfirm(''); }} type="button"><span>•••</span><strong>App password</strong><small>A separate password only for this app</small></button>
        </div>
        {appProtection.mode === 'password' && <div className="password-fields"><input value={currentAppPassword} onChange={(event) => setCurrentAppPassword(event.target.value)} type="password" autoComplete="current-password" placeholder="Current app password" /></div>}
        {protectionMode === 'password' && <div className="password-fields"><input value={appPassword} onChange={(event) => setAppPassword(event.target.value)} type="password" autoComplete="new-password" placeholder="New app password (at least 12 characters)" /><input value={appPasswordConfirm} onChange={(event) => setAppPasswordConfirm(event.target.value)} type="password" autoComplete="new-password" placeholder="Confirm password" /></div>}
        <button className="primary protection-save" disabled={appProtectionBusy || (appProtection.mode === 'password' && !currentAppPassword) || (protectionMode === 'password' && (!appPassword || !appPasswordConfirm))} onClick={() => void saveAppProtection()} type="button">{appProtectionBusy ? 'Saving…' : protectionMode === 'system' ? `Use ${appProtection.systemAuth.label}` : 'Set app password'}</button>
        <small>{protectionMode === 'system' ? `${appProtection.systemAuth.label} uses your Mac sign-in as backup. No extra app password is needed.` : 'This password is used only for Monero Fast Wallet.'}</small>
      </article>
      <article className="settings-panel settings-toggle-row"><div><strong>{t('settings.autoLock')}</strong><p>Lock all wallets together after this period without keyboard, pointer, touch, or scroll activity.</p></div><label><span className="sr-only">Inactivity timeout</span><select value={autoLockSeconds} disabled={autoLockBusy} onChange={(event) => void updateAutoLock(Number(event.target.value))}><option value={60}>1 minute</option><option value={300}>5 minutes</option><option value={900}>15 minutes</option><option value={1800}>30 minutes (default)</option><option value={3600}>1 hour</option><option value={0}>Never (not recommended)</option></select></label></article>
    </section>
    <section className="settings-section"><header><h3>{t('settings.node')}</h3><small>{changed ? t('settings.unsaved') : savedProfile ? t('settings.saved') : t('settings.loading')}</small></header>
      <article className="settings-panel node-settings">{profile && <>
        <p>{wallet ? t('settings.nodeForWallet', { name: walletDisplayName(wallet), network: networkLabel(profile.network) }) : t('settings.nodeChoose')}</p>
        <div className="settings-field"><span>{t('settings.network')}</span><div className="node-mode">{(['mainnet', 'testnet', 'stagenet'] as Network[]).map((item) => <button className={network === item ? 'selected' : ''} onClick={() => setNetwork(item)} key={item} type="button">{networkLabel(item)}</button>)}</div></div>
        <div className="settings-field"><span>{t('settings.connection')}</span><div className="node-mode">{([['optimized-grpc', t('settings.optimized')], ['original-rpc', t('settings.originalRpc')], ['custom', t('settings.custom')]] as const).map(([mode, title]) => <button className={profile.mode === mode ? 'selected' : ''} onClick={() => useMode(mode)} key={mode} type="button">{title}</button>)}</div></div>
        <div className="settings-form-grid"><label>{t('settings.daemonAddress')}<input value={profile.daemonAddress} onChange={(event) => setProfile({ ...profile, daemonAddress: event.target.value })} autoComplete="off" /></label>{profile.mode !== 'original-rpc' && <label>{t('settings.grpcEndpoint')}<input value={profile.grpcEndpoint} onChange={(event) => setProfile({ ...profile, grpcEndpoint: event.target.value })} autoComplete="off" /></label>}<label>{t('settings.nodeUsername')} <small>{t('common.optional')}</small><input value={profile.username} onChange={(event) => setProfile({ ...profile, username: event.target.value })} autoComplete="off" /></label><label>{t('settings.nodePassword')} <small>{t('settings.optionalKeychain')}</small><input value={nodePassword} onChange={(event) => { setNodePassword(event.target.value); setClearPassword(false); }} type="password" autoComplete="new-password" placeholder={profile.passwordStored ? t('settings.passwordStored') : t('settings.passwordKeychain')} /></label><label>{t('settings.socks5Proxy')} <small>{t('common.optional')}</small><input value={profile.proxyAddress} onChange={(event) => setProfile({ ...profile, proxyAddress: event.target.value })} placeholder="127.0.0.1:9050" autoComplete="off" /></label></div>
        <div className="settings-checkboxes"><label className="checkbox"><input checked={profile.trusted} onChange={(event) => setProfile({ ...profile, trusted: event.target.checked })} type="checkbox" />{t('settings.trustedNode')}</label><label className="checkbox"><input checked={profile.useSsl} onChange={(event) => setProfile({ ...profile, useSsl: event.target.checked })} type="checkbox" />{t('settings.tls')}</label>{profile.passwordStored && <label className="checkbox"><input checked={clearPassword} onChange={(event) => setClearPassword(event.target.checked)} type="checkbox" />{t('settings.forgetNodePassword')}</label>}</div>
        <div className="settings-actions"><button className="secondary" onClick={() => { setProfile(defaultNodeProfile(network)); setNodePassword(''); setClearPassword(false); }} type="button">{t('settings.resetDefaults')}</button><button className="primary" disabled={busy || !changed} onClick={() => void save()} type="button">{busy ? t('settings.saving') : t('settings.saveNode')}</button></div>
      </>}</article>
    </section>
    <section className="settings-section"><header><h3>Diagnostic testbench</h3><small>{diagnosing ? 'Running live tests' : diagnosticReport ? 'Last run complete' : 'Ready'}</small></header>
      <article className="settings-panel diagnostic-testbench">
        <div><strong>Safe end-to-end checks</strong><p>Tests the native Core, protected storage, shared node connection, real block throughput, wallet fan-out, Fast Wallet hosting, key derivation and Ledger transport. It never sends funds or changes wallet hosting.</p></div>
        {diagnosing && diagnosticProgress && <div className="diagnostic-progress" role="status" aria-live="polite"><div><span>{diagnosticProgress.label}</span><strong>{diagnosticProgress.completed}/{diagnosticProgress.total}</strong></div><progress value={diagnosticProgress.completed} max={diagnosticProgress.total} /></div>}
        {diagnosticReport && <>
          <div className="diagnostic-summary" aria-label="Diagnostic test summary">
            <DiagnosticCount label="Passed" value={diagnosticReport.passed} status="pass" />
            <DiagnosticCount label="Warnings" value={diagnosticReport.warnings} status="warning" />
            <DiagnosticCount label="Failed" value={diagnosticReport.failed} status="fail" />
            <DiagnosticCount label="Skipped" value={diagnosticReport.skipped} status="skipped" />
          </div>
          <div className="diagnostic-results">{diagnosticReport.tests.map(test => <article className="diagnostic-test" key={test.id}>
            <header><div><small>{test.category}</small><strong>{test.label}</strong></div><span className={`diagnostic-badge ${test.status}`}>{diagnosticStatusLabel(test.status)}</span></header>
            <p>{test.summary}</p>
            {test.metrics.length > 0 && <dl>{test.metrics.map(metric => <div key={`${test.id}-${metric.label}`}><dt>{metric.label}</dt><dd>{metric.value}{metric.unit ? ` ${metric.unit}` : ''}</dd></div>)}</dl>}
            <small className="diagnostic-duration">{test.durationMs} ms</small>
          </article>)}</div>
          <p className="diagnostic-total">Total test time: {diagnosticReport.durationMs} ms</p>
        </>}
        <button className="primary" disabled={diagnosing} onClick={() => void runDiagnosticTestbench()} type="button">{diagnosing ? 'Running testbench…' : 'Run full testbench'}</button>
      </article>
    </section>
    <section className="settings-section settings-about"><header><h3>{t('settings.about')}</h3><small>{t('settings.localDesktop')}</small></header><article className="settings-panel"><div><strong>{t('settings.privacyByDesign')}</strong><p>{t('settings.privacyText')}</p></div><div><strong>{t('settings.marketDisplay')}</strong><p>{t('settings.marketText')}</p></div></article></section>
    <button className="danger-button settings-lock" disabled={!walletId} onClick={onCloseWallet} type="button">{t('settings.closeWallet')}</button>
    {message && <p className="setup-message">{message}</p>}
  </section>;
}

function DiagnosticCount({ label, value, status }: { label: string; value: number; status: DiagnosticTestStatus }) {
  return <div className={`diagnostic-count ${status}`}><strong>{value}</strong><span>{label}</span></div>;
}

function diagnosticStatusLabel(status: DiagnosticTestStatus): string {
  if (status === 'pass') return 'Passed';
  if (status === 'warning') return 'Warning';
  if (status === 'fail') return 'Failed';
  return 'Skipped';
}

function SensitiveAuthorizationOverlay({ title, description, password, mode, systemLabel, allowPasswordFallback, busy, onPasswordChange, onConfirm, onDismiss }: { title: string; description: string; password: string; mode: AppProtectionMode; systemLabel: string; allowPasswordFallback: boolean; busy: boolean; onPasswordChange: (value: string) => void; onConfirm: () => void; onDismiss: () => void }) {
  const [usePasswordFallback, setUsePasswordFallback] = useState(false);
  const usesPassword = mode === 'password' || usePasswordFallback;
  return <div className="seed-overlay" role="dialog" aria-modal="true" aria-labelledby="sensitive-authorization-title"><section className="seed-dialog"><p className="eyebrow">Confirm it is you</p><h2 id="sensitive-authorization-title">{title}</h2><p>{description}</p>{usesPassword && <input autoFocus value={password} onChange={(event) => onPasswordChange(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && password) onConfirm(); }} type="password" autoComplete="current-password" placeholder={mode === 'system' ? 'Recovery app password' : 'App password'} />}{mode === 'system' && allowPasswordFallback && <button className="quiet-button protection-fallback" disabled={busy} onClick={() => { setUsePasswordFallback(value => !value); onPasswordChange(''); }} type="button">{usePasswordFallback ? `Use ${systemLabel}` : 'Use recovery app password instead'}</button>}<div className="dialog-actions"><button className="quiet-button" disabled={busy} onClick={onDismiss} type="button">Cancel</button><button className="primary" disabled={busy || (usesPassword && !password)} onClick={onConfirm} type="button">{busy ? 'Confirming…' : usesPassword ? 'Continue securely' : `Confirm with ${systemLabel}`}</button></div></section></div>;
}

function RecoverySeedBackupScreen({ label, seed, fastWallet = false, busy, onConfirm, onDismiss }: { label: string; seed: string; fastWallet?: boolean; busy: boolean; onConfirm: () => void; onDismiss: () => void }) {
  const [writtenDown, setWrittenDown] = useState(false);
  const words = useMemo(() => seed.trim().split(/\s+/).filter(Boolean), [seed]);
  return <div className="seed-overlay recovery-seed-overlay" role="dialog" aria-modal="true" aria-labelledby="recovery-seed-title">
    <section className="recovery-seed-screen">
      <header><img src="/monero-mark.png" alt="" /><div><p className="eyebrow">{fastWallet ? 'Fast Wallet backup' : 'Wallet backup'}</p><h2 id="recovery-seed-title">Write down your recovery words</h2></div></header>
      <p className="recovery-seed-intro"><strong>{label}</strong> can only be restored with these words. Write them down in this exact order and keep the paper somewhere safe.</p>
      <section className="recovery-seed-warning"><span>!</span><div><strong>Never share these words</strong><p>Anyone who has them can access your wallet. Monero Fast Wallet will never ask you to send them to anyone.</p></div></section>
      <ol className="recovery-seed-words" aria-label="Recovery words">{words.map((word, index) => <li key={`${index}-${word}`}><span>{index + 1}</span><b>{word}</b></li>)}</ol>
      <label className="seed-confirm recovery-seed-check"><input checked={writtenDown} onChange={(event) => setWrittenDown(event.target.checked)} type="checkbox" />I have written down all {words.length} words in the right order.</label>
      <div className="dialog-actions recovery-seed-actions"><button className="quiet-button" disabled={busy} onClick={onDismiss} type="button">I’ll do this later</button><button className="primary" disabled={busy || !writtenDown} onClick={onConfirm} type="button">{busy ? 'Saving…' : 'I have saved my words'}</button></div>
    </section>
  </div>;
}

function FastWalletTransferOverlay({ status }: { status: Exclude<FastWalletTransferStatus, 'idle'> }) {
  const accepted = status === 'accepted';
  const failed = status === 'failed';
  return <div className="seed-overlay fast-wallet-transfer-overlay" role="status" aria-live="polite" aria-atomic="true">
    <section className="seed-dialog fast-wallet-transfer-dialog">
      <img src="/monero-mark.png" alt="" />
      <p className="eyebrow">Fast Wallet</p>
      <h2>{accepted ? 'Connected' : failed ? 'Connection needs attention' : 'Connecting securely'}</h2>
      <div className={`fast-wallet-transfer-state ${status}`}>
        <span className="fast-wallet-transfer-led" aria-hidden="true" />
        <strong>{accepted
          ? 'Cuprate scan service accepted the encrypted view key.'
          : failed
            ? 'Cuprate scan service did not accept the encrypted view key.'
            : 'Sending encrypted view key to the Cuprate scan service…'}</strong>
      </div>
      <p>Your spend key and recovery words never leave this device.</p>
    </section>
  </div>;
}
