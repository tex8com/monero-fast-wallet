import React, { useEffect, useMemo, useState } from "react";
import {
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Icon } from "../components/Icon";
import {
  MONERO_SHARED_ELEMENTS,
  TEX8_SHARED_APP_CONTROL_SOURCE,
  createTex8SharedManifestSnapshot,
} from "../services/Tex8SharedAssistant";
import type { MoneroSharedElement } from "../services/Tex8SharedAssistant";
import { loadFastReceiveIdentities } from "../services/FastReceiveRegistry";
import type { FastReceiveIdentityRecord } from "../services/FastReceiveRegistry";
import { getActiveNodeConnectionSettings } from "../services/NodeConnectionSettings";
import { colors, radius, spacing } from "../theme/colors";
import { useWalletState } from "../services/WalletState";

function moduleStatus(
  element: MoneroSharedElement,
  input: {
    walletStatus: string;
    network?: string;
    hasWallet: boolean;
    hasOpenWallet: boolean;
    hardwareLabel: string;
    fastReceiveIdentities: FastReceiveIdentityRecord[];
    nodeMode: string;
  },
): { label: string; tone: "good" | "warning" | "neutral" } {
  switch (element.type) {
    case "monero_wallet":
      return {
        label: input.hasOpenWallet
          ? `${input.walletStatus} · ${input.network ?? "network"} · ${input.nodeMode}`
          : input.hasWallet
            ? "Registered · locked"
            : "Setup needed",
        tone: input.hasOpenWallet ? "good" : "warning",
      };
    case "monero_send":
      return {
        label: input.hasOpenWallet ? "Native prepare/commit ready" : "Open wallet first",
        tone: input.hasOpenWallet ? "good" : "warning",
      };
    case "monero_receive":
      return {
        label: input.hasOpenWallet ? "Address and QR ready" : "Open wallet first",
        tone: input.hasOpenWallet ? "good" : "warning",
      };
    case "monero_ledger":
      return {
        label: input.hardwareLabel,
        tone: input.hardwareLabel.includes("connected") ? "good" : "neutral",
      };
    case "monero_hosted_scan": {
      const enabled = input.fastReceiveIdentities.filter(
        identity => identity.status === "enabled",
      ).length;
      return {
        label:
          input.fastReceiveIdentities.length > 0
            ? `${input.fastReceiveIdentities.length} local · ${enabled} enabled`
            : "No fast receive identity yet",
        tone: enabled > 0 ? "good" : "neutral",
      };
    }
    case "monero_privacy":
      return { label: "Native/local key boundary", tone: "good" };
    case "xmr_marketplace":
      return { label: "Marketplace screen active", tone: "good" };
  }
}

function toneColor(tone: "good" | "warning" | "neutral") {
  if (tone === "good") return colors.success;
  if (tone === "warning") return colors.warning;
  return colors.textSecondary;
}

