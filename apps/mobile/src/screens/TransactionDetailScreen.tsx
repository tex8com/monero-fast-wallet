import React, { useMemo, useState } from 'react';
import {
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import Clipboard from '@react-native-clipboard/clipboard';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon } from '../components/Icon';
import { useI18n } from '../i18n';
import type { WalletTransaction } from '../services/NativeMoneroWallet';
import { formatAtomicXmr } from '../services/WalletFormat';
import { useWalletState } from '../services/WalletState';
import { colors, radius, spacing } from '../theme/colors';

type DetailRouteParams = {
  transaction?: WalletTransaction;
  transactionHash?: string;
  walletId?: string;
  walletName?: string;
};

export default function TransactionDetailScreen({ navigation, route }: any) {
  const insets = useSafeAreaInsets();
  const { dateLocale, t } = useI18n();
  const { registeredWallet, transactions } = useWalletState();
  const [copied, setCopied] = useState(false);
  const params = (route?.params ?? {}) as DetailRouteParams;
  const transaction = useMemo(
    () =>
      transactions.find(item => item.hash === params.transactionHash) ??
      params.transaction,
    [params.transaction, params.transactionHash, transactions],
  );

  if (!transaction) {
    return (
      <View style={s.container}>
        <View style={[s.header, { paddingTop: Math.max(insets.top + 12, 54) }]}>
          <BackButton navigation={navigation} label={t('action.back')} />
          <Text style={s.headerTitle}>{t('transactions.details')}</Text>
        </View>
        <View style={s.missing}>
          <Text style={s.missingTitle}>{t('transactions.notFound')}</Text>
        </View>
      </View>
    );
  }

  const incoming = transaction.direction === 'in';
  const amount = formatAtomicXmr(transaction.amountAtomic, {
    maxFractionDigits: 12,
    minFractionDigits: 2,
  });
  const fee = formatAtomicXmr(transaction.feeAtomic, {
    maxFractionDigits: 12,
    minFractionDigits: 2,
  });
  const status = transaction.failed
    ? t('status.failed')
    : transaction.pending
    ? t('status.pending')
    : transaction.confirmations > 0
    ? t('transactions.confirmed')
    : t('status.unconfirmed');
  const date = transaction.timestamp
    ? new Date(transaction.timestamp * 1000).toLocaleString(dateLocale, {
        dateStyle: 'medium',
        timeStyle: 'short',
      })
    : t('status.unconfirmed');
  const walletName =
    params.walletName ?? registeredWallet?.walletName ?? t('common.wallet');
  const paymentId = transaction.paymentId.replace(/^0+$/, '');

  const copyTransactionId = () => {
    if (!transaction.hash) {
      return;
    }
    Clipboard.setString(transaction.hash);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  return (
    <View style={s.container}>
      <View style={[s.header, { paddingTop: Math.max(insets.top + 12, 54) }]}>
        <BackButton navigation={navigation} label={t('action.back')} />
        <Text style={s.headerTitle}>{t('transactions.details')}</Text>
      </View>
      <ScrollView
        contentContainerStyle={[
          s.scroll,
          { paddingBottom: Math.max(insets.bottom + 28, 44) },
        ]}
      >
        <View style={s.summary}>
          <View style={[s.summaryIcon, incoming ? s.iconIn : s.iconOut]}>
            <Icon
              name={incoming ? 'arrow-down' : 'arrow-up'}
              size={24}
              color={incoming ? colors.success : colors.error}
            />
          </View>
          <Text style={s.summaryDirection}>
            {incoming ? t('home.received') : t('home.sent')}
          </Text>
          <Text
            adjustsFontSizeToFit
            minimumFontScale={0.7}
            numberOfLines={1}
            style={[s.summaryAmount, incoming && s.summaryAmountIn]}
          >
            {incoming ? '+' : '-'}
            {amount} XMR
          </Text>
          <View
            style={[
              s.statusPill,
              transaction.failed
                ? s.statusFailed
                : transaction.pending
                ? s.statusPending
                : s.statusConfirmed,
            ]}
          >
            <Text
              style={[
                s.statusText,
                transaction.failed
                  ? s.statusTextFailed
                  : transaction.pending
                  ? s.statusTextPending
                  : s.statusTextConfirmed,
              ]}
            >
              {status}
            </Text>
          </View>
        </View>

        <Text style={s.sectionLabel}>{t('transactions.transactionId')}</Text>
        <View style={s.hashCard}>
          <Text selectable style={s.hashText}>
            {transaction.hash || t('status.unconfirmed')}
          </Text>
          {transaction.hash ? (
            <TouchableOpacity
              accessibilityLabel={t('transactions.copyId')}
              accessibilityRole="button"
              activeOpacity={0.72}
              onPress={copyTransactionId}
              style={[s.copyButton, copied && s.copyButtonDone]}
            >
              <Icon
                name={copied ? 'check' : 'copy'}
                size={17}
                color={copied ? colors.success : colors.orange}
              />
              <Text style={[s.copyText, copied && s.copyTextDone]}>
                {copied ? t('action.copied') : t('transactions.copyId')}
              </Text>
            </TouchableOpacity>
          ) : null}
        </View>

        <View style={s.details}>
          <DetailRow label={t('transactions.status')} value={status} />
          <DetailRow
            label={t('transactions.direction')}
            value={incoming ? t('home.received') : t('home.sent')}
          />
          <DetailRow label={t('transactions.amount')} value={`${amount} XMR`} />
          <DetailRow label={t('transactions.fee')} value={`${fee} XMR`} />
          <DetailRow
            label={t('transactions.confirmations')}
            value={String(transaction.confirmations)}
          />
          <DetailRow
            label={t('transactions.blockHeight')}
            value={transaction.blockHeight ? String(transaction.blockHeight) : '—'}
          />
          <DetailRow label={t('transactions.date')} value={date} />
          <DetailRow label={t('transactions.wallet')} value={walletName} />
          <DetailRow
            label={t('transactions.type')}
            value={
              transaction.coinbase
                ? t('transactions.miningReward')
                : t('transactions.transfer')
            }
          />
          <DetailRow
            label={t('transactions.account')}
            value={String(transaction.subaddrAccount)}
          />
          {transaction.subaddrIndices.length > 0 ? (
            <DetailRow
              label={t('transactions.subaddresses')}
              value={transaction.subaddrIndices.join(', ')}
            />
          ) : null}
          {transaction.unlockTime > 0 ? (
            <DetailRow
              label={t('transactions.unlockTime')}
              value={String(transaction.unlockTime)}
            />
          ) : null}
          {paymentId ? (
            <DetailRow
              label={t('transactions.paymentId')}
              value={transaction.paymentId}
              mono
              selectable
            />
          ) : null}
          {transaction.label ? (
            <DetailRow
              label={t('transactions.label')}
              value={transaction.label}
            />
          ) : null}
          {transaction.description ? (
            <DetailRow
              label={t('transactions.description')}
              value={transaction.description}
            />
          ) : null}
        </View>

        {transaction.transfers.length > 0 ? (
          <View style={s.transferSection}>
            <Text style={s.sectionLabel}>{t('transactions.transfers')}</Text>
            {transaction.transfers.map((transfer, index) => (
              <View
                key={`${transfer.address}:${transfer.amountAtomic}:${index}`}
                style={s.transferCard}
              >
                <Text style={s.transferLabel}>
                  {t('transactions.transferNumber', { count: index + 1 })}
                </Text>
                <Text selectable style={s.transferAddress}>
                  {transfer.address || t('transactions.hiddenAddress')}
                </Text>
                <Text style={s.transferAmount}>
                  {formatAtomicXmr(transfer.amountAtomic, {
                    maxFractionDigits: 12,
                    minFractionDigits: 2,
                  })}{' '}
                  XMR
                </Text>
              </View>
            ))}
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

function BackButton({ navigation, label }: { navigation: any; label: string }) {
  return (
    <TouchableOpacity
      accessibilityLabel={label}
      accessibilityRole="button"
      activeOpacity={0.7}
      onPress={() => navigation.goBack()}
      style={s.back}
    >
      <Icon name="arrow-left" size={22} color={colors.textPrimary} />
    </TouchableOpacity>
  );
}

function DetailRow({
  label,
  mono,
  selectable,
  value,
}: {
  label: string;
  mono?: boolean;
  selectable?: boolean;
  value: string;
}) {
  return (
    <View style={s.detailRow}>
      <Text style={s.detailLabel}>{label}</Text>
      <Text
        selectable={selectable}
        style={[s.detailValue, mono && s.mono]}
      >
        {value}
      </Text>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingBottom: 18,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  back: {
    width: 42,
    height: 42,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
  },
  headerTitle: { color: colors.textPrimary, fontSize: 22, fontWeight: '900' },
  scroll: { padding: spacing.lg },
  summary: { alignItems: 'center', paddingVertical: 10, marginBottom: 28 },
  summaryIcon: {
    width: 58,
    height: 58,
    borderRadius: 29,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
  },
  iconIn: { backgroundColor: 'rgba(0,214,143,0.12)' },
  iconOut: { backgroundColor: 'rgba(255,68,102,0.12)' },
  summaryDirection: {
    color: colors.textSecondary,
    fontSize: 14,
    fontWeight: '700',
  },
  summaryAmount: {
    maxWidth: '100%',
    color: colors.textPrimary,
    fontSize: 30,
    fontWeight: '900',
    marginTop: 5,
  },
  summaryAmountIn: { color: colors.success },
  statusPill: {
    borderRadius: radius.full,
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginTop: 12,
  },
  statusConfirmed: { backgroundColor: 'rgba(0,214,143,0.12)' },
  statusPending: { backgroundColor: 'rgba(255,184,0,0.12)' },
  statusFailed: { backgroundColor: 'rgba(255,68,102,0.12)' },
  statusText: { fontSize: 12, fontWeight: '900' },
  statusTextConfirmed: { color: colors.success },
  statusTextPending: { color: colors.warning },
  statusTextFailed: { color: colors.error },
  sectionLabel: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: '800',
    textTransform: 'uppercase',
    marginBottom: 9,
  },
  hashCard: {
    backgroundColor: colors.bgInput,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    padding: spacing.md,
    marginBottom: 16,
  },
  hashText: {
    color: colors.textPrimary,
    fontFamily: 'monospace',
    fontSize: 12,
    lineHeight: 19,
  },
  copyButton: {
    minHeight: 42,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: radius.sm,
    backgroundColor: colors.orangeMuted,
    marginTop: 14,
  },
  copyButtonDone: { backgroundColor: 'rgba(0,214,143,0.12)' },
  copyText: { color: colors.orange, fontSize: 13, fontWeight: '800' },
  copyTextDone: { color: colors.success },
  details: {
    backgroundColor: colors.bgCard,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    marginBottom: 22,
  },
  detailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 20,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  detailLabel: {
    width: 112,
    color: colors.textSecondary,
    fontSize: 13,
    lineHeight: 19,
  },
  detailValue: {
    flex: 1,
    color: colors.textPrimary,
    fontSize: 13,
    fontWeight: '700',
    lineHeight: 19,
    textAlign: 'right',
  },
  mono: { fontFamily: 'monospace', fontSize: 11 },
  transferSection: { marginTop: 2 },
  transferCard: {
    backgroundColor: colors.bgCard,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    padding: spacing.md,
    marginBottom: 10,
  },
  transferLabel: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: '800',
    marginBottom: 8,
  },
  transferAddress: {
    color: colors.textPrimary,
    fontFamily: 'monospace',
    fontSize: 11,
    lineHeight: 18,
  },
  transferAmount: {
    color: colors.orange,
    fontSize: 13,
    fontWeight: '900',
    marginTop: 10,
  },
  missing: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  missingTitle: { color: colors.textSecondary, fontSize: 16 },
});
