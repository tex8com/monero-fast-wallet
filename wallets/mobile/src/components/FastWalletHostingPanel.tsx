import React from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import {
  fastWalletHostingErrorTranslationKey,
  parseFastWalletHostingView,
  type FastWalletHostingView,
} from '../../../../packages/wallet-shared/src/fastWalletHosting';
import { useI18n } from '../i18n';
import { colors, radius } from '../theme/colors';

export default function FastWalletHostingPanel({ status, busy, disabled, onCheck }: {
  status?: FastWalletHostingView;
  busy: boolean;
  disabled: boolean;
  onCheck: () => void;
}) {
  const { t, dateLocale } = useI18n();
  const view = parseFastWalletHostingView(status);
  const verified = view?.verified && (view.status === 'hosted' || view.status === 'rehosted');
  const label = busy ? t('wallets.hostingChecking')
    : view?.status === 'hosted' && verified ? t('wallets.hostingHosted')
    : view?.status === 'rehosted' && verified ? t('wallets.hostingRehosted')
    : view?.status === 'missing' ? t('wallets.hostingMissing')
    : view?.status === 'blocked' ? t('wallets.hostingBlocked')
    : view?.status === 'unsupported' ? t('wallets.hostingUnsupported')
    : t('wallets.hostingUnknown');
  return <View style={s.panel}>
    <Text accessibilityLiveRegion="polite" style={[s.title, verified && !busy ? s.verified : undefined]}>{label}</Text>
    <TouchableOpacity accessibilityRole="button" accessibilityState={{ disabled: disabled || busy, busy }}
      activeOpacity={0.72} disabled={disabled || busy} onPress={onCheck} style={[s.button, disabled || busy ? s.disabled : undefined]}>
      {busy ? <ActivityIndicator color={colors.orange} size="small" /> : null}
      <Text style={s.buttonText}>{busy ? t('wallets.hostingChecking') : t('wallets.hostingCheck')}</Text>
    </TouchableOpacity>
    {!busy && view?.errorCode ? <Text accessibilityRole="alert" style={s.error}>{t(fastWalletHostingErrorTranslationKey(view.errorCode))}</Text> : null}
    {view ? <Text style={s.detail}>{t(view.verified && view.checkedAt ? 'wallets.hostingCheckedAt' : 'wallets.hostingAttemptedAt', {
      time: new Date((view.verified && view.checkedAt ? view.checkedAt : view.attemptedAt) * 1000).toLocaleString(dateLocale),
    })}</Text> : null}
    <Text style={s.detail}>{t('wallets.hostingPermissionSeparate')}</Text>
  </View>;
}

const s = StyleSheet.create({
  panel: { padding: 14, gap: 10, marginTop: -4, marginBottom: 14, backgroundColor: colors.bgCard, borderColor: colors.border, borderWidth: 1, borderRadius: radius.md },
  title: { color: colors.textPrimary, fontSize: 14, fontWeight: '700' },
  verified: { color: colors.success },
  button: { flexDirection: 'row', gap: 8, minHeight: 44, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12, borderWidth: 1, borderColor: colors.borderLight, borderRadius: radius.sm },
  disabled: { opacity: 0.65 },
  buttonText: { color: colors.textPrimary, fontSize: 14, fontWeight: '700' },
  detail: { color: colors.textMuted, fontSize: 12, lineHeight: 18 },
  error: { color: colors.error, fontSize: 13, lineHeight: 19 },
});
