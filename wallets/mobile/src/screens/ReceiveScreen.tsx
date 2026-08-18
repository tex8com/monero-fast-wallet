import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  View,
  Text,
  StyleSheet,
  ScrollView,
  Share,
  TextInput,
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
import { useWalletState } from '../backend/WalletState';
import {
  isFastWalletRegistration,
  ledgerBalanceNeedsVerification,
  walletDisplayName,
} from '../backend/WalletRegistry';
import type {
  HardwareWalletStatus,
  WalletSnapshot,
} from '../backend/NativeMoneroWallet';
import { formatAtomicXmr } from '../backend/WalletFormat';
import { walletService } from '../backend/WalletService';
import {
  loadWalletAddresses,
  type WalletAddressRecord,
} from '../backend/WalletAddressRegistry';
import { transactionsForWalletAddress } from '../backend/WalletAddressActivity';
import { useXmrPrice } from '../data/priceService';
import {
  buildMoneroPaymentUri,
  convertPaymentAmount,
  paymentXmrAmount,
  sanitizePaymentAmountInput,
  type PaymentAmountCurrency,
} from '../backend/PaymentRequest';

function QrCode({ value, size }: { value: string; size: number }) {
  return (
    <View style={[s.qrCode, { width: size, height: size }]}>
      <QRCode
        backgroundColor="#FFF"
        color="#1A1A2E"
        ecl="H"
        quietZone={8}
        size={size}
        value={value}
      />
      <View style={s.qrLogo}>
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

function addressBalanceDetail(
  address: WalletAddressRecord,
  hideBalance: boolean,
): string {
  if (hideBalance || address.balanceAtomic === undefined) {
    return '—';
  }

  return `${formatAtomicXmr(address.balanceAtomic, {
    maxFractionDigits: 6,
    minFractionDigits: 2,
  })} XMR`;
}

export default function ReceiveScreen({ navigation, route }: any) {
  const [copied, setCopied] = useState(false);
  const [paymentLinkCopied, setPaymentLinkCopied] = useState(false);
  const [paymentAmount, setPaymentAmount] = useState('');
  const [paymentAmountCurrency, setPaymentAmountCurrency] =
    useState<PaymentAmountCurrency>('XMR');
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
  const [newAddressLabel, setNewAddressLabel] = useState('');
  const [showHardwareTools, setShowHardwareTools] = useState(false);
  const [selectedReceiveWalletId, setSelectedReceiveWalletId] = useState<
    string | undefined
  >();
  const [openingReceiveWalletId, setOpeningReceiveWalletId] = useState<
    string | undefined
  >();
  const [receiveWalletError, setReceiveWalletError] = useState<
    string | undefined
  >();
  const { t } = useI18n();
  const { price: xmrUsdPrice } = useXmrPrice();
  const routeWalletId =
    typeof route?.params?.walletId === 'string'
      ? route.params.walletId
      : undefined;
  const routeManageAddresses = route?.params?.manageAddresses === true;
  const {
    hardwareStatus,
    isRegisteredWalletOpen,
    openRegisteredWalletById,
    refreshHardwareWalletStatus,
    reconnectHardwareWallet,
    registeredWallet,
    registeredWallets,
    refreshSnapshot,
    refreshTransactions,
    session,
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
  const activeReceiveWalletId = selectedReceiveWalletId ?? registeredWallet?.id;
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
  const selectedSnapshot =
    activeReceiveWalletId === registeredWallet?.id
      ? snapshot
      : activeReceiveWalletId
      ? walletSnapshotMap[activeReceiveWalletId]
      : undefined;
  const address = selectedFastBackupPending
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
    ? balanceDetail(selectedSnapshot) ??
      walletDisplayName(selectedRegisteredWallet)
    : undefined;
  const showsActiveWalletHistory = Boolean(
    session && activeReceiveWalletId === registeredWallet?.id,
  );
  const ledgerBalanceUnverified = Boolean(
    selectedRegisteredWallet &&
      ledgerBalanceNeedsVerification(
        selectedRegisteredWallet,
        selectedSnapshot?.pendingOutputKeyImageCount,
        transactions.length,
      ),
  );
  const receiveAccountIndexesKey = useMemo(() => {
    const accountIndexes = new Set<number>();
    const isLegacyAccountRegistration =
      selectedRegisteredWallet?.kind === 'hardware' &&
      selectedRegisteredWallet.role === 'fast';
    if (isLegacyAccountRegistration) {
      accountIndexes.add(session?.accountIndex ?? 0);
    } else {
      accountIndexes.add(0);
      transactions.forEach(transaction => {
        if (
          Number.isSafeInteger(transaction.subaddrAccount) &&
          transaction.subaddrAccount >= 0
        ) {
          accountIndexes.add(transaction.subaddrAccount);
        }
      });
    }
    return Array.from(accountIndexes)
      .sort((left, right) => left - right)
      .join(',');
  }, [
    selectedRegisteredWallet?.kind,
    selectedRegisteredWallet?.role,
    session?.accountIndex,
    transactions,
  ]);
  const selectedAddressTransactions = useMemo(
    () => transactionsForWalletAddress(transactions, selectedAddress),
    [selectedAddress, transactions],
  );
  const paymentAmountXmr = paymentXmrAmount(
    paymentAmount,
    paymentAmountCurrency,
    xmrUsdPrice,
  );
  const paymentUri = buildMoneroPaymentUri(address, paymentAmountXmr);
  const paymentAmountEquivalent =
    paymentAmountCurrency === 'XMR'
      ? paymentAmountXmr && xmrUsdPrice > 0
        ? `≈ $${(Number(paymentAmountXmr) * xmrUsdPrice).toFixed(2)} USD`
        : undefined
      : paymentAmountXmr
      ? `≈ ${paymentAmountXmr} XMR`
      : undefined;

  useEffect(() => {
    if (routeWalletId) {
      setSelectedReceiveWalletId(routeWalletId);
    }
  }, [routeWalletId]);

  useEffect(() => {
    if (routeManageAddresses) {
      setShowAddressTools(true);
    }
  }, [routeManageAddresses, routeWalletId]);

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
      const accountIndexes = receiveAccountIndexesKey
        .split(',')
        .map(value => Number(value))
        .filter(value => Number.isSafeInteger(value) && value >= 0);
      const addresses = await walletService.listSubaddresses(
        session,
        accountIndexes,
      );
      if (!mounted) {
        return;
      }
      setWalletAddresses(addresses);
      setSelectedAddressId(current =>
        current && addresses.some(item => item.id === current)
          ? current
          : addresses[0]?.id,
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
    receiveAccountIndexesKey,
    registeredWallet,
    session,
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

  const handlePaymentCurrencyChange = (next: PaymentAmountCurrency) => {
    if (next === paymentAmountCurrency) return;
    setPaymentAmount(current =>
      convertPaymentAmount(current, paymentAmountCurrency, next, xmrUsdPrice),
    );
    setPaymentAmountCurrency(next);
  };

  const handleCopyPaymentLink = () => {
    if (!paymentUri) return;
    Clipboard.setString(paymentUri);
    setPaymentLinkCopied(true);
    setTimeout(() => setPaymentLinkCopied(false), 2000);
  };

  const handleSharePaymentLink = async () => {
    if (!paymentUri) return;
    await Share.share({
      message: paymentUri,
      title: t('receive.paymentLink'),
    });
  };

  const handleSelectWallet = async (wallet: WalletOption) => {
    if (openingReceiveWalletId) {
      return;
    }

    const previousWalletId = activeReceiveWalletId;
    const walletId = wallet.id;
    setSelectedReceiveWalletId(walletId);
    setReceiveWalletError(undefined);
    setSelectedAddressId(undefined);
    setHardwareMessage(undefined);
    setShowAddressTools(false);
    setShowHardwareTools(false);

    if (walletId === registeredWallet?.id && isRegisteredWalletOpen(walletId)) {
      return;
    }

    setOpeningReceiveWalletId(walletId);
    try {
      const opened = await openRegisteredWalletById(walletId);
      if (!opened) {
        throw new Error(t('wallets.openFailed'));
      }
      setSelectedReceiveWalletId(walletId);
    } catch (error) {
      setSelectedReceiveWalletId(previousWalletId);
      setReceiveWalletError(
        error instanceof Error ? error.message : t('wallets.openFailed'),
      );
    } finally {
      setOpeningReceiveWalletId(undefined);
    }
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
        newAddressLabel.trim() ||
          t('receive.newAddressLabel', { count: walletAddresses.length + 1 }),
        selectedAddress?.accountIndex,
      );
      const addresses = await walletService.listSubaddresses(
        session,
        receiveAccountIndexesKey
          .split(',')
          .map(value => Number(value))
          .filter(value => Number.isSafeInteger(value) && value >= 0),
      );
      setWalletAddresses(addresses);
      setSelectedAddressId(newAddress.id);
      setNewAddressLabel('');
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
                accessibilityState={{
                  busy: openingReceiveWalletId === wallet.id,
                  selected: active,
                }}
                disabled={Boolean(openingReceiveWalletId)}
                onPress={() => handleSelectWallet(wallet)}
                style={[s.walletCard, active && s.walletCardActive]}
              >
                <View style={s.walletCardTop}>
                  <Text style={s.walletCardTitle} numberOfLines={1}>
                    {wallet.label}
                  </Text>
                  {openingReceiveWalletId === wallet.id ? (
                    <ActivityIndicator color={colors.orange} size="small" />
                  ) : null}
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
        {receiveWalletError ? (
          <Text accessibilityRole="alert" style={s.walletSelectionError}>
            {receiveWalletError}
          </Text>
        ) : null}

        {address ? (
          <View style={s.card}>
            <View style={s.paymentAmountComposer}>
              <View style={s.paymentAmountHeader}>
                <Text style={s.paymentAmountLabel}>
                  {t('receive.amountOptional')}
                </Text>
                <View style={s.currencyToggle}>
                  {(['XMR', 'USD'] as const).map(currency => (
                    <TouchableOpacity
                      accessibilityRole="radio"
                      accessibilityState={{
                        selected: paymentAmountCurrency === currency,
                      }}
                      activeOpacity={0.75}
                      key={currency}
                      onPress={() => handlePaymentCurrencyChange(currency)}
                      style={[
                        s.currencyToggleButton,
                        paymentAmountCurrency === currency &&
                          s.currencyToggleButtonActive,
                      ]}
                    >
                      <Text
                        style={[
                          s.currencyToggleText,
                          paymentAmountCurrency === currency &&
                            s.currencyToggleTextActive,
                        ]}
                      >
                        {currency}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
              <View style={s.paymentAmountInputRow}>
                <TextInput
                  accessibilityLabel={t('receive.amountOptional')}
                  keyboardType="decimal-pad"
                  maxLength={24}
                  onChangeText={value =>
                    setPaymentAmount(
                      sanitizePaymentAmountInput(value, paymentAmountCurrency),
                    )
                  }
                  placeholder="0"
                  placeholderTextColor={colors.textMuted}
                  selectionColor={colors.orange}
                  style={s.paymentAmountInput}
                  value={paymentAmount}
                />
                <Text style={s.paymentAmountUnit}>{paymentAmountCurrency}</Text>
              </View>
              {paymentAmountEquivalent ? (
                <Text style={s.paymentAmountEquivalent}>
                  {paymentAmountEquivalent}
                </Text>
              ) : paymentAmountCurrency === 'USD' && xmrUsdPrice <= 0 ? (
                <Text style={s.paymentAmountUnavailable}>
                  {t('receive.usdRateUnavailable')}
                </Text>
              ) : null}
            </View>
            <View style={s.qrBox}>
              <QrCode value={paymentUri} size={252} />
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
            <View style={s.paymentLinkActions}>
              <TouchableOpacity
                accessibilityRole="button"
                activeOpacity={0.78}
                onPress={handleCopyPaymentLink}
                style={s.paymentLinkSecondary}
              >
                <Icon
                  name={paymentLinkCopied ? 'check' : 'copy'}
                  size={17}
                  color={paymentLinkCopied ? colors.success : colors.orange}
                />
                <Text style={s.paymentLinkSecondaryText} numberOfLines={1}>
                  {paymentLinkCopied
                    ? t('receive.paymentLinkCopied')
                    : t('receive.copyPaymentLink')}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                accessibilityRole="button"
                activeOpacity={0.82}
                onPress={handleSharePaymentLink}
                style={s.paymentLinkPrimary}
              >
                <Icon name="send" size={17} color="#FFF" />
                <Text style={s.paymentLinkPrimaryText} numberOfLines={1}>
                  {t('receive.sharePaymentLink')}
                </Text>
              </TouchableOpacity>
            </View>
            {activeReceiveWalletId === registeredWallet?.id && session ? (
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
                    <TextInput
                      accessibilityLabel={t('receive.newAddressName')}
                      autoCapitalize="words"
                      maxLength={80}
                      onChangeText={setNewAddressLabel}
                      placeholder={t('receive.newAddressPlaceholder')}
                      placeholderTextColor={colors.textMuted}
                      style={s.addressLabelInput}
                      value={newAddressLabel}
                    />
                    <Text style={s.addressPrivacyHint}>
                      {t('receive.subaddressPrivacyHint')}
                    </Text>
                    {walletAddresses.map(item => {
                      const selected = item.id === selectedAddress?.id;
                      return (
                        <TouchableOpacity
                          accessibilityRole="radio"
                          accessibilityState={{ selected }}
                          activeOpacity={0.75}
                          key={item.id}
                          onPress={() => setSelectedAddressId(item.id)}
                          style={[
                            s.addressRow,
                            selected && s.addressRowSelected,
                          ]}
                        >
                          <View style={s.addressRowCopy}>
                            <Text style={s.addressRowLabel} numberOfLines={1}>
                              {item.label}
                            </Text>
                            <Text style={s.addressRowValue} numberOfLines={1}>
                              {shortAddress(item.address)}
                            </Text>
                          </View>
                          <View style={s.addressRowBalanceGroup}>
                            <Text style={s.addressRowBalance} numberOfLines={1}>
                              {addressBalanceDetail(
                                item,
                                ledgerBalanceUnverified,
                              )}
                            </Text>
                            {selected ? (
                              <Icon
                                name="check"
                                size={16}
                                color={colors.orange}
                              />
                            ) : null}
                          </View>
                        </TouchableOpacity>
                      );
                    })}
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
                          hardwareConnected
                            ? s.hardwarePillConnected
                            : s.hardwarePillDisconnected,
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
                ? t('receive.backupFastWalletFirst')
                : status === 'locked'
                ? t('receive.walletLocked')
                : t('receive.noWalletOpen')}
            </Text>
            <Text style={s.emptyText}>
              {selectedFastBackupPending
                ? t('receive.backupFastWalletText')
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
                  ? t('receive.backupNow')
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
              onPress={() =>
                navigation.navigate('Transactions', {
                  addressFilter: selectedAddress
                    ? {
                        accountIndex: selectedAddress.accountIndex,
                        addressIndex: selectedAddress.addressIndex,
                        label: selectedAddress.label,
                      }
                    : undefined,
                })
              }
            >
              <Text style={s.transactionsLink}>
                {t('transactions.viewMore')}
              </Text>
            </TouchableOpacity>
          ) : null}
        </View>

        {showsActiveWalletHistory && selectedAddressTransactions.length > 0 ? (
          selectedAddressTransactions.slice(0, 3).map(transaction => (
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
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  scroll: { paddingHorizontal: spacing.lg, paddingTop: 12, paddingBottom: 100 },
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
  walletSelectionError: {
    color: colors.error,
    fontSize: 12,
    lineHeight: 17,
    marginBottom: 16,
  },
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
  paymentAmountComposer: {
    marginBottom: 18,
    width: '100%',
  },
  paymentAmountHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  paymentAmountLabel: {
    color: colors.textSecondary,
    fontSize: 13,
    fontWeight: '800',
  },
  currencyToggle: {
    backgroundColor: colors.bg,
    borderColor: colors.border,
    borderRadius: radius.full,
    borderWidth: 1,
    flexDirection: 'row',
    padding: 3,
  },
  currencyToggleButton: {
    alignItems: 'center',
    borderRadius: radius.full,
    justifyContent: 'center',
    minHeight: 30,
    paddingHorizontal: 13,
  },
  currencyToggleButtonActive: { backgroundColor: colors.orange },
  currencyToggleText: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '900',
  },
  currencyToggleTextActive: { color: '#FFF' },
  paymentAmountInputRow: {
    alignItems: 'center',
    backgroundColor: colors.bgInput,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: 1,
    flexDirection: 'row',
    minHeight: 58,
    paddingHorizontal: 14,
  },
  paymentAmountInput: {
    color: colors.textPrimary,
    flex: 1,
    fontSize: 24,
    fontWeight: '700',
    paddingVertical: 10,
  },
  paymentAmountUnit: {
    color: colors.orange,
    fontSize: 13,
    fontWeight: '900',
  },
  paymentAmountEquivalent: {
    color: colors.textSecondary,
    fontSize: 12,
    marginTop: 7,
    paddingHorizontal: 2,
  },
  paymentAmountUnavailable: {
    color: colors.warning,
    fontSize: 12,
    marginTop: 7,
    paddingHorizontal: 2,
  },
  qrCode: {
    backgroundColor: '#FFF',
    borderRadius: radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  qrLogo: {
    position: 'absolute',
    backgroundColor: '#FFF',
    borderRadius: 8,
    padding: 4,
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
  paymentLinkActions: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 10,
    width: '100%',
  },
  paymentLinkSecondary: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderColor: colors.borderLight,
    borderRadius: radius.md,
    borderWidth: 1,
    flex: 1,
    flexDirection: 'row',
    gap: 7,
    justifyContent: 'center',
    minHeight: 46,
    paddingHorizontal: 10,
  },
  paymentLinkSecondaryText: {
    color: colors.textSecondary,
    flexShrink: 1,
    fontSize: 12,
    fontWeight: '800',
  },
  paymentLinkPrimary: {
    alignItems: 'center',
    backgroundColor: colors.orange,
    borderRadius: radius.md,
    flex: 1.25,
    flexDirection: 'row',
    gap: 7,
    justifyContent: 'center',
    minHeight: 46,
    paddingHorizontal: 10,
  },
  paymentLinkPrimaryText: {
    color: '#FFF',
    flexShrink: 1,
    fontSize: 12,
    fontWeight: '900',
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
  addressLabelInput: {
    minHeight: 44,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bg,
    color: colors.textPrimary,
    fontSize: 14,
    marginBottom: 7,
    paddingHorizontal: 12,
  },
  addressPrivacyHint: {
    color: colors.textMuted,
    fontSize: 11,
    lineHeight: 16,
    marginBottom: 10,
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
  addressRowSelected: {
    backgroundColor: 'rgba(242,104,34,0.08)',
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
  addressRowBalanceGroup: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 7,
    justifyContent: 'flex-end',
    minWidth: 92,
  },
  addressRowBalance: {
    color: colors.textSecondary,
    fontSize: 11,
    fontWeight: '800',
    textAlign: 'right',
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
  hardwarePillConnected: { backgroundColor: 'rgba(0,214,143,0.12)' },
  hardwarePillDisconnected: { backgroundColor: 'rgba(255,184,0,0.12)' },
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
});
