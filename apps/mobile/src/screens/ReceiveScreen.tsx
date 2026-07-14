import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import Clipboard from '@react-native-clipboard/clipboard';
import QRCode from 'react-native-qrcode-svg';
import { colors, spacing, radius } from '../theme/colors';
import MoneroLogo from '../components/MoneroLogo';
import { Icon } from '../components/Icon';
import TransactionRow, {
  transactionRowKey,
} from '../components/TransactionRow';
import type {
  WalletOption,
  WalletSelectorItem,
} from '../components/WalletSelector';
import WalletSwitcherPill from '../components/WalletSwitcherPill';
import { type TranslationKey, useI18n } from '../i18n';
import { useWalletState } from '../services/WalletState';
import type {
  HardwareWalletStatus,
  WalletSnapshot,
} from '../services/NativeMoneroWallet';
import type { FastReceiveIdentityRecord } from '../services/FastReceiveRegistry';
import {
  fastWalletSelectorTone,
  fastWalletStatusPresentation,
} from '../services/FastWalletStatus';
import {
  getActiveNodeConnectionSettings,
  loadActiveNodeConnectionSettings,
} from '../services/NodeConnectionSettings';
import type { NodeConnectionMode } from '../services/NodeConnectionSettings';
import { formatAtomicXmr } from '../services/WalletFormat';
import { walletService } from '../services/WalletService';

const FAST_WALLET_STATUS_REFRESH_MS = 30_000;

