import React from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import Clipboard from '@react-native-clipboard/clipboard';
import { useI18n } from '../i18n';
import { formatAtomicXmr } from '../services/WalletFormat';
import {
  sendPlanOutcome,
  sendPlanTransactionIds,
  type SendPlan,
} from '../services/WalletSendPlan';
import { colors, spacing, radius } from '../theme/colors';

export default function SendPlanReceipt({
  plan,
  checking,
  error,
  onStatus,
  onDiscard,
  onClose,
}: {
  plan: SendPlan;
  checking: boolean;
  error?: string;
  onStatus: () => void;
  onDiscard: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const outcome = sendPlanOutcome(plan);
  const canDiscard =
    outcome === 'not-sent' &&
    plan.broadcastAttempted === false &&
    plan.phase !== 'broadcasting';
  const amount = (value: string | null | undefined) =>
    value == null
      ? t('send.planAmountUnknown')
      : `${formatAtomicXmr(value, { maxFractionDigits: 12 })} XMR`;
  return (
    <ScrollView contentContainerStyle={s.screen} testID="send-plan-receipt">
      <Text
        style={[
          s.title,
          {
            color: outcome === 'complete' ? colors.success : colors.textPrimary,
          },
        ]}
      >
        {t(`send.planOutcome.${outcome}`)}
      </Text>
      <Text style={s.description}>
        {t(
          outcome === 'complete'
            ? 'send.successSubtitle'
            : 'send.planReceiptExplanation',
        )}
      </Text>
      {plan.address ? (
        <View style={s.card}>
          <Text style={s.label}>{t('send.recipient')}</Text>
          <Text selectable style={s.address}>
            {plan.address}
          </Text>
        </View>
      ) : null}
      <View style={s.card}>
        <Text style={s.label}>{t('send.planAcceptedAmount')}</Text>
        <Text style={s.value}>
          {amount(
            plan.broadcastedTotalsKnown === false
              ? undefined
              : plan.broadcastedAmountAtomic,
          )}
        </Text>
        <Text style={s.label}>{t('transactions.fee')}</Text>
        <Text style={s.value}>
          {amount(
            plan.broadcastedTotalsKnown === false
              ? undefined
              : plan.broadcastedFeeAtomic,
          )}
        </Text>
        {sendPlanTransactionIds(plan).map(id => (
          <View key={id} style={s.transaction}>
            <Text style={s.label}>
              {t(
                plan.broadcastedTxIds?.includes(id)
                  ? 'send.planTxAccepted'
                  : plan.uncertainTxIds?.includes(id)
                  ? 'send.planTxUncertain'
                  : 'send.planTxRemaining',
              )}
            </Text>
            <Text selectable style={s.address}>
              {id}
            </Text>
            <TouchableOpacity
              accessibilityRole="button"
              onPress={() => Clipboard.setString(id)}
            >
              <Text style={s.link}>{t('transactions.copyId')}</Text>
            </TouchableOpacity>
          </View>
        ))}
      </View>
      {error ? (
        <Text accessibilityRole="alert" style={s.error}>
          {error}
        </Text>
      ) : null}
      {checking ? <ActivityIndicator color={colors.orange} /> : null}
      <TouchableOpacity
        accessibilityRole="button"
        disabled={checking}
        testID="send-plan-refresh"
        onPress={onStatus}
        style={s.button}
      >
        <Text style={s.buttonText}>{t('send.planCheckStatus')}</Text>
      </TouchableOpacity>
      {canDiscard && plan.leaseHeld ? (
        <TouchableOpacity
          accessibilityRole="button"
          disabled={checking}
          testID="send-plan-discard"
          onPress={onDiscard}
          style={s.button}
        >
          <Text style={s.buttonText}>{t('send.planDiscard')}</Text>
        </TouchableOpacity>
      ) : null}
      <TouchableOpacity
        accessibilityRole="button"
        onPress={onClose}
        style={s.button}
      >
        <Text style={s.buttonText}>{t('action.close')}</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  screen: {
    flexGrow: 1,
    backgroundColor: colors.bg,
    padding: spacing.lg,
    gap: spacing.md,
  },
  title: { fontSize: 25, fontWeight: '800', marginTop: spacing.xl },
  description: { color: colors.textSecondary, lineHeight: 22 },
  card: {
    padding: spacing.md,
    borderRadius: radius.lg,
    backgroundColor: colors.bgCard,
    gap: spacing.sm,
  },
  label: { color: colors.textSecondary, fontSize: 13 },
  value: {
    color: colors.textPrimary,
    fontSize: 22,
    fontWeight: '700',
    marginBottom: spacing.md,
  },
  address: { color: colors.textPrimary, fontSize: 13, lineHeight: 20 },
  transaction: {
    borderTopColor: colors.border,
    borderTopWidth: 1,
    paddingTop: spacing.md,
    marginTop: spacing.md,
    gap: spacing.sm,
  },
  link: { color: colors.orange, paddingVertical: spacing.sm },
  button: {
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
  },
  buttonText: { color: colors.textPrimary, fontWeight: '700' },
  error: { color: colors.error, lineHeight: 21 },
});
