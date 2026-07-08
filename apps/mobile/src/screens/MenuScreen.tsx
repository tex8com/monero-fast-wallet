import React from "react";
import { View, Text, StyleSheet, TouchableOpacity, ScrollView } from "react-native";
import Svg, { Path, Circle } from "react-native-svg";
import { colors } from "../theme/colors";
import MoneroLogo from "../components/MoneroLogo";
import { useWalletState } from "../services/WalletState";

/* ── SVG Icons ────────────────────────────────────────────────────── */
function IcoP2P({ c }: { c: string }) {
  return (<Svg width={20} height={20} viewBox="0 0 24 24" fill="none"><Circle cx="7" cy="8" r="3" stroke={c} strokeWidth={1.8} /><Circle cx="17" cy="8" r="3" stroke={c} strokeWidth={1.8} /><Path d="M4 19c0-3 2-5 5-5h6c3 0 5 2 5 5" stroke={c} strokeWidth={1.8} strokeLinecap="round" /></Svg>);
}
function IcoGear({ c }: { c: string }) {
  return (<Svg width={20} height={20} viewBox="0 0 24 24" fill="none"><Circle cx="12" cy="12" r="3" stroke={c} strokeWidth={1.8} /><Path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09a1.65 1.65 0 00-1.08-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09a1.65 1.65 0 001.51-1.08 1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9c.26.6.84 1 1.51 1.08H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" stroke={c} strokeWidth={1.5} /></Svg>);
}
function IcoSpark({ c }: { c: string }) {
  return (<Svg width={20} height={20} viewBox="0 0 24 24" fill="none"><Path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8L19 16zM5 15l.7 1.8L7.5 17.5l-1.8.7L5 20l-.7-1.8-1.8-.7 1.8-.7L5 15z" stroke={c} strokeWidth={1.6} strokeLinejoin="round" /></Svg>);
}
function IcoModules({ c }: { c: string }) {
  return (<Svg width={20} height={20} viewBox="0 0 24 24" fill="none"><Path d="M4 4h7v7H4V4zM13 4h7v7h-7V4zM4 13h7v7H4v-7zM13 13h7v7h-7v-7z" stroke={c} strokeWidth={1.8} strokeLinejoin="round" /></Svg>);
}
function IcoGlobe({ c }: { c: string }) {
  return (<Svg width={20} height={20} viewBox="0 0 24 24" fill="none"><Circle cx="12" cy="12" r="9" stroke={c} strokeWidth={1.8} /><Path d="M3 12h18M12 3c2.5 3 4 6 4 9s-1.5 6-4 9c-2.5-3-4-6-4-9s1.5-6 4-9z" stroke={c} strokeWidth={1.8} /></Svg>);
}
function IcoBook({ c }: { c: string }) {
  return (<Svg width={20} height={20} viewBox="0 0 24 24" fill="none"><Path d="M4 19.5A2.5 2.5 0 016.5 17H20" stroke={c} strokeWidth={1.8} strokeLinecap="round" /><Path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z" stroke={c} strokeWidth={1.8} /></Svg>);
}
function IcoDownload({ c }: { c: string }) {
  return (<Svg width={20} height={20} viewBox="0 0 24 24" fill="none"><Path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3" stroke={c} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" /></Svg>);
}
function IcoHelp({ c }: { c: string }) {
  return (<Svg width={20} height={20} viewBox="0 0 24 24" fill="none"><Circle cx="12" cy="12" r="9" stroke={c} strokeWidth={1.8} /><Path d="M9 9a3 3 0 015.12 2.12c0 2-3 3-3 3" stroke={c} strokeWidth={1.8} strokeLinecap="round" /><Circle cx="12" cy="17" r="0.5" fill={c} /></Svg>);
}
function IcoCode({ c }: { c: string }) {
  return (<Svg width={20} height={20} viewBox="0 0 24 24" fill="none"><Path d="M16 18l6-6-6-6M8 6l-6 6 6 6" stroke={c} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" /></Svg>);
}

const MENU_ITEMS = [
  { label: "Local Monero", desc: "P2P Trading", screen: "LocalMonero", Icon: IcoP2P },
  { label: "Settings",     desc: "Configure wallet", screen: "Settings",  Icon: IcoGear },
  { label: "Tex8 Assistant", desc: "Shared AI module", screen: "Tex8Assistant", Icon: IcoSpark },
  { label: "Shared Modules", desc: "Tex8 app elements", screen: "SharedModules", Icon: IcoModules },
  { label: "Node Status",  desc: "Connection status", screen: null,     Icon: IcoGlobe },
  { label: "Address Book",  desc: "Saved addresses", screen: null,     Icon: IcoBook },
  { label: "Export",        desc: "Export transactions", screen: null,  Icon: IcoDownload },
  { label: "Help",          desc: "FAQ & Support", screen: null,       Icon: IcoHelp },
];

const DEV_SCREENS = [
  { label: "Welcome Screen", screen: "Welcome" },
  { label: "Wallet Setup",   screen: "WalletSetup" },
  { label: "Local Monero",   screen: "LocalMonero" },
  { label: "Settings",       screen: "Settings" },
  { label: "Tex8 Assistant",  screen: "Tex8Assistant" },
  { label: "Shared Modules",  screen: "SharedModules" },
];

export default function MenuScreen({ navigation }: any) {
  const { registeredWallet, snapshot, status } = useWalletState();
  const walletName = registeredWallet?.walletName ?? "My Wallet";
  const address = snapshot?.primaryAddress;
  const addressLabel = address
    ? `${address.slice(0, 6)}...${address.slice(-5)}`
    : status === "locked"
      ? "Locked"
      : "No wallet open";

  return (
    <View style={s.container}>
      <ScrollView contentContainerStyle={s.scroll}>
        {/* Profile */}
        <View style={s.profileCard}>
          <MoneroLogo size={48} />
          <View style={s.profileInfo}>
            <Text style={s.profileName}>{walletName}</Text>
            <Text style={s.profileAddr}>
              {address ? (
                <>
                  {address.slice(0, 6)}...
                  <Text style={{ color: colors.orange }}>
                    {address.slice(-5)}
                  </Text>
                </>
              ) : (
                addressLabel
              )}
            </Text>
          </View>
        </View>

        {/* Menu Items */}
        {MENU_ITEMS.map(item => (
          <TouchableOpacity
            key={item.label}
            style={s.menuItem}
            activeOpacity={0.6}
            onPress={() => item.screen && navigation.navigate(item.screen)}
          >
            <View style={s.menuIcon}>
              <item.Icon c={colors.orange} />
            </View>
            <View style={s.menuInfo}>
              <Text style={s.menuLabel}>{item.label}</Text>
              <Text style={s.menuDesc}>{item.desc}</Text>
            </View>
            <Text style={s.menuArrow}>›</Text>
          </TouchableOpacity>
        ))}

        {/* Dev Menu */}
        <View style={s.devSection}>
          <Text style={s.devTitle}>DEV MENU</Text>
          {DEV_SCREENS.map(item => (
            <TouchableOpacity
              key={item.label}
              style={s.devItem}
              activeOpacity={0.6}
              onPress={() => navigation.navigate(item.screen)}
            >
              <IcoCode c={colors.textMuted} />
              <Text style={s.devLabel}>{item.label}</Text>
              <Text style={s.menuArrow}>›</Text>
            </TouchableOpacity>
          ))}
        </View>

        <Text style={s.footer}>Monero Wallet v1.0.0{"\n"}Privacy by Default</Text>
        <View style={{ height: 100 }} />
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  scroll: { paddingHorizontal: 20, paddingTop: 60 },
  profileCard: { flexDirection: "row", alignItems: "center", backgroundColor: colors.bgCard, borderRadius: 20, padding: 20, marginBottom: 24, gap: 16, borderWidth: 1, borderColor: colors.border },
  profileInfo: { flex: 1, gap: 4 },
  profileName: { color: "#FFF", fontSize: 20, fontWeight: "700" },
  profileAddr: { color: colors.textMuted, fontSize: 14, fontFamily: "monospace" },

  menuItem: { flexDirection: "row", alignItems: "center", backgroundColor: colors.bgCard, borderRadius: 14, paddingVertical: 16, paddingHorizontal: 16, marginBottom: 8, gap: 14, borderWidth: 1, borderColor: colors.border },
  menuIcon: { width: 42, height: 42, borderRadius: 21, backgroundColor: "rgba(255,102,0,0.1)", alignItems: "center", justifyContent: "center" },
  menuInfo: { flex: 1, gap: 2 },
  menuLabel: { color: "#FFF", fontSize: 15, fontWeight: "600" },
  menuDesc: { color: colors.textMuted, fontSize: 12 },
  menuArrow: { color: colors.textMuted, fontSize: 22, fontWeight: "300" },

  devSection: { marginTop: 24, paddingTop: 20, borderTopWidth: 1, borderTopColor: colors.border },
  devTitle: { color: colors.textMuted, fontSize: 11, fontWeight: "700", letterSpacing: 1, marginBottom: 12 },
  devItem: { flexDirection: "row", alignItems: "center", paddingVertical: 14, paddingHorizontal: 12, gap: 12, backgroundColor: "rgba(255,255,255,0.03)", borderRadius: 10, marginBottom: 6 },
  devLabel: { flex: 1, color: colors.textSecondary, fontSize: 14, fontWeight: "500" },

  footer: { color: colors.textMuted, fontSize: 12, textAlign: "center", marginTop: 28, lineHeight: 20 },
});
