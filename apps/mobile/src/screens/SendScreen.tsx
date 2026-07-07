import React, { useState } from "react";
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
import { Icon } from "../components/Icon";
import { useXmrPrice } from "../data/priceService";
import type { PreparedTransaction } from "../services/NativeMoneroWallet";
import {
  atomicXmrToNumber,
  formatAtomicXmr,
  parseXmrToAtomic,
  toAtomicBigInt,
} from "../services/WalletFormat";
import { useWalletState } from "../services/WalletState";
import { walletService } from "../services/WalletService";

type Step = "form" | "confirm";

const CONTACTS = [
  { id: "1", name: "Alice", label: "Design", address: "48aBcD3fGhIjKlMnOpQrStUvWxYz1234567890AbCdEfGhIjKlMnOpQrStUvWxYz1234567890AbCdEfGh" },
  { id: "2", name: "Noah", label: "Ledger", address: "83MkR9uFv2PaQpLmZ6xY8dCwN1sT4bGhIjKlMnOpQrStUvWxYz1234567890AbCdEfGh" },
  { id: "3", name: "Vault", label: "Cold", address: "46zTr9QwErTyUiOpAsDfGhJkLmNbVcXz1234567890AbCdEfGhIjKlMnOpQrStUvWxYz" },
  { id: "4", name: "Sam", label: "Work", address: "89sAaBbCcDdEeFf00112233445566778899AaBbCcDdEeFf00112233445566778899" },
];

