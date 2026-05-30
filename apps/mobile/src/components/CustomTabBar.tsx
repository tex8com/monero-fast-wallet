import React from "react";
import { View, Text, TouchableOpacity, StyleSheet, Platform } from "react-native";
import Svg, { Path, Rect, Line, Circle } from "react-native-svg";
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
function IconMarket({ color }: { color: string }) {
  return (<Svg width={22} height={22} viewBox="0 0 24 24" fill="none"><Path d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.3 4.6a1 1 0 00.9 1.4h12.8" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" /><Circle cx="9" cy="21" r="1.5" stroke={color} strokeWidth={1.8} /><Circle cx="18" cy="21" r="1.5" stroke={color} strokeWidth={1.8} /></Svg>);
}
function IconMenu({ color }: { color: string }) {
  return (<Svg width={22} height={22} viewBox="0 0 24 24" fill="none"><Line x1="4" y1="6" x2="20" y2="6" stroke={color} strokeWidth={1.8} strokeLinecap="round" /><Line x1="4" y1="12" x2="20" y2="12" stroke={color} strokeWidth={1.8} strokeLinecap="round" /><Line x1="4" y1="18" x2="20" y2="18" stroke={color} strokeWidth={1.8} strokeLinecap="round" /></Svg>);
}

const TABS = [
  { key: "Home",        label: "Home",    Icon: IconHome },
  { key: "Send",        label: "Send",    Icon: IconSend },
  { key: "Receive",     label: "Receive", Icon: IconReceive },
  { key: "Marketplace", label: "Market",  Icon: IconMarket },
  { key: "Menu",        label: "Menu",    Icon: IconMenu },
];

const HIDDEN_SCREENS = ["Welcome", "WalletSetup"];

export default function CustomTabBar({ state, navigation }: any) {
  const currentRoute = state.routes[state.index]?.name;
  if (HIDDEN_SCREENS.includes(currentRoute)) return null;

  return (
    <View style={s.bar}>
      {state.routes.map((route: any, index: number) => {
        const tab = TABS.find(t => t.key === route.name);
        if (!tab) return null;
        const focused = state.index === index;
        const clr = focused ? colors.orange : colors.tabInactive;
        return (
          <TouchableOpacity key={route.key} style={s.tab} activeOpacity={0.7} onPress={() => navigation.navigate(route.name)}>
            <tab.Icon color={clr} />
            <Text style={[s.label, focused && s.labelActive]}>{tab.label}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const s = StyleSheet.create({
  bar: { flexDirection: "row", backgroundColor: colors.tabBar, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 10, paddingBottom: Platform.OS === "ios" ? 30 : 10 },
  tab: { flex: 1, alignItems: "center", justifyContent: "center" },
  label: { fontSize: 10, fontWeight: "600", color: colors.tabInactive, marginTop: 4 },
  labelActive: { color: colors.orange },
});
