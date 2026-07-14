import React from "react";
import { View, Text, TouchableOpacity, StyleSheet, Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Path, Line } from "react-native-svg";
import { useI18n } from "../i18n";
import { colors } from "../theme/colors";

function IconHome({ color }: { color: string }) {
  return (<Svg width={22} height={22} viewBox="0 0 24 24" fill="none"><Path d="M3 9.5L12 3l9 6.5V20a1 1 0 01-1 1H4a1 1 0 01-1-1V9.5z" stroke={color} strokeWidth={1.8} strokeLinejoin="round" /><Path d="M9 21V13h6v8" stroke={color} strokeWidth={1.8} strokeLinejoin="round" /></Svg>);
}
function IconSend({ color }: { color: string }) {
  return (<Svg width={22} height={22} viewBox="0 0 24 24" fill="none"><Path d="M12 19V5M5 12l7-7 7 7" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" /></Svg>);
}
function IconReceive({ color }: { color: string }) {
  return (<Svg width={22} height={22} viewBox="0 0 24 24" fill="none"><Path d="M12 5v14M5 12l7 7 7-7" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" /></Svg>);
}
function IconMenu({ color }: { color: string }) {
  return (<Svg width={22} height={22} viewBox="0 0 24 24" fill="none"><Line x1="4" y1="6" x2="20" y2="6" stroke={color} strokeWidth={1.8} strokeLinecap="round" /><Line x1="4" y1="12" x2="20" y2="12" stroke={color} strokeWidth={1.8} strokeLinecap="round" /><Line x1="4" y1="18" x2="20" y2="18" stroke={color} strokeWidth={1.8} strokeLinecap="round" /></Svg>);
}

const TABS = [
  { key: "Home",        labelKey: "tabs.home",    Icon: IconHome },
  { key: "Send",        labelKey: "tabs.send",    Icon: IconSend },
  { key: "Receive",     labelKey: "tabs.receive", Icon: IconReceive },
  { key: "Menu",        labelKey: "tabs.menu",    Icon: IconMenu },
] as const;

const HIDDEN_SCREENS = [
  "Welcome",
  "WalletSetup",
  "Transactions",
  "TransactionDetail",
];
const MENU_CHILD_SCREENS = [
  "FindEnthusiasts",
  "Settings",
  "Tex8Assistant",
  "SharedModules",
  "Wallets",
];

export default function CustomTabBar({ state, navigation }: any) {
  const insets = useSafeAreaInsets();
  const { t } = useI18n();
  const currentRoute = state.routes[state.index]?.name;
  if (HIDDEN_SCREENS.includes(currentRoute)) return null;
  const focusedRoute = MENU_CHILD_SCREENS.includes(currentRoute)
    ? "Menu"
    : currentRoute;

  return (
    <View
      style={[
        s.bar,
        {
          paddingBottom: Math.max(
            insets.bottom + 12,
            Platform.OS === "ios" ? 30 : 34,
          ),
        },
      ]}
    >
      {state.routes.map((route: any) => {
        const tab = TABS.find(item => item.key === route.name);
        if (!tab) return null;
        const focused = route.name === focusedRoute;
        const clr = focused ? colors.orange : colors.tabInactive;
        return (
          <TouchableOpacity key={route.key} style={s.tab} activeOpacity={0.7} onPress={() => navigation.navigate(route.name)}>
            <tab.Icon color={clr} />
            <Text style={[s.label, focused && s.labelActive]}>{t(tab.labelKey)}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const s = StyleSheet.create({
  bar: { minHeight: 94, flexDirection: "row", backgroundColor: colors.tabBar, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 10 },
  tab: { flex: 1, minHeight: 48, alignItems: "center", justifyContent: "center" },
  label: { fontSize: 10, fontWeight: "600", color: colors.tabInactive, marginTop: 4 },
  labelActive: { color: colors.orange },
});