function QrCode({ value, size }: { value: string; size: number }) {
  return (
    <View
      style={{
        width: size,
        height: size,
        backgroundColor: '#FFF',
        borderRadius: radius.lg,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <QRCode
        backgroundColor="#FFF"
        color="#1A1A2E"
        ecl="H"
        quietZone={8}
        size={size}
        value={value}
      />
      <View
        style={{
          position: 'absolute',
          backgroundColor: '#FFF',
          borderRadius: 8,
          padding: 4,
        }}
      >
        <MoneroLogo size={28} />
      </View>
    </View>
  );
}

type Translator = (key: TranslationKey) => string;

function hardwareStatusText(
  status: HardwareWalletStatus | undefined,
  t: Translator,
): string {
  if (!status) {
    return t('receive.hardwareNotChecked');
  }

  if (status.promptKind === 'address-confirmed') {
    return t('receive.hardwareAddressConfirmed');
  }

  if (status.promptKind === 'address' || status.requiresUserAction) {
    return t('receive.hardwareConfirmAddress');
  }

  if (status.connected) {
    return t('receive.hardwareConnected');
  }

  return t('receive.hardwareConnectUnlock');
}

function fastWalletReceiveOption(
  identity: FastReceiveIdentityRecord,
  t: Translator,
  tex8Node: boolean,
): WalletOption {
  const status = fastWalletStatusPresentation(identity, tex8Node, t);
  return {
    id: identity.id,
    address: identity.address,
    badge: t('walletSelector.fast'),
    detail: status.label,
    kind: 'fast',
    label: identity.label,
    meta: identity.network,
    tone: fastWalletSelectorTone(status),
  };
}

function balanceDetail(
  snapshot: WalletSnapshot | undefined,
): string | undefined {
  if (!snapshot) {
    return undefined;
  }

  return `${formatAtomicXmr(snapshot.balanceAtomic, {
    maxFractionDigits: 4,
    minFractionDigits: 2,
  })} XMR`;
}

export default function ReceiveScreen({ navigation, route }: any) {
  const [copied, setCopied] = useState(false);
  const [hardwareBusy, setHardwareBusy] = useState(false);
  const [fastWalletBusy, setFastWalletBusy] = useState(false);
  const [hardwareMessage, setHardwareMessage] = useState<string | undefined>();
  const [selectedReceiveWalletId, setSelectedReceiveWalletId] = useState<
    string | undefined
  >();
  const [fastReceiveIdentities, setFastReceiveIdentities] = useState<
    FastReceiveIdentityRecord[]
  >([]);
  const [nodeMode, setNodeMode] = useState<NodeConnectionMode>(
    getActiveNodeConnectionSettings().mode,
  );
  const { t } = useI18n();
  const routeWalletId =
    typeof route?.params?.walletId === 'string'
      ? route.params.walletId
      : undefined;
  const {
    hardwareStatus,
    refreshHardwareWalletStatus,
    reconnectHardwareWallet,
    registeredWallet,
    registeredWallets,
    session,
    setActiveRegisteredWallet,
    showHardwareWalletAddress,
    snapshot,
    status,
    transactions,
    walletSnapshots,
  } = useWalletState();
  const walletSnapshotMap = {
    ...walletSnapshots,
    ...(registeredWallet && snapshot
      ? { [registeredWallet.id]: snapshot }
      : {}),
  };
  const receiveWalletOptions = useMemo<WalletSelectorItem[]>(
    () => [
      ...registeredWallets.filter(wallet => wallet.kind !== 'fast'),
      ...fastReceiveIdentities.map(identity =>
        fastWalletReceiveOption(identity, t, nodeMode === 'optimized-grpc'),
      ),
    ],
    [fastReceiveIdentities, nodeMode, registeredWallets, t],
  );
  const activeReceiveWalletId =
    selectedReceiveWalletId ??
    registeredWallet?.id ??
    fastReceiveIdentities[0]?.id;
  const selectedFastIdentity = fastReceiveIdentities.find(
    identity => identity.id === activeReceiveWalletId,
  );
  const selectedFastStatus = selectedFastIdentity
    ? fastWalletStatusPresentation(
        selectedFastIdentity,
        nodeMode === 'optimized-grpc',
        t,
      )
    : undefined;
  const selectedRegisteredWallet = registeredWallets.find(
    wallet => wallet.id === activeReceiveWalletId,
  );
  const selectedSnapshot =
    activeReceiveWalletId === registeredWallet?.id
      ? snapshot
      : activeReceiveWalletId
      ? walletSnapshotMap[activeReceiveWalletId]
      : undefined;
  const address =
    selectedFastIdentity?.address ?? selectedSnapshot?.primaryAddress ?? '';
  const isHardwareWallet = Boolean(
    !selectedFastIdentity &&
      selectedRegisteredWallet?.kind === 'hardware' &&
      selectedRegisteredWallet.id === registeredWallet?.id &&
      session?.hardwareDevice,
  );
  const hardwareConnected = hardwareStatus?.connected ?? false;
  const activeWalletDetail = selectedFastIdentity
    ? selectedFastStatus?.label
    : selectedRegisteredWallet
    ? balanceDetail(selectedSnapshot) ?? selectedRegisteredWallet.walletName
    : undefined;
  const showsActiveWalletHistory = Boolean(
    session && activeReceiveWalletId === registeredWallet?.id,
  );

  useEffect(() => {
    if (routeWalletId) {
      setSelectedReceiveWalletId(routeWalletId);
    }
  }, [routeWalletId]);

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
          if (mounted) {
            setFastReceiveIdentities(identities);
            setNodeMode(settings.mode);
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
    }, []),
  );

  useEffect(() => {
    if (!isHardwareWallet) {
      return;
    }

    refreshHardwareWalletStatus().catch(() => undefined);
  }, [isHardwareWallet, refreshHardwareWalletStatus]);

  const handleCopy = () => {
    if (!address) {
      return;
    }

    Clipboard.setString(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleSelectWallet = async (wallet: WalletOption) => {
    setSelectedReceiveWalletId(wallet.id);
    setHardwareMessage(undefined);

    if (wallet.kind === 'fast') {
      return;
    }

    const walletId = wallet.id;
    if (walletId === registeredWallet?.id && session) {
      return;
    }

    if (walletId !== registeredWallet?.id) {
      await setActiveRegisteredWallet(walletId);
    }
    navigation.navigate('WalletSetup', {
      mode: 'open',
      openRequestId: Date.now(),
    });
  };

  const handleReconnectHardwareWallet = async () => {
    setHardwareBusy(true);
    setHardwareMessage(undefined);

    try {
      const nextStatus = await reconnectHardwareWallet();
      setHardwareMessage(hardwareStatusText(nextStatus, t));
    } finally {
      setHardwareBusy(false);
    }
  };

  const handleRepairFastWallet = async () => {
    if (!selectedFastIdentity || fastWalletBusy) {
      return;
    }

    setFastWalletBusy(true);
    try {
      const identities =
        await walletService.repairFastReceiveIdentityForActiveNode(
          selectedFastIdentity.id,
        );
      setFastReceiveIdentities(identities);
    } catch {
      const identities =
        await walletService.loadFastReceiveIdentitiesForActiveNode();
      setFastReceiveIdentities(identities);
    } finally {
      setFastWalletBusy(false);
    }
  };

  const handleShowAddressOnDevice = async () => {
    setHardwareBusy(true);
    setHardwareMessage(t('receive.hardwareConfirmAddress'));

    try {
      const nextStatus = await showHardwareWalletAddress(0, 0, '');
      setHardwareMessage(hardwareStatusText(nextStatus, t));
    } finally {
      setHardwareBusy(false);
    }
  };

  return (
    <View style={s.container}>
      <ScrollView contentContainerStyle={s.scroll}>
        <View style={s.header}>
          <View style={s.headerCopy}>
            <Text style={s.title}>{t('receive.title')}</Text>
            <Text style={s.subtitle}>{t('receive.subtitle')}</Text>
          </View>
          <WalletSwitcherPill
            activeWalletId={activeReceiveWalletId}
            detail={activeWalletDetail}
            snapshots={walletSnapshotMap}
            titleKey="walletSelector.receiveTo"
            wallets={receiveWalletOptions}
            onManage={() => navigation.navigate('Wallets')}
            onSelect={handleSelectWallet}
          />
        </View>

        {address ? (
          <View style={s.card}>
            {selectedFastIdentity && selectedFastStatus ? (
              <View
                style={[
                  s.fastStatus,
                  selectedFastStatus.tone === 'success' && s.fastStatusSuccess,
                  selectedFastStatus.tone === 'danger' && s.fastStatusDanger,
                ]}
              >
                <View
                  style={[
                    s.fastStatusDot,
                    selectedFastStatus.tone === 'success' &&
                      s.fastStatusDotSuccess,
                    selectedFastStatus.tone === 'danger' &&
                      s.fastStatusDotDanger,
                    selectedFastStatus.tone === 'muted' && s.fastStatusDotMuted,
                  ]}
                />
                <View style={s.fastStatusCopy}>
                  <Text
                    style={[
                      s.fastStatusTitle,
                      selectedFastStatus.tone === 'success' &&
                        s.fastStatusTitleSuccess,
                      selectedFastStatus.tone === 'danger' &&
                        s.fastStatusTitleDanger,
                    ]}
                  >
                    {selectedFastStatus.label}
                  </Text>
                  <Text style={s.fastStatusText}>
                    {selectedFastStatus.description}
                  </Text>
                </View>
                {selectedFastStatus.canRetry ? (
                  <TouchableOpacity
                    activeOpacity={0.75}
                    disabled={fastWalletBusy}
                    onPress={handleRepairFastWallet}
                    style={s.fastStatusRetry}
                  >
                    {fastWalletBusy ? (
                      <ActivityIndicator color={colors.orange} size="small" />
                    ) : (
                      <Text style={s.fastStatusRetryText}>
                        {t('action.retry')}
                      </Text>
                    )}
                  </TouchableOpacity>
                ) : null}
              </View>
            ) : null}
            {/* QR Code */}
            <View style={s.qrBox}>
              <QrCode value={address} size={200} />
            </View>

            {/* Address */}
            <View style={s.addrBox}>
              <Text style={s.addrLabel}>{t('receive.addressLabel')}</Text>
              <Text style={s.addrText} selectable>
                {address.slice(0, -5)}
                <Text style={{ color: colors.orange }}>
                  {address.slice(-5)}
                </Text>
              </Text>
            </View>

            <View style={s.btnRow}>
              <TouchableOpacity
                style={[
                  s.copyBtn,
                  copied && { backgroundColor: colors.success },
                ]}
                onPress={handleCopy}
              >
                {copied ? (
                  <View
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 6,
                    }}
                  >
                    <Icon
                      name="check"
                      size={16}
                      color="#FFF"
                      strokeWidth={2.5}
                    />
                    <Text style={s.copyBtnText}>{t('action.copied')}</Text>
                  </View>
                ) : (
                  <Text style={s.copyBtnText}>{t('action.copyAddress')}</Text>
                )}
              </TouchableOpacity>
              <TouchableOpacity style={s.shareBtn}>
                <Text style={s.shareBtnText}>{t('action.share')}</Text>
              </TouchableOpacity>
            </View>
            {isHardwareWallet ? (
              <View style={s.hardwareBox}>
                <View style={s.hardwareHeader}>
                  <View style={s.hardwareTitleRow}>
                    <Icon name="wallet" size={17} color={colors.orange} />
                    <Text style={s.hardwareTitle}>
                      {session?.hardwareDevice?.name ?? 'Ledger Nano'}
                    </Text>
                  </View>
                  <View
                    style={[
                      s.hardwarePill,
                      {
                        backgroundColor: hardwareConnected
                          ? 'rgba(0,214,143,0.12)'
                          : 'rgba(255,184,0,0.12)',
                      },
                    ]}
                  >
                    <Text
                      style={[
                        s.hardwarePillText,
                        {
                          color: hardwareConnected
                            ? colors.success
                            : colors.warning,
                        },
                      ]}
                    >
                      {hardwareConnected
                        ? t('receive.connected')
                        : t('receive.checkDevice')}
                    </Text>
                  </View>
                </View>
                <Text style={s.hardwareText}>
                  {hardwareMessage ?? hardwareStatusText(hardwareStatus, t)}
                </Text>
                <View style={s.hardwareActions}>
                  <TouchableOpacity
                    style={[
                      s.hardwarePrimary,
                      hardwareBusy && s.hardwareButtonDisabled,
                    ]}
                    onPress={handleShowAddressOnDevice}
                    disabled={hardwareBusy}
                  >
                    {hardwareBusy ? (
                      <ActivityIndicator color="#FFF" size="small" />
                    ) : (
                      <Text style={s.hardwarePrimaryText}>
                        {t('action.showOnLedger')}
                      </Text>
                    )}
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[
                      s.hardwareSecondary,
                      hardwareBusy && s.hardwareButtonDisabled,
                    ]}
                    onPress={handleReconnectHardwareWallet}
                    disabled={hardwareBusy}
                  >
                    <Text style={s.hardwareSecondaryText}>
                      {t('action.reconnect')}
                    </Text>
                  </TouchableOpacity>
                </View>
              </View>
            ) : null}
          </View>
        ) : (
          <View style={s.card}>
            <View style={s.emptyIcon}>
              <Icon name="lock" size={28} color={colors.orange} />
            </View>
            <Text style={s.emptyTitle}>
              {status === 'locked'
                ? t('receive.walletLocked')
                : t('receive.noWalletOpen')}
            </Text>
            <Text style={s.emptyText}>{t('receive.emptyText')}</Text>
            <TouchableOpacity
              style={s.openButton}
              onPress={() =>
                navigation.navigate('WalletSetup', {
                  mode: 'open',
                  openRequestId: Date.now(),
                })
              }
            >
              <Text style={s.openButtonText}>
                {status === 'locked'
                  ? t('action.openWallet')
                  : t('action.createWallet')}
              </Text>
            </TouchableOpacity>
          </View>
        )}

        <View style={s.transactionsHeader}>
          <Text style={s.transactionsTitle}>
            {t('send.recentTransactions')}
          </Text>
          {showsActiveWalletHistory ? (
            <TouchableOpacity
              accessibilityRole="button"
              activeOpacity={0.7}
              onPress={() => navigation.navigate('Transactions')}
            >
              <Text style={s.transactionsLink}>
                {t('transactions.viewMore')}
              </Text>
            </TouchableOpacity>
          ) : null}
        </View>

        {showsActiveWalletHistory && transactions.length > 0 ? (
          transactions.slice(0, 3).map(transaction => (
            <TransactionRow
              key={transactionRowKey(transaction)}
              transaction={transaction}
              onPress={() =>
                navigation.navigate('TransactionDetail', {
                  transaction,
                  transactionHash: transaction.hash,
                  walletId: registeredWallet?.id,
                  walletName: registeredWallet?.walletName,
                })
              }
            />
          ))
        ) : (
          <View style={s.transactionsEmpty}>
            <Text style={s.transactionsEmptyTitle}>
              {showsActiveWalletHistory
                ? t('home.noTransactions')
                : t('home.walletNotOpen')}
            </Text>
            <Text style={s.transactionsEmptyText}>
              {showsActiveWalletHistory
                ? t('home.noTransactionsText')
                : t('transactions.openWalletToLoad')}
            </Text>
          </View>
        )}

        <View style={s.infoCard}>
          <View style={s.infoTitleRow}>
            <Icon name="lock" size={16} color={colors.textPrimary} />
            <Text style={s.infoTitle}>{t('receive.privacyTitle')}</Text>
          </View>
          <Text style={s.infoText}>{t('receive.privacyText')}</Text>
        </View>
        <View style={s.infoCard}>
          <View style={s.infoTitleRow}>
            <Icon name="lightbulb" size={16} color={colors.textPrimary} />
            <Text style={s.infoTitle}>{t('receive.stealthTitle')}</Text>
          </View>
          <Text style={s.infoText}>{t('receive.stealthText')}</Text>
        </View>
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  scroll: { paddingHorizontal: spacing.lg, paddingTop: 60, paddingBottom: 100 },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 14,
    marginBottom: 26,
  },
  headerCopy: { flex: 1, minWidth: 0 },
  title: { color: colors.textPrimary, fontSize: 28, fontWeight: '700' },
  subtitle: {
    color: colors.textSecondary,
    fontSize: 15,
    marginTop: 4,
    lineHeight: 20,
  },
  card: {
    backgroundColor: colors.bgCard,
    borderRadius: radius.lg,
    padding: spacing.lg,
    alignItems: 'center',
    marginBottom: 24,
    borderWidth: 1,
    borderColor: colors.border,
  },
  fastStatus: {
    width: '100%',
    minHeight: 72,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: 'rgba(255,184,0,0.24)',
    backgroundColor: 'rgba(255,184,0,0.08)',
    padding: 12,
    marginBottom: 18,
  },
  fastStatusSuccess: {
    borderColor: 'rgba(0,214,143,0.24)',
    backgroundColor: 'rgba(0,214,143,0.08)',
  },
  fastStatusDanger: {
    borderColor: 'rgba(255,68,102,0.24)',
    backgroundColor: 'rgba(255,68,102,0.08)',
  },
  fastStatusDot: {
    width: 9,
    height: 9,
    borderRadius: 5,
    backgroundColor: colors.warning,
  },
  fastStatusDotSuccess: { backgroundColor: colors.success },
  fastStatusDotDanger: { backgroundColor: colors.error },
  fastStatusDotMuted: { backgroundColor: colors.textMuted },
  fastStatusCopy: { flex: 1, minWidth: 0 },
  fastStatusTitle: { color: colors.warning, fontSize: 13, fontWeight: '900' },
  fastStatusTitleSuccess: { color: colors.success },
  fastStatusTitleDanger: { color: colors.error },
  fastStatusText: {
    color: colors.textSecondary,
    fontSize: 12,
    lineHeight: 17,
    marginTop: 3,
  },
  fastStatusRetry: {
    minWidth: 74,
    minHeight: 38,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.md,
    backgroundColor: 'rgba(242,104,34,0.12)',
    paddingHorizontal: 10,
  },
  fastStatusRetryText: {
    color: colors.orange,
    fontSize: 11,
    fontWeight: '900',
  },
  qrBox: {
    width: 200,
    height: 200,
    borderRadius: radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 24,
    overflow: 'hidden',
  },
  addrBox: {
    width: '100%',
    backgroundColor: colors.bgInput,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: 20,
    borderWidth: 1,
    borderColor: colors.border,
  },
  addrLabel: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  addrText: {
    color: colors.textPrimary,
    fontSize: 13,
    fontFamily: 'monospace',
    lineHeight: 20,
  },
  btnRow: { flexDirection: 'row', gap: 12, width: '100%' },
  copyBtn: {
    flex: 2,
    paddingVertical: 16,
    alignItems: 'center',
    backgroundColor: colors.orange,
    borderRadius: radius.md,
  },
  copyBtnText: { color: '#FFF', fontSize: 15, fontWeight: '700' },
  shareBtn: {
    flex: 1,
    paddingVertical: 16,
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderLight,
  },
  shareBtnText: {
    color: colors.textSecondary,
    fontSize: 15,
    fontWeight: '600',
  },
  hardwareBox: {
    width: '100%',
    marginTop: 16,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.bgInput,
    borderWidth: 1,
    borderColor: colors.border,
  },
  hardwareHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    marginBottom: 10,
  },
  hardwareTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexShrink: 1,
  },
  hardwareTitle: { color: colors.textPrimary, fontSize: 15, fontWeight: '800' },
  hardwarePill: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: radius.full,
  },
  hardwarePillText: { fontSize: 11, fontWeight: '800' },
  hardwareText: {
    color: colors.textSecondary,
    fontSize: 13,
    lineHeight: 19,
    marginBottom: 12,
  },
  hardwareActions: { flexDirection: 'row', gap: 10 },
  hardwarePrimary: {
    flex: 1.35,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.md,
    backgroundColor: colors.orange,
  },
  hardwareSecondary: {
    flex: 1,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderLight,
    backgroundColor: colors.surface,
  },
  hardwareButtonDisabled: { opacity: 0.62 },
  hardwarePrimaryText: { color: '#FFF', fontSize: 14, fontWeight: '800' },
  hardwareSecondaryText: {
    color: colors.textSecondary,
    fontSize: 14,
    fontWeight: '800',
  },
  emptyIcon: {
    width: 58,
    height: 58,
    borderRadius: 29,
    backgroundColor: colors.orangeMuted,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  emptyTitle: {
    color: colors.textPrimary,
    fontSize: 21,
    fontWeight: '800',
    marginBottom: 8,
  },
  emptyText: {
    color: colors.textSecondary,
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
    marginBottom: 18,
  },
  openButton: {
    paddingVertical: 14,
    paddingHorizontal: 20,
    borderRadius: radius.md,
    backgroundColor: colors.orange,
  },
  openButtonText: { color: '#FFF', fontSize: 15, fontWeight: '800' },
  transactionsHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 2,
    marginBottom: 12,
  },
  transactionsTitle: {
    color: colors.textPrimary,
    fontSize: 17,
    fontWeight: '800',
  },
  transactionsLink: { color: colors.orange, fontSize: 13, fontWeight: '700' },
  transactionsEmpty: {
    backgroundColor: colors.bgCard,
    borderRadius: radius.sm,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: 18,
  },
  transactionsEmptyTitle: {
    color: colors.textPrimary,
    fontSize: 14,
    fontWeight: '800',
    marginBottom: 4,
  },
  transactionsEmptyText: {
    color: colors.textSecondary,
    fontSize: 12,
    lineHeight: 18,
  },
  infoCard: {
    backgroundColor: colors.bgCard,
    borderRadius: radius.md,
    padding: spacing.lg,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: colors.border,
  },
  infoTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  infoTitle: { color: colors.textPrimary, fontSize: 15, fontWeight: '700' },
  infoText: { color: colors.textSecondary, fontSize: 14, lineHeight: 21 },
});
