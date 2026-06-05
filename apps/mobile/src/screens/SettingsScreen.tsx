import React, { useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Switch,
  TextInput,
} from "react-native";
import { colors, spacing, radius } from "../theme/colors";
import MoneroLogo from "../components/MoneroLogo";
import { Icon, IconName } from "../components/Icon";
import type { MoneroNetwork } from "../services/NativeMoneroWallet";
import {
  applyNodeModeDefaults,
  applyNodeNetworkDefaults,
  createDefaultNodeConnectionSettings,
  getActiveNodeConnectionSettings,
  loadActiveNodeConnectionSettings,
  nodeConnectionDraftToSettings,
  nodeConnectionSettingsToDraft,
  saveActiveNodeConnectionSettings,
} from "../services/NodeConnectionSettings";
import type {
  NodeConnectionDraft,
  NodeConnectionMode,
} from "../services/NodeConnectionSettings";
import { walletService } from "../services/WalletService";

type Item = {
  label: string;
  icon: IconName;
  danger?: boolean;
  toggle?: boolean;
  defaultOn?: boolean;
};

const SECTIONS: { title: string; items: Item[] }[] = [
  {
    title: "Wallet",
    items: [
      { label: "Show backup seed", icon: "key", danger: true },
      { label: "Change wallet password", icon: "lock" },
    ],
  },
  {
    title: "Security",
    items: [
      { label: "Enable biometrics", icon: "fingerprint", toggle: true },
      { label: "Auto-lock (5 min)", icon: "clock", toggle: true, defaultOn: true },
      { label: "Use Tor", icon: "onion", toggle: true },
    ],
  },
  {
    title: "Appearance",
    items: [
      { label: "Currency: USD", icon: "dollar" },
      { label: "Language: English", icon: "language" },
    ],
  },
  {
    title: "Info",
    items: [
      { label: "About Monero Wallet", icon: "info" },
      { label: "Privacy policy", icon: "file" },
      { label: "Open source licenses", icon: "package" },
    ],
  },
];

const NODE_MODES: { value: NodeConnectionMode; label: string }[] = [
  { value: "optimized-grpc", label: "Optimized gRPC" },
  { value: "original-rpc", label: "Original RPC" },
  { value: "custom", label: "Custom" },
];

const NETWORKS: { value: MoneroNetwork; label: string }[] = [
  { value: "mainnet", label: "Mainnet" },
  { value: "testnet", label: "Testnet" },
  { value: "stagenet", label: "Stagenet" },
];

