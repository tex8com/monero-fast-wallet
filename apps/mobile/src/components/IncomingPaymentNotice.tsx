import React, { useEffect, useState } from 'react';
import { Modal, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { useI18n } from '../i18n';
import { formatAtomicXmr } from '../services/WalletFormat';
import { useWalletState } from '../services/WalletState';
import { colors } from '../theme/colors';
import { Icon } from './Icon';

const AUTO_DISMISS_SECONDS = 5;

export default function IncomingPaymentNotice() {
  const { incomingTransactionNotice, dismissIncomingTransactionNotice } =
    useWalletState();
  const { t } = useI18n();
  const [secondsRemaining, setSecondsRemaining] =
    useState(AUTO_DISMISS_SECONDS);
  const noticeId = incomingTransactionNotice?.id;

  useEffect(() => {
    if (!noticeId) {
      return undefined;
    }

    setSecondsRemaining(AUTO_DISMISS_SECONDS);
    const interval = setInterval(() => {
      setSecondsRemaining(current => Math.max(0, current - 1));
    }, 1_000);
    const dismissTimeout = setTimeout(
      dismissIncomingTransactionNotice,
      AUTO_DISMISS_SECONDS * 1_000,
    );

    return () => {
      clearInterval(interval);
      clearTimeout(dismissTimeout);
    };
  }, [dismissIncomingTransactionNotice, noticeId]);

  if (!incomingTransactionNotice) {
    return null;
  }

  const amount = formatAtomicXmr(incomingTransactionNotice.amountAtomic, {
    maxFractionDigits: 12,
  });
  const outgoing = incomingTransactionNotice.direction === 'out';

  return (
    <Modal
      animationType="fade"
      transparent
      visible
      statusBarTranslucent
      onRequestClose={dismissIncomingTransactionNotice}
    >
      <View style={s.backdrop}>
        <View style={[s.dialog, outgoing && s.dialogOutgoing]}>
          <View style={[s.iconCircle, outgoing && s.iconCircleOutgoing]}>
            <Icon
              name={outgoing ? 'arrow-up' : 'arrow-down'}
              size={28}
              color={outgoing ? colors.error : colors.success}
              strokeWidth={2.4}
            />
          </View>
          <Text style={s.title}>
            {t(
              outgoing
                ? 'notification.outgoingTitle'
                : 'notification.incomingTitle',
            )}
          </Text>
          <Text style={[s.amount, outgoing && s.amountOutgoing]}>
            {t(
              outgoing
                ? 'notification.outgoingAmount'
                : 'notification.incomingAmount',
              { amount },
            )}
          </Text>
          <Text style={s.wallet} numberOfLines={1}>
            {t(
              outgoing
                ? 'notification.outgoingWallet'
                : 'notification.incomingWallet',
              { wallet: incomingTransactionNotice.walletName },
            )}
          </Text>
          <TouchableOpacity
            accessibilityLabel={t('notification.ok')}
            activeOpacity={0.78}
            onPress={dismissIncomingTransactionNotice}
            style={s.confirmButton}
          >
            <Text style={s.confirmButtonText}>{t('notification.ok')}</Text>
          </TouchableOpacity>
          <Text style={s.countdown}>
            {t('notification.closesIn', { seconds: secondsRemaining })}
          </Text>
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    backgroundColor: 'rgba(0,0,0,0.62)',
  },
  dialog: {
    width: '100%',
    maxWidth: 340,
    alignItems: 'center',
    borderRadius: 18,
    borderWidth: 1,
    borderColor: 'rgba(0,214,143,0.34)',
    backgroundColor: colors.bgCard,
    paddingHorizontal: 24,
    paddingTop: 26,
    paddingBottom: 20,
  },
  dialogOutgoing: {
    borderColor: 'rgba(255,92,92,0.38)',
  },
  iconCircle: {
    width: 58,
    height: 58,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 29,
    backgroundColor: 'rgba(0,214,143,0.14)',
    marginBottom: 16,
  },
  iconCircleOutgoing: {
    backgroundColor: 'rgba(255,92,92,0.14)',
  },
  title: {
    color: colors.textPrimary,
    fontSize: 21,
    fontWeight: '900',
    textAlign: 'center',
  },
  amountOutgoing: {
    color: colors.error,
  },
  amount: {
    color: colors.success,
    fontSize: 23,
    fontWeight: '900',
    marginTop: 10,
    textAlign: 'center',
  },
  wallet: {
    color: colors.textSecondary,
    fontSize: 13,
    marginTop: 8,
    textAlign: 'center',
  },
  confirmButton: {
    width: '100%',
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    backgroundColor: colors.orange,
    marginTop: 22,
  },
  confirmButtonText: {
    color: colors.textPrimary,
    fontSize: 16,
    fontWeight: '900',
  },
  countdown: {
    color: colors.textMuted,
    fontSize: 12,
    marginTop: 12,
    textAlign: 'center',
  },
});
