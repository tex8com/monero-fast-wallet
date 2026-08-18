import React from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import { useI18n, type TranslationKey } from '../i18n';
import type { WalletSnapshot } from '../backend/NativeMoneroWallet';
import {
  isFastWalletRegistration,
  isLegacyLedgerAccountRegistration,
  ledgerBalanceNeedsVerification,
  walletDisplayName,
  type RegisteredWallet,
} from '../backend/WalletRegistry';
import { formatAtomicXmr } from '../backend/WalletFormat';
import type { WalletSnapshotCache } from '../backend/WalletSnapshotCache';
import { colors, radius } from '../theme/colors';
import { presentWalletSync } from '../../../../packages/wallet-shared/src/walletSync';

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
  openingWalletId?: string;
  showTitle?: boolean;
  snapshots: WalletSnapshotCache;
  titleKey: TranslationKey;
  wallets: WalletSelectorItem[];
  onSelect: (wallet: WalletOption) => void | Promise<void>;
  onAdd?: () => void;
  onManage?: () => void;
};

export default function WalletSelector({
  activeWalletId,
  openingWalletId,
  showTitle = true,
  snapshots,
  titleKey,
  wallets,
  onSelect,
  onAdd,
  onManage,
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
      {showTitle ? (
        <View style={s.titleRow}>
          <Text style={s.title}>{t(titleKey)}</Text>
          {onManage ? (
            <TouchableOpacity
              accessibilityLabel={t('wallets.manage')}
              accessibilityRole="link"
              activeOpacity={0.7}
              onPress={onManage}
            >
              <Text style={s.manageLink}>{t('wallets.manage')}</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      ) : null}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={s.row}
      >
        {options.map(wallet => {
          const active = wallet.id === activeWalletId;
          const opening = wallet.id === openingWalletId;
          return (
            <TouchableOpacity
              key={wallet.id}
              style={[
                s.card,
                active && s.cardActive,
                wallet.disabled && s.cardDisabled,
              ]}
              activeOpacity={0.76}
              disabled={wallet.disabled || Boolean(openingWalletId)}
              onPress={() => onSelect(wallet)}
            >
              <View style={s.cardTop}>
                <Text style={s.name} numberOfLines={1}>
                  {wallet.label}
                </Text>
                {opening ? (
                  <ActivityIndicator color={colors.orange} size="small" />
                ) : active ? (
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
        {onAdd ? (
          <TouchableOpacity
            accessibilityLabel={t('action.addWallet')}
            accessibilityRole="button"
            activeOpacity={0.76}
            disabled={Boolean(openingWalletId)}
            onPress={onAdd}
            style={[s.card, s.addCard]}
          >
            <Text style={s.addIcon}>＋</Text>
            <Text style={s.addLabel}>{t('action.addWallet')}</Text>
          </TouchableOpacity>
        ) : null}
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

  const registration = wallet as RegisteredWallet;
  const snapshot = snapshots[registration.id];
  const fastWallet = isFastWalletRegistration(registration);
  const legacyLedgerAccount = isLegacyLedgerAccountRegistration(registration);
  const ledgerVerificationRequired = ledgerBalanceNeedsVerification(
    registration,
    snapshot?.pendingOutputKeyImageCount,
    snapshotHasKnownLedgerActivity(snapshot) ? 1 : 0,
  );
  return {
    id: registration.id,
    address: snapshot?.primaryAddress,
    badge: legacyLedgerAccount
      ? t('walletSelector.ledgerFast')
      : fastWallet
      ? t('walletSelector.fast')
      : registration.kind === 'hardware'
      ? registration.hardwareDeviceName ?? 'Ledger'
      : undefined,
    // The node transport belongs to the app/network, not to this card. Wallet
    // cards report only private scan readiness and never inherit the global
    // connection state.
    detail: ledgerVerificationRequired
      ? t('walletSelector.preparing')
      : snapshot
      ? walletSnapshotStatusLabel(snapshot, t)
      : t('walletSelector.waitingSharedBlocks'),
    kind: fastWallet ? 'fast' : registration.kind,
    label: walletDisplayName(registration),
    meta: legacyLedgerAccount
      ? t('walletSelector.ledgerFastAccount')
      : fastWallet
      ? registration.network
      : registration.kind === 'hardware'
      ? registration.hardwareDeviceName ?? 'Ledger'
      : registration.network,
    tone: snapshot ? 'balance' : 'warning',
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
  const sync = presentWalletSync(snapshot);
  if (sync.coreConfirmed) {
    return `${t('walletSelector.ready')} · ${balance}`;
  }
  if (sync.phase === 'finalizing') {
    return `${t('sync.verifyingRecent')} · ${balance}`;
  }
  if (sync.phase === 'waiting-for-node') {
    // Connection state is app-wide and appears once in the page header. This
    // card describes only the wallet-private consumer of the shared feed.
    return `${t('walletSelector.waitingSharedBlocks')} · ${balance}`;
  }
  return `${t('walletSelector.scanningWallet')} · ${balance}`;
}

function balanceLabel(snapshot: WalletSnapshot): string {
  return `${formatAtomicXmr(snapshot.balanceAtomic, {
    maxFractionDigits: 4,
    minFractionDigits: 2,
  })} XMR`;
}

function snapshotHasKnownLedgerActivity(
  snapshot: WalletSnapshot | undefined,
): boolean {
  if (!snapshot) return false;
  try {
    return (
      BigInt(snapshot.balanceAtomic) !== 0n ||
      BigInt(snapshot.unlockedBalanceAtomic) !== 0n
    );
  } catch {
    // A malformed amount must never make an unverified Ledger balance visible.
    return true;
  }
}

const s = StyleSheet.create({
  wrap: { marginBottom: 18 },
  titleRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  title: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  manageLink: {
    color: colors.orange,
    fontSize: 13,
    fontWeight: '700',
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
  addCard: {
    alignItems: 'center',
    borderStyle: 'dashed',
    justifyContent: 'center',
  },
  addIcon: {
    color: colors.orange,
    fontSize: 28,
    fontWeight: '500',
    lineHeight: 30,
  },
  addLabel: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: '800',
    marginTop: 6,
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
