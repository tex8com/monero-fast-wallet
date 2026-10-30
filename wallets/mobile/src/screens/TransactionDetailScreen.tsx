import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import Clipboard from '@react-native-clipboard/clipboard';
import { useFocusEffect } from '@react-navigation/native';
import { transactionConfirmationProgress } from '../../../../packages/wallet-shared/src/transactionConfirmations';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon } from '../components/Icon';
import { useI18n } from '../i18n';
import type { WalletTransaction } from '../services/NativeMoneroWallet';
import {
  formatAtomicXmr,
  normalizedTransactionAmountAtomic,
} from '../services/WalletFormat';
import { useWalletState } from '../services/WalletState';
import { walletDisplayName } from '../services/WalletRegistry';
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
  const { registeredWallet, transactions, refreshTransactions } = useWalletState();
  const [copied, setCopied] = useState(false);
  const params = (route?.params ?? {}) as DetailRouteParams;
  const targetHash = params.transactionHash ?? params.transaction?.hash;
  const belongsToCurrentWallet = !params.walletId || params.walletId === registeredWallet?.id;
  const detailIdentity = JSON.stringify([
    params.walletId ?? registeredWallet?.id, targetHash,
    params.transaction?.direction, params.transaction?.subaddrAccount,
  ]);
  const findSelectedTransaction = useCallback(
    (items: readonly WalletTransaction[]) => items.find(item =>
      item.hash === targetHash &&
      (params.transaction?.direction === undefined || item.direction === params.transaction.direction) &&
      (params.transaction?.subaddrAccount === undefined || item.subaddrAccount === params.transaction.subaddrAccount),
    ),
    [params.transaction?.direction, params.transaction?.subaddrAccount, targetHash],
  );
  const contextualTransaction = belongsToCurrentWallet
    ? findSelectedTransaction(transactions)
    : undefined;
  const [liveDetail, setLiveDetail] = useState<{
    identity: string; loaded: boolean; transaction?: WalletTransaction;
  }>();
  const previousContextRef = useRef<{
    identity: string; transaction?: WalletTransaction;
  } | undefined>(undefined);

  // WalletState already refreshes native history every five seconds. Follow
  // its selected wallet's real history, including removal after a reorg.
  useEffect(() => {
    if (!belongsToCurrentWallet) return;
    const previous = previousContextRef.current;
    previousContextRef.current = { identity: detailIdentity, transaction: contextualTransaction };
    if (contextualTransaction || (previous?.identity === detailIdentity && previous.transaction)) {
      setLiveDetail({ identity: detailIdentity, loaded: true, transaction: contextualTransaction });
    }
  }, [belongsToCurrentWallet, contextualTransaction, detailIdentity]);

  useFocusEffect(useCallback(() => {
    if (!belongsToCurrentWallet || !targetHash || !refreshTransactions) return;
    let active = true;
    const contextAtRequest = previousContextRef.current;
    refreshTransactions().then(items => {
      // A newer context publication, including removal, supersedes this read.
      if (!active || previousContextRef.current !== contextAtRequest) return;
      setLiveDetail({
        identity: detailIdentity, loaded: true,
        transaction: findSelectedTransaction(items),
      });
    }).catch(() => undefined);
    return () => { active = false; };
  }, [belongsToCurrentWallet, detailIdentity, findSelectedTransaction, refreshTransactions, targetHash]));

  const transaction = useMemo(
    () => contextualTransaction ?? (
      liveDetail?.identity === detailIdentity && liveDetail.loaded
        ? liveDetail.transaction
        : params.transaction
    ),
    [contextualTransaction, detailIdentity, liveDetail, params.transaction],
  );

  if (!transaction) {
    return (
      <View style={s.container}>
        <View style={s.header}>
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
  const normalizedAmountAtomic = normalizedTransactionAmountAtomic(transaction);
  const selfTransfer =
    !incoming &&
    normalizedAmountAtomic === '0' &&
    transaction.feeAtomic !== '0';
  const summaryAtomic = selfTransfer
    ? transaction.feeAtomic
    : normalizedAmountAtomic;
  const amount = formatAtomicXmr(summaryAtomic, {
    maxFractionDigits: 12,
    minFractionDigits: 2,
  });
  const confirmation = transactionConfirmationProgress(transaction);
  const confirmationProgress = t('transactions.confirmationProgress', {
    current: confirmation.current, required: confirmation.required,
  });
  const status = confirmation.state === 'failed'
    ? t('status.failed')
    : confirmation.state === 'confirmed'
    ? t('transactions.confirmed')
    : transaction.pending
    ? t('status.pending')
    : t('transactions.confirming');
  const incomingLabel = confirmation.state === 'confirmed'
    ? t('home.received')
    : confirmation.state === 'failed'
    ? t('status.failed')
    : t('home.receiving');
  const date = transaction.timestamp
    ? new Date(transaction.timestamp * 1000).toLocaleString(dateLocale, {
        dateStyle: 'medium',
        timeStyle: 'short',
      })
    : t('status.unconfirmed');
  const walletName =
    params.walletName ??
    (registeredWallet ? walletDisplayName(registeredWallet) : t('common.wallet'));
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
      <View style={s.header}>
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
            {incoming
              ? incomingLabel
              : selfTransfer
              ? t('transactions.selfTransfer')
              : t('home.sent')}
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
                : confirmation.state !== 'confirmed'
                ? s.statusPending
                : s.statusConfirmed,
            ]}
          >
            <Text
              style={[
                s.statusText,
                transaction.failed
                  ? s.statusTextFailed
                  : confirmation.state !== 'confirmed'
                  ? s.statusTextPending
                  : s.statusTextConfirmed,
              ]}
            >
              {status} · {confirmationProgress}
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
            value={
              incoming
                ? incomingLabel
                : selfTransfer
                ? t('transactions.selfTransfer')
                : t('home.sent')
            }
          />
          <AtomicXmrDetailRow
            atomicValue={normalizedAmountAtomic}
            label={t('transactions.amount')}
            testID="transaction-amount"
          />
          <AtomicXmrDetailRow
            atomicValue={transaction.feeAtomic}
            label={t('transactions.fee')}
            testID="transaction-network-fee"
          />
          <DetailRow
            label={t('transactions.confirmations')}
            value={`${confirmation.current}/${confirmation.required}`}
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

