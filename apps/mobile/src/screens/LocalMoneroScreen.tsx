import React, { useState } from "react";
import { View, Text, StyleSheet, ScrollView, TouchableOpacity } from "react-native";
import { colors, spacing, radius } from "../theme/colors";

type LocalMoneroOffer = {
  id: string;
  type: "buy" | "sell";
  user: string;
  reputation: number;
  lastSeen: string;
  price: string;
  limits: string;
  paymentMethod: string;
  trades: string;
};

// This feature has no live P2P marketplace backend yet. Keep the screen
// empty rather than showing fabricated offers as if they were real listings.
const LOCAL_MONERO_OFFERS: LocalMoneroOffer[] = [];

export default function LocalMoneroScreen() {
  const [tab, setTab] = useState<"buy" | "sell">("buy");
  const offers = LOCAL_MONERO_OFFERS.filter(o => (tab === "buy" ? o.type === "sell" : o.type === "buy"));

  return (
    <View style={s.container}>
      <ScrollView contentContainerStyle={s.scroll}>
        <Text style={s.title}>Local Monero</Text>
        <Text style={s.subtitle}>P2P Trading — direct and private</Text>

        {/* Create Listing */}
        <TouchableOpacity style={s.createBtn} activeOpacity={0.8}>
          <Text style={s.createBtnText}>+ Create Listing</Text>
        </TouchableOpacity>

        {/* Buy/Sell Toggle */}
        <View style={s.toggle}>
          <TouchableOpacity style={[s.toggleBtn, tab === "buy" && s.toggleActive]} onPress={() => setTab("buy")}>
            <Text style={[s.toggleText, tab === "buy" && s.toggleTextActive]}>Buy XMR</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[s.toggleBtn, tab === "sell" && s.toggleActive]} onPress={() => setTab("sell")}>
            <Text style={[s.toggleText, tab === "sell" && s.toggleTextActive]}>Sell XMR</Text>
          </TouchableOpacity>
        </View>

        {offers.map(offer => (
          <View key={offer.id} style={s.offerCard}>
            <View style={s.offerHeader}>
              <View style={s.offerUser}>
                <View style={s.userDot} />
                <Text style={s.userName}>{offer.user}</Text>
                <View style={s.repBadge}><Text style={s.repText}>{offer.reputation}%</Text></View>
              </View>
              <Text style={s.lastSeen}>{offer.lastSeen}</Text>
            </View>

            <View style={s.offerBody}>
              <View style={s.offerRow}>
                <Text style={s.offerLabel}>Price</Text>
                <Text style={s.offerPrice}>{offer.price}</Text>
              </View>
              <View style={s.offerRow}>
                <Text style={s.offerLabel}>Limits</Text>
                <Text style={s.offerValue}>{offer.limits}</Text>
              </View>
              <View style={s.offerRow}>
                <Text style={s.offerLabel}>Payment</Text>
                <Text style={s.offerValue}>{offer.paymentMethod}</Text>
              </View>
              <View style={s.offerRow}>
                <Text style={s.offerLabel}>Trades</Text>
                <Text style={s.offerValue}>{offer.trades}</Text>
              </View>
            </View>

            <TouchableOpacity style={s.tradeBtn}>
              <Text style={s.tradeBtnText}>{tab === "buy" ? "Buy" : "Sell"}</Text>
            </TouchableOpacity>
          </View>
        ))}
        {offers.length === 0 && (
          <View style={s.emptyCard}>
            <Text style={s.emptyTitle}>No listings yet</Text>
            <Text style={s.emptyText}>
              Local Monero listings will appear here when the marketplace service is available.
            </Text>
          </View>
        )}

        <View style={s.bottomSpacer} />
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  scroll: { paddingHorizontal: spacing.lg, paddingTop: 60 },
  title: { color: colors.textPrimary, fontSize: 28, fontWeight: "700" },
  subtitle: { color: colors.textSecondary, fontSize: 15, marginTop: 4, marginBottom: 16 },
  createBtn: { backgroundColor: colors.orange, borderRadius: radius.md, paddingVertical: 14, alignItems: "center", marginBottom: 20 },
  createBtnText: { color: "#FFF", fontSize: 16, fontWeight: "700" },
  toggle: { flexDirection: "row", backgroundColor: colors.bgCard, borderRadius: radius.md, padding: 4, marginBottom: 20, borderWidth: 1, borderColor: colors.border },
  toggleBtn: { flex: 1, paddingVertical: 12, alignItems: "center", borderRadius: radius.sm },
  toggleActive: { backgroundColor: colors.orange },
  toggleText: { color: colors.textMuted, fontSize: 15, fontWeight: "600" },
  toggleTextActive: { color: "#FFF" },
  offerCard: { backgroundColor: colors.bgCard, borderRadius: radius.lg, padding: spacing.lg, marginBottom: 12, borderWidth: 1, borderColor: colors.border },
  offerHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 14 },
  offerUser: { flexDirection: "row", alignItems: "center", gap: 8 },
  userDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.success },
  userName: { color: colors.textPrimary, fontSize: 15, fontWeight: "700" },
  repBadge: { backgroundColor: "rgba(0,214,143,0.12)", paddingHorizontal: 8, paddingVertical: 2, borderRadius: radius.full },
  repText: { color: colors.success, fontSize: 12, fontWeight: "600" },
  lastSeen: { color: colors.textMuted, fontSize: 12 },
  offerBody: { gap: 10, marginBottom: 16 },
  offerRow: { flexDirection: "row", justifyContent: "space-between" },
  offerLabel: { color: colors.textMuted, fontSize: 13 },
  offerPrice: { color: colors.textPrimary, fontSize: 18, fontWeight: "700" },
  offerValue: { color: colors.textSecondary, fontSize: 13, fontWeight: "500" },
  tradeBtn: { backgroundColor: colors.orange, borderRadius: radius.md, paddingVertical: 14, alignItems: "center" },
  tradeBtnText: { color: "#FFF", fontSize: 16, fontWeight: "700" },
  emptyCard: { backgroundColor: colors.bgCard, borderRadius: radius.lg, padding: spacing.lg, borderWidth: 1, borderColor: colors.border, alignItems: "center" },
  emptyTitle: { color: colors.textPrimary, fontSize: 16, fontWeight: "700" },
  emptyText: { color: colors.textSecondary, fontSize: 13, lineHeight: 20, marginTop: 8, textAlign: "center" },
  bottomSpacer: { height: 100 },
});
