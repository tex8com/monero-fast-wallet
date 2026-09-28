import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useI18n } from '../i18n';
import type {
  NetworkSyncStatus,
  WalletSnapshot,
} from '../services/NativeMoneroWallet';
import type { ConnectivityRouteState } from '../services/ConnectivityState';
import type { WalletRuntimeStatus } from '../services/WalletState';
import { walletSnapshotIsSynchronized } from '../services/WalletSynchronization';
import {
  networkSyncFailureCode,
  networkSyncFailureTranslationKey,
} from '../services/NetworkSyncFailure';
import { colors, radius } from '../theme/colors';
import {
  presentWalletSync,
  updateWalletSyncEta,
  type WalletReadinessPhase,
  type WalletSyncEtaState,
} from '../../../../packages/wallet-shared/src/walletSync';
import {
  displaySyncPercent,
  formatSyncPercent,
  formatWalletDerivationRate,
  presentNetworkSync,
  walletSyncDerivationsPerSecond,
} from '../../../../packages/wallet-shared/src/networkSync';
import {
  formatMobileNetworkSyncRate,
  updateMobileNetworkSyncRateWindow,
  type MobileNetworkSyncRateWindow,
} from '../services/MobileNetworkSyncRate';

type SyncStatusBarProps = {
  compact?: boolean;
  error?: string;
  expanded?: boolean;
  progress?: number;
  readinessPhase?: WalletReadinessPhase;
  networkStatus?: NetworkSyncStatus;
  onExpandedChange?: (expanded: boolean) => void;
  snapshot?: WalletSnapshot;
  spendReady?: boolean;
  syncStartHeight?: number;
  status: WalletRuntimeStatus;
  subtitle?: string;
  torStatus?: ConnectivityRouteState;
  walletName?: string;
};

