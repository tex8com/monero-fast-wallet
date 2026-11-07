import React from 'react';
import {StyleSheet, Text, View} from 'react-native';

import {networkSyncTransportPresentation} from '../../../../packages/wallet-shared/src/networkSync';
import {useI18n} from '../i18n';
import type {NetworkSyncStatus} from '../services/NativeMoneroWallet';
import {colors, radius} from '../theme/colors';

export function blockSyncTransportVisual(
  status: NetworkSyncStatus | undefined,
  t: ReturnType<typeof useI18n>['t'],
) {
  const transport = networkSyncTransportPresentation(status);
  const key = transport.tone === 'error'
    ? 'unavailable'
    : transport.transport === 'grpc'
    ? 'grpc'
    : transport.slowFallback
    ? 'fallback'
    : transport.transport === 'rpc'
    ? 'rpc'
    : 'unknown';
  const color = transport.tone === 'success'
    ? colors.success
    : transport.tone === 'warning'
    ? colors.warning
    : transport.tone === 'error'
    ? colors.error
    : colors.textMuted;
  return {
    ...transport,
    color,
    label: t(`sync.transport.${key}`),
    shortLabel: key === 'grpc' ? 'gRPC'
      : key === 'fallback' ? t('sync.transport.shortFallback')
      : key === 'rpc' ? 'RPC'
      : key === 'unavailable' ? t('sync.transport.shortUnavailable')
      : t('sync.transport.shortUnknown'),
    description: t(`sync.transport.${key}Hint`),
  };
}

export default function BlockSyncTransportStatus({
  status,
  testID = 'block-sync-transport',
}: {
  status?: NetworkSyncStatus;
  testID?: string;
}) {
  const {t} = useI18n();
  const visual = blockSyncTransportVisual(status, t);
  return (
    <View
      accessibilityLabel={`${t('sync.transport.title')}: ${visual.label}. ${visual.description}`}
      accessibilityLiveRegion="polite"
      style={[s.wrap, {borderColor: `${visual.color}66`}]}
      testID={testID}
    >
      <Text style={s.title}>{t('sync.transport.title')}</Text>
      <Text style={[s.label, {color: visual.color}]} testID={`${testID}-label`}>
        {visual.label}
      </Text>
      <Text style={s.hint}>{visual.description}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: {
    backgroundColor: colors.bgInput,
    borderRadius: radius.sm,
    borderWidth: 1,
    gap: 4,
    marginBottom: 10,
    padding: 10,
  },
  title: {color: colors.textMuted, fontSize: 11, fontWeight: '700'},
  label: {fontSize: 13, fontWeight: '800'},
  hint: {color: colors.textMuted, fontSize: 12, lineHeight: 17},
});
