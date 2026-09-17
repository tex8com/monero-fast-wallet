import React, { useEffect, useRef } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Modal,
  StyleSheet,
  Text,
  TouchableOpacity,
  Vibration,
  View,
} from 'react-native';
import Clipboard from '@react-native-clipboard/clipboard';
import QRCode from 'react-native-qrcode-svg';

import { useI18n } from '../i18n';
import { formatAtomicXmr } from '../services/WalletFormat';
import { colors, radius, spacing } from '../theme/colors';
import { Icon } from './Icon';

export type SendSuccessReceipt = {
  amountAtomic: string;
  feeAtomic: string;
  transactionId?: string;
  refreshing: boolean;
};

export default function SendSuccessModal({
  receipt,
  onDone,
}: {
  receipt: SendSuccessReceipt | undefined;
  onDone: () => void;
}) {
  const { t } = useI18n();
  const announcedReceiptRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!receipt) return;
    const receiptFingerprint = `${receipt.transactionId ?? ''}:${
      receipt.amountAtomic
    }:${receipt.feeAtomic}`;
    if (announcedReceiptRef.current === receiptFingerprint) return;
    announcedReceiptRef.current = receiptFingerprint;
    Vibration.vibrate(80);
    AccessibilityInfo.announceForAccessibility(t('send.successTitle'));
  });

  return (
    <Modal
      animationType="fade"
      onRequestClose={onDone}
      presentationStyle="fullScreen"
      visible={Boolean(receipt)}
    >
      <View style={s.screen} accessibilityViewIsModal>
        <View style={s.checkCircle}>
          <Icon
            name="check"
            size={52}
            color={colors.success}
            strokeWidth={2.5}
          />
        </View>
        <Text style={s.title}>{t('send.successTitle')}</Text>
        <Text style={s.subtitle}>{t('send.successSubtitle')}</Text>

        {receipt ? (
          <View style={s.receiptCard}>
            <View style={s.row}>
              <Text style={s.label}>{t('transactions.amount')}</Text>
              <Text style={s.value}>
                {formatAtomicXmr(receipt.amountAtomic, {
                  maxFractionDigits: 12,
                  minFractionDigits: 2,
                })}{' '}
                XMR
              </Text>
            </View>
            <View style={s.divider} />
            <View style={s.row}>
              <Text style={s.label}>{t('transactions.fee')}</Text>
              <Text style={s.value}>
                {formatAtomicXmr(receipt.feeAtomic, {
                  maxFractionDigits: 12,
                  minFractionDigits: 2,
                })}{' '}
                XMR
              </Text>
            </View>
            {receipt.transactionId ? (
              <>
                <View style={s.divider} />
                <Text style={s.label}>{t('transactions.transactionId')}</Text>
                <Text selectable style={s.transactionId}>
                  {receipt.transactionId}
                </Text>
                <TouchableOpacity
                  accessibilityLabel={t('transactions.copyId')}
                  accessibilityRole="button"
                  onPress={() => Clipboard.setString(receipt.transactionId!)}
                  style={s.copyIdButton}
                >
                  <Text style={s.copyIdText}>{t('transactions.copyId')}</Text>
                </TouchableOpacity>
                <View style={s.transactionQr}>
                  <QRCode
                    backgroundColor="#FFFFFF"
                    color={colors.bg}
                    ecl="M"
                    quietZone={8}
                    size={136}
                    value={receipt.transactionId}
                  />
                </View>
              </>
            ) : null}
          </View>
        ) : null}

        <View style={s.statusRow}>
          {receipt?.refreshing ? (
            <ActivityIndicator color={colors.orange} size="small" />
          ) : (
            <View style={s.statusDotDone} />
          )}
          <Text style={s.statusText}>
            {receipt?.refreshing
              ? t('send.successRefreshing')
              : t('send.successReady')}
          </Text>
        </View>

        <TouchableOpacity
          accessibilityLabel={t('send.successDone')}
          accessibilityRole="button"
          activeOpacity={0.86}
          onPress={onDone}
          style={s.doneButton}
        >
          <Text style={s.doneButtonText}>{t('send.successDone')}</Text>
        </TouchableOpacity>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  screen: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bg,
    paddingHorizontal: spacing.xl,
  },
  checkCircle: {
    alignItems: 'center',
    justifyContent: 'center',
    width: 112,
    height: 112,
    borderRadius: 56,
    backgroundColor: 'rgba(18, 208, 156, 0.12)',
    borderWidth: 1,
    borderColor: 'rgba(18, 208, 156, 0.35)',
    marginBottom: spacing.xl,
  },
  title: {
    color: colors.textPrimary,
    fontSize: 30,
    fontWeight: '800',
    textAlign: 'center',
  },
  subtitle: {
    color: colors.textSecondary,
    fontSize: 16,
    lineHeight: 23,
    textAlign: 'center',
    marginTop: spacing.sm,
    maxWidth: 380,
  },
  receiptCard: {
    alignSelf: 'stretch',
    backgroundColor: colors.bgCard,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.lg,
    marginTop: spacing.xl,
    padding: spacing.lg,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  label: {
    color: colors.textSecondary,
    fontSize: 14,
  },
  value: {
    color: colors.textPrimary,
    fontSize: 15,
    fontWeight: '700',
    textAlign: 'right',
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border,
    marginVertical: spacing.md,
  },
  transactionId: {
    color: colors.orange,
    fontSize: 12,
    lineHeight: 18,
    marginTop: spacing.xs,
  },
  copyIdButton: {
    alignSelf: 'flex-start',
    marginTop: spacing.sm,
    minHeight: 36,
    justifyContent: 'center',
  },
  copyIdText: { color: colors.orangeLight, fontSize: 13, fontWeight: '800' },
  transactionQr: {
    alignItems: 'center',
    marginTop: spacing.md,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: spacing.lg,
    gap: spacing.sm,
  },
  statusDotDone: {
    width: 9,
    height: 9,
    borderRadius: 5,
    backgroundColor: colors.success,
  },
  statusText: {
    color: colors.textSecondary,
    fontSize: 14,
  },
  doneButton: {
    alignSelf: 'stretch',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.orange,
    borderRadius: radius.lg,
    minHeight: 58,
    marginTop: spacing.xl,
  },
  doneButtonText: {
    color: colors.textPrimary,
    fontSize: 18,
    fontWeight: '800',
  },
});