const QUICK_AMOUNTS = ["0.10", "0.25", "0.50", "1.00"];

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
  const [sendError, setSendError] = useState<string | undefined>();
  const [sendStatus, setSendStatus] = useState<string | undefined>();
  const [preparedTx, setPreparedTx] = useState<PreparedTransaction | undefined>();
  const [sending, setSending] = useState(false);
  const { price } = useXmrPrice();
  const {
    refreshSnapshot,
    refreshTransactions,
    session,
    snapshot,
    status,
    transactions,
  } = useWalletState();

  const unlockedAtomic = toAtomicBigInt(snapshot?.unlockedBalanceAtomic);
  const amountAtomic = parseXmrToAtomic(amount);
  const hasAmount = amountAtomic !== undefined && amountAtomic > 0n;
  const amountNumber = hasAmount ? atomicXmrToNumber(amountAtomic) : 0;
  const amountAvailable =
    amountAtomic !== undefined &&
    amountAtomic > 0n &&
    amountAtomic <= unlockedAtomic;
  const usd = hasAmount && price > 0 ? (amountNumber * price).toFixed(2) : "0.00";
  const sendEnabled =
    Boolean(snapshot && session) && address.trim().length > 0 && amountAvailable;
  const availableXmr = snapshot
    ? formatAtomicXmr(snapshot.unlockedBalanceAtomic, {
        maxFractionDigits: 4,
        minFractionDigits: 2,
      })
    : status === "locked"
      ? "Locked"
      : "0.00";
  const maxAmount = snapshot
    ? formatAtomicXmr(snapshot.unlockedBalanceAtomic, {
        maxFractionDigits: 12,
      })
    : "";
  const preparedFee = preparedTx
    ? formatAtomicXmr(preparedTx.feeAtomic, { maxFractionDigits: 12 })
    : undefined;
  const totalXmr =
    amountAtomic !== undefined && preparedTx
      ? formatAtomicXmr(amountAtomic + toAtomicBigInt(preparedTx.feeAtomic), {
          maxFractionDigits: 12,
        })
      : amount || "0";

  const clearPreparedTransaction = () => {
    setPreparedTx(undefined);
    setSendStatus(undefined);
  };

  const selectContact = (contact: typeof CONTACTS[number]) => {
    setSelectedContact(contact.id);
    setAddress(contact.address);
    setSendError(undefined);
    clearPreparedTransaction();
  };

  const handleSend = async () => {
    if (!session) {
      setSendError("Open or create a wallet before sending.");
      return;
    }
    if (amountAtomic === undefined || amountAtomic <= 0n) {
      setSendError("Enter a valid XMR amount.");
      return;
    }

    setSending(true);
    setSendError(undefined);
    try {
      if (!preparedTx) {
        const nextTransaction = await walletService.prepareTransaction(session, {
          address: address.trim(),
          amountAtomic: amountAtomic.toString(),
          priority: "low",
        });
        if (nextTransaction.status !== "ok" || !nextTransaction.id) {
          throw new Error(
            nextTransaction.error || "Transaction preparation failed",
          );
        }
        setPreparedTx(nextTransaction);
        setSendStatus("Fee prepared. Review once more, then send.");
        return;
      }

      const committed = await walletService.commitTransaction(
        session,
        preparedTx.id,
      );
      if (committed.status !== "ok") {
        throw new Error(committed.error || "Transaction broadcast failed");
      }

      setAddress("");
      setAmount("");
      setSelectedContact(null);
      setPreparedTx(undefined);
      setSendStatus("Transaction broadcast.");
      setStep("form");
      await Promise.all([refreshSnapshot(), refreshTransactions()]);
    } catch (error) {
      setSendError(error instanceof Error ? error.message : String(error));
    } finally {
      setSending(false);
    }
  };

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
            <ReviewRow
              label="Network fee"
              value={preparedFee ? `${preparedFee} XMR` : "Prepared next"}
            />
            <Divider />
            <ReviewRow label="Privacy" value="Stealth address" />
            <Divider />
            <ReviewRow label="Total" value={`${totalXmr} XMR`} strong />
          </View>

          <View style={s.privacyBox}>
            <Icon name="lock" size={17} color={colors.orange} />
            <Text style={s.privacyText}>Sender, recipient, and amount stay hidden on-chain.</Text>
          </View>

          {sendStatus ? <Text style={s.statusText}>{sendStatus}</Text> : null}
          {sendError ? <Text style={s.errorText}>{sendError}</Text> : null}

          <TouchableOpacity
            onPress={handleSend}
            activeOpacity={0.86}
            disabled={sending}
          >
            <LinearGradient
              colors={[colors.orange, colors.orangeDark]}
              style={[s.primaryBtn, sending && s.primaryBtnDisabled]}
            >
              <Icon name="send" size={20} color="#FFF" strokeWidth={2} />
              <Text style={s.primaryBtnText}>
                {sending ? "Working..." : preparedTx ? "Send Now" : "Prepare Send"}
              </Text>
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
            <Text style={s.balanceBadgeValue}>{availableXmr}</Text>
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
              setSendError(undefined);
              clearPreparedTransaction();
            }}
            autoCapitalize="none"
            autoCorrect={false}
            multiline
          />
        </View>

        <View style={s.amountCard}>
          <View style={s.cardHeader}>
            <Text style={s.fieldLabel}>Amount</Text>
            <TouchableOpacity
              onPress={() => {
                setAmount(maxAmount);
                setSendError(undefined);
                clearPreparedTransaction();
              }}
              activeOpacity={0.7}
              disabled={!snapshot}
            >
              <Text style={s.maxText}>MAX</Text>
            </TouchableOpacity>
          </View>
          <View style={s.amountRow}>
            <TextInput
              style={s.amountInput}
              placeholder="0.0000"
              placeholderTextColor={colors.textMuted}
              value={amount}
              onChangeText={value => {
                setAmount(value);
                setSendError(undefined);
                clearPreparedTransaction();
              }}
              keyboardType="decimal-pad"
            />
            <Text style={s.xmrLabel}>XMR</Text>
          </View>
          <Text style={s.usdLabel}>≈ ${usd} USD</Text>

          <View style={s.quickRow}>
            {QUICK_AMOUNTS.map(value => (
              <TouchableOpacity
                key={value}
                style={s.quickBtn}
                onPress={() => {
                  setAmount(value);
                  setSendError(undefined);
                  clearPreparedTransaction();
                }}
                activeOpacity={0.72}
              >
                <Text style={s.quickBtnText}>{value}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {!snapshot ? (
          <Text style={s.errorText}>
            Open or create a wallet before preparing a transfer.
          </Text>
        ) : hasAmount && !amountAvailable ? (
          <Text style={s.errorText}>Amount is above unlocked balance.</Text>
        ) : null}

        <View style={s.summaryCard}>
          <View>
            <Text style={s.summaryTitle}>Private transfer</Text>
            <Text style={s.summaryText}>
              {preparedFee ? `Fee ${preparedFee} XMR` : "Fee prepared before broadcast"} · Recipient hidden
            </Text>
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

        {transactions.length > 0 ? (
          transactions.slice(0, 3).map(transaction => {
            const incoming = transaction.direction === "in";
            const xmr = formatAtomicXmr(transaction.amountAtomic, {
              maxFractionDigits: 4,
              minFractionDigits: 2,
            });
            return (
              <View
                style={s.txCard}
                key={transaction.hash || `${transaction.timestamp}-${transaction.amountAtomic}`}
              >
                <View style={[s.txIcon, incoming ? s.txIconIn : s.txIconOut]}>
                  <Icon
                    name={incoming ? "arrow-down" : "arrow-up"}
                    size={18}
                    color={incoming ? colors.success : colors.error}
                  />
                </View>
                <View style={s.txMid}>
                  <Text style={s.txTitle}>{incoming ? "Received" : "Sent"}</Text>
                  <Text style={s.txMeta}>
                    {transactionTimestampLabel(transaction.timestamp)}
                  </Text>
                </View>
                <View style={s.txRight}>
                  <Text style={[s.txAmount, incoming && s.txAmountIn]}>
                    {incoming ? "+" : "-"}{xmr}
                  </Text>
                  <Text style={s.txStatus}>
                    {transaction.pending ? "Pending" : `${transaction.confirmations} conf.`}
                  </Text>
                </View>
              </View>
            );
          })
        ) : (
          <View style={s.emptyTxCard}>
            <Text style={s.emptyTxTitle}>No recent transfers</Text>
            <Text style={s.emptyTxText}>
              Synced wallet activity appears here after the wallet is opened.
            </Text>
          </View>
        )}
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

function transactionTimestampLabel(timestamp: number): string {
  if (!timestamp) {
    return "Unconfirmed";
  }

  return new Date(timestamp * 1000).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
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
  statusText: { color: colors.success, fontSize: 13, lineHeight: 19, marginBottom: 14 },
  errorText: { color: colors.error, fontSize: 13, lineHeight: 19, marginBottom: 14 },
  emptyTxCard: { backgroundColor: colors.bgCard, borderRadius: radius.md, padding: spacing.md, borderWidth: 1, borderColor: colors.border, marginBottom: 9 },
  emptyTxTitle: { color: colors.textPrimary, fontSize: 14, fontWeight: "800", marginBottom: 4 },
  emptyTxText: { color: colors.textSecondary, fontSize: 12, lineHeight: 18 },
});
