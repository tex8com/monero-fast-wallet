import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Icon } from '../components/Icon';
import TransactionRow, {
  transactionRowKey,
} from '../components/TransactionRow';
import { useI18n } from '../i18n';
import type { FastWalletStatusTone } from '../services/FastWalletStatus';
import {
  isFastWalletRegistration,
  walletRegistrationIsRemovedWithTarget,
  walletRequiresRecoverySeedBackup,
  walletDisplayName,
  type RegisteredWallet,
} from '../services/WalletRegistry';
import { walletService } from '../services/WalletService';
import { useWalletState } from '../services/WalletState';
import { colors, radius, spacing } from '../theme/colors';

export default function WalletsScreen({ navigation }: any) {
  const { t } = useI18n();
  const {
    backupRegisteredWalletSeed,
    openRegisteredWalletById,
    registeredWallet,
    registeredWallets,
    reloadRegisteredWallets,
    renameRegisteredWallet,
    removeRegisteredWallet,
    session,
    transactions,
    walletSnapshots,
  } = useWalletState();
  const [backingUpWalletId, setBackingUpWalletId] = useState<
    string | undefined
  >();
  const [fastWalletTransfer, setFastWalletTransfer] = useState<{
    walletId: string;
    status: 'transferring' | 'accepted' | 'failed';
  }>();
  const fastWalletTransferTimer = useRef<
    ReturnType<typeof setTimeout> | undefined
  >(undefined);
  const [walletActionError, setWalletActionError] = useState<
    string | undefined
  >();
  const [renamingWalletId, setRenamingWalletId] = useState<
    string | undefined
  >();
  const [renameValue, setRenameValue] = useState('');
  const [renameError, setRenameError] = useState<string | undefined>();
  const [renameBusy, setRenameBusy] = useState(false);
  const [openingWalletId, setOpeningWalletId] = useState<string | undefined>();

  useEffect(
    () => () => {
      if (fastWalletTransferTimer.current) {
        clearTimeout(fastWalletTransferTimer.current);
      }
    },
    [],
  );
  const selectRegisteredWallet = (wallet: RegisteredWallet) => {
    if (openingWalletId) {
      return;
    }

    if (wallet.kind !== 'hardware' && wallet.credentialKey) {
      // Commit the selected wallet and cached snapshot immediately, then let a
      // rare cold native open finish behind Home. There is no intermediate
      // Open Wallet page or per-wallet authentication step.
      const opening = openRegisteredWalletById(wallet.id);
      if (isFastWalletRegistration(wallet)) {
        navigation.navigate('Receive', { walletId: wallet.id });
      } else {
        navigation.navigate('Home');
      }
      opening.catch(() => undefined);
      return;
    }

    setOpeningWalletId(wallet.id);
    openRegisteredWalletById(wallet.id)
      .then(opened => {
        if (opened) {
          if (isFastWalletRegistration(wallet)) {
            navigation.navigate('Receive', { walletId: wallet.id });
          } else {
            navigation.navigate('Home');
          }
        }
      })
      .catch(error => {
        Alert.alert(
          t('wallets.openFailedTitle'),
          error instanceof Error ? error.message : t('wallets.openFailed'),
        );
      })
      .finally(() => setOpeningWalletId(undefined));
  };

  const showRemoveWalletConfirmation = (wallet: RegisteredWallet) => {
    Alert.alert(
      t('wallets.removeWallet'),
      t('wallets.removeWalletConfirm', { name: walletDisplayName(wallet) }),
      [
        { text: t('action.cancel'), style: 'cancel' },
        {
          text: t('wallets.removeFromApp'),
          style: 'destructive',
          onPress: async () => {
            try {
              await removeRegisteredWallet(wallet.id);
              await reloadRegisteredWallets();
            } catch (error) {
              Alert.alert(
                t('wallets.removeFailedTitle'),
                error instanceof Error
                  ? error.message
                  : t('wallets.removeFailed'),
              );
            }
          },
        },
      ],
    );
  };

  const findPendingSeedBackupForRemoval = (
    wallet: RegisteredWallet,
    wallets = registeredWallets,
  ): RegisteredWallet | undefined =>
    wallets.find(
      candidate =>
        walletRegistrationIsRemovedWithTarget(candidate, wallet) &&
        walletRequiresRecoverySeedBackup(candidate) &&
        candidate.seedBackupStatus !== 'verified',
    );

  const backUpSeedBeforeRemoval = (
    removalTarget: RegisteredWallet,
    seedWallet: RegisteredWallet,
  ) => {
    Alert.alert(
      t('wallets.removeBackupTitle'),
      t('wallets.removeBackupDescription', {
        name: walletDisplayName(seedWallet),
      }),
      [
        { text: t('action.cancel'), style: 'cancel' },
        {
          text: t('settings.showBackupSeed'),
          onPress: async () => {
            try {
              const confirmed = await backupRegisteredWalletSeed(
                seedWallet.id,
                t('settings.recoverySeedWarning'),
              );
              if (!confirmed) {
                return;
              }
              await reloadRegisteredWallets();
              // Reload before retrying so UI and service evaluate the same
              // current registry state and the service-side deletion guard is
              // never bypassed.
              const refreshed = await walletService.loadRegisteredWallets();
              const latestTarget = refreshed.find(
                candidate => candidate.id === removalTarget.id,
              );
              if (latestTarget) {
                confirmRemoveWallet(latestTarget, refreshed);
              }
            } catch (error) {
              Alert.alert(
                t('wallets.removeFailedTitle'),
                error instanceof Error
                  ? error.message
                  : t('wallets.removeFailed'),
              );
            }
          },
        },
      ],
    );
  };

  const confirmRemoveWallet = (
    wallet: RegisteredWallet,
    wallets = registeredWallets,
  ) => {
    const walletNeedingBackup = findPendingSeedBackupForRemoval(wallet, wallets);
    if (walletNeedingBackup) {
      backUpSeedBeforeRemoval(wallet, walletNeedingBackup);
      return;
    }
    showRemoveWalletConfirmation(wallet);
  };

  const startRenameWallet = (wallet: RegisteredWallet) => {
    setRenamingWalletId(wallet.id);
    setRenameValue(walletDisplayName(wallet));
    setRenameError(undefined);
  };

  const saveWalletName = async () => {
    if (!renamingWalletId || renameBusy) {
      return;
    }
    setRenameBusy(true);
    setRenameError(undefined);
    try {
      await renameRegisteredWallet(renamingWalletId, renameValue);
      setRenamingWalletId(undefined);
      setRenameValue('');
    } catch (error) {
      setRenameError(error instanceof Error ? error.message : String(error));
    } finally {
      setRenameBusy(false);
    }
  };

  const manageWalletAddresses = (wallet: RegisteredWallet) => {
    if (openingWalletId) {
      return;
    }
    setOpeningWalletId(wallet.id);
    navigation.navigate('Receive', {
      walletId: wallet.id,
      manageAddresses: true,
    });
    openRegisteredWalletById(wallet.id)
      .catch(error => {
        Alert.alert(
          t('wallets.openFailedTitle'),
          error instanceof Error ? error.message : t('wallets.openFailed'),
        );
      })
      .finally(() => setOpeningWalletId(undefined));
  };

  const backupFastWallet = async (wallet: RegisteredWallet) => {
    if (backingUpWalletId) {
      return;
    }

    setBackingUpWalletId(wallet.id);
    setWalletActionError(undefined);
    try {
      const confirmed = await backupRegisteredWalletSeed(
        wallet.id,
        t('settings.recoverySeedWarning'),
      );
      if (!confirmed) {
        return;
      }
      setFastWalletTransfer({
        walletId: wallet.id,
        status: 'transferring',
      });
      await walletService.enableEncryptedFastWalletAlerts({
        identityId: wallet.id,
      });
      setFastWalletTransfer({ walletId: wallet.id, status: 'accepted' });
      await reloadRegisteredWallets();
      fastWalletTransferTimer.current = setTimeout(
        () => setFastWalletTransfer(undefined),
        2200,
      );
    } catch (error) {
      setFastWalletTransfer({ walletId: wallet.id, status: 'failed' });
      setWalletActionError(
        error instanceof Error
          ? error.message
          : t('settings.recoverySeedError'),
      );
    } finally {
      setBackingUpWalletId(undefined);
    }
  };

  return (
    <View style={s.container}>
      <ScrollView
        contentContainerStyle={s.scroll}
        showsVerticalScrollIndicator={false}
      >
        <View style={s.header}>
          <TouchableOpacity
            activeOpacity={0.72}
            onPress={() => navigation.goBack()}
            style={s.backButton}
          >
            <Icon name="arrow-left" size={20} color={colors.textSecondary} />
          </TouchableOpacity>
          <View style={s.headerCopy}>
            <Text style={s.title}>{t('wallets.title')}</Text>
            <Text style={s.subtitle}>{t('wallets.subtitle')}</Text>
          </View>
        </View>

        <View style={s.actionRow}>
          <TouchableOpacity
            activeOpacity={0.8}
            onPress={() => navigation.navigate('WalletSetup')}
            style={s.primaryAction}
          >
            <Icon name="plus" size={18} color="#FFF" strokeWidth={2.4} />
            <Text style={s.primaryActionText}>{t('action.addWallet')}</Text>
          </TouchableOpacity>
        </View>

        <View style={s.section}>
          <Text style={s.sectionTitle}>{t('walletSelector.wallets')}</Text>
          {registeredWallets.length > 0 ? (
            registeredWallets.map(wallet => {
              const fastWallet = isFastWalletRegistration(wallet);
              const needsSeedBackup =
                walletRequiresRecoverySeedBackup(wallet) &&
                wallet.seedBackupStatus !== 'verified';
              const transfer =
                fastWalletTransfer?.walletId === wallet.id
                  ? fastWalletTransfer.status
                  : undefined;
              return (
                <View key={wallet.id}>
                  <WalletRow
                    active={wallet.id === registeredWallet?.id}
                    address={
                      needsSeedBackup
                        ? undefined
                        : walletSnapshots[wallet.id]?.primaryAddress
                    }
                    badge={fastWallet ? t('walletSelector.fast') : undefined}
                    busy={
                      openingWalletId === wallet.id ||
                      backingUpWalletId === wallet.id
                    }
                    onSelect={
                      needsSeedBackup
                        ? undefined
                        : () => selectRegisteredWallet(wallet)
                    }
                    onSecondaryAction={
                      needsSeedBackup
                        ? () => backupFastWallet(wallet)
                        : undefined
                    }
                    secondaryActionLabel={
                      needsSeedBackup ? t('wallets.backup') : undefined
                    }
                    statusLabel={
                      transfer === 'transferring'
                        ? t('setup.fastWalletTransferSending')
                        : transfer === 'accepted'
                        ? t('setup.fastWalletTransferAccepted')
                        : transfer === 'failed'
                        ? t('setup.fastWalletTransferFailed')
                        : needsSeedBackup
                        ? t('wallets.backupRecoveryWords')
                        : wallet.id === registeredWallet?.id
                        ? t('walletSelector.active')
                        : undefined
                    }
                    statusTone={
                      transfer === 'failed'
                        ? 'danger'
                        : transfer === 'transferring' ||
                          needsSeedBackup
                        ? 'warning'
                        : 'success'
                    }
                    subtitle={
                      fastWallet
                        ? t('wallets.receiveQuickly')
                        : wallet.kind === 'hardware'
                        ? (wallet.hardwareDeviceName ?? 'Ledger Nano')
                        : wallet.network
                    }
                    title={walletDisplayName(wallet)}
                    onRename={() => startRenameWallet(wallet)}
                    onManageAddresses={
                      needsSeedBackup
                        ? undefined
                        : () => manageWalletAddresses(wallet)
                    }
                    onRemove={() => confirmRemoveWallet(wallet)}
                  />
                  {renamingWalletId === wallet.id ? (
                    <View style={s.renameBox}>
                      <TextInput
                        autoCapitalize="words"
                        autoFocus
                        maxLength={64}
                        onChangeText={setRenameValue}
                        placeholder={t('wallets.walletNamePlaceholder')}
                        placeholderTextColor={colors.textMuted}
                        style={s.renameInput}
                        value={renameValue}
                      />
                      <View style={s.renameActions}>
                        <TouchableOpacity
                          activeOpacity={0.72}
                          disabled={renameBusy}
                          onPress={() => {
                            setRenamingWalletId(undefined);
                            setRenameError(undefined);
                          }}
                          style={s.renameCancel}
                        >
                          <Text style={s.renameCancelText}>
                            {t('action.cancel')}
                          </Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          activeOpacity={0.72}
                          disabled={renameBusy}
                          onPress={saveWalletName}
                          style={s.renameSave}
                        >
                          {renameBusy ? (
                            <ActivityIndicator color="#FFF" size="small" />
                          ) : (
                            <Text style={s.renameSaveText}>{t('action.save')}</Text>
                          )}
                        </TouchableOpacity>
                      </View>
                      {renameError ? (
                        <Text style={s.renameError}>{renameError}</Text>
                      ) : null}
                    </View>
                  ) : null}
                </View>
              );
            })
          ) : (
            <EmptyCard text={t('wallets.noWallets')} />
          )}
          {walletActionError ? (
            <Text style={s.fastActionError}>{walletActionError}</Text>
          ) : null}
        </View>

        <View style={s.recentSection}>
          <View style={s.recentHeader}>
            <Text style={s.recentTitle}>{t('home.transactions')}</Text>
            <TouchableOpacity
              accessibilityRole="button"
              activeOpacity={0.7}
              onPress={() => navigation.navigate('Transactions')}
            >
              <Text style={s.recentLink}>{t('transactions.viewMore')}</Text>
            </TouchableOpacity>
          </View>
          {session && transactions.length > 0 ? (
            transactions.slice(0, 3).map(transaction => (
              <TransactionRow
                key={transactionRowKey(transaction)}
                transaction={transaction}
                onPress={() =>
                  navigation.navigate('TransactionDetail', {
                    transaction,
                    transactionHash: transaction.hash,
                    walletId: registeredWallet?.id,
                    walletName: registeredWallet
                      ? walletDisplayName(registeredWallet)
                      : undefined,
                  })
                }
              />
            ))
          ) : (
            <EmptyCard
              text={
                session ? t('home.noTransactions') : t('home.openWalletToLoad')
              }
            />
          )}
        </View>
      </ScrollView>
    </View>
  );
}

