import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  RefreshControl,
  ScrollView,
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
import type { WalletTransaction } from '../backend/NativeMoneroWallet';
import { useWalletState } from '../backend/WalletState';
import { walletDisplayName } from '../backend/WalletRegistry';
import { transactionsForWalletAddress } from '../backend/WalletAddressActivity';
import { walletService } from '../backend/WalletService';
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
  }, [
    addressFilter?.accountIndex,
    addressFilter?.addressIndex,
    session?.walletId,
  ]);

  const refresh = useCallback(async () => {
    if (!session) {
      setAllTransactions([]);
      return;
    }

    setRefreshing(true);
    try {
      const [, nextTransactions] = await Promise.all([
        refreshSnapshot(),
        walletService.getTransactionsForAllAccounts(session, 0),
      ]);
      setAllTransactions(nextTransactions);
    } finally {
      setRefreshing(false);
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

      <ScrollView
        contentContainerStyle={[
          s.scroll,
          { paddingBottom: Math.max(insets.bottom + 24, 40) },
        ]}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={refresh}
            tintColor={colors.orange}
          />
        }
      >
        {visibleTransactions.length > 0 ? (
          visibleTransactions.map(transaction => (
            <TransactionRow
              key={transactionRowKey(transaction)}
              transaction={transaction}
              onPress={() => openTransaction(transaction)}
            />
          ))
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
              {session
                ? t('home.noTransactionsText')
                : t('home.openWalletToLoad')}
            </Text>
          </View>
        )}
      </ScrollView>
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
});
