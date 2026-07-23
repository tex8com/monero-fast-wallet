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
  hideWhenSynced?: boolean;
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
  hideWhenSynced,
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
  const derivedProgress = progress ?? presentation.progress;
  const percent = presentation.coreConfirmed ? 100 : derivedProgress;
  const isSynced = presentation.coreConfirmed;
  const displayPercent = percent ?? (status === "syncing" ? 0 : undefined);
  const hasSyncError = status === "error" || Boolean(error);
  const tone = resolveTone(status, snapshot, hasSyncError);
  const label = walletName
    ? t("sync.walletName", { wallet: walletName })
    : t("sync.wallet");
  const detail = resolveDetail(status, snapshot, hasSyncError, presentation.phase, percent, t);
  const fillWidth = `${Math.max(0, Math.min(100, displayPercent ?? 0))}%` as `${number}%`;
  // 99% is an internal finalization state, not a useful user-facing target.
  // The native core still decides when it is actually spend-ready, so show an
  // honest finishing indicator rather than implying that sync is stuck.
  const finalizing = presentation.phase === "finalizing";
  const showPercent = displayPercent !== undefined && !hasSyncError && !finalizing;

  if (isSynced && !hasSyncError) {
    if (hideWhenSynced) {
      return null;
    }

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
              {finalizing ? "…" : tone === "danger" ? t("sync.offline") : t("sync.waiting")}
            </Text>
          )}
        </View>
      </View>
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
      {subtitle ? (
        <Text style={s.subtitle} numberOfLines={2}>
          {subtitle}
        </Text>
      ) : null}
    </View>
  );
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
    return t("sync.finalizing");
  }
  if (percent !== undefined) {
    return t("sync.syncing");
  }
  if (status === "syncing") {
    return t("sync.syncing");
  }
  if (status === "opening") {
    return t("sync.opening");
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