export default function SharedModulesScreen({ navigation }: any) {
  const insets = useSafeAreaInsets();
  const {
    hardwareStatus,
    registeredWallet,
    session,
    snapshot,
    status,
  } = useWalletState();
  const [fastReceiveIdentities, setFastReceiveIdentities] = useState<
    FastReceiveIdentityRecord[]
  >([]);

  useEffect(() => {
    let mounted = true;
    loadFastReceiveIdentities()
      .then(identities => {
        if (mounted) {
          setFastReceiveIdentities(identities);
        }
      })
      .catch(() => undefined);

    return () => {
      mounted = false;
    };
  }, []);

  const manifest = useMemo(() => createTex8SharedManifestSnapshot(), []);
  const nodeSettings = getActiveNodeConnectionSettings(session?.network);
  const hardwareLabel = session?.hardwareDevice
    ? hardwareStatus?.connected
      ? `${session.hardwareDevice.name} connected`
      : `${session.hardwareDevice.name} registered`
    : "Ledger setup available";

  const statusInput = {
    walletStatus: status,
    network: session?.network ?? registeredWallet?.network,
    hasWallet: Boolean(registeredWallet),
    hasOpenWallet: Boolean(session && snapshot),
    hardwareLabel,
    fastReceiveIdentities,
    nodeMode: nodeSettings.mode,
  };

  return (
    <View style={s.container}>
      <StatusBar barStyle="light-content" backgroundColor={colors.bg} />
      <ScrollView
        contentContainerStyle={[
          s.scroll,
          { paddingTop: insets.top + 16, paddingBottom: insets.bottom + 120 },
        ]}
        showsVerticalScrollIndicator={false}
      >
        <View style={s.header}>
          <TouchableOpacity
            style={s.backButton}
            onPress={() => navigation.navigate("Menu")}
            activeOpacity={0.7}
          >
            <Icon name="arrow-left" size={20} color={colors.textSecondary} />
          </TouchableOpacity>
          <View style={s.headerText}>
            <Text style={s.kicker}>Tex8 Shared App</Text>
            <Text style={s.title}>Monero Modules</Text>
          </View>
        </View>

        <View style={s.summaryCard}>
          <Text style={s.summaryTitle}>{manifest.contractVersion}</Text>
          <Text style={s.summaryText}>
            This wallet exposes Monero-specific Tex8 shared elements while
            keeping wallet custody in the existing native bridge.
          </Text>
          <Text style={s.sourceText} numberOfLines={2}>
            Source: {TEX8_SHARED_APP_CONTROL_SOURCE}
          </Text>
        </View>

        {MONERO_SHARED_ELEMENTS.map(element => {
          const currentStatus = moduleStatus(element, statusInput);
          return (
            <TouchableOpacity
              key={element.type}
              style={s.moduleCard}
              onPress={() => navigation.navigate(element.route)}
              activeOpacity={0.74}
            >
              <View style={s.moduleTop}>
                <View style={s.moduleIcon}>
                  <Icon name="lightbulb" size={18} color={colors.orange} />
                </View>
                <View style={s.moduleTitleBlock}>
                  <Text style={s.moduleTitle}>{element.label}</Text>
                  <Text style={s.moduleType}>{element.type}</Text>
                </View>
                <Icon
                  name="chevron-right"
                  size={20}
                  color={colors.textMuted}
                />
              </View>
              <Text style={s.moduleDescription}>{element.description}</Text>
              <View
                style={[
                  s.statusPill,
                  { backgroundColor: `${toneColor(currentStatus.tone)}1A` },
                ]}
              >
                <View
                  style={[
                    s.statusDot,
                    { backgroundColor: toneColor(currentStatus.tone) },
                  ]}
                />
                <Text
                  style={[
                    s.statusText,
                    { color: toneColor(currentStatus.tone) },
                  ]}
                  numberOfLines={1}
                >
                  {currentStatus.label}
                </Text>
              </View>
            </TouchableOpacity>
          );
        })}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  scroll: { paddingHorizontal: spacing.lg },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginBottom: spacing.md,
  },
  backButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.bgCard,
    borderWidth: 1,
    borderColor: colors.border,
  },
  headerText: { flex: 1 },
  kicker: {
    color: colors.orange,
    fontSize: 12,
    fontWeight: "800",
    textTransform: "uppercase",
  },
  title: { color: colors.textPrimary, fontSize: 28, fontWeight: "800" },
  summaryCard: {
    backgroundColor: colors.bgCard,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    marginBottom: spacing.md,
  },
  summaryTitle: { color: colors.textPrimary, fontSize: 17, fontWeight: "800" },
  summaryText: {
    color: colors.textSecondary,
    fontSize: 14,
    lineHeight: 20,
    marginTop: 8,
  },
  sourceText: {
    color: colors.textMuted,
    fontSize: 11,
    lineHeight: 16,
    marginTop: 12,
  },
  moduleCard: {
    backgroundColor: colors.bgCard,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    marginBottom: 10,
  },
  moduleTop: { flexDirection: "row", alignItems: "center", gap: 12 },
  moduleIcon: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.orangeMuted,
  },
  moduleTitleBlock: { flex: 1 },
  moduleTitle: { color: colors.textPrimary, fontSize: 16, fontWeight: "800" },
  moduleType: {
    color: colors.textMuted,
    fontSize: 11,
    fontFamily: "monospace",
    marginTop: 2,
  },
  moduleDescription: {
    color: colors.textSecondary,
    fontSize: 13,
    lineHeight: 19,
    marginTop: 12,
  },
  statusPill: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    marginTop: 12,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: radius.full,
    maxWidth: "100%",
  },
  statusDot: { width: 7, height: 7, borderRadius: 4 },
  statusText: { fontSize: 12, fontWeight: "800" },
});
