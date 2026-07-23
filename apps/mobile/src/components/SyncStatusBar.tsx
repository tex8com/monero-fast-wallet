import React from "react";
import { StyleSheet, Text, View } from "react-native";

import { useI18n } from "../i18n";
import type { WalletSnapshot } from "../services/NativeMoneroWallet";
import type { WalletRuntimeStatus } from "../services/WalletState";
import { colors, radius } from "../theme/colors";
import { presentWalletSync } from "../../../../packages/wallet-shared/src/walletSync";

type SyncStatusBarProps = {
  compact?: boolean;
  error?: string;
  progress?: number;
  snapshot?: WalletSnapshot;
  syncStartHeight?: number;
  status: WalletRuntimeStatus;
  subtitle?: string;
  walletName?: string;
};

export default function SyncStatusBar({
  compact,
  error,
  progress,
  snapshot,
  syncStartHeight,
  status,
  subtitle,
  walletName,
}: SyncStatusBarProps) {
  const { t } = useI18n();
  const presentation = presentWalletSync(snapshot, {
    startHeight: syncStartHeight,
  });
  const etaSeconds = useSyncEta(presentation);
  // A native snapshot is the source of truth.  Callers also pass a derived
  // progress value for legacy layouts; prefer the snapshot presentation so a
  // stale caller value can never reintroduce a synthetic 97–99% state.
  const derivedProgress = snapshot ? presentation.progress : progress ?? presentation.progress;
  const percent = presentation.coreConfirmed ? 100 : derivedProgress;
  const isSynced = presentation.coreConfirmed;
  const displayPercent = percent;
  const hasSyncError = status === "error" || Boolean(error);
  const tone = resolveTone(status, snapshot, hasSyncError);
  const label = walletName
    ? t("sync.walletName", { wallet: walletName })
    : t("sync.wallet");
  const fillWidth = `${Math.max(0, Math.min(100, displayPercent ?? 0))}%` as `${number}%`;
  // The native core still decides when it is actually spend-ready.  During
  // final verification we show the exact phase and block state, not a nearly
  // complete percentage that looks stuck.
  const finalizing = presentation.phase === "finalizing";
  // Do not show a misleading 0–1% bar while the native core is connecting or
  // restoring its latest checkpoint. The next native snapshot can already be
  // fully synchronized, which otherwise looks like a jump from 0% to 100%.
  const hasMeasuredProgress = (displayPercent ?? 0) > 1;
  const showPercent =
    hasMeasuredProgress && !hasSyncError && !finalizing && presentation.phase !== "waiting-for-node";
  const working =
    !hasSyncError &&
    !isSynced &&
    (status === "opening" ||
      status === "syncing" ||
      finalizing ||
      presentation.phase === "waiting-for-node");
  const animatedDots = useAnimatedDots(working);
  const detail = `${resolveDetail(
    status,
    snapshot,
    hasSyncError,
    presentation.phase,
    percent,
    t,
  )}${working ? animatedDots : ""}`;

  if (isSynced && !hasSyncError) {
    return (
      <View style={[s.readyRow, compact && s.readyRowCompact]}>
        <View style={[s.statusLed, s.statusLedReady]} />
        <Text style={s.readyWallet} numberOfLines={1}>
          {walletName ?? t("common.wallet")}
        </Text>
        <Text style={s.readyText}>{t("sync.synced")}</Text>
      </View>
    );
  }

  return (
    <View style={[s.wrap, compact && s.wrapCompact]}>
      <View style={s.topRow}>
        <View style={s.titleGroup}>
          <Text style={s.label} numberOfLines={1}>
            {label}
          </Text>
          <Text style={[s.detail, tone === "danger" && s.detailDanger]} numberOfLines={1}>
            {detail}
          </Text>
        </View>
        <View style={s.percentGroup}>
          <View
            style={[
              s.statusLed,
              tone === "ready" && s.statusLedReady,
              tone === "danger" && s.statusLedDanger,
            ]}
          />
          {showPercent ? (
            <Text style={[s.percent, tone === "ready" && s.percentReady]}>
              {t("sync.percent", { percent: displayPercent })}
            </Text>
          ) : (
            <Text style={[s.percent, s.percentMuted]}>
              {working
                ? animatedDots
                : tone === "danger"
                ? t("sync.offline")
                : t("sync.waiting")}
            </Text>
          )}
        </View>
      </View>
      {showPercent ? (
        <View style={s.track}>
          <View
            style={[
              s.fill,
              tone === "ready" && s.fillReady,
              tone === "danger" && s.fillDanger,
              { width: fillWidth },
            ]}
          />
        </View>
      ) : null}
      {!hasSyncError && !isSynced && presentation.targetHeight !== undefined ? (
        <View style={s.metrics}>
          <Text style={s.metric}>
            {t("sync.blockHeight", {
              current: formatBlockCount(presentation.walletHeight),
              target: formatBlockCount(presentation.targetHeight),
            })}
          </Text>
          {presentation.phase === "finalizing" ? (
            <Text style={s.metric}>{t("sync.coreConfirming")}</Text>
          ) : presentation.remainingBlocks !== undefined ? (
            <Text style={s.metric}>
              {t("sync.blocksRemaining", { count: formatBlockCount(presentation.remainingBlocks) })}
            </Text>
          ) : null}
          {presentation.phase === "syncing" ? (
            <Text style={s.metric}>{formatSyncEta(etaSeconds, t)}</Text>
          ) : null}
        </View>
      ) : null}
      {subtitle ? (
        <Text style={s.subtitle} numberOfLines={2}>
          {subtitle}
        </Text>
      ) : null}
    </View>
  );
}

