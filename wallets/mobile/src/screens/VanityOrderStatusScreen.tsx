import { useFocusEffect } from '@react-navigation/native';
import React, { useCallback, useRef, useState } from 'react';
import {
  AppState,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon } from '../components/Icon';
import {
  createVanityRecoveryBackup,
  getVanityOrderStatus,
  type VanityOrderStatus,
} from '../services/VanityServiceClient';
import { colors, radius, spacing } from '../theme/colors';

const TERMINAL = new Set([
  'completed',
  'partially_completed',
  'expired',
  'failed',
]);

function statusLabel(value: string): string {
  switch (value) {
    case 'awaiting_payment':
      return 'Waiting for payment';
    case 'payment_seen':
      return 'Payment detected';
    case 'paid':
      return 'Payment confirmed';
    case 'queued':
      return 'Waiting for a GPU slot';
    case 'searching':
      return 'Searching';
    case 'completed':
      return 'Address found';
    case 'partially_completed':
      return 'Partially completed';
    case 'expired':
      return 'Search expired';
    default:
      return value.replaceAll('_', ' ');
  }
}

function formatExpiry(value: number | null | undefined): string | undefined {
  if (!value) return undefined;
  return new Date(value * 1000).toLocaleString();
}

export default function VanityOrderStatusScreen({ navigation, route }: any) {
  const insets = useSafeAreaInsets();
  const orderId =
    typeof route?.params?.orderId === 'string' ? route.params.orderId : '';
  const [order, setOrder] = useState<VanityOrderStatus>();
  const [error, setError] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);
  const [backingUp, setBackingUp] = useState(false);
  const refreshInFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (!orderId || refreshInFlight.current) return;
    refreshInFlight.current = true;
    setRefreshing(true);
    try {
      setOrder(await getVanityOrderStatus(orderId));
      setError(undefined);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : 'The Vanity status is unavailable.',
      );
    } finally {
      refreshInFlight.current = false;
      setRefreshing(false);
    }
  }, [orderId]);

  useFocusEffect(
    useCallback(() => {
      refresh().catch(() => undefined);
    }, [refresh]),
  );

  useFocusEffect(
    useCallback(() => {
      if (order && TERMINAL.has(order.status)) return;
      const timer = setInterval(() => {
        if (AppState.currentState === 'active') {
          refresh().catch(() => undefined);
        }
      }, 10_000);
      return () => clearInterval(timer);
    }, [order, refresh]),
  );

  const backupRecovery = useCallback(async () => {
    if (!orderId || backingUp) return;
    setBackingUp(true);
    try {
      const recovery = await createVanityRecoveryBackup(orderId);
      await Share.share({
        title: 'Back up Vanity recovery data',
        message: recovery,
      });
      setError(undefined);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : 'The Vanity recovery backup could not be created.',
      );
    } finally {
      setBackingUp(false);
    }
  }, [backingUp, orderId]);

  const hasRecovery = Boolean(
    order?.search_groups.some(
      group =>
        group.status === 'completed' &&
        group.result_address &&
        group.recovery_available,
    ),
  );

  return (
    <View style={s.container}>
      <ScrollView
        contentContainerStyle={[
          s.scroll,
          { paddingBottom: Math.max(170, insets.bottom + 140) },
        ]}
      >
        <TouchableOpacity onPress={() => navigation.goBack()} style={s.back}>
          <Icon name="arrow-left" size={18} color={colors.textMuted} />
          <Text style={s.backText}>Back</Text>
        </TouchableOpacity>
        <View style={s.titleRow}>
          <View style={s.heroIcon}>
            <Icon name="key" size={27} color={colors.orange} />
          </View>
          <View style={s.titleCopy}>
            <Text style={s.title}>Vanity order</Text>
            <Text selectable style={s.orderId}>
              {orderId || 'Invalid order'}
            </Text>
          </View>
        </View>

        <View style={s.statusCard}>
          <Text style={s.eyebrow}>CURRENT STATUS</Text>
          <Text style={s.status}>
            {order
              ? statusLabel(order.status)
              : refreshing
              ? 'Loading…'
              : 'Unavailable'}
          </Text>
          {order ? (
            <Text style={s.meta}>
              {order.active_prefix_slots}/{order.maximum_prefix_slots} active
              service slots
            </Text>
          ) : null}
          {error ? <Text style={s.error}>{error}</Text> : null}
          <TouchableOpacity
            disabled={refreshing}
            onPress={() => refresh().catch(() => undefined)}
            style={s.refreshButton}
          >
            <Text style={s.refreshText}>
              {refreshing ? 'Refreshing…' : 'Refresh status'}
            </Text>
          </TouchableOpacity>
        </View>

        {order?.search_groups.map((group, index) => (
          <View key={group.id} style={s.groupCard}>
            <View style={s.groupHeader}>
              <Text style={s.groupTitle}>Search group {index + 1}</Text>
              <Text
                style={group.status === 'completed' ? s.success : s.groupStatus}
              >
                {statusLabel(group.status)}
              </Text>
            </View>
            <Text style={s.prefixes}>{group.prefixes.join('  ·  ')}</Text>
            {formatExpiry(group.search_expires_at) ? (
              <Text style={s.meta}>
                Ends: {formatExpiry(group.search_expires_at)}
              </Text>
            ) : null}
            {group.result_address ? (
              <View style={s.result}>
                <Text style={s.eyebrow}>FOUND ADDRESS</Text>
                <Text selectable style={s.address}>
                  {group.result_address}
                </Text>
                <Text style={s.meta}>Matched {group.matched_prefix}</Text>
              </View>
            ) : null}
          </View>
        ))}

        {order ? (
          <View style={s.paymentCard}>
            <Text style={s.eyebrow}>PAYMENT</Text>
            <Text style={s.payment}>{order.price_xmr} XMR</Text>
            <Text selectable style={s.address}>
              {order.payment_address}
            </Text>
            <Text style={s.meta}>
              {order.confirmations}/{order.required_confirmations} confirmations
            </Text>
          </View>
        ) : null}

        {hasRecovery ? (
          <View style={s.backupCard}>
            <Text style={s.eyebrow}>RECOVERY BACKUP</Text>
            <Text style={s.backupTitle}>Save before removing this wallet</Text>
            <Text style={s.meta}>
              Recovery needs both the original wallet seed and this key-offset
              backup. The offset alone cannot spend funds.
            </Text>
            <TouchableOpacity
              disabled={backingUp}
              onPress={() => backupRecovery().catch(() => undefined)}
              style={s.refreshButton}
            >
              <Text style={s.refreshText}>
                {backingUp ? 'Preparing backup…' : 'Back up recovery data'}
              </Text>
            </TouchableOpacity>
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  scroll: { paddingHorizontal: spacing.lg, paddingTop: 18 },
  back: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 8,
    marginBottom: 16,
  },
  backText: { color: colors.textMuted, fontSize: 16, fontWeight: '700' },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  heroIcon: {
    width: 54,
    height: 54,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 18,
    backgroundColor: 'rgba(255,102,0,0.12)',
  },
  titleCopy: { flex: 1 },
  title: {
    color: colors.textPrimary,
    fontSize: 32,
    lineHeight: 38,
    fontWeight: '800',
  },
  orderId: { color: colors.textMuted, fontSize: 11, marginTop: 3 },
  statusCard: {
    backgroundColor: colors.bgCard,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: 18,
    marginTop: 24,
  },
  eyebrow: {
    color: colors.orange,
    fontSize: 10,
    letterSpacing: 1.1,
    fontWeight: '800',
  },
  status: {
    color: colors.textPrimary,
    fontSize: 24,
    fontWeight: '800',
    marginTop: 7,
  },
  meta: { color: colors.textMuted, fontSize: 12, lineHeight: 18, marginTop: 6 },
  error: { color: colors.orange, fontSize: 13, lineHeight: 18, marginTop: 10 },
  refreshButton: {
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderColor: colors.orange,
    borderWidth: 1,
    borderRadius: 13,
    marginTop: 15,
  },
  refreshText: { color: colors.orange, fontSize: 14, fontWeight: '800' },
  groupCard: {
    backgroundColor: colors.bgCard,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: 18,
    marginTop: 16,
  },
  groupHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
  },
  groupTitle: { color: colors.textPrimary, fontSize: 15, fontWeight: '800' },
  groupStatus: { color: colors.orange, fontSize: 12, fontWeight: '800' },
  success: { color: colors.success, fontSize: 12, fontWeight: '800' },
  prefixes: {
    color: colors.textPrimary,
    fontSize: 15,
    fontWeight: '700',
    marginTop: 13,
  },
  result: {
    borderTopColor: colors.border,
    borderTopWidth: 1,
    marginTop: 16,
    paddingTop: 15,
  },
  address: {
    color: colors.textMuted,
    fontSize: 11,
    lineHeight: 17,
    marginTop: 7,
  },
  paymentCard: {
    backgroundColor: 'rgba(255,102,0,0.08)',
    borderColor: 'rgba(255,102,0,0.28)',
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: 18,
    marginTop: 16,
  },
  backupCard: {
    backgroundColor: colors.bgCard,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: 18,
    marginTop: 16,
  },
  backupTitle: {
    color: colors.textPrimary,
    fontSize: 17,
    fontWeight: '800',
    marginTop: 8,
  },
  payment: {
    color: colors.textPrimary,
    fontSize: 22,
    fontWeight: '800',
    marginTop: 7,
  },
});
