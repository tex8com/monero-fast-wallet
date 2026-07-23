import React, { useCallback, useState } from 'react';
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
import { useFocusEffect } from '@react-navigation/native';

import { Icon } from '../components/Icon';
import TransactionRow, {
  transactionRowKey,
} from '../components/TransactionRow';
import { useI18n } from '../i18n';
import {
  fastReceiveScannerUrlForSettings,
  getActiveNodeConnectionSettings,
  loadActiveNodeConnectionSettings,
  type NodeConnectionMode,
  type NodeConnectionSettings,
} from '../services/NodeConnectionSettings';
import type { FastReceiveIdentityRecord } from '../services/FastReceiveRegistry';
import {
  fastWalletStatusPresentation,
  type FastWalletStatusTone,
} from '../services/FastWalletStatus';
import { FastWalletPushService } from '../services/FastWalletPushService';
import { logWalletEvent } from '../services/WalletLogger';
import {
  walletDisplayName,
  type RegisteredWallet,
} from '../services/WalletRegistry';
import { walletService } from '../services/WalletService';
import { useWalletState } from '../services/WalletState';
import { colors, radius, spacing } from '../theme/colors';

const FAST_WALLET_STATUS_REFRESH_MS = 30_000;

export default function WalletsScreen({ navigation }: any) {
  const { t } = useI18n();
  const {
    registeredWallet,
    registeredWallets,
    reloadRegisteredWallets,
    renameRegisteredWallet,
    removeRegisteredWallet,
    session,
    transactions,
    walletSnapshots,
  } = useWalletState();
  const [fastReceiveIdentities, setFastReceiveIdentities] = useState<
    FastReceiveIdentityRecord[]
  >([]);
  const [nodeMode, setNodeMode] = useState<NodeConnectionMode>(
    getActiveNodeConnectionSettings().mode,
  );
  const [nodeSettings, setNodeSettings] = useState<NodeConnectionSettings>(
    getActiveNodeConnectionSettings(),
  );
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [busyIdentityId, setBusyIdentityId] = useState<string | undefined>();
  const [fastActionError, setFastActionError] = useState<string | undefined>();
  const [renamingWalletId, setRenamingWalletId] = useState<string | undefined>();
  const [renameValue, setRenameValue] = useState('');
  const [renameError, setRenameError] = useState<string | undefined>();
  const [renameBusy, setRenameBusy] = useState(false);
  const tex8Node = nodeMode === 'optimized-grpc';
  const needsPassword = Boolean(session && !session.credentialKey);
  const canCreateFastWallet =
    tex8Node &&
    Boolean(
      session &&
        !session.hardwareDevice &&
        registeredWallet?.kind === 'software',
    ) &&
    (!needsPassword || password.length > 0) &&
    !busy;

  useFocusEffect(
    useCallback(() => {
      let mounted = true;
      let refreshInFlight = false;
      const refreshFastWalletStatus = async () => {
        if (refreshInFlight) {
          return;
        }

        refreshInFlight = true;
        try {
          const [identities, settings] = await Promise.all([
            walletService.loadFastReceiveIdentitiesForActiveNode(),
            loadActiveNodeConnectionSettings(),
          ]);
          if (!mounted) {
            return;
          }
          setFastReceiveIdentities(identities);
          setNodeMode(settings.mode);
          setNodeSettings(settings);
          setFastActionError(undefined);
        } catch {
          if (mounted) {
            setFastActionError(t('fastWallet.status.errorDescription'));
          }
        } finally {
          refreshInFlight = false;
        }
      };

      refreshFastWalletStatus().catch(() => undefined);
      const interval = setInterval(
        () => refreshFastWalletStatus().catch(() => undefined),
        FAST_WALLET_STATUS_REFRESH_MS,
      );

      return () => {
        mounted = false;
        clearInterval(interval);
      };
    }, [t]),
  );

  const confirmRemoveWallet = (wallet: RegisteredWallet) => {
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

  const confirmRemoveFastWallet = (identity: FastReceiveIdentityRecord) => {
    Alert.alert(
      t('wallets.removeFastWallet'),
      t('wallets.removeFastWalletConfirm', { name: identity.label }),
      [
        { text: t('action.cancel'), style: 'cancel' },
        {
          text: t('wallets.removeFromApp'),
          style: 'destructive',
          onPress: async () => {
            setBusyIdentityId(identity.id);
            setFastActionError(undefined);
            try {
              const scannerUrl =
                identity.scannerUrl ||
                fastReceiveScannerUrlForSettings(nodeSettings);
              if (scannerUrl && identity.status !== 'local-only') {
                await walletService.disableFastReceiveIdentity({
                  identityId: identity.id,
                  scannerUrl,
                });
              }
              const identities = await walletService.removeFastReceiveIdentity(
                identity.id,
              );
              await removeRegisteredWallet(identity.id);
              setFastReceiveIdentities(identities);
            } catch {
              setFastActionError(t('fastWallet.status.errorDescription'));
            } finally {
              setBusyIdentityId(undefined);
            }
          },
        },
      ],
    );
  };

  const createFastWallet = async () => {
    if (!canCreateFastWallet) {
      return;
    }

    setBusy(true);
    setFastActionError(undefined);
    try {
      const result = await walletService.createFastReceiveIdentity({
        password: needsPassword ? password : undefined,
      });
      const scannerUrl = fastReceiveScannerUrlForSettings(nodeSettings);
      const pushSubscriptionId = scannerUrl
        ? await FastWalletPushService.enableFastWalletNotifications()
            .then(registration => registration.subscriptionId)
            .catch(error => {
              logWalletEvent('Wallets', 'fastWallet.pushRegistrationSkipped', {
                error: error instanceof Error ? error.message : String(error),
                identityId: result.identity.id,
              });
              return undefined;
            })
        : undefined;
      const enabled = scannerUrl
        ? await walletService.enableFastReceiveIdentity({
            identityId: result.identity.id,
            password: needsPassword ? password : undefined,
            secretKey: session?.credentialKey,
            scannerUrl,
            pushSubscriptionId,
          })
        : result;
      setFastReceiveIdentities(enabled.identities);
      await reloadRegisteredWallets();
      setPassword('');
    } catch {
      const identities =
        await walletService.loadFastReceiveIdentitiesForActiveNode();
      setFastReceiveIdentities(identities);
      setFastActionError(t('fastWallet.status.errorDescription'));
    } finally {
      setBusy(false);
    }
  };

  const repairFastWallet = async (identity: FastReceiveIdentityRecord) => {
    if (busyIdentityId) {
      return;
    }

    setBusyIdentityId(identity.id);
    setFastActionError(undefined);
    try {
      const identities =
        await walletService.repairFastReceiveIdentityForActiveNode(
          identity.id,
          needsPassword ? password : undefined,
        );
      setFastReceiveIdentities(identities);
      setPassword('');
    } catch {
      const identities =
        await walletService.loadFastReceiveIdentitiesForActiveNode();
      setFastReceiveIdentities(identities);
      setFastActionError(t('fastWallet.status.errorDescription'));
    } finally {
      setBusyIdentityId(undefined);
    }
  };

  const enablePushForFastWallet = async (
    identity: FastReceiveIdentityRecord,
  ) => {
    if (busyIdentityId) {
      return;
    }
    const scannerUrl =
      identity.scannerUrl || fastReceiveScannerUrlForSettings(nodeSettings);
    if (!scannerUrl) {
      return;
    }

    setBusyIdentityId(identity.id);
    setFastActionError(undefined);
    try {
      const registration =
        await FastWalletPushService.enableFastWalletNotifications();
      const result = await walletService.enableFastReceiveIdentity({
        identityId: identity.id,
        password: needsPassword ? password : undefined,
        secretKey: session?.credentialKey,
        pushSubscriptionId: registration.subscriptionId,
        scannerUrl,
      });
      setFastReceiveIdentities(result.identities);
      setPassword('');
    } catch (error) {
      logWalletEvent('Wallets', 'fastWallet.enablePushError', {
        error: error instanceof Error ? error.message : String(error),
        identityId: identity.id,
      });
      setFastActionError(t('fastWallet.status.pushErrorDescription'));
    } finally {
      setBusyIdentityId(undefined);
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
          <Text style={s.sectionTitle}>{t('wallets.privateWallets')}</Text>
          {registeredWallets.some(wallet => wallet.kind !== 'fast') ? (
            registeredWallets
              .filter(wallet => wallet.kind !== 'fast')
              .map(wallet => (
                <View key={wallet.id}>
                  <WalletRow
                    active={wallet.id === registeredWallet?.id}
                    address={walletSnapshots[wallet.id]?.primaryAddress}
                    statusLabel={
                      wallet.id === registeredWallet?.id
                        ? t('walletSelector.active')
                        : undefined
                    }
                    statusTone="success"
                    subtitle={
                      wallet.kind === 'hardware'
                        ? wallet.hardwareDeviceName ?? 'Ledger Nano'
                        : wallet.network
                    }
                    title={walletDisplayName(wallet)}
                    onRename={() => startRenameWallet(wallet)}
                    onRemove={() => confirmRemoveWallet(wallet)}
                  />
                  {renamingWalletId === wallet.id ? (
                    <View style={s.renameBox}>
                      <TextInput
                        autoCapitalize="words"
                        autoFocus
                        maxLength={64}
                        onChangeText={setRenameValue}
                        placeholder="Wallet name"
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
                          <Text style={s.renameCancelText}>{t('action.cancel')}</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          activeOpacity={0.72}
                          disabled={renameBusy}
                          onPress={saveWalletName}
                          style={s.renameSave}
                        >
                          {renameBusy ? <ActivityIndicator color="#FFF" size="small" /> : <Text style={s.renameSaveText}>Save</Text>}
                        </TouchableOpacity>
                      </View>
                      {renameError ? <Text style={s.renameError}>{renameError}</Text> : null}
                    </View>
                  ) : null}
                </View>
              ))
          ) : (
            <EmptyCard text={t('wallets.noWallets')} />
          )}
        </View>

        <View style={s.section}>
          <View style={s.sectionHeaderRow}>
            <Text style={s.sectionTitle}>{t('wallets.fastWallets')}</Text>
            <Text style={[s.nodePill, tex8Node ? s.nodePillOk : s.nodePillOff]}>
              {tex8Node
                ? t('settings.nodeModeTex8')
                : t('settings.nodeModeOriginal')}
            </Text>
          </View>

          <View style={s.fastInfo}>
            <Icon name="info" size={17} color={colors.orange} />
            <Text style={s.fastInfoText}>
              {tex8Node
                ? t('wallets.fastWalletTex8Only')
                : t('wallets.fastWalletOriginalDisabled')}
            </Text>
          </View>

          {fastReceiveIdentities.length > 0 ? (
            fastReceiveIdentities.map(identity => {
              const status = fastWalletStatusPresentation(
                identity,
                tex8Node,
                t,
              );
              return (
                <WalletRow
                  active={identity.id === registeredWallet?.id}
                  address={identity.address}
                  busy={busyIdentityId === identity.id}
                  key={identity.id}
                  onRemove={() => confirmRemoveFastWallet(identity)}
                  onRetry={
                    status.canRetry && (!needsPassword || password.length > 0)
                      ? () => repairFastWallet(identity)
                      : undefined
                  }
                  onSecondaryAction={
                    status.ready &&
                    !identity.notificationsEnabled &&
                    (!needsPassword || password.length > 0)
                      ? () => enablePushForFastWallet(identity)
                      : undefined
                  }
                  secondaryActionLabel={t('action.enableNotifications')}
                  statusLabel={status.label}
                  statusTone={status.tone}
                  subtitle={identity.network}
                  title={identity.label}
                />
              );
            })
          ) : (
            <EmptyCard text={t('wallets.noFastWallets')} />
          )}

          {fastActionError ? (
            <Text style={s.fastActionError}>{fastActionError}</Text>
          ) : null}

          {needsPassword ? (
            <TextInput
              value={password}
              onChangeText={setPassword}
              placeholder={t('settings.walletPassword')}
              placeholderTextColor={colors.textMuted}
              secureTextEntry
              style={s.passwordInput}
            />
          ) : null}

          <TouchableOpacity
            activeOpacity={0.8}
            disabled={!canCreateFastWallet}
            onPress={createFastWallet}
            style={[
              s.fastCreateButton,
              !canCreateFastWallet && s.fastCreateButtonDisabled,
            ]}
          >
            <Icon name="plus" size={18} color="#FFF" strokeWidth={2.4} />
            <Text style={s.fastCreateButtonText}>
              {busy ? t('status.creating') : t('wallets.createFastWallet')}
            </Text>
          </TouchableOpacity>
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
                session
                  ? t('home.noTransactions')
                  : t('home.openWalletToLoad')
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
  busy,
  onRetry,
  onSecondaryAction,
  secondaryActionLabel,
  statusLabel,
  statusTone,
  subtitle,
  title,
  onRename,
  onRemove,
}: {
  active?: boolean;
  address?: string;
  busy?: boolean;
  onRetry?: () => void;
  onSecondaryAction?: () => void;
  secondaryActionLabel?: string;
  statusLabel?: string;
  statusTone?: FastWalletStatusTone;
  subtitle: string;
  title: string;
  onRename?: () => void;
  onRemove: () => void;
}) {
  const { t } = useI18n();

  return (
    <View style={[s.walletRow, active && s.walletRowActive]}>
      <View style={s.walletIcon}>
        <Icon name="wallet" size={18} color={colors.orange} />
      </View>
      <View style={s.walletText}>
        <Text style={s.walletTitle} numberOfLines={1}>
          {title}
        </Text>
        <Text style={s.walletSubtitle} numberOfLines={1}>
          {address ? shortAddress(address) : subtitle}
        </Text>
      </View>
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
        {onRename ? (
          <TouchableOpacity activeOpacity={0.72} onPress={onRename} style={s.renameButton}>
            <Icon name="edit" size={16} color={colors.orange} />
          </TouchableOpacity>
        ) : null}
        <TouchableOpacity
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
  walletIcon: {
    width: 38,
    height: 38,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 19,
    backgroundColor: colors.orangeMuted,
  },
  walletText: { flex: 1, minWidth: 0 },
  walletTitle: { color: colors.textPrimary, fontSize: 15, fontWeight: '900' },
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
  renameActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 10 },
  renameCancel: { minHeight: 36, justifyContent: 'center', paddingHorizontal: 12 },
  renameCancelText: { color: colors.textSecondary, fontWeight: '800' },
  renameSave: { minWidth: 70, minHeight: 36, alignItems: 'center', justifyContent: 'center', borderRadius: radius.sm, backgroundColor: colors.orange, paddingHorizontal: 12 },
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
