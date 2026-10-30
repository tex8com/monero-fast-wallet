import React from 'react';
import {
  StyleProp,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  ViewStyle,
} from 'react-native';

import { useI18n } from '../i18n';
import { transactionConfirmationProgress } from '../../../../packages/wallet-shared/src/transactionConfirmations';
import type { WalletTransaction } from '../services/NativeMoneroWallet';
import {
  formatAtomicXmr,
  normalizedTransactionAmountAtomic,
} from '../services/WalletFormat';
import { colors, radius } from '../theme/colors';
import { Icon } from './Icon';

type TransactionRowProps = {
  onPress: () => void;
  style?: StyleProp<ViewStyle>;
  transaction: WalletTransaction;
};

export function transactionRowKey(transaction: WalletTransaction): string {
  return [
    transaction.hash || 'unconfirmed',
    transaction.direction,
    transaction.subaddrAccount,
    transaction.timestamp,
  ].join(':');
}

export default function TransactionRow({
  onPress,
  style,
  transaction,
}: TransactionRowProps) {
  const { dateLocale, t } = useI18n();
  const incoming = transaction.direction === 'in';
  const amount = formatAtomicXmr(
    normalizedTransactionAmountAtomic(transaction),
    {
      maxFractionDigits: 12,
      minFractionDigits: 2,
    },
  );
  const confirmation = transactionConfirmationProgress(transaction);
  const progress = t('transactions.confirmationProgressShort', {
    current: confirmation.current, required: confirmation.required,
  });
  const status = confirmation.state === 'failed'
    ? t('status.failed')
    : confirmation.state === 'confirmed'
    ? t('transactions.confirmed')
    : transaction.pending
    ? t('status.pending')
    : t('transactions.confirming');
  const directionLabel = incoming
    ? confirmation.state === 'confirmed'
      ? t('home.received')
      : confirmation.state === 'failed'
      ? t('status.failed')
      : t('home.receiving')
    : t('home.sent');
  const date = transaction.timestamp
    ? new Date(transaction.timestamp * 1000).toLocaleDateString(dateLocale, {
        day: 'numeric',
        month: 'short',
      })
    : t('status.unconfirmed');

  return (
    <TouchableOpacity
      accessibilityHint={t('transactions.openDetails')}
      accessibilityRole="button"
      activeOpacity={0.74}
      onPress={onPress}
      style={[s.card, style]}
    >
      <View style={[s.icon, incoming ? s.iconIn : s.iconOut]}>
        <Icon
          name={incoming ? 'arrow-down' : 'arrow-up'}
          size={18}
          color={incoming ? colors.success : colors.error}
        />
      </View>
      <View style={s.middle}>
        <Text style={s.title} numberOfLines={1}>
          {directionLabel}{transaction.timestamp ? ` · ${date}` : ''}
        </Text>
        <Text style={s.meta} numberOfLines={1} testID="transaction-confirmation-progress">
          {progress} · {status}
        </Text>
      </View>
      <View style={s.right}>
        <Text
          adjustsFontSizeToFit
          minimumFontScale={0.72}
          numberOfLines={1}
          style={[s.amount, incoming && s.amountIn]}
        >
          {incoming ? '+' : '-'}
          {amount} XMR
        </Text>
        <Text style={s.hash} numberOfLines={1}>
          {transaction.hash
            ? `${transaction.hash.slice(0, 6)}...${transaction.hash.slice(-4)}`
            : t('status.unconfirmed')}
        </Text>
      </View>
      <Icon name="chevron-right" size={17} color={colors.textMuted} />
    </TouchableOpacity>
  );
}

const s = StyleSheet.create({
  card: {
    minHeight: 70,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.bgCard,
    borderRadius: radius.sm,
    paddingVertical: 13,
    paddingHorizontal: 13,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: 9,
  },
  icon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  iconIn: { backgroundColor: 'rgba(0,214,143,0.12)' },
  iconOut: { backgroundColor: 'rgba(255,68,102,0.12)' },
  middle: { flex: 1, minWidth: 0, marginRight: 8 },
  title: { color: colors.textPrimary, fontSize: 14, fontWeight: '800' },
  meta: { color: colors.textMuted, fontSize: 11, marginTop: 3 },
  right: {
    width: 116,
    minWidth: 86,
    alignItems: 'flex-end',
    marginRight: 5,
  },
  amount: { color: colors.textPrimary, fontSize: 13, fontWeight: '900' },
  amountIn: { color: colors.success },
  hash: {
    color: colors.textMuted,
    fontFamily: 'monospace',
    fontSize: 10,
    marginTop: 3,
  },
});
