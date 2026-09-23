import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Keyboard,
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
import LedgerSigningModal from '../components/LedgerSigningModal';
import RecipientQrScanner from '../components/RecipientQrScanner';
import SendSuccessModal, {
  type SendSuccessReceipt,
} from '../components/SendSuccessModal';
import TransactionRow, {
  transactionRowKey,
} from '../components/TransactionRow';
import TransactionLoadMoreButton from '../components/TransactionLoadMoreButton';
import WalletSelector, {
  type WalletOption,
  type WalletSelectorItem,
} from '../components/WalletSelector';
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
import { walletDisplayName } from '../services/WalletRegistry';
import { walletService, type WalletSession } from '../services/WalletService';
import {
  loadRecentRecipients,
  loadRecipientContacts,
  rememberRecipient,
  saveRecipientContacts,
  type RecipientContact,
} from '../services/RecipientAddressBook';
import {
  validateMfwNameSendPreset,
  type MfwNameSendPreset,
} from '../services/MfwNameRegistration';
import {
  convertPaymentAmount,
  paymentXmrAmount,
  sanitizePaymentAmountInput,
  type PaymentAmountCurrency,
} from '../services/PaymentRequest';
import { validatePaymentLinkSendPreset } from '../services/IncomingPaymentLink';
import { useIncomingPaymentLinkAcknowledgement } from '../services/IncomingPaymentLinkController';
import {
  mfwNameAutocompletePrefix,
  mfwNameAutocompleteSuggestions,
} from '../services/MfwNameAutocomplete';
import {
  isLedgerSigningCancelledError,
  type LedgerSigningProgress,
} from '../services/LedgerSigningFlow';
import { logWalletEvent } from '../services/WalletLogger';
import { createPendingOutgoingTransaction } from '../services/PendingOutgoingRegistry';
import {
  fetchConfiguredMfwNameSuggestions,
  isMfwNameCandidate,
  resolveConfiguredMfwNameForPayment,
} from '../services/MfwNameResolutionService';
import {
  acceptRecipientReview,
  createPrivatePhoneSendPreset,
  createRecipientReview,
  maskPhoneNumber,
  recipientFingerprint,
  validatePrivatePhoneSendPreset,
  type RecipientReview,
} from '../services/RecipientReview';

type Step =
  | 'recipient-choice'
  | 'manual-recipient'
  | 'address-book'
  | 'recipient-review'
  | 'amount'
  | 'confirm';

function shortAddress(value: string, fallback: string) {
  if (!value) {
    return fallback;
  }
  if (value.length <= 18) {
    return value;
  }
  return `${value.slice(0, 8)}...${value.slice(-6)}`;
}