export default function SettingsScreen() {
  const [draft, setDraft] = useState<NodeConnectionDraft>(() =>
    nodeConnectionSettingsToDraft(getActiveNodeConnectionSettings()),
  );
  const [savedSettings, setSavedSettings] = useState(() =>
    getActiveNodeConnectionSettings(),
  );
  const [isLoadingNodeSettings, setIsLoadingNodeSettings] = useState(true);
  const [isSavingNodeSettings, setIsSavingNodeSettings] = useState(false);
  const [nodeStatusText, setNodeStatusText] = useState("Loading");

  useEffect(() => {
    let mounted = true;

    loadActiveNodeConnectionSettings()
      .then(settings => {
        if (!mounted) {
          return;
        }

        setSavedSettings(settings);
        setDraft(nodeConnectionSettingsToDraft(settings));
        setNodeStatusText("Saved");
      })
      .catch(() => {
        if (mounted) {
          setNodeStatusText("Default");
        }
      })
      .finally(() => {
        if (mounted) {
          setIsLoadingNodeSettings(false);
        }
      });

    return () => {
      mounted = false;
    };
  }, []);

  const resolvedSettings = useMemo(
    () => nodeConnectionDraftToSettings(draft),
    [draft],
  );

  const canSave =
    resolvedSettings.daemon.address.length > 0 &&
    (draft.mode !== "optimized-grpc" ||
      resolvedSettings.grpcEndpoint.length > 0);
  const hasChanges =
    JSON.stringify(resolvedSettings) !== JSON.stringify(savedSettings);
  const isOriginalRpc = draft.mode === "original-rpc";
  const showAdvancedFields = draft.mode === "custom";
  const nodeStatus =
    hasChanges && !isLoadingNodeSettings ? "Unsaved" : nodeStatusText;

  function updateDraft<K extends keyof NodeConnectionDraft>(
    key: K,
    value: NodeConnectionDraft[K],
  ) {
    setDraft(current => ({
      ...current,
      [key]: value,
    }));
  }

  function setMode(mode: NodeConnectionMode) {
    setDraft(current => applyNodeModeDefaults(current, mode));
  }

  function setNetwork(network: MoneroNetwork) {
    setDraft(current => applyNodeNetworkDefaults(current, network));
  }

  function resetNodeDefaults() {
    setDraft(
      nodeConnectionSettingsToDraft(
        createDefaultNodeConnectionSettings(draft.network, draft.mode),
      ),
    );
  }

  async function saveNodeSettings() {
    if (!canSave || isSavingNodeSettings) {
      return;
    }

    setIsSavingNodeSettings(true);
    setNodeStatusText("Saving");

    try {
      const saved = await saveActiveNodeConnectionSettings(resolvedSettings);
      const applied = await walletService.applyNodeConnectionToActive(saved);

      setSavedSettings(saved);
      setDraft(nodeConnectionSettingsToDraft(saved));
      setNodeStatusText(applied ? "Applied" : "Saved");
    } catch {
      setNodeStatusText("Error");
    } finally {
      setIsSavingNodeSettings(false);
    }
  }

  return (
    <View style={s.container}>
      <ScrollView contentContainerStyle={s.scroll}>
        <View style={s.header}>
          <MoneroLogo size={44} />
          <Text style={s.title}>Settings</Text>
          <Text style={s.version}>Version 1.0.0 (MVP)</Text>
        </View>

        <View style={s.section}>
          <View style={s.sectionHeaderRow}>
            <Text style={s.sectionTitle}>Node</Text>
            <Text style={[s.nodeStatus, hasChanges && s.nodeStatusDirty]}>
              {nodeStatus}
            </Text>
          </View>
          <View style={s.nodePanel}>
            <Text style={s.fieldLabel}>Mode</Text>
            <View style={s.segmented}>
              {NODE_MODES.map(mode => (
                <TouchableOpacity
                  key={mode.value}
                  style={[
                    s.segment,
                    draft.mode === mode.value && s.segmentActive,
                  ]}
                  activeOpacity={0.75}
                  onPress={() => setMode(mode.value)}
                >
                  <Text
                    style={[
                      s.segmentText,
                      draft.mode === mode.value && s.segmentTextActive,
                    ]}
                    numberOfLines={1}
                    adjustsFontSizeToFit
                  >
                    {mode.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            <Text style={s.fieldLabel}>Network</Text>
            <View style={s.segmented}>
              {NETWORKS.map(network => (
                <TouchableOpacity
                  key={network.value}
                  style={[
                    s.segment,
                    draft.network === network.value && s.segmentActive,
                  ]}
                  activeOpacity={0.75}
                  onPress={() => setNetwork(network.value)}
                >
                  <Text
                    style={[
                      s.segmentText,
                      draft.network === network.value && s.segmentTextActive,
                    ]}
                    numberOfLines={1}
                    adjustsFontSizeToFit
                  >
                    {network.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            <NodeInput
              label="Daemon RPC"
              value={draft.daemonAddress}
              onChangeText={value => updateDraft("daemonAddress", value)}
              placeholder="host:port"
            />

            <NodeInput
              label="Cuprate gRPC"
              value={isOriginalRpc ? "" : draft.grpcEndpoint}
              onChangeText={value => updateDraft("grpcEndpoint", value)}
              placeholder={isOriginalRpc ? "Disabled" : "host:port"}
              editable={!isOriginalRpc}
            />

            <View style={s.switchRow}>
              <View style={s.switchText}>
                <Text style={s.switchTitle}>Trusted daemon</Text>
                <Text style={s.switchValue}>{draft.trusted ? "On" : "Off"}</Text>
              </View>
              <Switch
                value={draft.trusted}
                onValueChange={value => updateDraft("trusted", value)}
                trackColor={{ false: colors.surface, true: colors.orange }}
                thumbColor="#FFF"
              />
            </View>

            <View style={s.switchRow}>
              <View style={s.switchText}>
                <Text style={s.switchTitle}>Daemon TLS</Text>
                <Text style={s.switchValue}>{draft.useSsl ? "On" : "Off"}</Text>
              </View>
              <Switch
                value={draft.useSsl}
                onValueChange={value => updateDraft("useSsl", value)}
                trackColor={{ false: colors.surface, true: colors.orange }}
                thumbColor="#FFF"
              />
            </View>

            {showAdvancedFields && (
              <View style={s.advancedFields}>
                <NodeInput
                  label="Username"
                  value={draft.username}
                  onChangeText={value => updateDraft("username", value)}
                  placeholder="Optional"
                />
                <NodeInput
                  label="Password"
                  value={draft.password}
                  onChangeText={value => updateDraft("password", value)}
                  placeholder="Optional"
                  secureTextEntry
                />
                <NodeInput
                  label="Proxy"
                  value={draft.proxyAddress}
                  onChangeText={value => updateDraft("proxyAddress", value)}
                  placeholder="Optional"
                />
              </View>
            )}

            <View style={s.nodeActions}>
              <TouchableOpacity
                style={s.secondaryButton}
                activeOpacity={0.75}
                onPress={resetNodeDefaults}
              >
                <Text style={s.secondaryButtonText}>Reset</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  s.primaryButton,
                  (!canSave || !hasChanges || isSavingNodeSettings) &&
                    s.primaryButtonDisabled,
                ]}
                activeOpacity={0.8}
                disabled={!canSave || !hasChanges || isSavingNodeSettings}
                onPress={saveNodeSettings}
              >
                <Icon name="check" size={18} color="#FFF" />
                <Text style={s.primaryButtonText}>
                  {isSavingNodeSettings ? "Saving" : "Save"}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>

        {SECTIONS.map(section => (
          <View key={section.title} style={s.section}>
            <Text style={s.sectionTitle}>{section.title}</Text>
            <View style={s.sectionCard}>
              {section.items.map((item, i) => (
                <TouchableOpacity key={item.label} style={[s.row, i < section.items.length - 1 && s.rowBorder]} activeOpacity={0.6}>
                  <View style={s.rowIconWrap}>
                    <Icon name={item.icon} size={20} color={item.danger ? colors.error : colors.textSecondary} />
                  </View>
                  <Text style={[s.rowLabel, item.danger && { color: colors.error }]}>{item.label}</Text>
                  {item.toggle ? (
                    <Switch
                      value={item.defaultOn ?? false}
                      trackColor={{ false: colors.surface, true: colors.orange }}
                      thumbColor="#FFF"
                    />
                  ) : (
                    <Icon name="chevron-right" size={18} color={colors.textMuted} />
                  )}
                </TouchableOpacity>
              ))}
            </View>
          </View>
        ))}

        <TouchableOpacity style={s.logoutBtn}>
          <Text style={s.logoutText}>Close wallet</Text>
        </TouchableOpacity>

        <View style={s.bottomSpacer} />
      </ScrollView>
    </View>
  );
}

function NodeInput({
  label,
  value,
  onChangeText,
  placeholder,
  editable = true,
  secureTextEntry = false,
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  placeholder: string;
  editable?: boolean;
  secureTextEntry?: boolean;
}) {
  return (
    <View style={s.inputGroup}>
      <Text style={s.fieldLabel}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.textMuted}
        editable={editable}
        secureTextEntry={secureTextEntry}
        autoCapitalize="none"
        autoCorrect={false}
        style={[s.input, !editable && s.inputDisabled]}
      />
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  scroll: { paddingHorizontal: spacing.lg, paddingTop: 60 },
  header: { alignItems: "center", marginBottom: 32, gap: 8 },
  title: { color: colors.textPrimary, fontSize: 22, fontWeight: "700", marginTop: 8 },
  version: { color: colors.textMuted, fontSize: 13 },
  section: { marginBottom: 24 },
  sectionHeaderRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  sectionTitle: { color: colors.textSecondary, fontSize: 12, fontWeight: "600", letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 8, paddingLeft: 4 },
  sectionCard: { backgroundColor: colors.bgCard, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, overflow: "hidden" },
  nodeStatus: { color: colors.success, fontSize: 12, fontWeight: "700", marginBottom: 8, paddingRight: 4 },
  nodeStatusDirty: { color: colors.warning },
  nodePanel: { backgroundColor: colors.bgCard, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, padding: spacing.md, gap: 12 },
  segmented: { flexDirection: "row", backgroundColor: colors.bgInput, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, padding: 4, gap: 4 },
  segment: { flex: 1, minHeight: 38, alignItems: "center", justifyContent: "center", borderRadius: radius.sm, paddingHorizontal: 6 },
  segmentActive: { backgroundColor: colors.orange },
  segmentText: { color: colors.textSecondary, fontSize: 12, fontWeight: "700", textAlign: "center" },
  segmentTextActive: { color: "#FFF" },
  inputGroup: { gap: 6 },
  fieldLabel: { color: colors.textSecondary, fontSize: 12, fontWeight: "700", paddingLeft: 2 },
  input: { minHeight: 46, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bgInput, color: colors.textPrimary, fontSize: 14, paddingHorizontal: 14 },
  inputDisabled: { color: colors.textMuted, opacity: 0.72 },
  switchRow: { minHeight: 52, flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderRadius: radius.md, backgroundColor: colors.bgInput, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 14 },
  switchText: { flex: 1, paddingRight: 12 },
  switchTitle: { color: colors.textPrimary, fontSize: 14, fontWeight: "600" },
  switchValue: { color: colors.textMuted, fontSize: 12, marginTop: 2 },
  advancedFields: { gap: 12 },
  nodeActions: { flexDirection: "row", gap: 10, marginTop: 2 },
  secondaryButton: { flex: 1, minHeight: 44, alignItems: "center", justifyContent: "center", borderRadius: radius.md, borderWidth: 1, borderColor: colors.borderLight, backgroundColor: colors.bgInput },
  secondaryButtonText: { color: colors.textPrimary, fontSize: 14, fontWeight: "700" },
  primaryButton: { flex: 1, minHeight: 44, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, borderRadius: radius.md, backgroundColor: colors.orange },
  primaryButtonDisabled: { opacity: 0.45 },
  primaryButtonText: { color: "#FFF", fontSize: 14, fontWeight: "800" },
  row: { flexDirection: "row", alignItems: "center", paddingVertical: 16, paddingHorizontal: spacing.md, gap: 12 },
  rowBorder: { borderBottomWidth: 1, borderBottomColor: colors.border },
  rowIconWrap: { width: 28, alignItems: "center", justifyContent: "center" },
  rowLabel: { flex: 1, color: colors.textPrimary, fontSize: 15, fontWeight: "500" },
  logoutBtn: { marginTop: 8, paddingVertical: 16, alignItems: "center", backgroundColor: "rgba(255,68,102,0.1)", borderRadius: radius.md, borderWidth: 1, borderColor: "rgba(255,68,102,0.2)" },
  logoutText: { color: colors.error, fontSize: 16, fontWeight: "600" },
  bottomSpacer: { height: 100 },
});
