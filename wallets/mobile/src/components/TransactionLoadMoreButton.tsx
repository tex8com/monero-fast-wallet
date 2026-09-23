import React from 'react';
import { StyleSheet, Text, TouchableOpacity } from 'react-native';
import { useI18n } from '../i18n';
import { colors, radius } from '../theme/colors';

export default function TransactionLoadMoreButton({
  onPress,
}: {
  onPress: () => void;
}) {
  const { t } = useI18n();

  return (
    <TouchableOpacity
      accessibilityLabel={t('transactions.loadMore')}
      accessibilityRole="button"
      activeOpacity={0.72}
      onPress={onPress}
      style={s.button}
    >
      <Text style={s.label}>{t('transactions.loadMore')}</Text>
    </TouchableOpacity>
  );
}

const s = StyleSheet.create({
  button: {
    alignSelf: 'center',
    minHeight: 36,
    justifyContent: 'center',
    marginTop: 12,
    paddingHorizontal: 18,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: colors.borderLight,
    borderRadius: radius.full,
    backgroundColor: colors.tabBar,
  },
  label: {
    color: colors.textPrimary,
    fontSize: 13,
    fontWeight: '700',
  },
});
