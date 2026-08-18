import React from "react";
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Linking } from "react-native";
import Svg, { Path, Circle } from "react-native-svg";
import { colors } from "../theme/colors";
import MoneroLogo from "../components/MoneroLogo";
import { Icon } from "../components/Icon";
import { useI18n, type TranslationKey } from "../i18n";
import { useWalletState } from "../services/WalletState";
import { walletDisplayName } from "../services/WalletRegistry";
import { v1ReleaseFeatures } from "../../../../packages/wallet-shared/src/v1ReleaseFeatures";

/* ── SVG Icons ────────────────────────────────────────────────────── */
function IcoCommunity({ c }: { c: string }) {
  return (<Svg width={20} height={20} viewBox="0 0 24 24" fill="none"><Circle cx="7" cy="8" r="3" stroke={c} strokeWidth={1.8} /><Circle cx="17" cy="8" r="3" stroke={c} strokeWidth={1.8} /><Path d="M4 19c0-3 2-5 5-5h6c3 0 5 2 5 5" stroke={c} strokeWidth={1.8} strokeLinecap="round" /></Svg>);
}
function IcoGear({ c }: { c: string }) {
  return (<Svg width={20} height={20} viewBox="0 0 24 24" fill="none"><Circle cx="12" cy="12" r="3" stroke={c} strokeWidth={1.8} /><Path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09a1.65 1.65 0 00-1.08-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09a1.65 1.65 0 001.51-1.08 1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9c.26.6.84 1 1.51 1.08H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" stroke={c} strokeWidth={1.5} /></Svg>);
}
function IcoSpark({ c }: { c: string }) {
  return (<Svg width={20} height={20} viewBox="0 0 24 24" fill="none"><Path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8L19 16zM5 15l.7 1.8L7.5 17.5l-1.8.7L5 20l-.7-1.8-1.8-.7 1.8-.7L5 15z" stroke={c} strokeWidth={1.6} strokeLinejoin="round" /></Svg>);
}
function IcoGlobe({ c }: { c: string }) {
  return (<Svg width={20} height={20} viewBox="0 0 24 24" fill="none"><Circle cx="12" cy="12" r="9" stroke={c} strokeWidth={1.8} /><Path d="M3 12h18M12 3c2.5 3 4 6 4 9s-1.5 6-4 9c-2.5-3-4-6-4-9s1.5-6 4-9z" stroke={c} strokeWidth={1.8} /></Svg>);
}
function IcoWallet({ c }: { c: string }) {
  return <Icon name="wallet" size={20} color={c} />;
}
function IcoKey({ c }: { c: string }) {
  return <Icon name="key" size={20} color={c} />;
}

type MenuItem = {
  labelKey: TranslationKey;
  descKey: TranslationKey;
  screen: string;
  Icon: React.ComponentType<{ c: string }>;
};
const menuItem = (labelKey: TranslationKey, descKey: TranslationKey, screen: string, MenuIcon: MenuItem['Icon']): MenuItem => ({ labelKey, descKey, screen, Icon: MenuIcon });
const MENU_ITEMS: ReadonlyArray<MenuItem> = [
  menuItem("wallets.manage", "wallets.subtitle", "Wallets", IcoWallet),
  ...(v1ReleaseFeatures.mfwNameRegistration ? [menuItem("mfwNames.title", "mfwNames.subtitle", "MfwNames", IcoKey)] : []),
  menuItem("communityV1.title", "communityV1.menuDescription", "MoneroEnthusiast", IcoCommunity),
  menuItem("settings.title", "menu.configureWallet", "Settings", IcoGear),
  ...(v1ReleaseFeatures.assistant ? [menuItem("assistant.title", "menu.sharedAiModule", "Tex8Assistant", IcoSpark)] : []),
  menuItem("menu.nodeStatus", "menu.connectionStatus", "NodeStatus", IcoGlobe),
];

export default function MenuScreen({ navigation }: any) {
  const { t } = useI18n();
  const { registeredWallet, snapshot, status } = useWalletState();
  const walletName = registeredWallet
    ? walletDisplayName(registeredWallet)
    : t("menu.myWallet");
  const address = snapshot?.primaryAddress;
  const addressLabel = address
    ? `${address.slice(0, 6)}...${address.slice(-5)}`
    : status === "locked"
      ? t("menu.locked")
      : t("menu.noWalletOpen");

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
            key={`${item.screen}-${item.labelKey}`}
            style={s.menuItem}
            activeOpacity={0.6}
            onPress={() => navigation.navigate(item.screen)}
          >
            <View style={s.menuIcon}>
              <item.Icon c={colors.orange} />
            </View>
            <View style={s.menuInfo}>
              <Text style={s.menuLabel}>
                {t(item.labelKey)}
              </Text>
              <Text style={s.menuDesc}>{t(item.descKey)}</Text>
            </View>
            <Text style={s.menuArrow}>›</Text>
          </TouchableOpacity>
        ))}

        <TouchableOpacity
          accessibilityRole="link"
          accessibilityLabel={t('menu.footerAccessibility')}
          onPress={() => {
            Linking.openURL("https://solutions.tex8.com/en");
          }}
          activeOpacity={0.72}
        >
          <Text style={s.footer}>{t('menu.footerPrefix')} <Text style={s.heart}>❤️</Text> {t('menu.footerBy')} <Text style={s.tex8}>TEX8</Text></Text>
        </TouchableOpacity>
        <View style={s.bottomSpacer} />
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  scroll: { paddingHorizontal: 20, paddingTop: 12 },
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

  footer: { color: colors.textMuted, fontSize: 12, textAlign: "center", marginTop: 28, lineHeight: 20 },
  heart: { color: colors.orange },
  tex8: { color: colors.textPrimary, fontWeight: "800" },
  bottomSpacer: { height: 100 },
});