export default function SendScreen({ navigation, route }: any) {
  const [address, setAddress] = useState('');
  const [addressInputHeight, setAddressInputHeight] = useState(58);
  const [amount, setAmount] = useState('');
  const [amountCurrency, setAmountCurrency] =
    useState<PaymentAmountCurrency>('XMR');
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
  const [sendSuccessReceipt, setSendSuccessReceipt] = useState<
    SendSuccessReceipt | undefined
  >();
  const [ledgerSigningProgress, setLedgerSigningProgress] = useState<
    LedgerSigningProgress | undefined
  >();
  const ledgerSigningCancelledRef = useRef(false);
  const [mfwNamePreset, setMfwNamePreset] = useState<
    MfwNameSendPreset | undefined
  >();
  const consumedMfwFlowId = useRef<string | undefined>(undefined);
  const [recipientReview, setRecipientReview] = useState<
    RecipientReview | undefined
  >();
  const consumedPrivatePhoneFlowId = useRef<string | undefined>(undefined);
  const consumedPaymentLinkFlowId = useRef<string | undefined>(undefined);
  const processingPaymentLinkFlow = useRef<
    { flowId: string; token: symbol } | undefined
  >(undefined);
  const [scannerVisible, setScannerVisible] = useState(false);
  const [sweepAll, setSweepAll] = useState(false);
  const [recipientContacts, setRecipientContacts] = useState<
    RecipientContact[]
  >([]);
  const [recentRecipients, setRecentRecipients] = useState<RecipientContact[]>(
    [],
  );
  const [resolverMfwNames, setResolverMfwNames] = useState<string[]>([]);
  const [resolvedMfwRecipient, setResolvedMfwRecipient] = useState<
    { name: string; address: string } | undefined
  >();
  const [mfwLookupPending, setMfwLookupPending] = useState(false);
  const [recipientValidationPending, setRecipientValidationPending] =
    useState(false);
  const mfwLookupGeneration = useRef(0);
  const [contactLabel, setContactLabel] = useState('');
  const [contactAddress, setContactAddress] = useState('');
  const { dateLocale, t } = useI18n();
  const acknowledgeIncomingPaymentLink =
    useIncomingPaymentLinkAcknowledgement();
  const consumePaymentLinkRoute = useCallback(
    (flowId: string) => {
      acknowledgeIncomingPaymentLink(flowId);
      navigation.setParams?.({ paymentLinkSendPreset: undefined });
    },
    [acknowledgeIncomingPaymentLink, navigation],
  );
  const { price } = useXmrPrice();
  const {
    connectLedgerForSigning,
    isRegisteredWalletOpen,
    openRegisteredWalletById,
    publishPendingOutgoing,
    reconcileLedgerBalance,
    refreshSnapshot,
    refreshTransactions,
    restoreLedgerViewAfterSigning,
    registeredWallet,
    registeredWallets,
    session,
    setActiveRegisteredWallet,
    snapshot,
    transactions,
    walletSnapshots,
  } = useWalletState();

  useEffect(
    () => () => {
      ledgerSigningCancelledRef.current = true;
    },
    [],
  );

  // Total Balance can span several Monero accounts, while one Core
  // transaction spends from exactly one account. WalletService publishes the
  // richest live account as this fail-closed transaction scope.
  const unlockedAtomic = toAtomicBigInt(snapshot?.spendUnlockedBalanceAtomic);
  const enteredAmountXmr = paymentXmrAmount(amount, amountCurrency, price);
  const amountAtomic = parseXmrToAtomic(enteredAmountXmr ?? '');
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
    : enteredAmountXmr || '0';
  const totalXmr =
    preparedAmountAtomic !== undefined && preparedTx
      ? formatAtomicXmr(
          preparedAmountAtomic + toAtomicBigInt(preparedTx.feeAtomic),
          {
            maxFractionDigits: 12,
          },
        )
      : enteredAmountXmr || '0';
  const amountEquivalent =
    amountCurrency === 'XMR'
      ? `≈ $${usd} USD`
      : enteredAmountXmr
      ? `≈ ${enteredAmountXmr} XMR`
      : price > 0
      ? '≈ 0.0000 XMR'
      : t('receive.usdRateUnavailable');
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
    () => registeredWallets,
    [registeredWallets],
  );
  const routeMfwNamePreset = useMemo(
    () =>
      validateMfwNameSendPreset(route?.params?.mfwNameSendPreset as unknown),
    [route?.params?.mfwNameSendPreset],
  );
  const routePrivatePhonePreset = useMemo(
    () =>
      validatePrivatePhoneSendPreset(
        route?.params?.privatePhoneSendPreset as unknown,
      ),
    [route?.params?.privatePhoneSendPreset],
  );
  const routePaymentLinkPreset = useMemo(
    () =>
      validatePaymentLinkSendPreset(
        route?.params?.paymentLinkSendPreset as unknown,
      ),
    [route?.params?.paymentLinkSendPreset],
  );
  const mfwAutocomplete = useMemo(
    () => mfwNameAutocompleteSuggestions(address, resolverMfwNames),
    [address, resolverMfwNames],
  );

  useEffect(() => {
    const generation = ++mfwLookupGeneration.current;
    setResolverMfwNames([]);
    setResolvedMfwRecipient(undefined);
    setMfwLookupPending(false);
    if (step !== 'manual-recipient') {
      return;
    }
    const prefix = mfwNameAutocompletePrefix(address);
    if (!prefix) {
      return;
    }
    setMfwLookupPending(true);
    const exactName = isMfwNameCandidate(address)
      ? address.trim().toLowerCase()
      : undefined;
    const network = session?.network ?? registeredWallet?.network;
    const timer = setTimeout(() => {
      Promise.all([
        fetchConfiguredMfwNameSuggestions(prefix).catch(() => []),
        exactName && network
          ? resolveConfiguredMfwNameForPayment(exactName, network).catch(
              () => undefined,
            )
          : Promise.resolve(undefined),
      ]).then(([names, resolvedAddress]) => {
        if (mfwLookupGeneration.current !== generation) {
          return;
        }
        setResolverMfwNames(names);
        setResolvedMfwRecipient(
          exactName && resolvedAddress
            ? { name: exactName, address: resolvedAddress }
            : undefined,
        );
        setMfwLookupPending(false);
      });
    }, 250);
    return () => {
      clearTimeout(timer);
      if (mfwLookupGeneration.current === generation) {
        mfwLookupGeneration.current += 1;
      }
    };
  }, [address, registeredWallet?.network, session?.network, step]);

  useEffect(() => {
    const preset = routeMfwNamePreset;
    if (!preset || consumedMfwFlowId.current === preset.flowId) {
      return;
    }
    if (registeredWallet?.id !== preset.walletRegistrationId) {
      setActiveRegisteredWallet(preset.walletRegistrationId).catch(error => {
        setSendError(error instanceof Error ? error.message : String(error));
      });
      return;
    }
    if (!session || session.registrationId !== preset.walletRegistrationId) {
      setSendError(t('mfwNames.openSelectedWallet'));
      return;
    }

    consumedMfwFlowId.current = preset.flowId;
    setMfwNamePreset(preset);
    setAddress(preset.destinationAddress);
    setAmountCurrency('XMR');
    setAmount(
      formatAtomicXmr(preset.preparedTransaction.amountAtomic, {
        maxFractionDigits: 12,
      }),
    );
    setPreparedTx(preset.preparedTransaction);
    setPreparedSession(session);
    setSweepAll(false);
    setSendError(undefined);
    setSendStatus(undefined);
    setStep('confirm');
  }, [
    registeredWallet?.id,
    routeMfwNamePreset,
    session,
    setActiveRegisteredWallet,
    t,
  ]);

  useEffect(() => {
    const preset = routePrivatePhonePreset;
    if (!preset || consumedPrivatePhoneFlowId.current === preset.flowId) {
      return;
    }
    const activeNetwork = session?.network ?? registeredWallet?.network;
    if (!activeNetwork) {
      setSendError(t('send.openWalletBeforeSending'));
      return;
    }
    if (activeNetwork !== preset.network) {
      setSendError(t('send.privateContactWrongNetwork'));
      return;
    }
    if (!session) {
      setSendError(t('send.openWalletBeforeSending'));
      return;
    }

    consumedPrivatePhoneFlowId.current = preset.flowId;
    let active = true;
    walletService
      .validateRecipientAddress(preset.address, preset.network)
      .then(validatedAddress =>
        createPrivatePhoneSendPreset({
          flowId: preset.flowId,
          phoneNumber: preset.privatePhoneNumber,
          displayName: preset.displayName,
          network: preset.network,
          address: validatedAddress,
          issuedAt: preset.resolvedAt,
          expiresAt: preset.expiresAt,
          sequence: preset.sequence,
        }),
      )
      .then(recheckedPreset => {
        if (!active) return;
        setAddress(recheckedPreset.address);
        setRecipientReview(recheckedPreset);
        setPreparedTx(undefined);
        setPreparedSession(undefined);
        setSweepAll(false);
        setSendError(undefined);
        setSendStatus(undefined);
        setStep('recipient-review');
      })
      .catch(() => {
        if (active) {
          setSendError(t('send.privateContactUnavailable'));
        }
      });
    return () => {
      active = false;
    };
  }, [registeredWallet?.network, routePrivatePhonePreset, session, t]);

  useEffect(() => {
    const preset = routePaymentLinkPreset;
    if (
      !preset ||
      consumedPaymentLinkFlowId.current === preset.flowId ||
      processingPaymentLinkFlow.current?.flowId === preset.flowId
    ) {
      return;
    }
    const network = session?.network ?? registeredWallet?.network;
    if (!network || !session) {
      setSendError(t('send.openWalletBeforeSending'));
      return;
    }
    if (preset.expiresAtMs !== undefined && preset.expiresAtMs <= Date.now()) {
      consumedPaymentLinkFlowId.current = preset.flowId;
      consumePaymentLinkRoute(preset.flowId);
      setSendError(t('send.paymentLinkInvalid'));
      return;
    }

    let active = true;
    const token = Symbol(preset.flowId);
    processingPaymentLinkFlow.current = { flowId: preset.flowId, token };
    walletService
      .validateRecipientAddress(preset.address, network)
      .then(validatedAddress => {
        if (!active) return;
        if (
          preset.expiresAtMs !== undefined &&
          preset.expiresAtMs <= Date.now()
        ) {
          consumedPaymentLinkFlowId.current = preset.flowId;
          consumePaymentLinkRoute(preset.flowId);
          setSendError(t('send.paymentLinkInvalid'));
          return;
        }
        const baseReview = createRecipientReview({
          source: 'payment-link',
          network,
          address: validatedAddress,
          displayName: preset.recipientName,
          now: Math.floor(preset.resolvedAtMs / 1_000),
        });
        consumedPaymentLinkFlowId.current = preset.flowId;
        setAddress(validatedAddress);
        setAmountCurrency('XMR');
        setAmount(preset.amountXmr ?? '');
        setRecipientReview(
          preset.expiresAtMs === undefined
            ? baseReview
            : Object.freeze({
                ...baseReview,
                expiresAt: Math.floor(preset.expiresAtMs / 1_000),
              }),
        );
        setMfwNamePreset(undefined);
        setPreparedTx(undefined);
        setPreparedSession(undefined);
        setSweepAll(false);
        setSendError(undefined);
        setSendStatus(undefined);
        setStep('recipient-review');
      })
      .catch(() => {
        if (active) {
          consumedPaymentLinkFlowId.current = preset.flowId;
          consumePaymentLinkRoute(preset.flowId);
          setSendError(t('send.invalidRecipientForNetwork'));
        }
      })
      .finally(() => {
        if (processingPaymentLinkFlow.current?.token === token) {
          processingPaymentLinkFlow.current = undefined;
        }
      });
    return () => {
      active = false;
      if (processingPaymentLinkFlow.current?.token === token) {
        processingPaymentLinkFlow.current = undefined;
      }
    };
  }, [
    consumePaymentLinkRoute,
    registeredWallet?.network,
    routePaymentLinkPreset,
    session,
    t,
  ]);

  useEffect(() => {
    if (
      routePaymentLinkPreset &&
      consumedPaymentLinkFlowId.current === routePaymentLinkPreset.flowId &&
      recipientReview?.source === 'payment-link'
    ) {
      consumePaymentLinkRoute(routePaymentLinkPreset.flowId);
    }
  }, [consumePaymentLinkRoute, recipientReview, routePaymentLinkPreset]);

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
    next = sanitizePaymentAmountInput(next, amountCurrency);
    if (next.length > 24) {
      return;
    }
    setAmount(next);
    setSweepAll(false);
    setSendError(undefined);
    clearPreparedTransaction();
  };

  const changeAmountCurrency = (next: PaymentAmountCurrency) => {
    if (next === amountCurrency) {
      return;
    }
    setAmount(current =>
      convertPaymentAmount(current, amountCurrency, next, price),
    );
    setAmountCurrency(next);
    setSendError(undefined);
    clearPreparedTransaction();
  };

  const selectWallet = async (wallet: WalletOption) => {
    if (wallet.disabled) {
      return;
    }

    const walletId = wallet.id;
    clearPreparedTransaction();
    setAmount('');
    setSweepAll(false);
    if (isRegisteredWalletOpen(walletId)) {
      if (walletId !== registeredWallet?.id) {
        await setActiveRegisteredWallet(walletId);
      }
      return;
    }

    const opened = await openRegisteredWalletById(walletId);
    if (opened) {
      return;
    }
    setSendError(t('send.openWalletBeforeSending'));
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
    setSendStatus(undefined);
    let hardwareStatusTimer: ReturnType<typeof setInterval> | undefined;
    let ledgerHandoffCreated = false;
    try {
      let signingSession: WalletSession | undefined = session;
      if (registeredWallet?.kind === 'hardware') {
        ledgerSigningCancelledRef.current = false;
        setLedgerSigningProgress({ phase: 'searching' });
        signingSession = await connectLedgerForSigning({
          isCancelled: () => ledgerSigningCancelledRef.current,
          onProgress: setLedgerSigningProgress,
        });
        ledgerHandoffCreated = Boolean(
          signingSession && !signingSession.readOnly,
        );
      }
      if (!signingSession) {
        throw new Error(t('send.openWalletBeforeSending'));
      }
      if (signingSession.hardwareDevice) {
        setLedgerSigningProgress({ phase: 'preparing-request' });
        hardwareStatusTimer = setInterval(() => {
          walletService
            .getHardwareWalletStatus(signingSession)
            .then(status => {
              if (status.requiresUserAction) {
                setLedgerSigningProgress({ phase: 'awaiting-confirmation' });
              }
            })
            .catch(() => undefined);
        }, 500);
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
      setLedgerSigningProgress(undefined);
      if (sweepAll) {
        setAmountCurrency('XMR');
        setAmount(
          formatAtomicXmr(nextTransaction.amountAtomic, {
            maxFractionDigits: 12,
          }),
        );
      }
      setStep('confirm');
    } catch (error) {
      if (ledgerHandoffCreated) {
        await restoreLedgerViewAfterSigning().catch(() => false);
      }
      setSendStatus(undefined);
      setLedgerSigningProgress(undefined);
      if (!isLedgerSigningCancelledError(error)) {
        setSendError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (hardwareStatusTimer) {
        clearInterval(hardwareStatusTimer);
      }
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
    let broadcastSucceeded = false;
    let postBroadcastRefreshPending = false;
    const recordPostBroadcastFailure = (stage: string, error: unknown) => {
      postBroadcastRefreshPending = true;
      logWalletEvent('SendScreen', `postBroadcast.${stage}.error`, { error });
    };
    try {
      const completedNamePreset = mfwNamePreset;
      const committed = await walletService.commitTransaction(
        transactionSession,
        preparedTx.id,
      );
      if (committed.status !== 'ok') {
        throw new Error(
          committed.error || t('send.transactionBroadcastFailed'),
        );
      }
      broadcastSucceeded = true;

      if (!completedNamePreset) {
        const recipientAddress = address.trim();
        const hardwareWallet = registeredWallet?.kind === 'hardware';
        const normalLedgerWallet =
          hardwareWallet && registeredWallet?.role !== 'fast';
        const transactionId =
          committed.txIds.length === 1 ? committed.txIds[0] : undefined;
        const pendingOutgoing = transactionId
          ? createPendingOutgoingTransaction({
              hash: transactionId,
              address: recipientAddress,
              amountAtomic: committed.amountAtomic,
              feeAtomic: committed.feeAtomic,
              subaddrAccount:
                transactionSession.accountIndex ??
                committed.subaddrAccounts[0] ??
                0,
              subaddrIndices: committed.subaddrIndices,
            })
          : undefined;
        if (pendingOutgoing) {
          publishPendingOutgoing(pendingOutgoing);
        }

        // A successful Core commit is the definitive send boundary. Show it
        // immediately; Ledger companion restoration, spent-output
        // reconciliation and history refresh are maintenance and must never
        // keep the Send button in "Working…" or turn a broadcast into an
        // apparent failure.
        setSendSuccessReceipt({
          amountAtomic: committed.amountAtomic,
          feeAtomic: committed.feeAtomic,
          transactionId,
          refreshing: true,
        });
        setAddress('');
        setAmount('');
        setPreparedTx(undefined);
        setPreparedSession(undefined);
        setSweepAll(false);
        setMfwNamePreset(undefined);
        setRecipientReview(undefined);
        setStep('recipient-choice');

        (async () => {
          try {
            if (hardwareWallet) {
              await restoreLedgerViewAfterSigning().catch(error => {
                recordPostBroadcastFailure('restoreLedgerView', error);
                return false;
              });
            }
            if (normalLedgerWallet) {
              await reconcileLedgerBalance().catch(error => {
                recordPostBroadcastFailure('reconcileLedgerBalance', error);
              });
            }
            await rememberRecipient(recipientAddress, recipientContacts)
              .then(setRecentRecipients)
              .catch(error => {
                recordPostBroadcastFailure('rememberRecipient', error);
              });
            await Promise.all([
              refreshSnapshot().catch(error => {
                recordPostBroadcastFailure('refreshSnapshot', error);
              }),
              refreshTransactions().catch(error => {
                recordPostBroadcastFailure('refreshTransactions', error);
              }),
            ]);
          } catch (error) {
            recordPostBroadcastFailure('unexpectedFollowUp', error);
          } finally {
            setSendStatus(
              t(
                postBroadcastRefreshPending
                  ? 'send.transactionBroadcastRefreshPending'
                  : 'send.transactionBroadcast',
              ),
            );
            setSendSuccessReceipt(current => {
              if (!current || current.transactionId !== transactionId) {
                return current;
              }
              return { ...current, refreshing: false };
            });
          }
        })();
        return;
      }

      // The pending transaction belongs to the signing session and can only be
      // closed after Core has committed it. Reopen and reconcile the companion
      // while Ledger is still available, but never turn a successful broadcast
      // into a reported send failure if only this refresh needs a later retry.
      if (registeredWallet?.kind === 'hardware') {
        await restoreLedgerViewAfterSigning().catch(error => {
          recordPostBroadcastFailure('restoreLedgerView', error);
          return false;
        });
      }
      if (
        registeredWallet?.kind === 'hardware' &&
        registeredWallet.role !== 'fast'
      ) {
        await reconcileLedgerBalance().catch(error => {
          recordPostBroadcastFailure('reconcileLedgerBalance', error);
        });
      }

      try {
        setAddress('');
        setAmount('');
        setPreparedTx(undefined);
        setPreparedSession(undefined);
        setSweepAll(false);
        setMfwNamePreset(undefined);
        setRecipientReview(undefined);
        setStep('recipient-choice');
      } catch (error) {
        recordPostBroadcastFailure('resetSendForm', error);
      }
      if (!completedNamePreset) {
        await rememberRecipient(address.trim(), recipientContacts)
          .then(setRecentRecipients)
          .catch(error => {
            recordPostBroadcastFailure('rememberRecipient', error);
          });
      }
      await Promise.all([
        refreshSnapshot().catch(error => {
          recordPostBroadcastFailure('refreshSnapshot', error);
        }),
        refreshTransactions().catch(error => {
          recordPostBroadcastFailure('refreshTransactions', error);
        }),
      ]);
      setSendStatus(
        t(
          postBroadcastRefreshPending
            ? 'send.transactionBroadcastRefreshPending'
            : 'send.transactionBroadcast',
        ),
      );
      if (completedNamePreset) {
        try {
          navigation.navigate('MfwNames', {
            mfwNameBroadcast: {
              registrationId: completedNamePreset.registrationId,
              kind: completedNamePreset.kind,
              years: completedNamePreset.years,
              txIds: committed.txIds,
            },
          });
        } catch (error) {
          recordPostBroadcastFailure('navigateMfwNames', error);
          setSendStatus(t('send.transactionBroadcastRefreshPending'));
        }
      }
    } catch (error) {
      if (broadcastSucceeded) {
        recordPostBroadcastFailure('unexpectedFollowUp', error);
        setSendError(undefined);
        setSendStatus(t('send.transactionBroadcastRefreshPending'));
      } else {
        setSendError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      setSending(false);
    }
  };

  const validateRecipientAndContinue = async (
    candidate: string,
    source: 'manual-address' | 'qr-code' | 'address-book' = 'manual-address',
    displayName = '',
  ) => {
    const network = session?.network ?? registeredWallet?.network;
    if (!network) {
      setSendError(t('send.openWalletBeforeSending'));
      return;
    }
    const isMfwName = isMfwNameCandidate(candidate);
    setRecipientValidationPending(true);
    try {
      const validated = isMfwName
        ? await resolveConfiguredMfwNameForPayment(candidate, network)
        : await walletService.validateRecipientAddress(candidate, network);
      setAddress(validated);
      setRecipientReview(
        createRecipientReview({
          source: isMfwName ? 'mfw-name' : source,
          network,
          address: validated,
          displayName: isMfwName ? candidate.trim().toLowerCase() : displayName,
        }),
      );
      setSendError(undefined);
      clearPreparedTransaction();
      setStep('recipient-review');
    } catch {
      setSendError(
        t(
          isMfwName ? 'send.mfwUnavailable' : 'send.invalidRecipientForNetwork',
        ),
      );
    } finally {
      setRecipientValidationPending(false);
    }
  };

  const selectRecipientContact = (contact: RecipientContact) => {
    validateRecipientAndContinue(
      contact.address,
      'address-book',
      contact.label,
    ).catch(() => undefined);
  };

  const saveContact = async () => {
    const label = contactLabel.trim();
    const contactAddressValue = contactAddress.trim();
    if (!label || !contactAddressValue) {
      setSendError(t('send.contactDetailsRequired'));
      return;
    }
    const network = session?.network ?? registeredWallet?.network;
    if (!network) {
      setSendError(t('send.openWalletBeforeSending'));
      return;
    }
    let validatedAddress: string;
    try {
      validatedAddress = await walletService.validateRecipientAddress(
        contactAddressValue,
        network,
      );
    } catch {
      setSendError(t('send.invalidRecipientForNetwork'));
      return;
    }
    const next = await saveRecipientContacts([
      ...recipientContacts,
      {
        id: `contact:${Date.now()}`,
        label,
        address: validatedAddress,
      },
    ]);
    setRecipientContacts(next);
    setContactLabel('');
    setContactAddress('');
    setSendError(undefined);
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
            onPress={() =>
              mfwNamePreset
                ? navigation.navigate('MfwNames')
                : setStep('amount')
            }
            activeOpacity={0.7}
          >
            <Icon name="arrow-left" size={20} color={colors.textSecondary} />
            <Text style={s.backText}>{t('action.back')}</Text>
          </TouchableOpacity>

          <Text style={s.title}>
            {mfwNamePreset
              ? t('mfwNames.reviewTitle')
              : t('send.reviewPayment')}
          </Text>
          <Text style={s.subtitle}>
            {mfwNamePreset
              ? t('mfwNames.reviewSubtitle')
              : t('send.confirmDetails')}
          </Text>

          <View style={s.confirmAmountCard}>
            <Text style={s.confirmAmount}>{reviewAmount} XMR</Text>
            <Text style={s.confirmUsd}>≈ ${usd} USD</Text>
          </View>

          <View style={s.card}>
            {mfwNamePreset ? (
              <>
                <ReviewRow
                  label={t('mfwNames.name')}
                  value={mfwNamePreset.name}
                  strong
                />
                <Divider />
                <ReviewRow
                  label={t('mfwNames.operation')}
                  value={
                    mfwNamePreset.kind === 'commit'
                      ? t('mfwNames.commitTitle')
                      : mfwNamePreset.kind === 'update'
                      ? t('mfwNames.updateTitle')
                      : mfwNamePreset.kind === 'renew'
                      ? t('mfwNames.renewTitle')
                      : mfwNamePreset.kind === 'revoke'
                      ? t('mfwNames.revokeTitle')
                      : t('mfwNames.claimTitle')
                  }
                />
                {mfwNamePreset.kind === 'commit' ||
                mfwNamePreset.kind === 'claim' ||
                mfwNamePreset.kind === 'renew' ? (
                  <>
                    <Divider />
                    <ReviewRow
                      label={t('mfwNames.term')}
                      value={t('mfwNames.termValue', {
                        count: mfwNamePreset.years,
                      })}
                    />
                  </>
                ) : null}
                <Divider />
              </>
            ) : null}
            <ReviewRow
              label={t('send.recipient')}
              value={address || t('send.noRecipient')}
              mono
              wrap
            />
            {recipientReview ? (
              <>
                <Divider />
                <ReviewRow
                  label={t('send.resolutionSource')}
                  value={t(recipientSourceKey(recipientReview.source))}
                />
                <Divider />
                <ReviewRow
                  label={t('send.addressFingerprint')}
                  value={recipientFingerprint(recipientReview.address)}
                  mono
                />
              </>
            ) : null}
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
                {sending
                  ? t('action.working')
                  : mfwNamePreset?.kind === 'commit'
                  ? t('mfwNames.confirmCommit')
                  : mfwNamePreset?.kind === 'claim'
                  ? t('mfwNames.confirmClaim')
                  : mfwNamePreset?.kind === 'renew'
                  ? t('mfwNames.confirmRenew')
                  : mfwNamePreset?.kind === 'update'
                  ? t('mfwNames.confirmUpdate')
                  : mfwNamePreset?.kind === 'revoke'
                  ? t('mfwNames.confirmRevoke')
                  : t('action.sendNow')}
              </Text>
            </LinearGradient>
          </TouchableOpacity>
        </ScrollView>
      </View>
    );
  }

  if (step === 'recipient-review' && recipientReview) {
    const phoneLabel = recipientReview.privatePhoneNumber
      ? maskPhoneNumber(recipientReview.privatePhoneNumber)
      : '';
    return (
      <View style={s.container}>
        <StatusBar barStyle="light-content" backgroundColor={colors.bg} />
        <ScrollView
          contentContainerStyle={s.confirmScroll}
          showsVerticalScrollIndicator={false}
        >
          <TouchableOpacity
            accessibilityRole="button"
            style={s.backButton}
            onPress={() => {
              setRecipientReview(undefined);
              setAddress('');
              setSendError(undefined);
              setStep('recipient-choice');
            }}
          >
            <Icon name="arrow-left" size={20} color={colors.textSecondary} />
            <Text style={s.backText}>{t('action.back')}</Text>
          </TouchableOpacity>

          <Text style={s.title}>{t('send.checkRecipientTitle')}</Text>
          <Text style={s.subtitle}>{t('send.checkRecipientDescription')}</Text>

          <View style={s.recipientReviewCard}>
            {recipientReview.displayName ? (
              <>
                <Text style={s.recipientReviewName}>
                  {recipientReview.displayName}
                </Text>
                {phoneLabel ? (
                  <Text style={s.recipientReviewPhone}>{phoneLabel}</Text>
                ) : null}
              </>
            ) : null}
            <Text style={s.fieldLabel}>{t('send.resolutionSource')}</Text>
            <Text style={s.recipientReviewMeta}>
              {t(recipientSourceKey(recipientReview.source))}
            </Text>
            <Text style={s.fieldLabel}>{t('send.fullAddress')}</Text>
            <Text selectable style={s.recipientReviewAddress}>
              {recipientReview.address}
            </Text>
            <Text style={s.fieldLabel}>{t('send.addressFingerprint')}</Text>
            <Text style={s.recipientReviewFingerprint}>
              {recipientFingerprint(recipientReview.address)}
            </Text>
            {recipientReview.expiresAt ? (
              <>
                <Text style={s.fieldLabel}>{t('send.sharingFreshness')}</Text>
                <Text style={s.recipientReviewMeta}>
                  {t('send.sharedUntil', {
                    date: new Date(
                      recipientReview.expiresAt * 1000,
                    ).toLocaleString(dateLocale),
                  })}
                </Text>
              </>
            ) : null}
          </View>

          {recipientReview.addressChanged ? (
            <View style={s.addressChangedWarning}>
              <Icon name="info" size={20} color={colors.error} />
              <Text style={s.addressChangedText}>
                {t('send.addressChangedWarning')}
              </Text>
            </View>
          ) : (
            <View style={s.privacyBox}>
              <Icon name="lock" size={17} color={colors.orange} />
              <Text style={s.privacyText}>{t('send.checkRecipientHint')}</Text>
            </View>
          )}

          {sendError ? <Text style={s.errorText}>{sendError}</Text> : null}
          <TouchableOpacity
            accessibilityLabel={t('send.useThisRecipient')}
            accessibilityRole="button"
            disabled={sending}
            onPress={() => {
              setSending(true);
              setSendError(undefined);
              acceptRecipientReview(recipientReview)
                .then(() => setStep('amount'))
                .catch(error => {
                  setSendError(
                    error instanceof Error ? error.message : String(error),
                  );
                })
                .finally(() => setSending(false));
            }}
            style={s.formCta}
          >
            <LinearGradient
              colors={[colors.orange, colors.orangeDark]}
              style={[s.primaryBtn, sending && s.primaryBtnDisabled]}
            >
              <Text style={s.primaryBtnText}>
                {recipientReview.addressChanged
                  ? t('send.confirmChangedAddress')
                  : t('send.useThisRecipient')}
              </Text>
            </LinearGradient>
          </TouchableOpacity>
        </ScrollView>
      </View>
    );
  }

  if (
    step === 'recipient-choice' ||
    step === 'manual-recipient' ||
    step === 'address-book'
  ) {
    const recipientLookupPending =
      mfwLookupPending ||
      (recipientValidationPending && isMfwNameCandidate(address));
    const recipientContinueDisabled =
      mfwLookupPending || recipientValidationPending;
    const continueWithRecipient = () => {
      if (recipientContinueDisabled) {
        return;
      }
      const candidate = address.trim();
      if (!candidate) {
        setSendError(t('send.noRecipient'));
        return;
      }
      const normalizedName = candidate.toLowerCase();
      if (
        isMfwNameCandidate(candidate) &&
        resolvedMfwRecipient?.name === normalizedName
      ) {
        const network = session?.network ?? registeredWallet?.network;
        if (!network) {
          setSendError(t('send.openWalletBeforeSending'));
          return;
        }
        setAddress(resolvedMfwRecipient.address);
        setRecipientReview(
          createRecipientReview({
            source: 'mfw-name',
            network,
            address: resolvedMfwRecipient.address,
            displayName: normalizedName,
          }),
        );
        setSendError(undefined);
        clearPreparedTransaction();
        setStep('recipient-review');
        return;
      }
      validateRecipientAndContinue(candidate).catch(() => undefined);
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
          {sendStatus ? <Text style={s.statusText}>{sendStatus}</Text> : null}

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
                onPress={() => {
                  setRecipientReview(undefined);
                  setStep('manual-recipient');
                }}
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

              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel={t('send.addressBook')}
                activeOpacity={0.78}
                onPress={() => setStep('address-book')}
                style={s.choiceCard}
              >
                <View style={s.choiceIcon}>
                  <Icon name="users" size={27} color={colors.orange} />
                </View>
                <View style={s.choiceCopy}>
                  <Text style={[s.choiceTitle, s.choiceTitleDark]}>
                    {t('send.addressBook')}
                  </Text>
                  <Text style={s.choiceText}>{t('send.addressBookHint')}</Text>
                </View>
                <Icon name="chevron-right" size={22} color={colors.orange} />
              </TouchableOpacity>

              {recentRecipients.length > 0 ? (
                <View style={s.quickRecipients}>
                  <View style={s.quickRecipientsHeader}>
                    <Text style={s.fieldLabel}>{t('send.recentContacts')}</Text>
                    <TouchableOpacity
                      accessibilityRole="button"
                      accessibilityLabel={t('send.addressBook')}
                      onPress={() => setStep('address-book')}
                    >
                      <Text style={s.viewMore}>{t('send.viewMore')}</Text>
                    </TouchableOpacity>
                  </View>
                  <View style={s.contactRow}>
                    {recentRecipients.map(contact => (
                      <TouchableOpacity
                        key={contact.id}
                        style={s.contactChip}
                        onPress={() => selectRecipientContact(contact)}
                      >
                        <Text style={s.contactName}>{contact.label}</Text>
                        <Text style={s.contactAddress} numberOfLines={1}>
                          {shortAddress(contact.address, contact.address)}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                </View>
              ) : null}
            </View>
          ) : step === 'manual-recipient' ? (
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
                  style={[s.addressInput, { height: addressInputHeight }]}
                  placeholder={t('send.pasteAddress')}
                  placeholderTextColor={colors.textMuted}
                  value={address}
                  onChangeText={value => {
                    mfwLookupGeneration.current += 1;
                    setMfwLookupPending(
                      Boolean(mfwNameAutocompletePrefix(value)),
                    );
                    setAddress(value);
                    setRecipientReview(undefined);
                    setSendError(undefined);
                    clearPreparedTransaction();
                  }}
                  onContentSizeChange={event => {
                    setAddressInputHeight(
                      Math.max(
                        58,
                        Math.min(132, event.nativeEvent.contentSize.height + 28),
                      ),
                    );
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
                          mfwLookupGeneration.current += 1;
                          setMfwLookupPending(
                            Boolean(mfwNameAutocompletePrefix(value)),
                          );
                          setAddress(value.trim());
                          setRecipientReview(undefined);
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

              {mfwAutocomplete.length > 0 ? (
                <View style={s.mfwAutocompleteRow}>
                  {mfwAutocomplete.map(suggestion => (
                    <TouchableOpacity
                      key={suggestion}
                      accessibilityRole="button"
                      accessibilityLabel={t('send.useMfwSuggestion', {
                        name: suggestion,
                      })}
                      style={s.mfwAutocompleteChip}
                      onPress={() => {
                        Keyboard.dismiss();
                        mfwLookupGeneration.current += 1;
                        setMfwLookupPending(true);
                        setAddress(suggestion);
                        setRecipientReview(undefined);
                        setSendError(undefined);
                        clearPreparedTransaction();
                      }}
                    >
                      <Icon name="key" size={16} color={colors.orange} />
                      <Text style={s.mfwAutocompleteText}>{suggestion}</Text>
                      <Icon
                        name="arrow-right"
                        size={15}
                        color={colors.orange}
                      />
                    </TouchableOpacity>
                  ))}
                </View>
              ) : null}

              {recipientLookupPending ? (
                <View
                  accessibilityLabel={t('send.resolvingMfwName')}
                  accessibilityLiveRegion="polite"
                  accessibilityRole="progressbar"
                  style={s.mfwLookupRow}
                >
                  <ActivityIndicator
                    color={colors.orange}
                    size="small"
                    testID="mfw-name-lookup-spinner"
                  />
                  <Text style={s.mfwLookupText}>
                    {t('send.resolvingMfwName')}
                  </Text>
                </View>
              ) : resolvedMfwRecipient ? (
                <View style={s.resolvedMfwAddressRow}>
                  <Icon name="check" size={15} color={colors.textMuted} />
                  <View style={s.resolvedMfwAddressCopy}>
                    <Text style={s.resolvedMfwAddressLabel}>
                      {t('send.resolvedMfwAddress')}
                    </Text>
                    <Text
                      selectable
                      numberOfLines={1}
                      style={s.resolvedMfwAddress}
                    >
                      {resolvedMfwRecipient.address}
                    </Text>
                  </View>
                </View>
              ) : null}

              {recipientContacts.length > 0 || recentRecipients.length > 0 ? (
                <View style={s.contactsCompact}>
                  {recipientContacts.length > 0 ? (
                    <>
                      <View style={s.quickRecipientsHeader}>
                        <Text style={s.fieldLabel}>
                          {t('send.addressBook')}
                        </Text>
                        <TouchableOpacity
                          accessibilityRole="button"
                          onPress={() => setStep('address-book')}
                        >
                          <Text style={s.viewMore}>{t('send.viewMore')}</Text>
                        </TouchableOpacity>
                      </View>
                      <View style={s.contactRow}>
                        {recipientContacts.slice(0, 3).map(contact => (
                          <TouchableOpacity
                            key={contact.id}
                            style={[
                              s.contactChip,
                              contact.donor && s.donorChip,
                            ]}
                            onPress={() => selectRecipientContact(contact)}
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
                            onPress={() => selectRecipientContact(contact)}
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
                accessibilityState={{ disabled: recipientContinueDisabled }}
                disabled={recipientContinueDisabled}
                onPress={continueWithRecipient}
                style={s.formCta}
              >
                <LinearGradient
                  colors={[colors.orange, colors.orangeDark]}
                  style={[
                    s.primaryBtn,
                    recipientContinueDisabled && s.primaryBtnDisabled,
                  ]}
                >
                  <Text style={s.primaryBtnText}>{t('action.continue')}</Text>
                </LinearGradient>
              </TouchableOpacity>
            </View>
          ) : (
            <View style={s.addressBookCard}>
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
              <Text style={s.addressBookTitle}>{t('send.addressBook')}</Text>
              <Text style={s.addressBookDescription}>
                {t('send.addressBookHint')}
              </Text>

              {recipientContacts.length > 0 ? (
                <View style={s.addressBookList}>
                  {recipientContacts.map(contact => (
                    <TouchableOpacity
                      key={contact.id}
                      style={[
                        s.addressBookRecipient,
                        contact.donor && s.donorRecipient,
                      ]}
                      onPress={() => selectRecipientContact(contact)}
                    >
                      <View style={s.addressBookRecipientIcon}>
                        <Icon
                          name={contact.donor ? 'wallet' : 'users'}
                          size={20}
                          color={contact.donor ? '#FFF' : colors.orange}
                        />
                      </View>
                      <View style={s.choiceCopy}>
                        <Text style={s.contactName}>{contact.label}</Text>
                        <Text style={s.contactAddress} numberOfLines={1}>
                          {shortAddress(contact.address, contact.address)}
                        </Text>
                      </View>
                      <Icon
                        name="chevron-right"
                        size={20}
                        color={colors.orange}
                      />
                    </TouchableOpacity>
                  ))}
                </View>
              ) : (
                <Text style={s.emptyAddressBook}>
                  {t('send.noSavedContacts')}
                </Text>
              )}

              {recentRecipients.length > 0 ? (
                <View style={s.addressBookRecent}>
                  <Text style={s.fieldLabel}>{t('send.recentContacts')}</Text>
                  <View style={s.contactRow}>
                    {recentRecipients.map(contact => (
                      <TouchableOpacity
                        key={contact.id}
                        style={s.contactChip}
                        onPress={() => selectRecipientContact(contact)}
                      >
                        <Text style={s.contactName}>{contact.label}</Text>
                        <Text style={s.contactAddress} numberOfLines={1}>
                          {shortAddress(contact.address, contact.address)}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                </View>
              ) : null}

              <View style={s.addContactCard}>
                <Text style={s.fieldLabel}>{t('send.addContact')}</Text>
                <TextInput
                  style={s.contactInput}
                  placeholder={t('send.contactName')}
                  placeholderTextColor={colors.textMuted}
                  value={contactLabel}
                  onChangeText={setContactLabel}
                  maxLength={80}
                />
                <TextInput
                  style={s.contactInput}
                  placeholder={t('send.pasteAddress')}
                  placeholderTextColor={colors.textMuted}
                  value={contactAddress}
                  onChangeText={setContactAddress}
                  autoCapitalize="none"
                  autoCorrect={false}
                  multiline
                />
                <TouchableOpacity
                  accessibilityRole="button"
                  onPress={() => saveContact().catch(() => undefined)}
                  style={s.addContactButton}
                >
                  <Icon name="plus" size={18} color={colors.orange} />
                  <Text style={s.addContactText}>{t('send.saveContact')}</Text>
                </TouchableOpacity>
              </View>
              {sendError ? <Text style={s.errorText}>{sendError}</Text> : null}
            </View>
          )}
        </ScrollView>
        <RecipientQrScanner
          visible={scannerVisible}
          onClose={() => setScannerVisible(false)}
          onScanned={scannedAddress => {
            setScannerVisible(false);
            validateRecipientAndContinue(scannedAddress, 'qr-code').catch(
              () => undefined,
            );
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
          <Text style={s.title}>{t('send.title')}</Text>
          <Text style={s.subtitle}>{t('send.subtitle')}</Text>
        </View>

        {sendWalletOptions.length > 0 ? (
          <WalletSelector
            activeWalletId={registeredWallet?.id}
            snapshots={walletSnapshotMap}
            titleKey="walletSelector.sendFrom"
            wallets={sendWalletOptions}
            onAdd={() => navigation.navigate('WalletSetup')}
            onManage={() => navigation.navigate('Wallets')}
            onSelect={selectWallet}
          />
        ) : null}

        <View style={s.recipientSummaryCard}>
          <View style={s.recipientSummaryCopy}>
            <Text style={s.fieldLabel}>{t('send.recipient')}</Text>
            {recipientReview?.displayName ? (
              <Text style={s.recipientSummaryName}>
                {recipientReview.displayName}
              </Text>
            ) : null}
            <Text selectable style={s.recipientSummaryAddress}>
              {address || t('send.noRecipient')}
            </Text>
            {recipientReview ? (
              <Text style={s.recipientSummaryMeta}>
                {t(recipientSourceKey(recipientReview.source))}
                {' · '}
                {recipientFingerprint(recipientReview.address)}
              </Text>
            ) : null}
          </View>
          <TouchableOpacity
            accessibilityRole="button"
            onPress={() => {
              setRecipientReview(undefined);
              setStep('manual-recipient');
            }}
          >
            <Text style={s.changeRecipient}>{t('action.change')}</Text>
          </TouchableOpacity>
        </View>

        <View style={s.amountCard}>
          <View style={s.cardHeader}>
            <Text style={s.fieldLabel}>{t('send.amount')}</Text>
            <View style={s.amountHeaderActions}>
              <View style={s.amountCurrencyToggle}>
                {(['XMR', 'USD'] as const).map(currency => (
                  <TouchableOpacity
                    accessibilityRole="radio"
                    accessibilityState={{
                      selected: amountCurrency === currency,
                    }}
                    activeOpacity={0.75}
                    key={currency}
                    onPress={() => changeAmountCurrency(currency)}
                    style={[
                      s.amountCurrencyToggleButton,
                      amountCurrency === currency &&
                        s.amountCurrencyToggleButtonActive,
                    ]}
                  >
                    <Text
                      style={[
                        s.amountCurrencyToggleText,
                        amountCurrency === currency &&
                          s.amountCurrencyToggleTextActive,
                      ]}
                    >
                      {currency}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
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
          </View>
          <Text style={s.amountInput}>
            {amount || (amountCurrency === 'XMR' ? '0.0000' : '0.00')}
          </Text>
          <Text style={s.xmrLabel}>{amountCurrency}</Text>
          <Text style={s.usdLabel}>{amountEquivalent}</Text>

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
                accessibilityLabel={
                  key === 'backspace' ? t('action.delete') : key
                }
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
            onPress={() =>
              navigation.navigate('Transactions', { addressFilter: null })
            }
          >
            <Text style={s.viewMore}>{t('transactions.viewMore')}</Text>
          </TouchableOpacity>
        </View>

        {transactions.length > 0 ? (
          <>
            {transactions.slice(0, 3).map(transaction => (
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
            ))}
            <TransactionLoadMoreButton
              onPress={() =>
                navigation.navigate('Transactions', { addressFilter: null })
              }
            />
          </>
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
          setScannerVisible(false);
          validateRecipientAndContinue(scannedAddress, 'qr-code').catch(
            () => undefined,
          );
        }}
      />
      <SendSuccessModal
        receipt={sendSuccessReceipt}
        onDone={() => setSendSuccessReceipt(undefined)}
      />
      <LedgerSigningModal
        canCancel={
          ledgerSigningProgress?.phase === 'searching' ||
          ledgerSigningProgress?.phase === 'connecting'
        }
        progress={ledgerSigningProgress}
        onCancel={() => {
          ledgerSigningCancelledRef.current = true;
          setLedgerSigningProgress(undefined);
          setSendStatus(undefined);
        }}
      />
    </KeyboardAvoidingView>
  );
}

function recipientSourceKey(source: RecipientReview['source']) {
  switch (source) {
    case 'qr-code':
      return 'send.sourceQr';
    case 'address-book':
      return 'send.sourceAddressBook';
    case 'mfw-name':
      return 'send.sourceMfwName';
    case 'payment-link':
      return 'send.sourcePaymentLink';
    case 'private-phone':
      return 'send.sourcePrivateContact';
    default:
      return 'send.sourceManual';
  }
}

function ReviewRow({
  label,
  value,
  strong,
  mono,
  wrap,
}: {
  label: string;
  value: string;
  strong?: boolean;
  mono?: boolean;
  wrap?: boolean;
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
        numberOfLines={wrap ? undefined : 1}
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
  scroll: { paddingHorizontal: spacing.lg, paddingTop: 12, paddingBottom: 132 },
  confirmScroll: {
    paddingHorizontal: spacing.lg,
    paddingTop: 12,
    paddingBottom: 120,
  },

  header: {
    marginBottom: 24,
  },
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
    alignItems: 'center',
    borderLeftColor: colors.border,
    borderLeftWidth: 1,
    justifyContent: 'center',
    minWidth: 70,
    paddingHorizontal: 12,
    backgroundColor: 'rgba(242,104,34,0.12)',
  },
  pasteButtonText: { color: colors.orange, fontSize: 14, fontWeight: '900' },
  contactsCompact: { marginTop: 22 },
  quickRecipients: {
    marginTop: 4,
    paddingTop: 2,
  },
  quickRecipientsHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  addressBookCard: {
    marginTop: 26,
    padding: spacing.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgCard,
  },
  addressBookTitle: {
    color: colors.textPrimary,
    fontSize: 22,
    fontWeight: '900',
  },
  addressBookDescription: {
    color: colors.textSecondary,
    fontSize: 13,
    lineHeight: 19,
    marginTop: 5,
  },
  addressBookList: { marginTop: 18, gap: 8 },
  addressBookRecipient: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
    padding: 12,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: 'rgba(255,255,255,0.025)',
  },
  donorRecipient: {
    borderColor: 'rgba(242,104,34,0.7)',
    backgroundColor: 'rgba(242,104,34,0.12)',
  },
  addressBookRecipientIcon: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(242,104,34,0.12)',
  },
  addressBookRecent: { marginTop: 22 },
  emptyAddressBook: {
    color: colors.textMuted,
    fontSize: 13,
    lineHeight: 19,
    marginTop: 18,
  },
  addContactCard: {
    marginTop: 24,
    gap: 10,
    paddingTop: 18,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  contactInput: {
    minHeight: 48,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    color: colors.textPrimary,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
  },
  addContactButton: {
    flexDirection: 'row',
    alignSelf: 'flex-start',
    alignItems: 'center',
    gap: 7,
    paddingVertical: 8,
  },
  addContactText: { color: colors.orange, fontSize: 14, fontWeight: '900' },
  recipientSummaryCard: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgCard,
    marginBottom: 12,
  },
  recipientSummaryCopy: { flex: 1, minWidth: 0 },
  recipientSummaryName: {
    color: colors.textPrimary,
    fontSize: 16,
    fontWeight: '800',
    marginTop: 5,
  },
  recipientSummaryAddress: {
    color: colors.textPrimary,
    marginTop: 5,
    fontSize: 12,
    lineHeight: 17,
    fontFamily: 'monospace',
  },
  recipientSummaryMeta: {
    color: colors.textSecondary,
    fontSize: 12,
    lineHeight: 17,
    marginTop: 6,
  },
  changeRecipient: { color: colors.orange, fontWeight: '800', fontSize: 14 },

  recipientReviewCard: {
    backgroundColor: colors.bgCard,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: 1,
    gap: spacing.sm,
    marginBottom: spacing.md,
    marginTop: spacing.lg,
    padding: spacing.md,
  },
  recipientReviewName: {
    color: colors.textPrimary,
    fontSize: 20,
    fontWeight: '900',
  },
  recipientReviewPhone: {
    color: colors.textSecondary,
    fontFamily: 'monospace',
    fontSize: 14,
  },
  recipientReviewAddress: {
    color: colors.textPrimary,
    fontFamily: 'monospace',
    fontSize: 13,
    lineHeight: 19,
  },
  recipientReviewFingerprint: {
    color: colors.orange,
    fontFamily: 'monospace',
    fontSize: 15,
    fontWeight: '800',
  },
  recipientReviewMeta: {
    color: colors.textSecondary,
    fontSize: 14,
    lineHeight: 20,
  },
  addressChangedWarning: {
    alignItems: 'flex-start',
    backgroundColor: 'rgba(255,80,80,0.1)',
    borderColor: colors.error,
    borderRadius: radius.md,
    borderWidth: 1,
    flexDirection: 'row',
    gap: spacing.sm,
    marginBottom: spacing.md,
    padding: spacing.md,
  },
  addressChangedText: {
    color: colors.error,
    flex: 1,
    fontSize: 14,
    fontWeight: '700',
    lineHeight: 20,
  },

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
  amountHeaderActions: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
  },
  amountCurrencyToggle: {
    backgroundColor: colors.bg,
    borderColor: colors.border,
    borderRadius: radius.full,
    borderWidth: 1,
    flexDirection: 'row',
    padding: 3,
  },
  amountCurrencyToggleButton: {
    alignItems: 'center',
    borderRadius: radius.full,
    justifyContent: 'center',
    minHeight: 30,
    paddingHorizontal: 13,
  },
  amountCurrencyToggleButtonActive: { backgroundColor: colors.orange },
  amountCurrencyToggleText: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '900',
  },
  amountCurrencyToggleTextActive: { color: '#FFF' },
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
    minHeight: 58,
    color: colors.textPrimary,
    fontFamily: Platform.select({
      android: 'monospace',
      default: 'monospace',
      ios: 'Menlo',
    }),
    fontSize: 15,
    lineHeight: 21,
    paddingHorizontal: 13,
    paddingVertical: 14,
    textAlignVertical: 'top',
  },
  addressInputRow: {
    backgroundColor: 'rgba(7,5,12,0.34)',
    borderColor: colors.border,
    borderRadius: radius.sm,
    borderWidth: 1,
    alignItems: 'center',
    flexDirection: 'row',
    marginTop: 8,
    overflow: 'hidden',
  },
  mfwAutocompleteRow: {
    alignItems: 'stretch',
    gap: 8,
    marginTop: 12,
  },
  mfwAutocompleteChip: {
    alignItems: 'center',
    backgroundColor: 'rgba(242,104,34,0.10)',
    borderColor: 'rgba(242,104,34,0.52)',
    borderRadius: radius.sm,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 7,
    width: '100%',
    paddingHorizontal: 11,
    paddingVertical: 9,
  },
  mfwAutocompleteText: {
    color: colors.textPrimary,
    flexShrink: 1,
    fontSize: 13,
    fontWeight: '800',
  },
  mfwLookupRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
    marginTop: 12,
    paddingHorizontal: 2,
  },
  mfwLookupText: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: '700',
  },
  resolvedMfwAddressRow: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: 8,
    marginTop: 12,
    paddingHorizontal: 2,
  },
  resolvedMfwAddressCopy: { flex: 1, minWidth: 0 },
  resolvedMfwAddressLabel: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '700',
  },
  resolvedMfwAddress: {
    color: 'rgba(255,255,255,0.52)',
    fontFamily: 'monospace',
    fontSize: 11,
    marginTop: 3,
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

  formCta: { marginBottom: 22, marginTop: 18 },
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