export default function SyncStatusBar({
  compact,
  error,
  expanded: controlledExpanded,
  progress,
  readinessPhase,
  networkStatus,
  onExpandedChange,
  snapshot,
  spendReady = true,
  syncStartHeight,
  status,
  subtitle,
  torStatus,
  walletName,
}: SyncStatusBarProps) {
  const { dateLocale, t } = useI18n();
  const presentationSnapshot = snapshotWithNetworkScanProgress(
    snapshot,
    networkStatus,
  );
  const presentationStartHeight =
    syncStartHeight ?? snapshot?.walletHeight;
  const presentation = presentWalletSync(presentationSnapshot, {
    // A shared downloader may serve wallets with different restore heights.
    // Only the selected wallet's own first snapshot is a valid fallback
    // baseline for its percentage.
    startHeight: presentationStartHeight,
  });
  const network = presentNetworkSync(networkStatus);
  const networkRate = useAggregateNetworkRate(networkStatus);
  const walletDerivationRate = walletSyncDerivationsPerSecond(networkStatus);
  const networkFailure = networkSyncFailureCode(networkStatus);
  const etaSeconds = useSyncEta(presentation, networkStatus);
  const connectionElapsedSeconds = useElapsedSeconds(
    Boolean(networkStatus && !network.ready && !network.failed && network.busy),
  );
  const hasSyncError = status === 'error' || Boolean(error) || network.failed;
  const walletHeightProgress = blockHeightProgress(
    presentation.walletHeight,
    presentation.targetHeight,
  );
  const spendOutputPhase =
    readinessPhase === 'scanning-spend-outputs' ||
    readinessPhase === 'retrying-spent-output-node';
  const walletProgress =
    spendOutputPhase
      ? undefined
      : presentation.coreConfirmed
      ? 100
      : presentation.phase === 'finalizing'
      ? undefined
      : snapshot
      ? walletHeightProgress ?? presentation.progress ?? 0
      : progress ?? 0;
  // A wallet cache at the tip does not prove that the one process-wide
  // downloader has finished an older shared range. Keep these two progress
  // sources independent on mobile just as on desktop.
  const blockchainCurrent =
    network.downloadedHeight && network.downloadedHeight > 0
      ? network.downloadedHeight
      : network.chainHeight;
  const blockchainProgress = network.ready
    ? 100
    : blockHeightProgress(blockchainCurrent, network.targetHeight) ??
      network.progress ??
      0;
  const blockchainConnected = network.ready || network.connected;
  const torReady = !torStatus || torStatus.connected;
  const torConnecting = Boolean(
    torStatus && !torStatus.connected && torStatus.phase !== 'error',
  );
  const connected = blockchainConnected && torReady;
  const connecting =
    torConnecting || (!blockchainConnected && !network.failed && network.busy);
  const walletOpened =
    Boolean(snapshot) && (status === 'open' || status === 'syncing');
  const showWalletSync = blockchainConnected && walletOpened;
  const walletDetail =
    readinessPhase === 'retrying-spent-output-node'
      ? t('sync.spendOutputsNodeRetry')
      : readinessPhase === 'scanning-spend-outputs'
      ? t('sync.spendOutputsChecking')
      : readinessPhase === 'waiting-ledger'
      ? t('sync.waitingLedger')
      : readinessPhase === 'connecting-ledger'
      ? t('sync.connectingLedger')
      : readinessPhase === 'persisting-wallet'
      ? t('sync.persistingWallet')
      : readinessPhase === 'recovering-session'
      ? t('sync.recoveringSession')
      : resolveDetail(
          status,
          snapshot,
          hasSyncError,
          presentation.phase,
          walletProgress,
          t,
        );
  const blockchainDetail =
    blockchainProgress === 100
      ? t('sync.synced')
      : resolveNetworkDetail(network.phase, network.failed, networkFailure, t);
  const blockchainExtra =
    network.failed && (networkStatus?.consecutiveFailures ?? 0) > 0
      ? t('sync.retryAttempt', {
          count: networkStatus?.consecutiveFailures ?? 0,
        })
      : network.phase === 'selecting-provider' ||
        network.phase === 'initializing-transport'
      ? t('sync.startingConnectionElapsed', {
          seconds: connectionElapsedSeconds,
        })
      : undefined;
  const walletEta =
    presentation.phase === 'syncing' ? formatSyncEta(etaSeconds, t) : undefined;
  const fullySynced =
    showWalletSync &&
    spendReady &&
    (readinessPhase === undefined || readinessPhase === 'ready') &&
    presentation.coreConfirmed &&
    (networkStatus ? network.ready : true) &&
    torReady &&
    !hasSyncError;
  const walletIdentity = snapshot?.id ?? walletName ?? 'wallet';
  const [internalExpanded, setInternalExpanded] = React.useState(
    () => !fullySynced,
  );
  const expanded = controlledExpanded ?? internalExpanded;
  const updateExpanded = React.useCallback(
    (nextExpanded: boolean) => {
      if (controlledExpanded === undefined) {
        setInternalExpanded(nextExpanded);
      }
      onExpandedChange?.(nextExpanded);
    },
    [controlledExpanded, onExpandedChange],
  );
  const previousSyncState = React.useRef({ fullySynced, walletIdentity });
  const compactStatus = hasSyncError
    ? networkFailure
      ? networkFailure === 'server-response'
        ? t('sync.failureServerResponseShort')
        : t(networkSyncFailureTranslationKey(networkFailure))
      : t('sync.error')
    : torConnecting
    ? t('topBar.connectingTor')
    : spendOutputPhase
    ? walletDetail
    : walletSnapshotIsSynchronized(snapshot) && !spendReady
    ? t('sync.ledgerSigningPreparationRequired')
    : fullySynced
    ? t('sync.synced')
    : !networkStatus || network.ready
    ? walletDetail
    : blockchainDetail;

  React.useEffect(() => {
    const previous = previousSyncState.current;
    if (previous.walletIdentity !== walletIdentity) {
      updateExpanded(!fullySynced);
    } else if (!previous.fullySynced && fullySynced) {
      // Collapse once after completion. A user who opens it again remains in
      // control, and routine one-block tip checks cannot make the card jump.
      updateExpanded(false);
    }
    previousSyncState.current = { fullySynced, walletIdentity };
  }, [fullySynced, updateExpanded, walletIdentity]);

  return (
    <View
      style={[s.wrap, compact && s.wrapCompact, !expanded && s.wrapCollapsed]}
      testID="sync-status-popup"
    >
      <View style={s.connectionRow}>
        <Text style={s.connectionTitle} numberOfLines={1}>
          {walletName ?? t('common.wallet')}
        </Text>
        <Pressable
          accessibilityLabel={
            expanded ? t('sync.hideDetails') : t('sync.showDetails')
          }
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          hitSlop={8}
          onPress={() => updateExpanded(!expanded)}
          style={({ pressed }) => [
            s.statusToggle,
            pressed && s.statusTogglePressed,
          ]}
          testID="sync-status-toggle"
        >
          <Text
            numberOfLines={1}
            style={[
              s.compactStatus,
              fullySynced && s.compactStatusReady,
              hasSyncError && s.compactStatusError,
            ]}
          >
            {compactStatus}
          </Text>
          <View
            accessibilityLabel={
              torConnecting
                ? t('topBar.connectingTor')
                : fullySynced
                ? t('sync.synced')
                : connected
                ? compactStatus
                : connecting
                ? t('sync.connectingNode')
                : t('sync.nodeOffline')
            }
            style={[
              s.statusLed,
              fullySynced && s.statusLedReady,
              !connected && !connecting && s.statusLedOffline,
            ]}
            testID="sync-connection-led"
          />
          <Text style={s.toggleChevron}>{expanded ? '−' : '+'}</Text>
        </Pressable>
      </View>
      {expanded ? (
        <View style={s.expandedBody} testID="sync-status-details">
          <SyncProgressRow
            current={blockchainCurrent}
            detail={blockchainDetail}
            confirmedComplete={network.ready}
            extra={blockchainExtra}
            label={t('sync.blockchainData')}
            percent={blockchainProgress}
            rate={
              networkRate === undefined
                ? undefined
                : t('sync.networkRate', {
                    rate: formatMobileNetworkSyncRate(networkRate, dateLocale),
                  })
            }
            target={network.targetHeight}
            testID="blockchain-progress"
            variant="blockchain"
          />
          {showWalletSync ? (
            <>
              <View style={s.divider} />
              <SyncProgressRow
                current={presentation.walletHeight}
                confirmedComplete={presentation.coreConfirmed}
                detail={walletDetail}
                extra={
                  presentation.phase === 'finalizing'
                    ? t('sync.coreConfirming')
                    : walletEta
                }
                label={
                  spendOutputPhase
                    ? t('sync.spendOutputs')
                    : t('sync.wallet')
                }
                percent={walletProgress}
                rate={
                  walletDerivationRate === undefined
                    ? undefined
                    : t('sync.derivationRate', {
                        rate: formatWalletDerivationRate(
                          walletDerivationRate,
                          dateLocale,
                        ),
                      })
                }
                target={presentation.targetHeight}
                testID="wallet-progress"
                variant="wallet"
              />
            </>
          ) : null}
          {subtitle ? (
            <Text style={s.subtitle} numberOfLines={2}>
              {subtitle}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/**
 * Native shared sync owns the Monero wallet while blocks are scanned, so a
 * live snapshot can legitimately lag behind. Use only the selected wallet's
 * committed cursor for presentation; the shared chain cursor can belong to a
 * different restore range. Persisted wallet state remains Core-owned.
 */
export function snapshotWithNetworkScanProgress(
  snapshot: WalletSnapshot | undefined,
  networkStatus: NetworkSyncStatus | undefined,
): WalletSnapshot | undefined {
  if (
    !snapshot ||
    !networkStatus ||
    networkStatus.joinedWallets < 1 ||
    !['fetching-blocks', 'fanout', 'scanning'].includes(networkStatus.state)
  ) {
    return snapshot
      ? {
          ...snapshot,
          synchronized: walletSnapshotIsSynchronized(snapshot),
        }
      : snapshot;
  }

  const walletHeight = Math.max(
    snapshot.walletHeight,
    networkStatus.priorityWalletHeight,
  );
  const daemonTargetHeight = Math.max(
    snapshot.daemonTargetHeight,
    networkStatus.targetHeight,
  );

  return {
    ...snapshot,
    walletHeight,
    daemonHeight: Math.max(
      snapshot.daemonHeight,
      networkStatus.downloadedHeight,
    ),
    daemonTargetHeight,
    synchronized: walletSnapshotIsSynchronized({
      ...snapshot,
      walletHeight,
      daemonHeight: Math.max(
        snapshot.daemonHeight,
        networkStatus.downloadedHeight,
      ),
      daemonTargetHeight,
    }),
  };
}

function SyncProgressRow({
  confirmedComplete,
  current,
  detail,
  extra,
  label,
  percent,
  rate,
  target,
  testID,
  variant,
}: {
  confirmedComplete: boolean;
  current?: number;
  detail: string;
  extra?: string;
  label: string;
  percent?: number;
  rate?: string;
  target?: number;
  testID: string;
  variant: 'blockchain' | 'wallet';
}) {
  const { t } = useI18n();
  const normalizedPercent = displaySyncPercent(percent, confirmedComplete);
  const complete = confirmedComplete;
  const blocksRemaining =
    current !== undefined && target !== undefined
      ? Math.max(target - current, 0)
      : undefined;
  const fillWidth = `${normalizedPercent ?? 0}%` as `${number}%`;
  return (
    <View style={s.progressSection} testID={testID}>
      <View style={s.topRow}>
        <View style={s.titleGroup}>
          <Text style={s.label}>{label}</Text>
          <Text style={s.detail} numberOfLines={2}>
            {detail}
          </Text>
        </View>
        <Text style={[s.percent, normalizedPercent === 100 && s.percentReady]}>
          {normalizedPercent === undefined
            ? '—'
            : t('sync.percent', {
                percent: formatSyncPercent(normalizedPercent),
              })}
        </Text>
      </View>
      <View style={s.track}>
        <View
          style={[
            s.fill,
            variant === 'blockchain' ? s.fillBlockchain : s.fillWallet,
            { width: fillWidth },
          ]}
        />
      </View>
      {!complete && (blocksRemaining !== undefined || rate || extra) ? (
        <View style={s.metrics}>
          <View style={s.metricsPrimary}>
            {blocksRemaining !== undefined ? (
              <Text style={s.metric} numberOfLines={1}>
                {t('sync.blocksRemaining', {
                  count: formatBlockCount(blocksRemaining),
                })}
              </Text>
            ) : null}
            {rate ? <Text style={s.metricStrong}>{rate}</Text> : null}
          </View>
          {extra ? <Text style={s.metricExtra}>{extra}</Text> : null}
        </View>
      ) : null}
    </View>
  );
}

function resolveNetworkDetail(
  phase: ReturnType<typeof presentNetworkSync>['phase'],
  failed: boolean,
  failure: ReturnType<typeof networkSyncFailureCode>,
  t: ReturnType<typeof useI18n>['t'],
): string {
  if (failed) return t(networkSyncFailureTranslationKey(failure));
  switch (phase) {
    case 'selecting-provider':
      return t('sync.selectingSource');
    case 'initializing-transport':
      return t('sync.startingConnection');
    case 'reconnecting':
      return t('sync.retryingNode');
    case 'fetching-blocks':
    case 'waiting-next-batch':
    case 'scanning-wallets':
      return t('sync.downloadingAndScanning');
    case 'checking-mempool':
      return t('sync.checkingMempool');
    case 'checkpointing-wallets':
      return t('sync.savingWallets');
    case 'degraded':
      return t('sync.degraded');
    default:
      return t('sync.waitingForStatus');
  }
}

function useSyncEta(
  presentation: ReturnType<typeof presentWalletSync>,
  networkStatus?: NetworkSyncStatus,
) {
  const sampleRef = React.useRef<WalletSyncEtaState | undefined>(undefined);
  const [etaSeconds, setEtaSeconds] = React.useState<number | undefined>();
  const etaActive =
    !networkStatus ||
    ['fetching-blocks', 'scanning-wallets', 'waiting-next-batch'].includes(
      networkStatus.phase,
    );

  React.useEffect(() => {
    if (
      presentation.phase !== 'syncing' ||
      presentation.remainingBlocks === undefined ||
      presentation.remainingBlocks <= 0 ||
      presentation.scannedBlocks === undefined
    ) {
      sampleRef.current = undefined;
      setEtaSeconds(undefined);
      return;
    }

    const estimate = updateWalletSyncEta(
      sampleRef.current,
      presentation.remainingBlocks,
      Date.now(),
      { active: etaActive },
    );
    sampleRef.current = estimate.state;
    setEtaSeconds(estimate.etaSeconds);
  }, [
    etaActive,
    presentation.phase,
    presentation.remainingBlocks,
    presentation.scannedBlocks,
  ]);

  return etaSeconds;
}

function useElapsedSeconds(active: boolean) {
  const startedAtRef = React.useRef<number | undefined>(undefined);
  const [elapsedSeconds, setElapsedSeconds] = React.useState(0);

  React.useEffect(() => {
    if (!active) {
      startedAtRef.current = undefined;
      setElapsedSeconds(0);
      return;
    }

    if (startedAtRef.current === undefined) {
      startedAtRef.current = Date.now();
    }
    const update = () => {
      const startedAt = startedAtRef.current ?? Date.now();
      setElapsedSeconds(
        Math.max(0, Math.floor((Date.now() - startedAt) / 1_000)),
      );
    };
    update();
    const interval = setInterval(update, 1_000);
    return () => clearInterval(interval);
  }, [active]);

  return elapsedSeconds;
}

/** Aggregate every completed transport lane over a short rolling window. */
function useAggregateNetworkRate(status?: NetworkSyncStatus) {
  const windowRef = React.useRef<MobileNetworkSyncRateWindow>({ samples: [] });
  const [rate, setRate] = React.useState<number | undefined>();

  React.useEffect(() => {
    windowRef.current = updateMobileNetworkSyncRateWindow(
      windowRef.current,
      status,
      Date.now(),
    );
    setRate(windowRef.current.rate);
  }, [status]);

  return rate;
}

function formatBlockCount(value?: number) {
  return typeof value === 'number' && Number.isFinite(value)
    ? value.toLocaleString()
    : '–';
}

/** Keep the visible percentage consistent with the tracked target height. */
export function blockHeightProgress(current?: number, target?: number) {
  if (
    current === undefined ||
    target === undefined ||
    !Number.isFinite(current) ||
    !Number.isFinite(target) ||
    target <= 0
  ) {
    return undefined;
  }
  const clampedCurrent = Math.max(0, Math.min(current, target));
  return displaySyncPercent(
    (clampedCurrent / target) * 100,
    clampedCurrent >= target,
  );
}

function formatSyncEta(
  seconds: number | undefined,
  t: ReturnType<typeof useI18n>['t'],
) {
  if (!seconds || seconds <= 0) return t('sync.etaCalculating');
  if (seconds < 60) return t('sync.etaSeconds', { count: seconds });
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return t('sync.etaMinutes', { count: minutes });
  return t('sync.etaHours', { count: Math.ceil(minutes / 60) });
}

function resolveDetail(
  status: WalletRuntimeStatus,
  snapshot: WalletSnapshot | undefined,
  hasSyncError: boolean,
  phase: ReturnType<typeof presentWalletSync>['phase'],
  percent: number | undefined,
  t: ReturnType<typeof useI18n>['t'],
): string {
  if (hasSyncError) {
    return t('sync.error');
  }
  if (walletSnapshotIsSynchronized(snapshot)) {
    return t('sync.synced');
  }
  if (phase === 'finalizing') {
    return t('sync.verifyingRecent');
  }
  if (phase === 'waiting-for-node') {
    // The page header owns the single network connection indicator. This
    // component reports only the selected wallet's private scan phase.
    return t('sync.checkingBlocks');
  }
  if (status === 'opening') {
    return t('sync.opening');
  }
  if (status === 'syncing') {
    return percent !== undefined && percent > 1
      ? t('sync.scanningBlocks')
      : t('sync.checkingBlocks');
  }
  if (percent !== undefined) {
    return percent > 1 ? t('sync.scanningBlocks') : t('sync.checkingBlocks');
  }
  if (status === 'locked') {
    return t('sync.openWallet');
  }
  if (status === 'empty') {
    return t('sync.noWallet');
  }
  return t('sync.waitingForStatus');
}

const s = StyleSheet.create({
  wrap: {
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: 'rgba(255,255,255,0.045)',
    paddingHorizontal: 11,
    paddingVertical: 9,
    marginBottom: 11,
  },
  wrapCompact: {
    marginBottom: 13,
  },
  wrapCollapsed: {
    paddingVertical: 7,
  },
  connectionRow: {
    minHeight: 24,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  expandedBody: {
    marginTop: 8,
  },
  connectionTitle: {
    flex: 1,
    color: colors.textPrimary,
    fontSize: 14,
    fontWeight: '900',
  },
  statusToggle: {
    minWidth: 0,
    maxWidth: '72%',
    minHeight: 30,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 7,
    borderRadius: radius.full,
    paddingHorizontal: 5,
  },
  statusTogglePressed: {
    backgroundColor: 'rgba(255,255,255,0.055)',
  },
  compactStatus: {
    flexShrink: 1,
    color: colors.warning,
    fontSize: 11,
    fontWeight: '800',
  },
  compactStatusReady: {
    color: colors.success,
  },
  compactStatusError: {
    color: colors.error,
  },
  toggleChevron: {
    width: 13,
    color: colors.textSecondary,
    fontSize: 15,
    fontWeight: '900',
    lineHeight: 17,
    textAlign: 'center',
  },
  progressSection: { gap: 0 },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border,
    marginVertical: 10,
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  titleGroup: {
    flex: 1,
    minWidth: 0,
  },
  label: {
    color: colors.textPrimary,
    fontSize: 13,
    fontWeight: '800',
  },
  detail: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: '600',
    marginTop: 2,
  },
  detailDanger: {
    color: colors.error,
  },
  percent: {
    color: colors.warning,
    fontSize: 16,
    fontWeight: '900',
    minWidth: 52,
    textAlign: 'right',
  },
  percentGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 7,
    minWidth: 74,
  },
  percentReady: {
    color: colors.success,
  },
  percentMuted: {
    color: colors.textMuted,
    fontSize: 12,
    minWidth: 52,
  },
  statusLed: {
    width: 9,
    height: 9,
    borderRadius: 5,
    backgroundColor: colors.warning,
  },
  statusLedReady: {
    backgroundColor: colors.success,
  },
  statusLedOffline: {
    backgroundColor: colors.textSecondary,
  },
  statusLedDanger: {
    backgroundColor: colors.error,
  },
  track: {
    height: 4,
    borderRadius: radius.full,
    backgroundColor: 'rgba(255,255,255,0.08)',
    marginTop: 8,
    overflow: 'hidden',
  },
  metrics: {
    marginTop: 8,
    gap: 2,
  },
  metricsPrimary: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  metric: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: '600',
    lineHeight: 17,
  },
  metricStrong: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: '800',
    lineHeight: 17,
  },
  metricExtra: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: '800',
    lineHeight: 17,
  },
  fill: {
    height: '100%',
    borderRadius: radius.full,
  },
  fillBlockchain: {
    backgroundColor: colors.orange,
  },
  fillWallet: {
    backgroundColor: '#737381',
  },
  fillReady: {
    backgroundColor: colors.success,
  },
  fillDanger: {
    backgroundColor: colors.error,
  },
  subtitle: {
    color: colors.textMuted,
    fontSize: 12,
    lineHeight: 17,
    marginTop: 8,
  },
  readyWrap: {
    marginBottom: 14,
  },
  readyWrapCompact: {
    marginBottom: 16,
  },
  readyRow: {
    minHeight: 30,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  readyWallet: {
    flex: 1,
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: '700',
  },
  readyText: {
    color: colors.success,
    fontSize: 12,
    fontWeight: '900',
  },
  readyHeight: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '600',
    marginLeft: 17,
    marginTop: 1,
  },
});