function WalletRow({
  active,
  address,
  badge,
  busy,
  onRetry,
  onSelect,
  onSecondaryAction,
  secondaryActionLabel,
  statusLabel,
  statusTone,
  subtitle,
  title,
  onRename,
  onManageAddresses,
  onRemove,
}: {
  active?: boolean;
  address?: string;
  badge?: string;
  busy?: boolean;
  onRetry?: () => void;
  onSelect?: () => void;
  onSecondaryAction?: () => void;
  secondaryActionLabel?: string;
  statusLabel?: string;
  statusTone?: FastWalletStatusTone;
  subtitle: string;
  title: string;
  onRename?: () => void;
  onManageAddresses?: () => void;
  onRemove: () => void;
}) {
  const { t } = useI18n();

  return (
    <View style={[s.walletRow, active && s.walletRowActive]}>
      <TouchableOpacity
        accessibilityLabel={`Open ${title}`}
        accessibilityRole="button"
        activeOpacity={onSelect ? 0.72 : 1}
        disabled={!onSelect || busy}
        onPress={onSelect}
        style={s.walletSelect}
      >
        <View style={s.walletIcon}>
          {busy && onSelect ? (
            <ActivityIndicator color={colors.orange} size="small" />
          ) : (
            <Icon name="wallet" size={18} color={colors.orange} />
          )}
        </View>
        <View style={s.walletText}>
          <View style={s.walletTitleRow}>
            <Text style={s.walletTitle} numberOfLines={1}>
              {title}
            </Text>
            {badge ? <Text style={s.walletBadge}>{badge}</Text> : null}
          </View>
          <Text style={s.walletSubtitle} numberOfLines={1}>
            {address ? shortAddress(address) : subtitle}
          </Text>
        </View>
      </TouchableOpacity>
      {statusLabel ? (
        <View style={s.statusColumn}>
          <View style={s.statusRow}>
            <View
              style={[
                s.statusDot,
                statusTone === 'success' && s.statusDotSuccess,
                statusTone === 'danger' && s.statusDotDanger,
                statusTone === 'muted' && s.statusDotMuted,
              ]}
            />
            <Text
              style={[
                s.statusLabel,
                statusTone === 'success' && s.statusLabelSuccess,
                statusTone === 'danger' && s.statusLabelDanger,
                statusTone === 'muted' && s.statusLabelMuted,
              ]}
              numberOfLines={1}
            >
              {statusLabel}
            </Text>
          </View>
          {onRetry ? (
            <TouchableOpacity
              activeOpacity={0.72}
              disabled={busy}
              onPress={onRetry}
              style={s.retryButton}
            >
              {busy ? (
                <ActivityIndicator color={colors.orange} size="small" />
              ) : (
                <Text style={s.retryText}>{t('action.retry')}</Text>
              )}
            </TouchableOpacity>
          ) : null}
          {onSecondaryAction ? (
            <TouchableOpacity
              activeOpacity={0.72}
              disabled={busy}
              onPress={onSecondaryAction}
              style={s.retryButton}
            >
              {busy ? (
                <ActivityIndicator color={colors.orange} size="small" />
              ) : (
                <Text style={s.retryText}>{secondaryActionLabel}</Text>
              )}
            </TouchableOpacity>
          ) : null}
        </View>
      ) : null}
      <View style={s.walletActions}>
        {onManageAddresses ? (
          <TouchableOpacity
            accessibilityLabel={`${t('receive.manageAddresses')}: ${title}`}
            accessibilityRole="button"
            activeOpacity={0.72}
            onPress={onManageAddresses}
            style={s.addressesButton}
          >
            <Text style={s.addressesButtonText}>{t('receive.addresses')}</Text>
          </TouchableOpacity>
        ) : null}
        {onRename ? (
          <TouchableOpacity
            accessibilityLabel={`Rename ${title}`}
            accessibilityRole="button"
            activeOpacity={0.72}
            onPress={onRename}
            style={s.renameButton}
          >
            <Icon name="edit" size={16} color={colors.orange} />
          </TouchableOpacity>
        ) : null}
        <TouchableOpacity
          accessibilityLabel={`Remove ${title}`}
          accessibilityRole="button"
          activeOpacity={0.72}
          onPress={onRemove}
          style={s.removeButton}
        >
          <Icon name="trash" size={17} color={colors.error} />
        </TouchableOpacity>
      </View>
    </View>
  );
}