function AtomicXmrDetailRow({
  atomicValue,
  label,
  testID,
}: {
  atomicValue: string;
  label: string;
  testID: string;
}) {
  const fullValue = formatAtomicXmr(atomicValue, {
    maxFractionDigits: 12,
    minFractionDigits: 12,
    trimTrailingZeros: false,
  });
  const trailingZeroCount = fullValue.match(/0+$/)?.[0].length ?? 0;
  const significantValue = trailingZeroCount
    ? fullValue.slice(0, -trailingZeroCount)
    : fullValue;
  const trailingZeros = trailingZeroCount ? '0'.repeat(trailingZeroCount) : '';

  return (
    <View style={s.detailRow}>
      <Text style={s.detailLabel}>{label}</Text>
      <Text
        accessibilityLabel={`${fullValue} XMR`}
        selectable
        style={[s.detailValue, s.atomicXmrValue]}
        testID={testID}
      >
        <Text testID={`${testID}-significant`}>{significantValue}</Text>
        {trailingZeros ? (
          <Text style={s.trailingZeros} testID={`${testID}-trailing-zeros`}>
            {trailingZeros}
          </Text>
        ) : null}
        {' XMR'}
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
    paddingTop: 12,
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
  atomicXmrValue: {
    fontFamily: 'monospace',
    fontVariant: ['tabular-nums'],
    fontSize: 12,
  },
  trailingZeros: { color: colors.textSecondary },
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
