import React from "react";
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Switch } from "react-native";
import { colors, spacing, radius } from "../theme/colors";
import MoneroLogo from "../components/MoneroLogo";
import { Icon, IconName } from "../components/Icon";

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
      { label: "Change node", icon: "globe" },
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

export default function SettingsScreen() {
  return (
    <View style={s.container}>
      <ScrollView contentContainerStyle={s.scroll}>
        <View style={s.header}>
          <MoneroLogo size={44} />
          <Text style={s.title}>Settings</Text>
          <Text style={s.version}>Version 1.0.0 (MVP)</Text>
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

        <View style={{ height: 100 }} />
      </ScrollView>
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
  sectionTitle: { color: colors.textSecondary, fontSize: 12, fontWeight: "600", letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 8, paddingLeft: 4 },
  sectionCard: { backgroundColor: colors.bgCard, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, overflow: "hidden" },
  row: { flexDirection: "row", alignItems: "center", paddingVertical: 16, paddingHorizontal: spacing.md, gap: 12 },
  rowBorder: { borderBottomWidth: 1, borderBottomColor: colors.border },
  rowIconWrap: { width: 28, alignItems: "center", justifyContent: "center" },
  rowLabel: { flex: 1, color: colors.textPrimary, fontSize: 15, fontWeight: "500" },
  logoutBtn: { marginTop: 8, paddingVertical: 16, alignItems: "center", backgroundColor: "rgba(255,68,102,0.1)", borderRadius: radius.md, borderWidth: 1, borderColor: "rgba(255,68,102,0.2)" },
  logoutText: { color: colors.error, fontSize: 16, fontWeight: "600" },
});