function EmptyCard({ text }: { text: string }) {
  return (
    <View style={s.emptyCard}>
      <Text style={s.emptyText}>{text}</Text>
    </View>
  );
}

function shortAddress(address: string): string {
  if (address.length <= 18) {
    return address;
  }

  return `${address.slice(0, 7)}...${address.slice(-6)}`;
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  scroll: { paddingHorizontal: spacing.lg, paddingTop: 60, paddingBottom: 140 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: 22,
  },
  backButton: {
    width: 42,
    height: 42,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 21,
    backgroundColor: 'rgba(255,255,255,0.055)',
  },
  headerCopy: { flex: 1, minWidth: 0 },
  title: { color: colors.textPrimary, fontSize: 28, fontWeight: '900' },
  subtitle: {
    color: colors.textSecondary,
    fontSize: 14,
    lineHeight: 20,
    marginTop: 4,
  },
  actionRow: { marginBottom: 24 },
  primaryAction: {
    minHeight: 50,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: radius.md,
    backgroundColor: colors.orange,
  },
  primaryActionText: { color: '#FFF', fontSize: 15, fontWeight: '900' },
  section: { marginBottom: 26 },
  sectionHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    marginBottom: 10,
  },
  sectionTitle: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: '900',
    letterSpacing: 0.4,
    marginBottom: 10,
    textTransform: 'uppercase',
  },
  recentSection: { marginBottom: 26 },
  recentHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  recentTitle: {
    color: colors.textPrimary,
    fontSize: 17,
    fontWeight: '800',
  },
  recentLink: { color: colors.orange, fontSize: 13, fontWeight: '800' },
  nodePill: {
    overflow: 'hidden',
    borderRadius: radius.full,
    paddingHorizontal: 10,
    paddingVertical: 4,
    fontSize: 11,
    fontWeight: '900',
  },
  nodePillOk: {
    color: colors.success,
    backgroundColor: 'rgba(0,214,143,0.12)',
  },
  nodePillOff: {
    color: colors.warning,
    backgroundColor: 'rgba(255,184,0,0.12)',
  },
  fastHeaderActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  fastInfoButton: {
    width: 30,
    height: 30,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 15,
    borderWidth: 1,
    borderColor: 'rgba(242,104,34,0.35)',
    backgroundColor: 'rgba(242,104,34,0.08)',
  },
  fastInfo: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: 'rgba(242,104,34,0.18)',
    backgroundColor: 'rgba(242,104,34,0.08)',
    padding: spacing.md,
    marginBottom: 10,
  },
  fastInfoText: {
    flex: 1,
    color: colors.textSecondary,
    fontSize: 13,
    lineHeight: 19,
  },
  alertControls: {
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgCard,
    padding: 12,
    marginTop: -4,
    marginBottom: 10,
  },
  alertControlCopy: { gap: 3 },
  alertControlTitle: {
    color: colors.textPrimary,
    fontSize: 13,
    fontWeight: '900',
  },
  alertControlText: {
    color: colors.textSecondary,
    fontSize: 12,
    lineHeight: 17,
  },
  alertControlActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 10,
  },
  alertPrimaryButton: {
    minHeight: 38,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.sm,
    backgroundColor: colors.orange,
    paddingHorizontal: 12,
  },
  alertPrimaryButtonText: { color: '#FFF', fontSize: 12, fontWeight: '900' },
  alertSecondaryButton: {
    minHeight: 38,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 12,
  },
  alertSecondaryButtonText: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: '900',
  },
  alertDeleteButton: {
    minHeight: 38,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.sm,
    backgroundColor: 'rgba(255,68,102,0.1)',
    paddingHorizontal: 12,
  },
  alertDeleteButtonText: { color: colors.error, fontSize: 12, fontWeight: '900' },
  walletRow: {
    minHeight: 70,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgCard,
    paddingHorizontal: 14,
    marginBottom: 10,
  },
  walletRowActive: {
    borderColor: 'rgba(242,104,34,0.42)',
  },
  walletSelect: {
    minWidth: 0,
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    alignSelf: 'stretch',
  },
  walletIcon: {
    width: 38,
    height: 38,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 19,
    backgroundColor: colors.orangeMuted,
  },
  walletText: { flex: 1, minWidth: 0 },
  walletTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  walletTitle: {
    flexShrink: 1,
    color: colors.textPrimary,
    fontSize: 15,
    fontWeight: '900',
  },
  walletBadge: {
    overflow: 'hidden',
    borderRadius: radius.full,
    backgroundColor: 'rgba(242,104,34,0.14)',
    color: colors.orange,
    fontSize: 9,
    fontWeight: '900',
    paddingHorizontal: 7,
    paddingVertical: 3,
  },
  walletSubtitle: { color: colors.textMuted, fontSize: 12, marginTop: 3 },
  statusColumn: {
    maxWidth: 104,
    alignItems: 'flex-end',
    gap: 3,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.warning,
  },
  statusDotSuccess: { backgroundColor: colors.success },
  statusDotDanger: { backgroundColor: colors.error },
  statusDotMuted: { backgroundColor: colors.textMuted },
  statusLabel: { color: colors.warning, fontSize: 10, fontWeight: '900' },
  statusLabelSuccess: { color: colors.success },
  statusLabelDanger: { color: colors.error },
  statusLabelMuted: { color: colors.textMuted },
  retryButton: {
    minWidth: 48,
    minHeight: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  retryText: { color: colors.orange, fontSize: 10, fontWeight: '900' },
  walletActions: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  addressesButton: {
    minHeight: 34,
    justifyContent: 'center',
    paddingHorizontal: 7,
  },
  addressesButtonText: {
    color: colors.orange,
    fontSize: 11,
    fontWeight: '800',
  },
  renameButton: {
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 17,
    backgroundColor: colors.orangeMuted,
  },
  removeButton: {
    width: 38,
    height: 38,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 19,
    backgroundColor: 'rgba(255,68,102,0.1)',
  },
  renameBox: {
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgCard,
    padding: 12,
    marginTop: -2,
    marginBottom: 10,
  },
  renameInput: {
    minHeight: 44,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    color: colors.textPrimary,
    backgroundColor: colors.bgInput,
    paddingHorizontal: 12,
    fontSize: 14,
  },
  renameActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 8,
    marginTop: 10,
  },
  renameCancel: {
    minHeight: 36,
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  renameCancelText: { color: colors.textSecondary, fontWeight: '800' },
  renameSave: {
    minWidth: 70,
    minHeight: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.sm,
    backgroundColor: colors.orange,
    paddingHorizontal: 12,
  },
  renameSaveText: { color: '#FFF', fontWeight: '900' },
  renameError: { color: colors.error, fontSize: 12, marginTop: 8 },
  emptyCard: {
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgCard,
    padding: spacing.md,
  },
  emptyText: { color: colors.textSecondary, fontSize: 13, lineHeight: 19 },
  passwordInput: {
    minHeight: 46,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgInput,
    color: colors.textPrimary,
    fontSize: 14,
    paddingHorizontal: 14,
    marginTop: 2,
    marginBottom: 10,
  },
  fastCreateButton: {
    minHeight: 50,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: radius.md,
    backgroundColor: colors.orange,
    marginTop: 2,
  },
  fastCreateButtonDisabled: { opacity: 0.42 },
  fastCreateButtonText: { color: '#FFF', fontSize: 15, fontWeight: '900' },
  fastActionError: {
    color: colors.error,
    fontSize: 12,
    lineHeight: 17,
    marginBottom: 10,
  },
});
