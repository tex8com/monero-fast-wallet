import React, { useCallback, useMemo, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import Clipboard from '@react-native-clipboard/clipboard';
import LinearGradient from 'react-native-linear-gradient';
import { colors, radius, spacing } from '../theme/colors';
import { Icon } from '../components/Icon';
import RecipientQrScanner from '../components/RecipientQrScanner';
import SyncStatusBar from '../components/SyncStatusBar';
import TransactionRow, {
  transactionRowKey,
} from '../components/TransactionRow';
import {
  type WalletOption,
  type WalletSelectorItem,
} from '../components/WalletSelector';
import WalletSwitcherPill from '../components/WalletSwitcherPill';
import { useXmrPrice } from '../data/priceService';
import { useI18n } from '../i18n';
import type {
  PreparedTransaction,
  TransactionPriority,
} from '../services/NativeMoneroWallet';
import {
  atomicXmrToNumber,
  formatAtomicXmr,
  parseXmrToAtomic,
  toAtomicBigInt,
} from '../services/WalletFormat';
import { useWalletState } from '../services/WalletState';
import {
  isFastWalletRegistration,
  walletDisplayName,
} from '../services/WalletRegistry';
import { walletService, type WalletSession } from '../services/WalletService';
import {
  loadRecentRecipients,
  loadRecipientContacts,
  rememberRecipient,
  type RecipientContact,
} from '../services/RecipientAddressBook';

type Step = 'recipient-choice' | 'manual-recipient' | 'amount' | 'confirm';

function shortAddress(value: string, fallback: string) {
  if (!value) {
    return fallback;
  }
  if (value.length <= 18) {
    return value;
  }
  return `${value.slice(0, 8)}...${value.slice(-6)}`;
}

export default function SendScreen({ navigation }: any) {
  const [address, setAddress] = useState('');
  const [amount, setAmount] = useState('');
  const [step, setStep] = useState<Step>('recipient-choice');
  // Keep the straightforward default. Advanced fee selection belongs in a
  // future optional details sheet, not in the primary send journey.
  const priority: TransactionPriority = 'low';
  const [sendError, setSendError] = useState<string | undefined>();
  const [sendStatus, setSendStatus] = useState<string | undefined>();
  const [preparedTx, setPreparedTx] = useState<
    PreparedTransaction | undefined
  >();
  const [preparedSession, setPreparedSession] = useState<
    WalletSession | undefined
  >();
  const [sending, setSending] = useState(false);
  const [scannerVisible, setScannerVisible] = useState(false);
  const [sweepAll, setSweepAll] = useState(false);
  const [recipientContacts, setRecipientContacts] = useState<
    RecipientContact[]
  >([]);
  const [recentRecipients, setRecentRecipients] = useState<RecipientContact[]>(
    [],
  );
  const { t } = useI18n();
  const { price } = useXmrPrice();
  const {
    error: walletError,
    connectLedgerForSigning,
    isRegisteredWalletOpen,
    refreshSnapshot,
    refreshTransactions,
    registeredWallet,
    registeredWallets,
    session,
    setActiveRegisteredWallet,
    snapshot,
    status,
    syncProgress,
    syncStartHeight,
    transactions,
    walletSnapshots,
  } = useWalletState();

  const unlockedAtomic = toAtomicBigInt(snapshot?.unlockedBalanceAtomic);
  const amountAtomic = parseXmrToAtomic(amount);
  const hasAmount = amountAtomic !== undefined && amountAtomic > 0n;
  const amountNumber = hasAmount ? atomicXmrToNumber(amountAtomic) : 0;
  const amountAvailable =
    amountAtomic !== undefined &&
    amountAtomic > 0n &&
    amountAtomic <= unlockedAtomic;
  const usd =
    hasAmount && price > 0 ? (amountNumber * price).toFixed(2) : '0.00';
  const sendEnabled =
    Boolean(snapshot?.synchronized && session) &&
    address.trim().length > 0 &&
    (sweepAll ? unlockedAtomic > 0n : amountAvailable);
  const availableXmr = snapshot
    ? formatAtomicXmr(snapshot.unlockedBalanceAtomic, {
        maxFractionDigits: 4,
        minFractionDigits: 2,
      })
    : status === 'locked'
      ? t('status.locked')
      : '0.00';
  const preparedFee = preparedTx
    ? formatAtomicXmr(preparedTx.feeAtomic, { maxFractionDigits: 12 })
    : undefined;
  const preparedAmountAtomic = preparedTx
    ? toAtomicBigInt(preparedTx.amountAtomic)
    : amountAtomic;
  const reviewAmount = preparedTx
    ? formatAtomicXmr(preparedTx.amountAtomic, {
        maxFractionDigits: 12,
        minFractionDigits: 2,
      })
    : amount || '0';
  const totalXmr =
    preparedAmountAtomic !== undefined && preparedTx
      ? formatAtomicXmr(
          preparedAmountAtomic + toAtomicBigInt(preparedTx.feeAtomic),
          {
            maxFractionDigits: 12,
          },
        )
      : amount || '0';
  const walletSnapshotMap = useMemo(
    () => ({
      ...walletSnapshots,
      ...(registeredWallet && snapshot
        ? { [registeredWallet.id]: snapshot }
        : {}),
    }),
    [registeredWallet, snapshot, walletSnapshots],
  );
  const sendWalletOptions = useMemo<WalletSelectorItem[]>(
    () =>
      registeredWallets
        .filter(wallet => !isFastWalletRegistration(wallet))
        .filter(wallet => {
          const candidate = walletSnapshotMap[wallet.id];
          return (
            candidate && toAtomicBigInt(candidate.unlockedBalanceAtomic) > 0n
          );
        }),
    [registeredWallets, walletSnapshotMap],
  );

  useFocusEffect(
    useCallback(() => {
      let mounted = true;
      Promise.all([loadRecipientContacts(), loadRecentRecipients()])
        .then(([contacts, recent]) => {
          if (mounted) {
            setRecipientContacts(contacts);
            setRecentRecipients(recent);
          }
        })
        .catch(() => undefined);

      // Recent transactions are refreshed by WalletState while a wallet is
      // open. Doing an immediate refresh on focus avoids stale activity after
      // switching tabs without exposing a separate manual refresh button.
      refreshSnapshot().catch(() => undefined);
      refreshTransactions().catch(() => undefined);

      return () => {
        mounted = false;
      };
    }, [refreshSnapshot, refreshTransactions]),
  );

  const clearPreparedTransaction = () => {
    setPreparedTx(undefined);
    setPreparedSession(undefined);
    setSendStatus(undefined);
  };

  const enterAmountKey = (key: string) => {
    let next = amount;
    if (key === 'backspace') {
      next = amount.slice(0, -1);
    } else if (key === '.') {
      if (amount.includes('.')) {
        return;
      }
      next = amount ? `${amount}.` : '0.';
    } else if (amount === '0') {
      next = key;
    } else {
      next = `${amount}${key}`;
    }
    const [, fraction = ''] = next.split('.');
    if (fraction.length > 12 || next.length > 24) {
      return;
    }
    setAmount(next);
    setSweepAll(false);
    setSendError(undefined);
    clearPreparedTransaction();
  };

  const selectWallet = async (wallet: WalletOption) => {
    if (wallet.disabled) {
      return;
    }

    const walletId = wallet.id;
    if (isRegisteredWalletOpen(walletId)) {
      if (walletId !== registeredWallet?.id) {
        await setActiveRegisteredWallet(walletId);
      }
      return;
    }

    clearPreparedTransaction();
    setAmount('');
    setSweepAll(false);
    let selectedWallet = registeredWallet;
    const changedWallet = walletId !== registeredWallet?.id;
    if (changedWallet) {
      selectedWallet = await setActiveRegisteredWallet(walletId);
    }
    if (changedWallet && selectedWallet?.credentialKey) {
      return;
    }
    navigation.navigate('WalletSetup', {
      mode: 'open',
      openRequestId: Date.now(),
    });
  };

  const prepareForReview = async () => {
    if (!session) {
      setSendError(t('send.openWalletBeforeSending'));
      return;
    }
    if (!snapshot?.synchronized) {
      setSendError(t('send.waitForSync'));
      return;
    }
    if (
      (!sweepAll && (amountAtomic === undefined || amountAtomic <= 0n)) ||
      (sweepAll && unlockedAtomic <= 0n)
    ) {
      setSendError(t('send.enterValidAmount'));
      return;
    }
    if (!address.trim()) {
      setSendError(t('send.noRecipient'));
      return;
    }
    if (!sweepAll && !amountAvailable) {
      setSendError(t('send.amountAboveBalance'));
      return;
    }
    if (preparedTx) {
      setStep('confirm');
      return;
    }

    setSending(true);
    setSendError(undefined);
    try {
      const signingSession = session.readOnly
        ? await connectLedgerForSigning()
        : session;
      if (!signingSession) {
        throw new Error(t('send.openWalletBeforeSending'));
      }
      const nextTransaction = await walletService.prepareTransaction(
        signingSession,
        {
          address: address.trim(),
          amountAtomic: sweepAll ? undefined : amountAtomic?.toString(),
          priority,
          sweepAll,
        },
      );
      if (nextTransaction.status !== 'ok' || !nextTransaction.id) {
        throw new Error(
          nextTransaction.error || t('send.transactionPreparationFailed'),
        );
      }
      setPreparedTx(nextTransaction);
      setPreparedSession(signingSession);
      setSendStatus(undefined);
      if (sweepAll) {
        setAmount(
          formatAtomicXmr(nextTransaction.amountAtomic, {
            maxFractionDigits: 12,
          }),
        );
      }
      setStep('confirm');
    } catch (error) {
      setSendError(error instanceof Error ? error.message : String(error));
    } finally {
      setSending(false);
    }
  };

  const handleSend = async () => {
    const transactionSession = preparedSession ?? session;
    if (!transactionSession || !preparedTx) {
      setSendError(t('send.transactionPreparationFailed'));
      return;
    }

    setSending(true);
    setSendError(undefined);
    try {
      const committed = await walletService.commitTransaction(
        transactionSession,
        preparedTx.id,
      );
      if (committed.status !== 'ok') {
        throw new Error(
          committed.error || t('send.transactionBroadcastFailed'),
        );
      }

      setAddress('');
      setAmount('');
      setPreparedTx(undefined);
      setPreparedSession(undefined);
      setSweepAll(false);
      setSendStatus(t('send.transactionBroadcast'));
      setStep('recipient-choice');
      setRecentRecipients(
        await rememberRecipient(address.trim(), recipientContacts),
      );
      await Promise.all([refreshSnapshot(), refreshTransactions()]);
    } catch (error) {
      setSendError(error instanceof Error ? error.message : String(error));
    } finally {
      setSending(false);
    }
  };

  if (step === 'confirm') {
    return (
      <View style={s.container}>
        <StatusBar barStyle="light-content" backgroundColor={colors.bg} />
        <ScrollView
          contentContainerStyle={s.confirmScroll}
          showsVerticalScrollIndicator={false}
        >
          <TouchableOpacity
            style={s.backButton}
            onPress={() => setStep('amount')}
            activeOpacity={0.7}
          >
            <Icon name="arrow-left" size={20} color={colors.textSecondary} />
            <Text style={s.backText}>{t('action.back')}</Text>
          </TouchableOpacity>

          <Text style={s.title}>{t('send.reviewPayment')}</Text>
          <Text style={s.subtitle}>{t('send.confirmDetails')}</Text>

          <View style={s.confirmAmountCard}>
            <Text style={s.confirmAmount}>{reviewAmount} XMR</Text>
            <Text style={s.confirmUsd}>≈ ${usd} USD</Text>
          </View>

          <View style={s.card}>
            <ReviewRow
              label={t('send.recipient')}
              value={shortAddress(address, t('send.noRecipient'))}
              mono
            />
            <Divider />
            <ReviewRow
              label={t('send.networkFee')}
              value={
                preparedFee ? `${preparedFee} XMR` : t('send.preparedNext')
              }
            />
            <Divider />
            <ReviewRow
              label={t('send.privacy')}
              value={t('send.stealthAddress')}
            />
            <Divider />
            <ReviewRow
              label={t('send.total')}
              value={`${totalXmr} XMR`}
              strong
            />
          </View>

          <View style={s.privacyBox}>
            <Icon name="lock" size={17} color={colors.orange} />
            <Text style={s.privacyText}>{t('send.privacyDetails')}</Text>
          </View>

          {sendError ? <Text style={s.errorText}>{sendError}</Text> : null}

          <TouchableOpacity
            accessibilityLabel={t('action.sendNow')}
            accessibilityRole="button"
            onPress={handleSend}
            activeOpacity={0.86}
            disabled={sending}
          >
            <LinearGradient
              colors={[colors.orange, colors.orangeDark]}
              style={[s.primaryBtn, sending && s.primaryBtnDisabled]}
            >
              <Icon name="send" size={20} color="#FFF" strokeWidth={2} />
              <Text style={s.primaryBtnText}>
                {sending ? t('action.working') : t('action.sendNow')}
              </Text>
            </LinearGradient>
          </TouchableOpacity>
        </ScrollView>
      </View>
    );
  }

  if (step === 'recipient-choice' || step === 'manual-recipient') {
    const continueWithRecipient = () => {
      if (!address.trim()) {
        setSendError(t('send.noRecipient'));
        return;
      }
      setSendError(undefined);
      setStep('amount');
    };

    return (
      <KeyboardAvoidingView
        style={s.container}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <StatusBar barStyle="light-content" backgroundColor={colors.bg} />
        <ScrollView
          contentContainerStyle={s.scroll}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <Text style={s.title}>{t('send.title')}</Text>
          <Text style={s.subtitle}>{t('send.subtitle')}</Text>

          {step === 'recipient-choice' ? (
            <View style={s.choiceStack}>
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel={t('send.scanAddress')}
                activeOpacity={0.82}
                onPress={() => setScannerVisible(true)}
                style={[s.choiceCard, s.choiceCardPrimary]}
              >
                <View style={s.choiceIconPrimary}>
                  <Icon name="qr-scan" size={34} color="#FFF" />
                </View>
                <View style={s.choiceCopy}>
                  <Text style={s.choiceTitle}>{t('send.scanAddress')}</Text>
                  <Text style={s.choiceText}>{t('send.scanAddressHint')}</Text>
                </View>
                <Icon name="chevron-right" size={22} color="#FFF" />
              </TouchableOpacity>

              <View style={s.orRow}>
                <View style={s.orLine} />
                <Text style={s.orText}>{t('send.or')}</Text>
                <View style={s.orLine} />
              </View>

              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel={t('send.manualRecipient')}
                activeOpacity={0.78}
                onPress={() => setStep('manual-recipient')}
                style={s.choiceCard}
              >
                <View style={s.choiceIcon}>
                  <Icon name="edit" size={28} color={colors.orange} />
                </View>
                <View style={s.choiceCopy}>
                  <Text style={[s.choiceTitle, s.choiceTitleDark]}>
                    {t('send.manualRecipient')}
                  </Text>
                  <Text style={s.choiceText}>
                    {t('send.manualRecipientHint')}
                  </Text>
                </View>
                <Icon name="chevron-right" size={22} color={colors.orange} />
              </TouchableOpacity>
            </View>
          ) : (
            <View style={s.manualCard}>
              <TouchableOpacity
                style={s.backButton}
                accessibilityRole="button"
                onPress={() => {
                  setSendError(undefined);
                  setStep('recipient-choice');
                }}
              >
                <Icon
                  name="arrow-left"
                  size={20}
                  color={colors.textSecondary}
                />
                <Text style={s.backText}>{t('action.back')}</Text>
              </TouchableOpacity>
              <Text style={s.fieldLabel}>{t('send.recipient')}</Text>
              <View style={s.addressInputRow}>
                <TextInput
                  style={s.addressInput}
                  placeholder={t('send.pasteAddress')}
                  placeholderTextColor={colors.textMuted}
                  value={address}
                  onChangeText={value => {
                    setAddress(value);
                    setSendError(undefined);
                    clearPreparedTransaction();
                  }}
                  autoCapitalize="none"
                  autoCorrect={false}
                  multiline
                />
                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityLabel={t('action.paste')}
                  style={s.pasteButton}
                  onPress={() => {
                    Clipboard.getString()
                      .then(value => {
                        if (value.trim()) {
                          setAddress(value.trim());
                          setSendError(undefined);
                          clearPreparedTransaction();
                        }
                      })
                      .catch(() => undefined);
                  }}
                >
                  <Text style={s.pasteButtonText}>{t('action.paste')}</Text>
                </TouchableOpacity>
              </View>

              {recipientContacts.length > 0 || recentRecipients.length > 0 ? (
                <View style={s.contactsCompact}>
                  {recipientContacts.length > 0 ? (
                    <>
                      <Text style={s.fieldLabel}>{t('send.addressBook')}</Text>
                      <View style={s.contactRow}>
                        {recipientContacts.slice(0, 3).map(contact => (
                          <TouchableOpacity
                            key={contact.id}
                            style={[
                              s.contactChip,
                              contact.donor && s.donorChip,
                            ]}
                            onPress={() => {
                              setAddress(contact.address);
                              setSendError(undefined);
                            }}
                          >
                            <Text style={s.contactName}>{contact.label}</Text>
                            <Text style={s.contactAddress} numberOfLines={1}>
                              {shortAddress(contact.address, contact.address)}
                            </Text>
                          </TouchableOpacity>
                        ))}
                      </View>
                    </>
                  ) : null}
                  {recentRecipients.length > 0 ? (
                    <>
                      <Text style={[s.fieldLabel, s.recentLabel]}>
                        {t('send.recentContacts')}
                      </Text>
                      <View style={s.contactRow}>
                        {recentRecipients.slice(0, 3).map(contact => (
                          <TouchableOpacity
                            key={contact.id}
                            style={s.contactChip}
                            onPress={() => {
                              setAddress(contact.address);
                              setSendError(undefined);
                            }}
                          >
                            <Text style={s.contactName}>{contact.label}</Text>
                            <Text style={s.contactAddress} numberOfLines={1}>
                              {shortAddress(contact.address, contact.address)}
                            </Text>
                          </TouchableOpacity>
                        ))}
                      </View>
                    </>
                  ) : null}
                </View>
              ) : null}
              {sendError ? <Text style={s.errorText}>{sendError}</Text> : null}
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel={t('action.continue')}
                onPress={continueWithRecipient}
                style={s.formCta}
              >
                <LinearGradient
                  colors={[colors.orange, colors.orangeDark]}
                  style={s.primaryBtn}
                >
                  <Text style={s.primaryBtnText}>{t('action.continue')}</Text>
                </LinearGradient>
              </TouchableOpacity>
            </View>
          )}
        </ScrollView>
        <RecipientQrScanner
          visible={scannerVisible}
          onClose={() => setScannerVisible(false)}
          onScanned={scannedAddress => {
            setAddress(scannedAddress);
            setSendError(undefined);
            clearPreparedTransaction();
            setScannerVisible(false);
            setStep('amount');
          }}
        />
      </KeyboardAvoidingView>
    );
  }

  return (
    <KeyboardAvoidingView
      style={s.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <StatusBar barStyle="light-content" backgroundColor={colors.bg} />
      <ScrollView
        contentContainerStyle={s.scroll}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={s.header}>
          <View style={s.headerCopy}>
            <Text style={s.title}>{t('send.title')}</Text>
            <Text style={s.subtitle}>{t('send.subtitle')}</Text>
          </View>
          <WalletSwitcherPill
            activeWalletId={registeredWallet?.id}
            detail={snapshot ? `${availableXmr} XMR` : availableXmr}
            snapshots={walletSnapshotMap}
            titleKey="walletSelector.sendFrom"
            wallets={sendWalletOptions}
            onManage={() => navigation.navigate('Wallets')}
            onSelect={selectWallet}
          />
        </View>

        {registeredWallet ? (
          <SyncStatusBar
            compact
            error={walletError}
            progress={syncProgress}
            snapshot={snapshot}
            syncStartHeight={syncStartHeight}
            status={status}
            subtitle={
              snapshot && !snapshot.synchronized
                ? t('sync.sendBalanceNotice')
                : undefined
            }
            walletName={walletDisplayName(registeredWallet)}
          />
        ) : null}

        <View style={s.recipientSummaryCard}>
          <View>
            <Text style={s.fieldLabel}>{t('send.recipient')}</Text>
            <Text style={s.recipientSummaryAddress} numberOfLines={1}>
              {shortAddress(address, t('send.noRecipient'))}
            </Text>
          </View>
          <TouchableOpacity
            accessibilityRole="button"
            onPress={() => setStep('manual-recipient')}
          >
            <Text style={s.changeRecipient}>{t('action.change')}</Text>
          </TouchableOpacity>
        </View>

        <View style={s.amountCard}>
          <View style={s.cardHeader}>
            <Text style={s.fieldLabel}>{t('send.amount')}</Text>
            <TouchableOpacity
              accessibilityLabel={t('send.all')}
              accessibilityRole="button"
              onPress={() => {
                setAmount('');
                setSweepAll(true);
                setSendError(undefined);
                clearPreparedTransaction();
              }}
            >
              <Text style={s.maxText}>{t('send.all')}</Text>
            </TouchableOpacity>
          </View>
          <Text style={s.amountInput}>{amount || '0.0000'}</Text>
          <Text style={s.xmrLabel}>XMR</Text>
          <Text style={s.usdLabel}>≈ ${usd} USD</Text>

          <View style={s.keypad}>
            {[
              '1',
              '2',
              '3',
              '4',
              '5',
              '6',
              '7',
              '8',
              '.',
              '9',
              '0',
              'backspace',
            ].map(key => (
              <TouchableOpacity
                key={key}
                accessibilityRole="button"
                accessibilityLabel={key === 'backspace' ? 'Delete' : key}
                style={s.keypadKey}
                onPress={() => enterAmountKey(key)}
                activeOpacity={0.72}
              >
                <Text style={s.keypadKeyText}>
                  {key === 'backspace' ? '⌫' : key}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {sendStatus ? <Text style={s.statusText}>{sendStatus}</Text> : null}
        {sendError ? <Text style={s.errorText}>{sendError}</Text> : null}
        {!snapshot ? (
          <Text style={s.errorText}>{t('send.openWalletBeforePreparing')}</Text>
        ) : !snapshot.synchronized ? (
          <Text style={s.errorText}>{t('send.waitForSync')}</Text>
        ) : hasAmount && !amountAvailable ? (
          <Text style={s.errorText}>{t('send.amountAboveBalance')}</Text>
        ) : null}

        <TouchableOpacity
          accessibilityLabel={t('send.sendXmr')}
          accessibilityRole="button"
          disabled={!sendEnabled || sending}
          onPress={prepareForReview}
          activeOpacity={0.86}
          style={s.formCta}
        >
          <LinearGradient
            colors={
              sendEnabled && !sending
                ? [colors.orange, colors.orangeDark]
                : [colors.surface, colors.surface]
            }
            style={[
              s.primaryBtn,
              (!sendEnabled || sending) && s.primaryBtnDisabled,
            ]}
          >
            <Icon name="send" size={20} color="#FFF" strokeWidth={2} />
            <Text style={s.primaryBtnText}>
              {sending ? t('action.working') : t('send.sendXmr')}
            </Text>
          </LinearGradient>
        </TouchableOpacity>

        <View style={s.sectionHeaderRecent}>
          <Text style={s.sectionTitle}>{t('send.recentTransactions')}</Text>
          <TouchableOpacity
            accessibilityRole="button"
            activeOpacity={0.7}
            onPress={() => navigation.navigate('Transactions')}
          >
            <Text style={s.viewMore}>{t('transactions.viewMore')}</Text>
          </TouchableOpacity>
        </View>

        {transactions.length > 0 ? (
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
          <View style={s.emptyTxCard}>
            <Text style={s.emptyTxTitle}>{t('send.noRecent')}</Text>
            <Text style={s.emptyTxText}>{t('send.noRecentText')}</Text>
          </View>
        )}
      </ScrollView>
      <RecipientQrScanner
        visible={scannerVisible}
        onClose={() => setScannerVisible(false)}
        onScanned={scannedAddress => {
          setAddress(scannedAddress);
          setSendError(undefined);
          clearPreparedTransaction();
          setScannerVisible(false);
        }}
      />
    </KeyboardAvoidingView>
  );
}

function ReviewRow({
  label,
  value,
  strong,
  mono,
}: {
  label: string;
  value: string;
  strong?: boolean;
  mono?: boolean;
}) {
  return (
    <View style={s.reviewRow}>
      <Text style={s.reviewLabel}>{label}</Text>
      <Text
        style={[
          s.reviewValue,
          strong && s.reviewValueStrong,
          mono && s.reviewValueMono,
        ]}
        numberOfLines={1}
      >
        {value}
      </Text>
    </View>
  );
}

function Divider() {
  return <View style={s.divider} />;
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  scroll: { paddingHorizontal: spacing.lg, paddingTop: 56, paddingBottom: 132 },
  confirmScroll: {
    paddingHorizontal: spacing.lg,
    paddingTop: 60,
    paddingBottom: 120,
  },

  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 24,
    gap: 14,
  },
  headerCopy: { flex: 1, minWidth: 0 },
  title: {
    color: colors.textPrimary,
    fontSize: 30,
    fontWeight: '800',
    letterSpacing: 0,
  },
  subtitle: {
    color: colors.textSecondary,
    fontSize: 14,
    marginTop: 5,
    lineHeight: 20,
  },
  choiceStack: { marginTop: 34, gap: 16 },
  choiceCard: {
    minHeight: 116,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgCard,
    padding: spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  choiceCardPrimary: {
    backgroundColor: colors.orange,
    borderColor: colors.orange,
  },
  choiceIcon: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(242,104,34,0.12)',
  },
  choiceIconPrimary: {
    width: 58,
    height: 58,
    borderRadius: 29,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.13)',
  },
  choiceCopy: { flex: 1 },
  choiceTitle: { color: '#FFF', fontSize: 19, fontWeight: '900' },
  choiceTitleDark: { color: colors.textPrimary },
  choiceText: {
    color: 'rgba(255,255,255,0.72)',
    fontSize: 13,
    lineHeight: 18,
    marginTop: 4,
  },
  orRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  orLine: { height: 1, flex: 1, backgroundColor: colors.border },
  orText: { color: colors.textMuted, fontSize: 12, fontWeight: '800' },
  manualCard: {
    marginTop: 26,
    padding: spacing.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgCard,
  },
  pasteButton: {
    alignSelf: 'stretch',
    justifyContent: 'center',
    paddingHorizontal: 13,
    borderRadius: radius.sm,
    backgroundColor: 'rgba(242,104,34,0.12)',
  },
  pasteButtonText: { color: colors.orange, fontSize: 14, fontWeight: '900' },
  contactsCompact: { marginTop: 22 },
  recipientSummaryCard: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgCard,
    marginBottom: 12,
  },
  recipientSummaryAddress: {
    color: colors.textPrimary,
    marginTop: 5,
    fontSize: 15,
    fontFamily: 'monospace',
  },
  changeRecipient: { color: colors.orange, fontWeight: '800', fontSize: 14 },

  sectionHeaderRecent: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 8,
    marginBottom: 12,
  },
  sectionTitle: { color: colors.textPrimary, fontSize: 17, fontWeight: '800' },
  viewMore: { color: 'rgba(242,104,34,0.76)', fontSize: 13, fontWeight: '700' },

  card: {
    backgroundColor: colors.bgCard,
    borderRadius: radius.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: 12,
  },
  amountCard: {
    backgroundColor: colors.bgCard,
    borderRadius: radius.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: 12,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  fieldLabel: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  maxText: {
    color: colors.orange,
    fontSize: 12,
    fontWeight: '900',
    letterSpacing: 0.8,
  },
  addressInput: {
    flex: 1,
    minHeight: 54,
    color: colors.textPrimary,
    fontSize: 15,
    lineHeight: 21,
    padding: 0,
    textAlignVertical: 'top',
  },
  addressInputRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
  },
  scanButton: {
    alignItems: 'center',
    alignSelf: 'stretch',
    borderColor: colors.border,
    borderLeftWidth: 1,
    justifyContent: 'center',
    minWidth: 46,
  },
  contactsCard: {
    backgroundColor: colors.bgCard,
    borderRadius: radius.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: 12,
  },
  contactRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 },
  contactChip: {
    minWidth: 118,
    maxWidth: '100%',
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: 'rgba(255,255,255,0.035)',
  },
  donorChip: {
    borderColor: 'rgba(242,104,34,0.52)',
    backgroundColor: 'rgba(242,104,34,0.08)',
  },
  contactName: { color: colors.textPrimary, fontSize: 12, fontWeight: '800' },
  contactAddress: {
    color: colors.textMuted,
    fontSize: 10,
    marginTop: 3,
    fontFamily: 'monospace',
  },
  recentLabel: { marginTop: 15 },

  amountRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  amountInput: {
    color: colors.textPrimary,
    fontSize: 42,
    fontWeight: '900',
    textAlign: 'center',
    paddingVertical: 2,
    letterSpacing: 0,
  },
  xmrLabel: {
    color: colors.orange,
    fontSize: 15,
    fontWeight: '900',
    textAlign: 'center',
    marginTop: -2,
  },
  usdLabel: {
    color: colors.textMuted,
    fontSize: 14,
    textAlign: 'center',
    marginBottom: 12,
  },
  keypad: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 9,
    marginTop: 8,
  },
  keypadKey: {
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.055)',
    borderColor: 'rgba(255,255,255,0.10)',
    borderRadius: radius.sm,
    borderWidth: 1,
    flexBasis: '31%',
    flexGrow: 1,
    justifyContent: 'center',
    minHeight: 54,
  },
  keypadKeyText: {
    color: colors.textPrimary,
    fontSize: 22,
    fontWeight: '800',
  },
  quickRow: { flexDirection: 'row', gap: 8 },
  quickBtn: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: radius.sm,
    backgroundColor: 'rgba(255,255,255,0.055)',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
  },
  quickBtnText: {
    color: colors.textSecondary,
    fontSize: 13,
    fontWeight: '800',
  },
  priorityCard: {
    backgroundColor: colors.bgCard,
    borderRadius: radius.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: 12,
  },
  priorityRow: { flexDirection: 'row', gap: 6, marginTop: 10 },
  priorityButton: {
    flex: 1,
    minHeight: 38,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.sm,
    backgroundColor: 'rgba(255,255,255,0.055)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
  },
  priorityButtonActive: {
    backgroundColor: colors.orange,
    borderColor: colors.orange,
  },
  priorityButtonText: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: '800',
  },
  priorityButtonTextActive: { color: '#FFF' },
  sweepHint: {
    color: colors.textMuted,
    fontSize: 12,
    lineHeight: 17,
    marginTop: 10,
  },

  summaryCard: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: 'rgba(242,104,34,0.09)',
    borderRadius: radius.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: 'rgba(242,104,34,0.18)',
    marginBottom: 14,
  },
  summaryTitle: {
    color: colors.textPrimary,
    fontSize: 15,
    fontWeight: '800',
    marginBottom: 3,
  },
  summaryText: {
    color: 'rgba(255,255,255,0.46)',
    fontSize: 13,
    fontWeight: '500',
  },

  txCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.bgCard,
    borderRadius: radius.md,
    padding: 14,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: 9,
  },
  txIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  txIconIn: { backgroundColor: 'rgba(0,214,143,0.12)' },
  txIconOut: { backgroundColor: 'rgba(255,68,102,0.12)' },
  txMid: { flex: 1, marginRight: 10 },
  txTitle: { color: colors.textPrimary, fontSize: 14, fontWeight: '800' },
  txMeta: { color: colors.textMuted, fontSize: 11, marginTop: 3 },
  txRight: { alignItems: 'flex-end' },
  txAmount: { color: colors.textPrimary, fontSize: 14, fontWeight: '900' },
  txAmountIn: { color: colors.success },
  txStatus: {
    color: colors.textMuted,
    fontSize: 11,
    marginTop: 3,
    textTransform: 'capitalize',
  },

  formCta: { marginBottom: 22 },
  primaryBtn: {
    height: 54,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 10,
  },
  primaryBtnDisabled: { opacity: 0.55 },
  primaryBtnText: { color: '#FFF', fontSize: 17, fontWeight: '900' },

  backButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    alignSelf: 'flex-start',
    marginBottom: 22,
  },
  backText: { color: colors.textSecondary, fontSize: 15, fontWeight: '700' },
  confirmAmountCard: {
    alignItems: 'center',
    backgroundColor: colors.bgCard,
    borderRadius: radius.lg,
    paddingVertical: 28,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: 14,
  },
  confirmAmount: { color: colors.textPrimary, fontSize: 36, fontWeight: '900' },
  confirmUsd: {
    color: colors.textSecondary,
    fontSize: 15,
    marginTop: 6,
    fontWeight: '600',
  },
  reviewRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 14,
    gap: 14,
  },
  reviewLabel: { color: colors.textSecondary, fontSize: 14, fontWeight: '600' },
  reviewValue: {
    flex: 1,
    color: colors.textPrimary,
    fontSize: 14,
    fontWeight: '700',
    textAlign: 'right',
  },
  reviewValueStrong: { fontSize: 17, fontWeight: '900' },
  reviewValueMono: { fontFamily: 'monospace', color: colors.orange },
  divider: { height: 1, backgroundColor: colors.border },
  privacyBox: {
    backgroundColor: colors.orangeMuted,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: 28,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  privacyText: {
    color: colors.orange,
    fontSize: 13,
    fontWeight: '700',
    lineHeight: 19,
    flex: 1,
  },
  statusText: {
    color: colors.success,
    fontSize: 13,
    lineHeight: 19,
    marginBottom: 14,
  },
  errorText: {
    color: colors.error,
    fontSize: 13,
    lineHeight: 19,
    marginBottom: 14,
  },
  emptyTxCard: {
    backgroundColor: colors.bgCard,
    borderRadius: radius.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: 9,
  },
  emptyTxTitle: {
    color: colors.textPrimary,
    fontSize: 14,
    fontWeight: '800',
    marginBottom: 4,
  },
  emptyTxText: { color: colors.textSecondary, fontSize: 12, lineHeight: 18 },
});
