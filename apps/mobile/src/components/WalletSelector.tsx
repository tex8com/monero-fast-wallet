import React from 'react';
import {
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import { useI18n, type TranslationKey } from '../i18n';
import type { WalletSnapshot } from '../services/NativeMoneroWallet';
import type { RegisteredWallet } from '../services/WalletRegistry';
import { formatAtomicXmr } from '../services/WalletFormat';
import type { WalletSnapshotCache } from '../services/WalletSnapshotCache';
import { colors, radius } from '../theme/colors';

export type WalletOptionKind = RegisteredWallet['kind'] | 'fast';

export type WalletOption = {
  id: string;
  address?: string;
  badge?: string;
  detail?: string;
  disabled?: boolean;
  disabledReason?: string;
  kind: WalletOptionKind;
  label: string;
  meta: string;
  tone?: 'balance' | 'muted' | 'success' | 'warning';
};

export type WalletSelectorItem = RegisteredWallet | WalletOption;

type WalletSelectorProps = {
  activeWalletId?: string;
  showTitle?: boolean;
  snapshots: WalletSnapshotCache;
  titleKey: TranslationKey;
  wallets: WalletSelectorItem[];
  onSelect: (wallet: WalletOption) => void | Promise<void>;
};

export default function WalletSelector({
  activeWalletId,
  showTitle = true,
  snapshots,
  titleKey,
  wallets,
  onSelect,
}: WalletSelectorProps) {
  const { t } = useI18n();

  if (wallets.length === 0) {
    return null;
  }

  const options = wallets.map(wallet =>
    resolveWalletOption(wallet, snapshots, key => t(key)),
  );

  return (
    <View style={s.wrap}>
      {showTitle ? <Text style={s.title}>{t(titleKey)}</Text> : null}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={s.row}
      >
        {options.map(wallet => {
          const active = wallet.id === activeWalletId;
          return (
            <TouchableOpacity
              key={wallet.id}
              style={[
                s.card,
                active && s.cardActive,
                wallet.disabled && s.cardDisabled,
              ]}
              activeOpacity={0.76}
              disabled={wallet.disabled}
              onPress={() => onSelect(wallet)}
            >
              <View style={s.cardTop}>
                <Text style={s.name} numberOfLines={1}>
                  {wallet.label}
                </Text>
                {active ? (
                  <Text style={s.activePill}>{t('walletSelector.active')}</Text>
                ) : wallet.badge ? (
                  <Text
                    style={[s.activePill, wallet.kind === 'fast' && s.fastPill]}
                  >
                    {wallet.badge}
                  </Text>
                ) : null}
              </View>
              <Text style={s.meta} numberOfLines={1}>
                {wallet.meta}
              </Text>
              <Text
                style={[
                  wallet.tone === 'balance' ? s.balance : s.locked,
                  wallet.tone === 'success' && s.success,
                  wallet.tone === 'warning' && s.warning,
                ]}
                numberOfLines={1}
              >
                {wallet.detail ?? t('walletSelector.openToLoad')}
              </Text>
              {wallet.disabledReason ? (
                <Text style={s.disabledReason} numberOfLines={2}>
                  {wallet.disabledReason}
                </Text>
              ) : null}
            </TouchableOpacity>
          );
        })}
      </ScrollView>
    </View>
  );
}

export function resolveWalletOption(
  wallet: WalletSelectorItem,
  snapshots: WalletSnapshotCache,
  t: (key: TranslationKey) => string,
): WalletOption {
  if (isWalletOption(wallet)) {
    return wallet;
  }

  const snapshot = snapshots[wallet.id];
  return {
    id: wallet.id,
    address: snapshot?.primaryAddress,
    badge:
      wallet.kind === 'hardware'
        ? wallet.hardwareDeviceName ?? 'Ledger'
        : undefined,
    detail: snapshot
      ? walletSnapshotStatusLabel(snapshot, t)
      : t('walletSelector.openToCheckNode'),
    kind: wallet.kind,
    label: wallet.walletName,
    meta:
      wallet.kind === 'hardware'
        ? wallet.hardwareDeviceName ?? 'Ledger'
        : wallet.network,
    tone: snapshot ? 'balance' : 'muted',
  };
}

function isWalletOption(wallet: WalletSelectorItem): wallet is WalletOption {
  return 'label' in wallet;
}

export function walletSnapshotStatusLabel(
  snapshot: WalletSnapshot,
  t: (key: TranslationKey) => string,
): string {
  const balance = balanceLabel(snapshot);
  const targetHeight =
    snapshot.daemonTargetHeight > 0
      ? snapshot.daemonTargetHeight
      : snapshot.daemonHeight;

  if (snapshot.synchronized) {
    return `${t('walletSelector.synced')} · ${balance}`;
  }

  const progress =
    targetHeight > 0
      ? Math.max(
          0,
          Math.min(
            100,
            Math.floor((snapshot.walletHeight / targetHeight) * 100),
          ),
        )
      : 0;
  return `${t('walletSelector.syncing')} ${progress}% · ${balance}`;
}

function balanceLabel(snapshot: WalletSnapshot): string {
  return `${formatAtomicXmr(snapshot.balanceAtomic, {
    maxFractionDigits: 4,
    minFractionDigits: 2,
  })} XMR`;
}

const s = StyleSheet.create({
  wrap: { marginBottom: 18 },
  title: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0.5,
    marginBottom: 10,
    textTransform: 'uppercase',
  },
  row: { gap: 10, paddingRight: 20 },
  card: {
    width: 172,
    minHeight: 92,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgCard,
    padding: 12,
  },
  cardActive: {
    borderColor: colors.orange,
    backgroundColor: 'rgba(242,104,34,0.1)',
  },
  cardTop: {
    minHeight: 22,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  name: { flex: 1, color: colors.textPrimary, fontSize: 14, fontWeight: '800' },
  activePill: {
    color: colors.orange,
    fontSize: 10,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  fastPill: {
    color: colors.success,
  },
  meta: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '700',
    marginTop: 4,
    textTransform: 'uppercase',
  },
  balance: {
    color: colors.textPrimary,
    fontSize: 16,
    fontWeight: '900',
    marginTop: 12,
  },
  locked: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: '700',
    lineHeight: 17,
    marginTop: 10,
  },
  warning: {
    color: colors.warning,
  },
  success: {
    color: colors.success,
  },
  cardDisabled: {
    opacity: 0.62,
  },
  disabledReason: {
    color: colors.textMuted,
    fontSize: 10,
    fontWeight: '700',
    lineHeight: 14,
    marginTop: 4,
  },
});
