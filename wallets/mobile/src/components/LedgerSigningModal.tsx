import React from 'react';
import {
  ActivityIndicator,
  Modal,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import { useI18n } from '../i18n';
import type { LedgerSigningProgress } from '../backend/LedgerSigningFlow';
import { colors, radius, spacing } from '../theme/colors';
import { Icon } from './Icon';

export default function LedgerSigningModal({
  progress,
  onCancel,
  canCancel = true,
}: {
  progress: LedgerSigningProgress | undefined;
  onCancel: () => void;
  canCancel?: boolean;
}) {
  const { t } = useI18n();
  if (!progress) {
    return null;
  }

  const connected =
    progress.phase === 'connected' ||
    progress.phase === 'preparing-request' ||
    progress.phase === 'awaiting-confirmation';
  const title = connected
    ? t('ledgerSigning.connectedTitle')
    : t('ledgerSigning.connectTitle');
  const message =
    progress.detail ||
    (progress.phase === 'searching'
      ? t('ledgerSigning.searching')
      : progress.phase === 'connecting'
        ? t('ledgerSigning.connecting')
        : progress.phase === 'connected'
          ? t('ledgerSigning.connected')
          : progress.phase === 'preparing-request'
            ? t('ledgerSigning.preparingRequest')
            : t('ledgerSigning.awaitingConfirmation'));

  return (
    <Modal
      animationType="fade"
      onRequestClose={() => {
        if (canCancel) {
          onCancel();
        }
      }}
      transparent
      visible
    >
      <View style={s.backdrop} testID="ledger-signing-modal">
        <View style={s.card}>
          <View style={s.header}>
            <View style={[s.icon, connected && s.iconConnected]}>
              <Icon
                name={connected ? 'check' : 'wallet'}
                size={24}
                color={connected ? colors.success : colors.orange}
              />
            </View>
            <View style={s.copy}>
              <Text style={s.title}>{title}</Text>
              <Text style={s.instructions}>
                {t('ledgerSigning.instructions')}
              </Text>
            </View>
          </View>

          <View style={s.statusRow}>
            {connected ? (
              <View style={s.connectedDot} />
            ) : (
              <ActivityIndicator color={colors.orange} size="small" />
            )}
            <Text
              accessibilityLiveRegion="polite"
              style={s.statusText}
              testID="ledger-signing-status"
            >
              {message}
            </Text>
          </View>

          {progress.transport ? (
            <Text style={s.meta}>
              {progress.transport.transport.toUpperCase()} ·{' '}
              {progress.transport.deviceName || 'Ledger'}
            </Text>
          ) : null}

          {canCancel ? (
            <TouchableOpacity
              accessibilityRole="button"
              onPress={onCancel}
              style={s.cancelButton}
            >
              <Text style={s.cancelText}>{t('action.cancel')}</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: {
    alignItems: 'center',
    backgroundColor: 'rgba(3, 2, 12, 0.84)',
    flex: 1,
    justifyContent: 'center',
    padding: spacing.lg,
  },
  card: {
    backgroundColor: colors.bgCard,
    borderColor: colors.border,
    borderRadius: radius.xl,
    borderWidth: 1,
    gap: spacing.md,
    maxWidth: 460,
    padding: spacing.lg,
    width: '100%',
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.md,
  },
  icon: {
    alignItems: 'center',
    backgroundColor: colors.orangeMuted,
    borderRadius: radius.lg,
    height: 52,
    justifyContent: 'center',
    width: 52,
  },
  iconConnected: {
    backgroundColor: 'rgba(20, 213, 160, 0.12)',
  },
  copy: { flex: 1 },
  title: { color: colors.textPrimary, fontSize: 21, fontWeight: '800' },
  instructions: {
    color: colors.textSecondary,
    fontSize: 14,
    lineHeight: 20,
    marginTop: 4,
  },
  statusRow: {
    alignItems: 'center',
    backgroundColor: colors.bg,
    borderColor: colors.border,
    borderRadius: radius.lg,
    borderWidth: 1,
    flexDirection: 'row',
    gap: spacing.sm,
    minHeight: 58,
    paddingHorizontal: spacing.md,
  },
  connectedDot: {
    backgroundColor: colors.success,
    borderRadius: 6,
    height: 12,
    width: 12,
  },
  statusText: {
    color: colors.textPrimary,
    flex: 1,
    fontSize: 15,
    fontWeight: '700',
    lineHeight: 21,
  },
  meta: { color: colors.textMuted, fontSize: 12 },
  cancelButton: {
    alignItems: 'center',
    borderColor: colors.border,
    borderRadius: radius.lg,
    borderWidth: 1,
    minHeight: 50,
    justifyContent: 'center',
  },
  cancelText: { color: colors.textPrimary, fontSize: 16, fontWeight: '800' },
});
