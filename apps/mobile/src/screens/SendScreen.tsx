import React, { useMemo, useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import LinearGradient from "react-native-linear-gradient";
import { colors, radius, spacing } from "../theme/colors";
import { TRANSACTIONS, WALLET } from "../data/mock";
import { Icon } from "../components/Icon";

type Step = "form" | "confirm" | "done";

const CONTACTS = [
  { id: "1", name: "Alice", label: "Design", address: "48aBcD3fGhIjKlMnOpQrStUvWxYz1234567890AbCdEfGhIjKlMnOpQrStUvWxYz1234567890AbCdEfGh" },
  { id: "2", name: "Noah", label: "Ledger", address: "83MkR9uFv2PaQpLmZ6xY8dCwN1sT4bGhIjKlMnOpQrStUvWxYz1234567890AbCdEfGh" },
  { id: "3", name: "Vault", label: "Cold", address: "46zTr9QwErTyUiOpAsDfGhJkLmNbVcXz1234567890AbCdEfGhIjKlMnOpQrStUvWxYz" },
  { id: "4", name: "Sam", label: "Work", address: "89sAaBbCcDdEeFf00112233445566778899AaBbCcDdEeFf00112233445566778899" },
];

const QUICK_AMOUNTS = ["0.10", "0.25", "0.50", "1.00"];
const XMR_PRICE = 161.3;

function shortAddress(value: string) {
  if (!value) {
    return "No recipient selected";
  }
  if (value.length <= 18) {
    return value;
  }
  return `${value.slice(0, 8)}...${value.slice(-6)}`;
}

export default function SendScreen() {
  const [address, setAddress] = useState("");
  const [amount, setAmount] = useState("");
  const [step, setStep] = useState<Step>("form");
  const [selectedContact, setSelectedContact] = useState<string | null>(null);

  const amountNumber = Number.parseFloat(amount);
  const hasAmount = Number.isFinite(amountNumber) && amountNumber > 0;
  const usd = hasAmount ? (amountNumber * XMR_PRICE).toFixed(2) : "0.00";
  const sendEnabled = address.trim().length > 0 && hasAmount;
  const fee = "0.000012";
  const recentTransactions = useMemo(() => TRANSACTIONS.slice(0, 3), []);

  const reset = () => {
    setStep("form");
    setAddress("");
    setAmount("");
    setSelectedContact(null);
  };

  const selectContact = (contact: typeof CONTACTS[number]) => {
    setSelectedContact(contact.id);
    setAddress(contact.address);
  };

  if (step === "done") {
    return (
      <View style={s.containerCenter}>
        <StatusBar barStyle="light-content" backgroundColor={colors.bg} />
        <View style={s.doneCircle}>
          <Icon name="check" size={54} color={colors.success} strokeWidth={3} />
        </View>
        <Text style={s.doneTitle}>Payment Sent</Text>
        <Text style={s.doneSub}>{amount} XMR is on its way.</Text>
        <TouchableOpacity style={s.doneBtn} onPress={reset} activeOpacity={0.75}>
          <Text style={s.doneBtnText}>Back to Send</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (step === "confirm") {
    return (
      <View style={s.container}>
        <StatusBar barStyle="light-content" backgroundColor={colors.bg} />
        <ScrollView contentContainerStyle={s.confirmScroll} showsVerticalScrollIndicator={false}>
          <TouchableOpacity style={s.backButton} onPress={() => setStep("form")} activeOpacity={0.7}>
            <Icon name="arrow-left" size={20} color={colors.textSecondary} />
            <Text style={s.backText}>Back</Text>
          </TouchableOpacity>

          <Text style={s.title}>Review Payment</Text>
          <Text style={s.subtitle}>Confirm the private transfer details.</Text>

          <View style={s.confirmAmountCard}>
            <Text style={s.confirmAmount}>{amount} XMR</Text>
            <Text style={s.confirmUsd}>≈ ${usd} USD</Text>
          </View>

          <View style={s.card}>
            <ReviewRow label="Recipient" value={shortAddress(address)} mono />
            <Divider />
            <ReviewRow label="Network fee" value={`~${fee} XMR`} />
            <Divider />
            <ReviewRow label="Privacy" value="Stealth address" />
            <Divider />
            <ReviewRow label="Total" value={`${amount} XMR`} strong />
          </View>

          <View style={s.privacyBox}>
            <Icon name="lock" size={17} color={colors.orange} />
            <Text style={s.privacyText}>Sender, recipient, and amount stay hidden on-chain.</Text>
          </View>

          <TouchableOpacity onPress={() => setStep("done")} activeOpacity={0.86}>
            <LinearGradient colors={[colors.orange, colors.orangeDark]} style={s.primaryBtn}>
              <Icon name="send" size={20} color="#FFF" strokeWidth={2} />
              <Text style={s.primaryBtnText}>Confirm Send</Text>
            </LinearGradient>
          </TouchableOpacity>
        </ScrollView>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView style={s.container} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <StatusBar barStyle="light-content" backgroundColor={colors.bg} />
      <ScrollView contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
        <View style={s.header}>
          <View>
            <Text style={s.title}>Send XMR</Text>
            <Text style={s.subtitle}>Choose a contact or paste an address.</Text>
          </View>
          <View style={s.balanceBadge}>
            <Text style={s.balanceBadgeLabel}>Available</Text>
            <Text style={s.balanceBadgeValue}>{WALLET.balance}</Text>
          </View>
        </View>

        <View style={s.sectionHeader}>
          <Text style={s.sectionTitle}>Contacts</Text>
          <TouchableOpacity activeOpacity={0.7}>
            <Text style={s.sectionLink}>Address book</Text>
          </TouchableOpacity>
        </View>

        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.contactsRow}>
          {CONTACTS.map(contact => {
            const active = selectedContact === contact.id;
            return (
              <TouchableOpacity
                key={contact.id}
                style={[s.contactChip, active && s.contactChipActive]}
                onPress={() => selectContact(contact)}
                activeOpacity={0.72}
              >
                <View style={[s.contactAvatar, active && s.contactAvatarActive]}>
                  <Text style={s.contactInitial}>{contact.name.slice(0, 1)}</Text>
                </View>
                <Text style={s.contactName}>{contact.name}</Text>
                <Text style={s.contactLabel}>{contact.label}</Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>

        <View style={s.card}>
          <View style={s.cardHeader}>
            <Text style={s.fieldLabel}>Recipient</Text>
            <TouchableOpacity style={s.iconButton} activeOpacity={0.72}>
              <Icon name="qr-scan" size={20} color={colors.orange} />
            </TouchableOpacity>
          </View>
          <TextInput
            style={s.addressInput}
            placeholder="Paste Monero address"
            placeholderTextColor={colors.textMuted}
            value={address}
            onChangeText={(value) => {
              setAddress(value);
              setSelectedContact(null);
            }}
            autoCapitalize="none"
            autoCorrect={false}
            multiline
          />
        </View>

        <View style={s.amountCard}>
          <View style={s.cardHeader}>
            <Text style={s.fieldLabel}>Amount</Text>
            <TouchableOpacity onPress={() => setAmount(WALLET.balance)} activeOpacity={0.7}>
              <Text style={s.maxText}>MAX</Text>
            </TouchableOpacity>
          </View>
          <View style={s.amountRow}>
            <TextInput
              style={s.amountInput}
              placeholder="0.0000"
              placeholderTextColor={colors.textMuted}
              value={amount}
              onChangeText={setAmount}
              keyboardType="decimal-pad"
            />
            <Text style={s.xmrLabel}>XMR</Text>
          </View>
          <Text style={s.usdLabel}>≈ ${usd} USD</Text>

          <View style={s.quickRow}>
            {QUICK_AMOUNTS.map(value => (
              <TouchableOpacity key={value} style={s.quickBtn} onPress={() => setAmount(value)} activeOpacity={0.72}>
                <Text style={s.quickBtnText}>{value}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        <View style={s.summaryCard}>
          <View>
            <Text style={s.summaryTitle}>Private transfer</Text>
            <Text style={s.summaryText}>Fee ~{fee} XMR · Recipient hidden</Text>
          </View>
          <Icon name="lock" size={22} color={colors.orange} />
        </View>

        <TouchableOpacity disabled={!sendEnabled} onPress={() => setStep("confirm")} activeOpacity={0.86} style={s.formCta}>
          <LinearGradient
            colors={sendEnabled ? [colors.orange, colors.orangeDark] : [colors.surface, colors.surface]}
            style={[s.primaryBtn, !sendEnabled && s.primaryBtnDisabled]}
          >
            <Icon name="send" size={20} color="#FFF" strokeWidth={2} />
            <Text style={s.primaryBtnText}>Send XMR</Text>
          </LinearGradient>
        </TouchableOpacity>

        <View style={s.sectionHeaderRecent}>
          <Text style={s.sectionTitle}>Recent Transactions</Text>
          <TouchableOpacity activeOpacity={0.7}>
            <Text style={s.viewMore}>View more</Text>
          </TouchableOpacity>
        </View>

        {recentTransactions.map(tx => {
          const isIn = tx.type === "received";
          return (
            <View key={tx.id} style={s.txCard}>
              <View style={[s.txIcon, isIn ? s.txIconIn : s.txIconOut]}>
                <Icon name={isIn ? "arrow-down" : "arrow-up"} size={18} color={isIn ? colors.success : colors.error} />
              </View>
              <View style={s.txMid}>
                <Text style={s.txTitle}>{isIn ? "Received" : "Sent"}</Text>
                <Text style={s.txMeta} numberOfLines={1}>{tx.address} · {tx.date}</Text>
              </View>
              <View style={s.txRight}>
                <Text style={[s.txAmount, isIn && s.txAmountIn]}>{tx.xmrAmount}</Text>
                <Text style={s.txStatus}>{tx.status}</Text>
              </View>
            </View>
          );
        })}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function ReviewRow({ label, value, strong, mono }: { label: string; value: string; strong?: boolean; mono?: boolean }) {
  return (
    <View style={s.reviewRow}>
      <Text style={s.reviewLabel}>{label}</Text>
      <Text style={[s.reviewValue, strong && s.reviewValueStrong, mono && s.reviewValueMono]} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

function Divider() {
  return <View style={s.divider} />;
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  containerCenter: { flex: 1, backgroundColor: colors.bg, justifyContent: "center", alignItems: "center", paddingHorizontal: spacing.lg },
  scroll: { paddingHorizontal: spacing.lg, paddingTop: 56, paddingBottom: 132 },
  confirmScroll: { paddingHorizontal: spacing.lg, paddingTop: 60, paddingBottom: 120 },

  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 24, gap: 14 },
  title: { color: colors.textPrimary, fontSize: 30, fontWeight: "800", letterSpacing: 0 },
  subtitle: { color: colors.textSecondary, fontSize: 14, marginTop: 5, lineHeight: 20 },
  balanceBadge: { alignItems: "flex-end", backgroundColor: "rgba(255,255,255,0.045)", borderRadius: 14, paddingHorizontal: 12, paddingVertical: 9, borderWidth: 1, borderColor: colors.border },
  balanceBadgeLabel: { color: colors.textMuted, fontSize: 11, fontWeight: "700", marginBottom: 2 },
  balanceBadgeValue: { color: colors.textPrimary, fontSize: 14, fontWeight: "800" },

  sectionHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 12 },
  sectionHeaderRecent: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 8, marginBottom: 12 },
  sectionTitle: { color: colors.textPrimary, fontSize: 17, fontWeight: "800" },
  sectionLink: { color: colors.orange, fontSize: 13, fontWeight: "700" },
  viewMore: { color: "rgba(242,104,34,0.76)", fontSize: 13, fontWeight: "700" },

  contactsRow: { gap: 10, paddingRight: spacing.lg, paddingBottom: 18 },
  contactChip: { width: 84, borderRadius: 14, backgroundColor: "rgba(255,255,255,0.045)", borderWidth: 1, borderColor: colors.border, padding: 10, alignItems: "center" },
  contactChipActive: { borderColor: colors.orange, backgroundColor: "rgba(242,104,34,0.12)" },
  contactAvatar: { width: 34, height: 34, borderRadius: 17, backgroundColor: colors.bgElevated, alignItems: "center", justifyContent: "center", marginBottom: 8 },
  contactAvatarActive: { backgroundColor: colors.orange },
  contactInitial: { color: colors.textPrimary, fontSize: 15, fontWeight: "800" },
  contactName: { color: colors.textPrimary, fontSize: 12, fontWeight: "800" },
  contactLabel: { color: colors.textMuted, fontSize: 11, marginTop: 2 },

  card: { backgroundColor: colors.bgCard, borderRadius: radius.md, padding: spacing.md, borderWidth: 1, borderColor: colors.border, marginBottom: 12 },
  amountCard: { backgroundColor: colors.bgCard, borderRadius: radius.md, padding: spacing.md, borderWidth: 1, borderColor: colors.border, marginBottom: 12 },
  cardHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 12 },
  fieldLabel: { color: colors.textSecondary, fontSize: 12, fontWeight: "800", letterSpacing: 0.5, textTransform: "uppercase" },
  iconButton: { width: 34, height: 34, borderRadius: 17, backgroundColor: colors.orangeMuted, alignItems: "center", justifyContent: "center" },
  maxText: { color: colors.orange, fontSize: 12, fontWeight: "900", letterSpacing: 0.8 },
  addressInput: { minHeight: 54, color: colors.textPrimary, fontSize: 15, lineHeight: 21, padding: 0, textAlignVertical: "top" },

  amountRow: { flexDirection: "row", alignItems: "center", justifyContent: "center" },
  amountInput: { flex: 1, color: colors.textPrimary, fontSize: 36, fontWeight: "800", textAlign: "center", paddingVertical: 4, letterSpacing: 0 },
  xmrLabel: { color: colors.orange, fontSize: 15, fontWeight: "900", marginLeft: 10 },
  usdLabel: { color: colors.textMuted, fontSize: 14, textAlign: "center", marginBottom: 12 },
  quickRow: { flexDirection: "row", gap: 8 },
  quickBtn: { flex: 1, paddingVertical: 8, borderRadius: radius.sm, backgroundColor: "rgba(255,255,255,0.055)", alignItems: "center", borderWidth: 1, borderColor: "rgba(255,255,255,0.06)" },
  quickBtnText: { color: colors.textSecondary, fontSize: 13, fontWeight: "800" },

  summaryCard: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", backgroundColor: "rgba(242,104,34,0.09)", borderRadius: radius.md, padding: spacing.md, borderWidth: 1, borderColor: "rgba(242,104,34,0.18)", marginBottom: 14 },
  summaryTitle: { color: colors.textPrimary, fontSize: 15, fontWeight: "800", marginBottom: 3 },
  summaryText: { color: "rgba(255,255,255,0.46)", fontSize: 13, fontWeight: "500" },

  txCard: { flexDirection: "row", alignItems: "center", backgroundColor: colors.bgCard, borderRadius: radius.md, padding: 14, borderWidth: 1, borderColor: colors.border, marginBottom: 9 },
  txIcon: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center", marginRight: 12 },
  txIconIn: { backgroundColor: "rgba(0,214,143,0.12)" },
  txIconOut: { backgroundColor: "rgba(255,68,102,0.12)" },
  txMid: { flex: 1, marginRight: 10 },
  txTitle: { color: colors.textPrimary, fontSize: 14, fontWeight: "800" },
  txMeta: { color: colors.textMuted, fontSize: 11, marginTop: 3 },
  txRight: { alignItems: "flex-end" },
  txAmount: { color: colors.textPrimary, fontSize: 14, fontWeight: "900" },
  txAmountIn: { color: colors.success },
  txStatus: { color: colors.textMuted, fontSize: 11, marginTop: 3, textTransform: "capitalize" },

  formCta: { marginBottom: 22 },
  primaryBtn: { height: 54, borderRadius: radius.md, alignItems: "center", justifyContent: "center", flexDirection: "row", gap: 10 },
  primaryBtnDisabled: { opacity: 0.55 },
  primaryBtnText: { color: "#FFF", fontSize: 17, fontWeight: "900" },

  backButton: { flexDirection: "row", alignItems: "center", gap: 8, alignSelf: "flex-start", marginBottom: 22 },
  backText: { color: colors.textSecondary, fontSize: 15, fontWeight: "700" },
  confirmAmountCard: { alignItems: "center", backgroundColor: colors.bgCard, borderRadius: radius.lg, paddingVertical: 28, borderWidth: 1, borderColor: colors.border, marginBottom: 14 },
  confirmAmount: { color: colors.textPrimary, fontSize: 36, fontWeight: "900" },
  confirmUsd: { color: colors.textSecondary, fontSize: 15, marginTop: 6, fontWeight: "600" },
  reviewRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 14, gap: 14 },
  reviewLabel: { color: colors.textSecondary, fontSize: 14, fontWeight: "600" },
  reviewValue: { flex: 1, color: colors.textPrimary, fontSize: 14, fontWeight: "700", textAlign: "right" },
  reviewValueStrong: { fontSize: 17, fontWeight: "900" },
  reviewValueMono: { fontFamily: "monospace", color: colors.orange },
  divider: { height: 1, backgroundColor: colors.border },
  privacyBox: { backgroundColor: colors.orangeMuted, borderRadius: radius.md, padding: spacing.md, marginBottom: 28, flexDirection: "row", alignItems: "center", gap: 10 },
  privacyText: { color: colors.orange, fontSize: 13, fontWeight: "700", lineHeight: 19, flex: 1 },

  doneCircle: { width: 104, height: 104, borderRadius: 52, backgroundColor: "rgba(0,214,143,0.12)", alignItems: "center", justifyContent: "center", marginBottom: 24 },
  doneTitle: { color: colors.success, fontSize: 30, fontWeight: "900", marginBottom: 8 },
  doneSub: { color: colors.textSecondary, fontSize: 16, marginBottom: 40, textAlign: "center" },
  doneBtn: { paddingVertical: 16, paddingHorizontal: 34, backgroundColor: colors.surface, borderRadius: radius.md },
  doneBtnText: { color: colors.textPrimary, fontSize: 16, fontWeight: "800" },
});
