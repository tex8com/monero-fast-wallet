import React from 'react';
import {StyleSheet, Text, View} from 'react-native';

import {presentBalanceAvailability, type BalanceAvailabilitySource} from '../../../../packages/wallet-shared/src/balanceAvailability';
import {useI18n} from '../i18n';
import {formatAtomicXmr} from '../services/WalletFormat';
import {colors} from '../theme/colors';

export default function BalanceAvailability({snapshot, live = true, provisional = false}: {
  snapshot?: BalanceAvailabilitySource;
  live?: boolean;
  provisional?: boolean;
}) {
  const {dateLocale, t} = useI18n();
  const availability = presentBalanceAvailability(live ? snapshot : snapshot && {
    balanceAtomic: snapshot.balanceAtomic,
    unlockedBalanceAtomic: snapshot.unlockedBalanceAtomic,
  });
  const amount = (value: string | undefined) => value === undefined
    ? '— XMR' : `${formatAtomicXmr(value, {maxFractionDigits: 12})} XMR`;
  const locked = availability.lockedAtomic === undefined ? undefined : BigInt(availability.lockedAtomic);
  const unlockHint = availability.state === 'pending'
    ? t('home.unlockPending')
    : locked !== undefined && locked > 0n
    ? availability.state === 'blocks'
      ? t(provisional ? 'home.unlockBlocksProvisional' : 'home.unlockBlocks', {
          count: availability.blocksRemaining!.toLocaleString(dateLocale),
        })
      : availability.state === 'timestamp'
      ? t('home.unlockTime', {seconds: availability.secondsRemaining!.toLocaleString(dateLocale)})
      : availability.state === 'mixed'
      ? t(provisional ? 'home.unlockMixedProvisional' : 'home.unlockMixed', {
          count: availability.blocksRemaining!.toLocaleString(dateLocale),
          seconds: availability.secondsRemaining!.toLocaleString(dateLocale),
        })
      : t('home.unlockUnknown')
    : undefined;
  return (
    <View style={s.wrap} testID="home-balance-availability">
      <View style={s.row}>
        <Text style={s.label}>{t(provisional ? 'home.availableBalanceProvisional' : 'home.availableBalance')}</Text>
        <Text style={[s.amount, !provisional && availability.availableAtomic !== undefined && s.available]} testID="home-balance-available">
          {amount(availability.availableAtomic)}
        </Text>
      </View>
      <View style={s.row}>
        <Text style={s.label}>{t(provisional ? 'home.lockedBalanceProvisional' : 'home.lockedBalanceLabel')}</Text>
        <Text style={[s.amount, locked !== undefined && locked > 0n && s.locked]} testID="home-balance-locked">
          {amount(availability.lockedAtomic)}
        </Text>
      </View>
      {unlockHint ? <Text accessibilityLiveRegion="polite" style={s.hint} testID="home-balance-unlock-hint">
        {unlockHint}
      </Text> : null}
      {provisional && availability.availableAtomic !== undefined ? <Text style={s.hint} testID="home-balance-provisional-hint">
        {t('home.ledgerAvailabilityProvisional')}
      </Text> : null}
    </View>
  );
}

const s = StyleSheet.create({
  wrap: {borderTopColor: colors.border, borderTopWidth: StyleSheet.hairlineWidth, gap: 7, marginTop: 13, paddingTop: 13},
  row: {alignItems: 'flex-start', flexDirection: 'row', gap: 14, justifyContent: 'space-between'},
  label: {color: colors.textMuted, flexShrink: 0, fontSize: 13},
  amount: {color: colors.textMuted, flexShrink: 1, fontSize: 13, fontWeight: '700', textAlign: 'right'},
  available: {color: colors.success},
  locked: {color: colors.warning},
  hint: {color: colors.textMuted, fontSize: 12, lineHeight: 18, marginTop: 2},
});