function useAnimatedDots(active: boolean): string {
  const [frame, setFrame] = React.useState(0);

  React.useEffect(() => {
    if (!active) {
      setFrame(0);
      return;
    }
    const interval = setInterval(() => {
      setFrame(current => (current + 1) % 3);
    }, 450);
    return () => clearInterval(interval);
  }, [active]);

  return ".".repeat(frame + 1);
}

type SyncSample = {
  remainingBlocks: number;
  at: number;
  blocksPerSecond?: number;
};

function useSyncEta(presentation: ReturnType<typeof presentWalletSync>) {
  const sampleRef = React.useRef<SyncSample | null>(null);
  const [etaSeconds, setEtaSeconds] = React.useState<number | undefined>();

  React.useEffect(() => {
    if (
      presentation.phase !== "syncing" ||
      presentation.remainingBlocks === undefined ||
      presentation.remainingBlocks <= 0
    ) {
      sampleRef.current = null;
      setEtaSeconds(undefined);
      return;
    }

    const now = Date.now();
    const previous = sampleRef.current;
    let blocksPerSecond = previous?.blocksPerSecond;

    if (previous && previous.remainingBlocks > presentation.remainingBlocks) {
      const elapsedSeconds = (now - previous.at) / 1000;
      if (elapsedSeconds >= 1) {
        const measured = (previous.remainingBlocks - presentation.remainingBlocks) / elapsedSeconds;
        if (Number.isFinite(measured) && measured > 0) {
          blocksPerSecond = blocksPerSecond ? blocksPerSecond * 0.7 + measured * 0.3 : measured;
        }
      }
    }

    sampleRef.current = { remainingBlocks: presentation.remainingBlocks, at: now, blocksPerSecond };
    setEtaSeconds(blocksPerSecond ? Math.ceil(presentation.remainingBlocks / blocksPerSecond) : undefined);
  }, [presentation.phase, presentation.remainingBlocks]);

  return etaSeconds;
}

function formatBlockCount(value?: number) {
  return typeof value === "number" && Number.isFinite(value) ? value.toLocaleString() : "–";
}

function formatSyncEta(seconds: number | undefined, t: ReturnType<typeof useI18n>["t"]) {
  if (!seconds || seconds <= 0) return t("sync.etaCalculating");
  if (seconds < 60) return t("sync.etaSeconds", { count: seconds });
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return t("sync.etaMinutes", { count: minutes });
  return t("sync.etaHours", { count: Math.ceil(minutes / 60) });
}

function resolveTone(
  status: WalletRuntimeStatus,
  snapshot: WalletSnapshot | undefined,
  hasSyncError: boolean,
): "danger" | "ready" | "syncing" | "waiting" {
  if (hasSyncError) {
    return "danger";
  }
  if (snapshot?.synchronized || status === "open") {
    return "ready";
  }
  if (status === "syncing") {
    return "syncing";
  }
  return "waiting";
}

function resolveDetail(
  status: WalletRuntimeStatus,
  snapshot: WalletSnapshot | undefined,
  hasSyncError: boolean,
  phase: ReturnType<typeof presentWalletSync>["phase"],
  percent: number | undefined,
  t: ReturnType<typeof useI18n>["t"],
): string {
  if (hasSyncError) {
    return t("sync.error");
  }
  if (snapshot?.synchronized) {
    return t("sync.synced");
  }
  if (phase === "finalizing") {
    return t("sync.verifyingRecent");
  }
  if (phase === "waiting-for-node") {
    return t("sync.connectingNode");
  }
  if (status === "opening") {
    return t("sync.opening");
  }
  if (status === "syncing") {
    return percent !== undefined && percent > 1
      ? t("sync.scanningBlocks")
      : t("sync.checkingBlocks");
  }
  if (percent !== undefined) {
    return percent > 1 ? t("sync.scanningBlocks") : t("sync.checkingBlocks");
  }
  if (status === "locked") {
    return t("sync.openWallet");
  }
  if (status === "empty") {
    return t("sync.noWallet");
  }
  return t("sync.waitingForStatus");
}

const s = StyleSheet.create({
  wrap: {
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: "rgba(255,255,255,0.045)",
    padding: 12,
    marginBottom: 14,
  },
  wrapCompact: {
    marginBottom: 18,
  },
  topRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  titleGroup: {
    flex: 1,
    minWidth: 0,
  },
  label: {
    color: colors.textPrimary,
    fontSize: 13,
    fontWeight: "800",
  },
  detail: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: "600",
    marginTop: 2,
  },
  detailDanger: {
    color: colors.error,
  },
  percent: {
    color: colors.warning,
    fontSize: 18,
    fontWeight: "900",
    minWidth: 52,
    textAlign: "right",
  },
  percentGroup: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
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
  statusLedDanger: {
    backgroundColor: colors.error,
  },
  track: {
    height: 5,
    borderRadius: radius.full,
    backgroundColor: "rgba(255,255,255,0.08)",
    marginTop: 10,
    overflow: "hidden",
  },
  metrics: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    marginTop: 10,
  },
  metric: {
    backgroundColor: "rgba(255,255,255,0.03)",
    borderColor: colors.border,
    borderRadius: radius.full,
    borderWidth: 1,
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: "700",
    paddingHorizontal: 8,
    paddingVertical: 5,
  },
  fill: {
    height: "100%",
    borderRadius: radius.full,
    backgroundColor: colors.warning,
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
  readyRow: {
    minHeight: 34,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 14,
  },
  readyRowCompact: {
    marginBottom: 16,
  },
  readyWallet: {
    flex: 1,
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: "700",
  },
  readyText: {
    color: colors.success,
    fontSize: 12,
    fontWeight: "900",
  },
});
