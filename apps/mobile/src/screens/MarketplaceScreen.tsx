import React, { useState } from "react";
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, FlatList, Alert } from "react-native";
import { colors, spacing, radius } from "../theme/colors";
import { MARKETPLACE_CATEGORIES, MARKETPLACE_SERVICES } from "../data/mock";

export default function MarketplaceScreen() {
  const [category, setCategory] = useState("All");
  const filtered = category === "All" ? MARKETPLACE_SERVICES : MARKETPLACE_SERVICES.filter(s => s.category === category);

  return (
    <View style={s.container}>
      <View style={s.headerArea}>
        <Text style={s.title}>Marketplace</Text>
        <Text style={s.subtitle}>Pay for services with XMR</Text>

        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.catRow}>
          {MARKETPLACE_CATEGORIES.map(cat => (
            <TouchableOpacity key={cat} style={[s.catChip, category === cat && s.catChipActive]} onPress={() => setCategory(cat)}>
              <Text style={[s.catText, category === cat && s.catTextActive]}>{cat}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>

      <FlatList
        data={filtered}
        keyExtractor={i => i.id}
        contentContainerStyle={s.list}
        showsVerticalScrollIndicator={false}
        renderItem={({ item }) => (
          <TouchableOpacity style={s.card} activeOpacity={0.7}>
            {item.featured && <View style={s.featBadge}><Text style={s.featText}>Featured</Text></View>}
            <View style={s.cardHeader}>
              <View style={s.avatar}><Text style={s.avatarText}>{item.avatar}</Text></View>
              <View style={s.cardInfo}>
                <Text style={s.cardTitle}>{item.title}</Text>
                <Text style={s.cardProvider}>{item.provider}</Text>
              </View>
            </View>
            <View style={s.cardFooter}>
              <View style={s.cardMeta}>
                <Text style={s.cardRating}>★ {item.rating}</Text>
                <Text style={s.cardReviews}>({item.reviews})</Text>
                <Text style={s.cardDot}>·</Text>
                <Text style={s.cardDelivery}>{item.deliveryTime}</Text>
              </View>
              <Text style={s.cardPrice}>{item.price}</Text>
            </View>
          </TouchableOpacity>
        )}
      />

      {/* Floating Action Button */}
      <TouchableOpacity
        style={s.fab}
        activeOpacity={0.8}
        onPress={() => Alert.alert("New Listing", "Create a new service listing")}
      >
        <Text style={s.fabIcon}>+</Text>
      </TouchableOpacity>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  headerArea: { paddingHorizontal: spacing.lg, paddingTop: 60 },
  title: { color: colors.textPrimary, fontSize: 28, fontWeight: "700" },
  subtitle: { color: colors.textSecondary, fontSize: 15, marginTop: 4, marginBottom: 20 },
  catRow: { gap: 8, paddingBottom: 16 },
  catChip: { paddingHorizontal: 16, paddingVertical: 8, borderRadius: radius.full, backgroundColor: colors.bgCard, borderWidth: 1, borderColor: colors.border },
  catChipActive: { backgroundColor: colors.orange, borderColor: colors.orange },
  catText: { color: colors.textSecondary, fontSize: 13, fontWeight: "600" },
  catTextActive: { color: "#FFF" },
  list: { paddingHorizontal: spacing.lg, paddingBottom: 100 },
  card: { backgroundColor: colors.bgCard, borderRadius: radius.lg, padding: spacing.lg, marginBottom: 12, borderWidth: 1, borderColor: colors.border },
  featBadge: { position: "absolute", top: 12, right: 12, backgroundColor: colors.orangeMuted, paddingHorizontal: 10, paddingVertical: 3, borderRadius: radius.full },
  featText: { color: colors.orange, fontSize: 11, fontWeight: "700" },
  cardHeader: { flexDirection: "row", gap: 14, marginBottom: 14 },
  avatar: { width: 48, height: 48, borderRadius: 24, backgroundColor: colors.surface, alignItems: "center", justifyContent: "center" },
  avatarText: { color: colors.orange, fontSize: 16, fontWeight: "700" },
  cardInfo: { flex: 1, gap: 2 },
  cardTitle: { color: colors.textPrimary, fontSize: 16, fontWeight: "700" },
  cardProvider: { color: colors.textMuted, fontSize: 13 },
  cardFooter: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingTop: 12, borderTopWidth: 1, borderTopColor: colors.border },
  cardMeta: { flexDirection: "row", alignItems: "center", gap: 4 },
  cardRating: { color: colors.warning, fontSize: 13, fontWeight: "600" },
  cardReviews: { color: colors.textMuted, fontSize: 12 },
  cardDot: { color: colors.textMuted },
  cardDelivery: { color: colors.textSecondary, fontSize: 12 },
  cardPrice: { color: colors.orange, fontSize: 16, fontWeight: "700" },
  fab: { position: "absolute", bottom: 100, right: 20, width: 56, height: 56, borderRadius: 28, backgroundColor: colors.orange, alignItems: "center", justifyContent: "center", elevation: 6, shadowColor: "#000", shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.3, shadowRadius: 4 },
  fabIcon: { color: "#FFF", fontSize: 28, fontWeight: "600", lineHeight: 30 },
});
