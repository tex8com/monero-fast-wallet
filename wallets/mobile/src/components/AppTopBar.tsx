import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  useConnectivityState,
  type ConnectivityRouteState,
} from '../services/ConnectivityState';
import { useWalletState } from '../services/WalletState';
import { walletSnapshotIsSynchronized } from '../services/WalletSynchronization';
import { colors } from '../theme/colors';
import MoneroLogo from './MoneroLogo';

type ConnectionVisual = {
  color: string;
  stateLabel: string;
};

export function appTopBarConnectionVisual(
  route: ConnectivityRouteState,
): ConnectionVisual {
  switch (route.phase) {
    case 'connected':
      return { color: colors.success, stateLabel: 'connected' };
    case 'starting':
    case 'checking':
      return { color: colors.warning, stateLabel: 'connecting' };
    case 'error':
      return { color: colors.error, stateLabel: 'failed' };
    default:
      return { color: colors.textSecondary, stateLabel: 'idle' };
  }
}

export default function AppTopBar({
  safeAreaHandledByTicker,
  onLogoPress,
  onStatusPress,
}: {
  safeAreaHandledByTicker: boolean;
  onLogoPress: () => void;
  onStatusPress: () => void;
}) {
  const insets = useSafeAreaInsets();
  const connectivity = useConnectivityState();
  const { snapshot, spendReady, status } = useWalletState();
  const syncVisual: ConnectionVisual =
    walletSnapshotIsSynchronized(snapshot) && spendReady
    ? { color: colors.success, stateLabel: 'synchronized' }
    : status === 'error'
    ? { color: colors.error, stateLabel: 'failed' }
    : snapshot || status === 'opening' || status === 'syncing'
    ? { color: colors.warning, stateLabel: 'synchronizing' }
    : { color: colors.textSecondary, stateLabel: 'idle' };
  const statuses = [
    {
      label: 'Tor',
      visual: appTopBarConnectionVisual(connectivity.tor),
    },
    { label: 'Sync', visual: syncVisual },
  ] as const;
  const safeAreaStyle = {
    paddingTop: safeAreaHandledByTicker ? 0 : insets.top,
  };

  return (
    <View
      style={[s.safeArea, safeAreaStyle]}
    >
      <View style={s.bar}>
        <TouchableOpacity
          accessibilityLabel="Monero Fast Wallet"
          accessibilityRole="button"
          activeOpacity={0.72}
          onPress={onLogoPress}
          style={s.brand}
        >
          <MoneroLogo size={27} />
          <Text numberOfLines={1} style={s.brandText}>
            Monero <Text style={s.brandAccent}>Fast Wallet</Text>
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          accessibilityLabel={statuses
            .map(({ label: routeLabel, visual }) =>
              `${routeLabel}: ${visual.stateLabel}`,
            )
            .join(', ')}
          accessibilityRole="button"
          activeOpacity={0.72}
          onPress={onStatusPress}
          style={s.statusGroup}
        >
          {statuses.map(({ label: routeLabel, visual }) => {
            return (
              <View
                key={routeLabel}
                style={[s.status, { borderColor: `${visual.color}55` }]}
              >
                <View
                  style={[
                    s.ledGlow,
                    { backgroundColor: `${visual.color}28` },
                  ]}
                >
                  <View style={[s.led, { backgroundColor: visual.color }]} />
                </View>
                <Text
                  numberOfLines={1}
                  style={[s.statusText, { color: visual.color }]}
                >
                  {routeLabel}
                </Text>
              </View>
            );
          })}
        </TouchableOpacity>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  safeArea: {
    backgroundColor: colors.bg,
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    zIndex: 20,
  },
  bar: {
    alignItems: 'center',
    flexDirection: 'row',
    height: 48,
    justifyContent: 'space-between',
    paddingHorizontal: 20,
  },
  brand: {
    alignItems: 'center',
    flex: 1,
    flexDirection: 'row',
    gap: 9,
    minWidth: 0,
  },
  brandText: {
    color: colors.textPrimary,
    flexShrink: 1,
    fontSize: 15,
    fontWeight: '800',
  },
  brandAccent: { color: colors.orange },
  statusGroup: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 6,
    marginLeft: 9,
  },
  status: {
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.025)',
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 6,
    minHeight: 29,
    paddingHorizontal: 7,
  },
  ledGlow: {
    alignItems: 'center',
    borderRadius: 7,
    height: 14,
    justifyContent: 'center',
    width: 14,
  },
  led: { borderRadius: 4, height: 8, width: 8 },
  statusText: { fontSize: 11, fontWeight: '800' },
});
