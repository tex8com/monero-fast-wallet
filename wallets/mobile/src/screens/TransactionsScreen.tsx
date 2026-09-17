import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon } from '../components/Icon';
import TransactionRow, {
  transactionRowKey,
} from '../components/TransactionRow';
import { useI18n } from '../i18n';
import type { WalletTransaction } from '../services/NativeMoneroWallet';
import { useWalletState } from '../services/WalletState';
import { walletDisplayName } from '../services/WalletRegistry';
import { transactionsForWalletAddress } from '../services/WalletAddressActivity';
import { walletService } from '../services/WalletService';
import { colors, spacing } from '../theme/colors';

export default function TransactionsScreen({ navigation, route }: any) {
  const insets = useSafeAreaInsets();
  const { t } = useI18n();
  const {
    refreshSnapshot,
    registeredWallet,
    session,
    transactions,
  } = useWalletState();
  const [refreshing, setRefreshing] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(Boolean(session));
  const [historyFailed, setHistoryFailed] = useState(false);
  const [allTransactions, setAllTransactions] = useState<WalletTransaction[]>(
    transactions,
  );
  const routeAddressFilter = route?.params?.addressFilter;
  const addressFilter = useMemo(
    () =>
      Number.isInteger(routeAddressFilter?.accountIndex) &&
      routeAddressFilter.accountIndex >= 0 &&
      Number.isInteger(routeAddressFilter?.addressIndex) &&
      routeAddressFilter.addressIndex >= 0
        ? {
            accountIndex: routeAddressFilter.accountIndex as number,
            addressIndex: routeAddressFilter.addressIndex as number,
            label:
              typeof routeAddressFilter.label === 'string'
                ? routeAddressFilter.label
                : undefined,
          }
        : undefined,
    [
      routeAddressFilter?.accountIndex,
      routeAddressFilter?.addressIndex,
      routeAddressFilter?.label,
    ],
  );
  const visibleTransactions = useMemo(
    () => transactionsForWalletAddress(allTransactions, addressFilter),
    [addressFilter, allTransactions],
  );

  useEffect(() => {
    setAllTransactions([]);
    setHistoryLoading(Boolean(session));
    setHistoryFailed(false);
  }, [
    addressFilter?.accountIndex,
    addressFilter?.addressIndex,
    session,
    session?.walletId,
  ]);

  const refresh = useCallback(async () => {
    if (!session) {
      setAllTransactions([]);
      setHistoryLoading(false);
      setHistoryFailed(false);
      return;
    }

    setRefreshing(true);
    setHistoryLoading(true);
    setHistoryFailed(false);
    try {
      const [, nextTransactions] = await Promise.all([
        refreshSnapshot(),
        walletService.getTransactionsForAllAccounts(session, 0),
      ]);
      setAllTransactions(nextTransactions);
    } catch (error) {
      setHistoryFailed(true);
      throw error;
    } finally {
      setRefreshing(false);
      setHistoryLoading(false);
    }
  }, [refreshSnapshot, session]);

  useFocusEffect(
    useCallback(() => {
      refresh().catch(() => undefined);
    }, [refresh]),
  );

  const openTransaction = (transaction: WalletTransaction) => {
    navigation.navigate('TransactionDetail', {
      transaction,
      transactionHash: transaction.hash,
      walletId: registeredWallet?.id,
      walletName: registeredWallet
        ? walletDisplayName(registeredWallet)
        : undefined,
    });
  };

  return (
    <View style={s.container}>
      <View style={s.header}>
        <TouchableOpacity
          accessibilityLabel={t('action.back')}
          accessibilityRole="button"
          activeOpacity={0.7}
          onPress={() => navigation.goBack()}
          style={s.back}
        >
          <Icon name="arrow-left" size={22} color={colors.textPrimary} />
        </TouchableOpacity>
        <View style={s.headerCopy}>
          <Text style={s.title}>{t('transactions.title')}</Text>
          <Text style={s.subtitle} numberOfLines={1}>
            {addressFilter?.label || (registeredWallet
              ? walletDisplayName(registeredWallet)
              : t('common.wallet'))}
          </Text>
        </View>
      </View>

      <FlatList
        contentContainerStyle={[
          s.scroll,
          { paddingBottom: Math.max(insets.bottom + 24, 40) },
        ]}
        data={visibleTransactions}
        keyExtractor={transactionRowKey}
        ListHeaderComponent={
          historyFailed && visibleTransactions.length > 0 ? (
            <View style={s.refreshFailure}>
              <Text style={s.refreshFailureText}>{t('action.retry')}</Text>
              <TouchableOpacity
                accessibilityRole="button"
                onPress={() => refresh().catch(() => undefined)}
                style={s.refreshRetryButton}
              >
                <Text style={s.retryText}>{t('action.retry')}</Text>
              </TouchableOpacity>
            </View>
          ) : null
        }
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={refresh}
            tintColor={colors.orange}
          />
        }
        renderItem={({ item: transaction }) => (
          <TransactionRow
            transaction={transaction}
            onPress={() => openTransaction(transaction)}
          />
        )}
        ListEmptyComponent={
          historyLoading ? (
            <View style={s.loading}>
              <ActivityIndicator color={colors.orange} size="large" />
              <Text style={s.loadingText}>{t('sync.updatingHistory')}</Text>
            </View>
          ) : (
            <View style={s.empty}>
              <View style={s.emptyIcon}>
                <Icon name="file" size={28} color={colors.orange} />
              </View>
              <Text style={s.emptyTitle}>
                {session
                  ? t('home.noTransactions')
                  : t('home.walletNotOpen')}
              </Text>
              <Text style={s.emptyText}>
                {historyFailed
                  ? t('action.retry')
                  : session
                    ? t('home.noTransactionsText')
                    : t('home.openWalletToLoad')}
              </Text>
              {historyFailed ? (
                <TouchableOpacity
                  accessibilityRole="button"
                  onPress={() => refresh().catch(() => undefined)}
                  style={s.retryButton}
                >
                  <Text style={s.retryText}>{t('action.retry')}</Text>
                </TouchableOpacity>
              ) : null}
            </View>
          )
        }
      />
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
  headerCopy: { flex: 1, minWidth: 0 },
  title: { color: colors.textPrimary, fontSize: 24, fontWeight: '900' },
  subtitle: { color: colors.textSecondary, fontSize: 13, marginTop: 2 },
  scroll: { padding: spacing.lg },
  loading: {
    alignItems: 'center',
    gap: spacing.md,
    paddingTop: 64,
  },
  loadingText: { color: colors.textSecondary, fontSize: 14 },
  refreshFailure: {
    alignItems: 'center',
    backgroundColor: colors.bgCard,
    borderColor: colors.border,
    borderRadius: 10,
    borderWidth: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  refreshFailureText: { color: colors.textSecondary, fontSize: 13 },
  refreshRetryButton: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 32,
    paddingHorizontal: spacing.sm,
  },
  empty: {
    alignItems: 'center',
    paddingHorizontal: spacing.xl,
    paddingTop: 64,
  },
  emptyIcon: {
    width: 58,
    height: 58,
    borderRadius: 29,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.orangeMuted,
    marginBottom: 16,
  },
  emptyTitle: {
    color: colors.textPrimary,
    fontSize: 19,
    fontWeight: '800',
    textAlign: 'center',
  },
  emptyText: {
    color: colors.textSecondary,
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
    marginTop: 7,
  },
  retryButton: {
    alignItems: 'center',
    borderColor: colors.orange,
    borderRadius: 10,
    borderWidth: 1,
    marginTop: spacing.lg,
    minHeight: 42,
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
  },
  retryText: { color: colors.orange, fontSize: 14, fontWeight: '800' },
});
