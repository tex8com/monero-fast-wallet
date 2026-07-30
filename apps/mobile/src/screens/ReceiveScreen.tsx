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
import type { WalletOption } from '../components/WalletSelector';
import { resolveWalletOption } from '../components/WalletSelector';
import { type TranslationKey, useI18n } from '../i18n';
import { useWalletState } from '../services/WalletState';
import {
  isFastWalletRegistration,
  walletDisplayName,
} from '../services/WalletRegistry';
import type {
  HardwareWalletStatus,
  WalletSnapshot,
} from '../services/NativeMoneroWallet';
import { formatAtomicXmr } from '../services/WalletFormat';
import { walletService } from '../services/WalletService';
import {
  createWalletAddressRecord,
  loadWalletAddresses,
  upsertWalletAddress,
  type WalletAddressRecord,
} from '../services/WalletAddressRegistry';

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

function shortAddress(address: string): string {
  return address.length > 18
    ? `${address.slice(0, 9)}…${address.slice(-7)}`
    : address;
}

export default function ReceiveScreen({ navigation, route }: any) {
  const [copied, setCopied] = useState(false);
  const [hardwareBusy, setHardwareBusy] = useState(false);
  const [hardwareMessage, setHardwareMessage] = useState<string | undefined>();
  const [walletAddresses, setWalletAddresses] = useState<WalletAddressRecord[]>(
    [],
  );
  const [selectedAddressId, setSelectedAddressId] = useState<
    string | undefined
  >();
  const [addressBusy, setAddressBusy] = useState(false);
  const [showAddressTools, setShowAddressTools] = useState(false);
  const [showHardwareTools, setShowHardwareTools] = useState(false);
  const [selectedReceiveWalletId, setSelectedReceiveWalletId] = useState<
    string | undefined
  >();
  const { t } = useI18n();
  const routeWalletId =
    typeof route?.params?.walletId === 'string'
      ? route.params.walletId
      : undefined;
  const {
    hardwareStatus,
    isRegisteredWalletOpen,
    refreshHardwareWalletStatus,
    reconnectHardwareWallet,
    registeredWallet,
    registeredWallets,
    refreshSnapshot,
    refreshTransactions,
    session,
    setActiveRegisteredWallet,
    showHardwareWalletAddress,
    snapshot,
    status,
    transactions,
    walletSnapshots,
  } = useWalletState();
  const walletSnapshotMap = useMemo(
    () => ({
      ...walletSnapshots,
      ...(registeredWallet && snapshot
        ? { [registeredWallet.id]: snapshot }
        : {}),
    }),
    [registeredWallet, snapshot, walletSnapshots],
  );
  const receiveWalletOptions = useMemo<WalletOption[]>(
    () =>
      registeredWallets
        .filter(
          wallet =>
            !isFastWalletRegistration(wallet) ||
            wallet.seedBackupStatus === 'verified',
        )
        .map(wallet => resolveWalletOption(wallet, walletSnapshotMap, t)),
    [registeredWallets, t, walletSnapshotMap],
  );
  const activeReceiveWalletId =
    selectedReceiveWalletId ?? registeredWallet?.id;
  const selectedRegisteredWallet = registeredWallets.find(
    wallet => wallet.id === activeReceiveWalletId,
  );
  const selectedFastBackupPending = Boolean(
    selectedRegisteredWallet &&
      isFastWalletRegistration(selectedRegisteredWallet) &&
      selectedRegisteredWallet.seedBackupStatus !== 'verified',
  );
  const selectedAddress =
    walletAddresses.find(item => item.id === selectedAddressId) ??
    walletAddresses[0];
  // The selected address is already presented in full above the QR code. Keep
  // the selector focused on the alternatives so the same address is never
  // rendered twice on this screen.
  const otherWalletAddresses = walletAddresses.filter(
    item => item.id !== selectedAddress?.id,
  );
  const selectedSnapshot =
    activeReceiveWalletId === registeredWallet?.id
      ? snapshot
      : activeReceiveWalletId
        ? walletSnapshotMap[activeReceiveWalletId]
        : undefined;
  const address =
    selectedFastBackupPending
      ? ''
      : (activeReceiveWalletId === registeredWallet?.id
          ? selectedAddress?.address
          : undefined) ??
        selectedSnapshot?.primaryAddress ??
        '';
  const isHardwareWallet = Boolean(
    selectedRegisteredWallet?.kind === 'hardware' &&
    selectedRegisteredWallet.id === registeredWallet?.id &&
    session?.hardwareDevice,
  );
  const hardwareConnected = hardwareStatus?.connected ?? false;
  const activeWalletDetail = selectedRegisteredWallet
    ? (balanceDetail(selectedSnapshot) ??
      walletDisplayName(selectedRegisteredWallet))
    : undefined;
  const showsActiveWalletHistory = Boolean(
    session && activeReceiveWalletId === registeredWallet?.id,
  );

  useEffect(() => {
    if (routeWalletId) {
      setSelectedReceiveWalletId(routeWalletId);
    }
  }, [routeWalletId]);

  useEffect(() => {
    let mounted = true;
    if (
      !session ||
      !registeredWallet ||
      activeReceiveWalletId !== registeredWallet.id
    ) {
      setWalletAddresses([]);
      return () => {
        mounted = false;
      };
    }

    const load = async () => {
      const primaryAddress = await walletService.getAddress(session);
      const primary = createWalletAddressRecord({
        walletId: registeredWallet.id,
        accountIndex: session.accountIndex ?? 0,
        addressIndex: session.addressIndex ?? 0,
        address: primaryAddress,
        label:
          registeredWallet.role === 'fast'
            ? t('receive.ledgerFastWallet')
            : t('receive.primaryAddress'),
      });
      const addresses = await upsertWalletAddress(primary);
      if (!mounted) {
        return;
      }
      setWalletAddresses(addresses);
      setSelectedAddressId(current =>
        current && addresses.some(item => item.id === current)
          ? current
          : primary.id,
      );
    };

    load().catch(() => {
      loadWalletAddresses(registeredWallet.id)
        .then(addresses => {
          if (mounted) {
            setWalletAddresses(addresses);
          }
        })
        .catch(() => undefined);
    });

    return () => {
      mounted = false;
    };
  }, [
    activeReceiveWalletId,
    registeredWallet,
    session,
    t,
  ]);

  useFocusEffect(
    useCallback(() => {
      // WalletState keeps an active wallet fresh in the background. Refresh
      // once when this screen becomes visible as well, so the recent activity
      // section never depends on a manual refresh action.
      refreshSnapshot().catch(() => undefined);
      refreshTransactions().catch(() => undefined);
      return undefined;
    }, [refreshSnapshot, refreshTransactions]),
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
    setSelectedAddressId(undefined);
    setHardwareMessage(undefined);
    setShowAddressTools(false);
    setShowHardwareTools(false);

    const walletId = wallet.id;
    if (isRegisteredWalletOpen(walletId)) {
      if (walletId !== registeredWallet?.id) {
        await setActiveRegisteredWallet(walletId);
      }
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

  const handleShowAddressOnDevice = async () => {
    setHardwareBusy(true);
    setHardwareMessage(t('receive.hardwareConfirmAddress'));

    try {
      const nextStatus = await showHardwareWalletAddress(
        selectedAddress?.accountIndex,
        selectedAddress?.addressIndex,
        '',
      );
      setHardwareMessage(hardwareStatusText(nextStatus, t));
    } finally {
      setHardwareBusy(false);
    }
  };

  const handleCreateAddress = async () => {
    if (!session || !registeredWallet || addressBusy) {
      return;
    }

    setAddressBusy(true);
    try {
      const newAddress = await walletService.createSubaddress(
        session,
        t('receive.newAddressLabel', { count: walletAddresses.length + 1 }),
      );
      const addresses = await loadWalletAddresses(registeredWallet.id);
      setWalletAddresses(addresses);
      setSelectedAddressId(newAddress.id);
    } finally {
      setAddressBusy(false);
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
        </View>

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={s.walletCarousel}
          style={s.walletCarouselScroll}
        >
          {receiveWalletOptions.map(wallet => {
            const active = wallet.id === activeReceiveWalletId;
            return (
              <TouchableOpacity
                key={wallet.id}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                onPress={() => handleSelectWallet(wallet)}
                style={[s.walletCard, active && s.walletCardActive]}
              >
                <View style={s.walletCardTop}>
                  <Text style={s.walletCardTitle} numberOfLines={1}>
                    {wallet.label}
                  </Text>
                  {wallet.badge ? (
                    <Text style={s.fastBadge}>{wallet.badge}</Text>
                  ) : null}
                </View>
                <Text style={s.walletCardDetail} numberOfLines={1}>
                  {wallet.detail ?? activeWalletDetail ?? t('common.wallet')}
                </Text>
              </TouchableOpacity>
            );
          })}
          <TouchableOpacity
            accessibilityRole="button"
            onPress={() => navigation.navigate('Wallets')}
            style={s.manageWalletsCard}
          >
            <Icon name="settings" size={18} color={colors.orange} />
            <Text style={s.manageWalletsText}>
              {t('walletSelector.wallets')}
            </Text>
          </TouchableOpacity>
        </ScrollView>

        {address ? (
          <View style={s.card}>
            <View style={s.qrBox}>
              <QrCode value={address} size={252} />
            </View>

            <View style={s.simpleAddressRow}>
              <Text style={s.simpleAddress} numberOfLines={1}>
                {shortAddress(address)}
              </Text>
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel={t('action.copyAddress')}
                style={[s.copyIconButton, copied && s.copyIconButtonDone]}
                onPress={handleCopy}
              >
                <Icon
                  name={copied ? 'check' : 'copy'}
                  size={18}
                  color={copied ? '#FFF' : colors.orange}
                />
              </TouchableOpacity>
            </View>
            {activeReceiveWalletId === registeredWallet?.id &&
            session ? (
              <View style={s.addressToolsContainer}>
                <TouchableOpacity
                  accessibilityRole="button"
                  onPress={() => setShowAddressTools(value => !value)}
                  style={s.addressToolsToggle}
                >
                  <Text style={s.addressToolsToggleText}>
                    {t('receive.manageAddresses')}
                  </Text>
                  <Icon name="chevron-right" size={18} color={colors.orange} />
                </TouchableOpacity>
                {showAddressTools ? (
                  <View style={s.addressesBox}>
                    <View style={s.addressesHeader}>
                      <Text style={s.addressesTitle}>
                        {t('receive.otherAddresses')}
                      </Text>
                      <TouchableOpacity
                        activeOpacity={0.75}
                        disabled={addressBusy}
                        onPress={handleCreateAddress}
                        style={[
                          s.newAddressButton,
                          addressBusy && s.addressButtonBusy,
                        ]}
                      >
                        {addressBusy ? (
                          <ActivityIndicator
                            color={colors.orange}
                            size="small"
                          />
                        ) : (
                          <Text style={s.newAddressButtonText}>
                            {t('receive.newAddress')}
                          </Text>
                        )}
                      </TouchableOpacity>
                    </View>
                    {otherWalletAddresses.map(item => (
                      <TouchableOpacity
                        activeOpacity={0.75}
                        key={item.id}
                        onPress={() => setSelectedAddressId(item.id)}
                        style={[s.addressRow]}
                      >
                        <View style={s.addressRowCopy}>
                          <Text style={s.addressRowLabel} numberOfLines={1}>
                            {item.label}
                          </Text>
                          <Text style={s.addressRowValue} numberOfLines={1}>
                            {shortAddress(item.address)}
                          </Text>
                        </View>
                        <Text style={s.addressRowIndex}>
                          {item.accountIndex}.{item.addressIndex}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                ) : null}
              </View>
            ) : null}
            {isHardwareWallet ? (
              <View style={s.addressToolsContainer}>
                <TouchableOpacity
                  accessibilityRole="button"
                  onPress={() => setShowHardwareTools(value => !value)}
                  style={s.addressToolsToggle}
                >
                  <Text style={s.addressToolsToggleText}>
                    {session?.hardwareDevice?.name ?? 'Ledger Nano'}
                  </Text>
                  <Icon name="chevron-right" size={18} color={colors.orange} />
                </TouchableOpacity>
                {showHardwareTools ? (
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
            ) : null}
          </View>
        ) : (
          <View style={s.card}>
            <View style={s.emptyIcon}>
              <Icon name="lock" size={28} color={colors.orange} />
            </View>
            <Text style={s.emptyTitle}>
              {selectedFastBackupPending
                ? 'Back up this Fast Wallet first'
                : status === 'locked'
                ? t('receive.walletLocked')
                : t('receive.noWalletOpen')}
            </Text>
            <Text style={s.emptyText}>
              {selectedFastBackupPending
                ? 'Its receive address stays hidden until you confirm that the recovery words are safely backed up.'
                : t('receive.emptyText')}
            </Text>
            <TouchableOpacity
              style={s.openButton}
              onPress={() =>
                selectedFastBackupPending
                  ? navigation.navigate('Wallets')
                  : navigation.navigate('WalletSetup', {
                      mode: 'open',
                      openRequestId: Date.now(),
                    })
              }
            >
              <Text style={s.openButtonText}>
                {selectedFastBackupPending
                  ? 'Back up now'
                  : status === 'locked'
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
                  walletName: registeredWallet
                    ? walletDisplayName(registeredWallet)
                    : undefined,
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
  walletCarouselScroll: { marginBottom: 16 },
  walletCarousel: { gap: 10, paddingRight: spacing.lg },
  walletCard: {
    width: 196,
    minHeight: 76,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgCard,
    padding: 12,
    justifyContent: 'center',
  },
  walletCardActive: {
    borderColor: colors.orange,
    backgroundColor: 'rgba(242,104,34,0.1)',
  },
  walletCardTop: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  walletCardTitle: {
    flex: 1,
    color: colors.textPrimary,
    fontSize: 15,
    fontWeight: '800',
  },
  fastBadge: {
    color: colors.success,
    backgroundColor: 'rgba(0,214,143,0.14)',
    borderRadius: radius.full,
    paddingHorizontal: 7,
    paddingVertical: 3,
    fontSize: 10,
    fontWeight: '900',
  },
  walletCardDetail: { color: colors.textSecondary, fontSize: 12, marginTop: 6 },
  manageWalletsCard: {
    minWidth: 112,
    minHeight: 76,
    paddingHorizontal: 14,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderStyle: 'dashed',
    backgroundColor: colors.bgCard,
  },
  manageWalletsText: { color: colors.orange, fontSize: 12, fontWeight: '800' },
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
  qrBox: {
    width: 252,
    height: 252,
    borderRadius: radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 24,
    overflow: 'hidden',
  },
  simpleAddressRow: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 6,
  },
  simpleAddress: {
    flex: 1,
    color: colors.textSecondary,
    fontFamily: 'monospace',
    fontSize: 13,
  },
  copyIconButton: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.borderLight,
    backgroundColor: colors.surface,
  },
  copyIconButtonDone: {
    backgroundColor: colors.success,
    borderColor: colors.success,
  },
  addressToolsContainer: { width: '100%', marginTop: 12 },
  addressToolsToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 44,
    paddingHorizontal: 4,
  },
  addressToolsToggleText: {
    color: colors.textSecondary,
    fontSize: 13,
    fontWeight: '800',
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
  addressesBox: {
    width: '100%',
    marginTop: 16,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.bgInput,
  },
  addressesHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  addressesTitle: {
    color: colors.textPrimary,
    fontSize: 15,
    fontWeight: '800',
  },
  newAddressButton: {
    minHeight: 34,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 10,
    borderRadius: radius.sm,
    backgroundColor: 'rgba(242,104,34,0.12)',
  },
  newAddressButtonText: {
    color: colors.orange,
    fontSize: 12,
    fontWeight: '800',
  },
  addressButtonBusy: { opacity: 0.62 },
  addressRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 10,
    paddingVertical: 9,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  addressRowCopy: { flex: 1, minWidth: 0 },
  addressRowLabel: {
    color: colors.textPrimary,
    fontSize: 13,
    fontWeight: '700',
  },
  addressRowValue: {
    color: colors.textMuted,
    fontFamily: 'monospace',
    fontSize: 11,
    marginTop: 2,
  },
  addressRowIndex: {
    color: colors.textMuted,
    fontFamily: 'monospace',
    fontSize: 11,
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
