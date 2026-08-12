import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  StatusBar,
  Animated,
  Dimensions,
  Modal,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Switch,
  TextInput,
  ActivityIndicator,
  Alert,
  Linking,
  useWindowDimensions,
} from 'react-native';
import LinearGradient from 'react-native-linear-gradient';
import { useIsFocused } from '@react-navigation/native';
import Svg, { Path, Rect, Circle, Line } from 'react-native-svg';
import { colors } from '../theme/colors';
import MoneroCoinGhost from '../components/MoneroCoinGhost';
import MoneroCoin from '../components/MoneroCoin';
import {
  walletService,
  type LedgerReconciliationProgress,
} from '../services/WalletService';
import { withSystemUiInterruption } from '../services/SystemUiInterruption';
import { type TranslationKey, useI18n } from '../i18n';
import { useWalletState } from '../services/WalletState';
import {
  classifyDiagnosticFailure,
  logWalletEvent,
} from '../services/WalletLogger';
import { loadActiveNodeConnectionSettings } from '../services/NodeConnectionSettings';
import type {
  BiometricAuthStatus,
  LedgerTransportStatus,
} from '../services/NativeMoneroWallet';
import {
  isFastWalletRegistration,
  walletDisplayName,
} from '../services/WalletRegistry';
import {
  isFastWalletEnabled,
  loadFastWalletPreference,
  saveFastWalletPreference,
} from '../services/FastWalletPreference';
import {
  loadFastReceiveIdentities,
  loadRetiredFastWalletSlots,
  nextFastReceiveDerivationIndex,
} from '../services/FastReceiveRegistry';
import {
  dateInputValue,
  isRestoreStartDateValid,
  parseRestoreStartDate,
  restoreHeightFromStartDate,
  todayRestoreDate,
} from '../services/RestoreStart';
import mobileAppVersion from '../../../../config/mobile-app-version.json';

const { width: SW, height: SH } = Dimensions.get('window');
const CREATE_STEPS = [
  'setup.step.preparingStorage',
  'setup.step.generatingEntropy',
  'setup.step.encryptingSeed',
  'setup.step.derivingKeys',
  'setup.step.preparingBackup',
] as const satisfies readonly TranslationKey[];
const HARDWARE_STEPS = [
  'setup.step.preparingWalletFile',
  'setup.step.waitingForLedger',
  'setup.step.openingMoneroApp',
  'setup.step.readingPublicKeys',
  'setup.step.savingWallet',
] as const satisfies readonly TranslationKey[];
const RESTORE_STEPS = [
  'setup.step.preparingStorage',
  'setup.step.restoringSeed',
  'setup.step.derivingKeys',
  'setup.step.preparingScan',
  'setup.step.startingScan',
] as const satisfies readonly TranslationKey[];
const OPEN_STEPS = [
  'setup.step.openingWallet',
  'setup.step.readingLocalState',
  'setup.step.loadingWallet',
  'setup.step.preparingSync',
] as const satisfies readonly TranslationKey[];
const DEFAULT_WALLET_NAME = 'wallet';
const DEFAULT_HARDWARE_WALLET_NAME = 'ledger';
const CREATE_CARD_HORIZONTAL_MARGIN = 20;
const CREATE_CARD_MAX_WIDTH = 360;
const WALLET_OPEN_SLOW_MS = 15_000;
const WALLET_OPEN_TIMEOUT_MS = 120_000;
type PasswordPromptMode = 'create' | 'open' | 'restore';
type CreationKind = 'software' | 'hardware' | 'restore' | 'open';
type FastWalletTransferStatus = 'idle' | 'transferring' | 'accepted' | 'failed';

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function setupLog(event: string, fields: Record<string, unknown> = {}) {
  logWalletEvent('WalletSetup', event, fields);
}

function fastWalletCreationFailureText(
  error: unknown,
  productSlot: number,
): string {
  const failureCode = classifyDiagnosticFailure(error);
  if (failureCode === 'slot-occupied') {
    return `Fast Wallet slot ${productSlot} cannot be reused. If its wallet was deleted, its local files are gone; the slot stays blocked because previously hosted read access cannot be taken back. Choose another slot.`;
  }
  if (failureCode === 'file-exists') {
    return `A local Fast Wallet file already exists for slot ${productSlot}. Choose another slot or recover the existing wallet; nothing was overwritten.`;
  }
  if (failureCode === 'app-locked') {
    return 'The app locked before Fast Wallet creation finished. Unlock it and add the Fast Wallet from Wallets.';
  }
  if (failureCode === 'wallet-scan' || failureCode === 'network') {
    return 'The node height was not ready for safe Fast Wallet creation. Your private wallet is ready; reconnect and add the Fast Wallet from Wallets.';
  }
  if (failureCode === 'storage' || failureCode === 'credential') {
    return 'Secure local storage could not finish Fast Wallet creation. Your private wallet is ready and no key was uploaded.';
  }
  return `Fast Wallet creation failed (${failureCode}). Your private wallet is ready and no key was uploaded. You can retry from Wallets.`;
}

function rejectAfter<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
  onTimeout: () => void,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      onTimeout();
      reject(new Error(message));
    }, timeoutMs);
  });
  return Promise.race([operation, timeoutPromise]).finally(() => {
    if (timeout) {
      clearTimeout(timeout);
    }
  });
}

function ledgerTransportReady(
  status: LedgerTransportStatus | undefined,
): boolean {
  return Boolean(
    status?.supported &&
      status.available &&
      status.permissionGranted &&
      (status.transport !== 'ble' || status.deviceCount > 0),
  );
}

function ledgerStatusTitle(
  status: LedgerTransportStatus | undefined,
  t: (key: TranslationKey) => string,
): string {
  if (!status) {
    return t('setup.hardware.searchingTitle');
  }
  if (status.transport === 'ble' && status.available && !status.supported) {
    return t('setup.hardware.bleFound');
  }
  if (!status.supported) {
    return t('setup.hardware.transportUnavailable');
  }
  if (!status.permissionGranted) {
    return t('setup.hardware.permissionRequired');
  }
  if (!status.available) {
    return t('setup.hardware.waiting');
  }
  if (status.transport === 'ble' && status.deviceCount === 0) {
    return t('setup.hardware.waiting');
  }
  return status.deviceName || t('setup.hardware.found');
}

function biometricReady(status: BiometricAuthStatus | undefined): boolean {
  return Boolean(status?.supported && status.available && status.enrolled);
}

function biometricLabel(status: BiometricAuthStatus | undefined): string {
  if (status?.biometryType === 'face') {
    return 'Face ID';
  }
  if (status?.biometryType === 'fingerprint') {
    return Platform.OS === 'ios' ? 'Touch ID' : 'Fingerprint';
  }
  if (Platform.OS === 'android') {
    return 'Fingerprint or Face Unlock';
  }
  return 'Biometrics';
}

/* ── Icons ──────────────────────────────────────────────────────────── */
function IcoPlus({ c }: { c: string }) {
  return (
    <Svg width={28} height={28} viewBox="0 0 24 24" fill="none">
      <Circle cx="12" cy="12" r="10" stroke={c} strokeWidth={1.8} />
      <Line
        x1="12"
        y1="8"
        x2="12"
        y2="16"
        stroke={c}
        strokeWidth={2}
        strokeLinecap="round"
      />
      <Line
        x1="8"
        y1="12"
        x2="16"
        y2="12"
        stroke={c}
        strokeWidth={2}
        strokeLinecap="round"
      />
    </Svg>
  );
}
function IcoUsb({ c }: { c: string }) {
  return (
    <Svg width={28} height={28} viewBox="0 0 24 24" fill="none">
      <Rect
        x="7"
        y="2"
        width="10"
        height="8"
        rx="2"
        stroke={c}
        strokeWidth={1.8}
      />
      <Line x1="12" y1="10" x2="12" y2="18" stroke={c} strokeWidth={1.8} />
      <Circle cx="12" cy="20" r="2" stroke={c} strokeWidth={1.8} />
      <Line x1="8" y1="14" x2="12" y2="18" stroke={c} strokeWidth={1.8} />
      <Line x1="16" y1="14" x2="12" y2="18" stroke={c} strokeWidth={1.8} />
    </Svg>
  );
}
function IcoImport({ c }: { c: string }) {
  return (
    <Svg width={28} height={28} viewBox="0 0 24 24" fill="none">
      <Path
        d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"
        stroke={c}
        strokeWidth={1.8}
        strokeLinecap="round"
      />
      <Path
        d="M7 10l5 5 5-5"
        stroke={c}
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Line
        x1="12"
        y1="15"
        x2="12"
        y2="3"
        stroke={c}
        strokeWidth={1.8}
        strokeLinecap="round"
      />
    </Svg>
  );
}

/* ── Setup Option ───────────────────────────────────────────────────── */
function SetupOption({
  icon,
  title,
  desc,
  onPress,
  disabled = false,
}: {
  icon: React.ReactNode;
  title: string;
  desc: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <TouchableOpacity
      style={[s.option, disabled && s.optionDisabled]}
      activeOpacity={0.7}
      onPress={onPress}
      disabled={disabled}
    >
      <View style={s.optionIcon}>{icon}</View>
      <View style={s.optionText}>
        <Text style={s.optionTitle}>{title}</Text>
        <Text style={s.optionDesc}>{desc}</Text>
      </View>
      <Text style={s.optionArrow}>›</Text>
    </TouchableOpacity>
  );
}

function RestoreStartDateField({
  value,
  onChange,
  dateLocale,
  required = false,
  t,
}: {
  value: string;
  onChange: (value: string) => void;
  dateLocale: string;
  required?: boolean;
  t: (key: TranslationKey) => string;
}) {
  const [calendarVisible, setCalendarVisible] = useState(false);
  const [calendarMonth, setCalendarMonth] = useState(() => new Date());
  const valid =
    (!required || value.trim().length > 0) &&
    isRestoreStartDateValid(value);
  const selectedDate = (() => {
    try {
      return parseRestoreStartDate(value);
    } catch {
      return undefined;
    }
  })();
  const selectedDateTime = selectedDate?.getTime();

  useEffect(() => {
    if (calendarVisible) {
      setCalendarMonth(
        selectedDateTime === undefined
          ? new Date()
          : new Date(selectedDateTime),
      );
    }
  }, [calendarVisible, selectedDateTime]);

  const year = calendarMonth.getFullYear();
  const month = calendarMonth.getMonth();
  const firstDayOffset = (new Date(year, month, 1, 12).getDay() + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0, 12).getDate();
  const days = Array.from(
    { length: firstDayOffset + daysInMonth },
    (_, index) =>
      index < firstDayOffset ? undefined : index - firstDayOffset + 1,
  );
  const weekdays = Array.from({ length: 7 }, (_, index) =>
    new Intl.DateTimeFormat(dateLocale, { weekday: 'narrow' }).format(
      new Date(2024, 0, index + 1, 12),
    ),
  );
  const label = selectedDate
    ? new Intl.DateTimeFormat(dateLocale, { dateStyle: 'medium' }).format(
        selectedDate,
      )
    : required
      ? t('setup.scanRequired')
      : t('setup.scanAutomatic');

  return (
    <View style={s.restoreStartField}>
      <Text style={s.restoreStartLabel}>{t('setup.scanStart')}</Text>
      <TouchableOpacity
        style={s.restoreDateButton}
        onPress={() => setCalendarVisible(visible => !visible)}
        activeOpacity={0.76}
      >
        <Text style={s.restoreDateButtonText}>{label}</Text>
        <Text style={s.restoreDateChevron}>{calendarVisible ? '⌃' : '⌄'}</Text>
      </TouchableOpacity>
      {!valid ? (
        <Text style={s.errorText}>{t('setup.scanDateError')}</Text>
      ) : null}
      <Text style={s.restoreDateHint}>
        {t(required ? 'setup.ledgerScanDateHint' : 'setup.scanDateHint')}
      </Text>
      {calendarVisible ? (
        <View style={s.restoreCalendar}>
          <View style={s.restoreCalendarHeader}>
            <TouchableOpacity
              style={s.restoreCalendarNav}
              onPress={() =>
                setCalendarMonth(
                  current =>
                    new Date(
                      current.getFullYear(),
                      current.getMonth() - 1,
                      1,
                      12,
                    ),
                )
              }
            >
              <Text style={s.restoreCalendarNavText}>‹</Text>
            </TouchableOpacity>
            <Text style={s.restoreCalendarMonth}>
              {new Intl.DateTimeFormat(dateLocale, {
                month: 'long',
                year: 'numeric',
              }).format(calendarMonth)}
            </Text>
            <TouchableOpacity
              style={s.restoreCalendarNav}
              onPress={() =>
                setCalendarMonth(
                  current =>
                    new Date(
                      current.getFullYear(),
                      current.getMonth() + 1,
                      1,
                      12,
                    ),
                )
              }
              disabled={
                dateInputValue(new Date(year, month + 1, 1, 12)) >
                todayRestoreDate()
              }
            >
              <Text style={s.restoreCalendarNavText}>›</Text>
            </TouchableOpacity>
          </View>
          <View style={s.restoreCalendarGrid}>
            {weekdays.map((weekday, index) => (
              <Text style={s.restoreWeekday} key={`${weekday}-${index}`}>
                {weekday}
              </Text>
            ))}
            {days.map((day, index) => {
              if (!day)
                return (
                  <View style={s.restoreCalendarDay} key={`empty-${index}`} />
                );
              const date = new Date(year, month, day, 12);
              const inputValue = dateInputValue(date);
              const isFuture = inputValue > todayRestoreDate();
              const isSelected = inputValue === value;
              return (
                <TouchableOpacity
                  style={[
                    s.restoreCalendarDay,
                    isSelected && s.restoreCalendarDaySelected,
                  ]}
                  disabled={isFuture}
                  key={inputValue}
                  onPress={() => {
                    onChange(inputValue);
                    setCalendarVisible(false);
                  }}
                >
                  <Text
                    style={[
                      s.restoreCalendarDayText,
                      isSelected && s.restoreCalendarDayTextSelected,
                      isFuture && s.restoreCalendarDayTextDisabled,
                    ]}
                  >
                    {day}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
          {!required ? (
            <TouchableOpacity
              style={s.restoreAutomaticButton}
              onPress={() => {
                onChange('');
                setCalendarVisible(false);
              }}
            >
              <Text style={s.restoreAutomaticText}>
                {t('setup.scanAutomatic')}
              </Text>
            </TouchableOpacity>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/* ── Screen ─────────────────────────────────────────────────────────── */
export default function WalletSetupScreen({ navigation, route }: any) {
  const { dateLocale, t } = useI18n();
  const isFocused = useIsFocused();
  const { width: windowWidth } = useWindowDimensions();
  const createCardWidth = Math.min(
    CREATE_CARD_MAX_WIDTH,
    Math.max(280, windowWidth - CREATE_CARD_HORIZONTAL_MARGIN * 2),
  );
  const fadeIn = useRef(new Animated.Value(0)).current;
  const slideUp = useRef(new Animated.Value(30)).current;
  const bgOp = useRef(new Animated.Value(0)).current;
  const handledModeRequest = useRef<string | undefined>(undefined);
  const [creating, setCreating] = useState(false);
  const [creatingKind, setCreatingKind] = useState<CreationKind>('software');
  const [passwordPromptMode, setPasswordPromptMode] = useState<
    PasswordPromptMode | undefined
  >();
  const [ledgerPromptVisible, setLedgerPromptVisible] = useState(false);
  const [ledgerBusy, setLedgerBusy] = useState(false);
  const [ledgerViewKeyExportPending, setLedgerViewKeyExportPending] =
    useState(false);
  const [ledgerStatus, setLedgerStatus] = useState<
    LedgerTransportStatus | undefined
  >();
  const [ledgerError, setLedgerError] = useState<string | undefined>();
  const [biometricStatus, setBiometricStatus] = useState<
    BiometricAuthStatus | undefined
  >();
  const [biometricError, setBiometricError] = useState<string | undefined>();
  const [restoreStartDate, setRestoreStartDate] = useState('');
  const [ledgerRestoreStartDate, setLedgerRestoreStartDate] = useState('');
  const [openingWalletId, setOpeningWalletId] = useState<string | undefined>();
  const [openingElapsedSeconds, setOpeningElapsedSeconds] = useState(0);
  const [creatingElapsedSeconds, setCreatingElapsedSeconds] = useState(0);
  const [nativeWalletOperationPending, setNativeWalletOperationPending] =
    useState(false);
  const [walletOpenError, setWalletOpenError] = useState<string | undefined>();
  const [createStep, setCreateStep] = useState(() => t(CREATE_STEPS[0]));
  const [createError, setCreateError] = useState<string | undefined>();
  const [fastWalletTransferStatus, setFastWalletTransferStatus] =
    useState<FastWalletTransferStatus>('idle');
  const [hardwareSetupProgress, setHardwareSetupProgress] =
    useState<LedgerReconciliationProgress>();
  // A Ledger wallet cannot present a trustworthy balance or outgoing history
  // without its encrypted local read-only companion and a completed Key-Image
  // reconciliation. This is part of Ledger setup, not an optional feature.
  const persistLedgerViewOnly = true;
  const [fastWalletEnabled, setFastWalletEnabled] = useState(false);
  const [fastWalletSlotInput, setFastWalletSlotInput] = useState('199');
  const fastWalletSlotEditedRef = useRef(false);
  const {
    backupRegisteredWalletSeed,
    registeredWallet,
    registeredWallets,
    openRegisteredWalletById,
    refreshSnapshot,
    refreshTransactions,
    registerOpenedSession,
    reloadRegisteredWallet,
    reloadRegisteredWallets,
  } = useWalletState();

  useEffect(() => {
    let mounted = true;
    const requested = route?.params?.fastWalletEnabled;
    if (typeof requested === 'boolean') {
      setFastWalletEnabled(requested);
      return () => {
        mounted = false;
      };
    }

    loadFastWalletPreference()
      .then(preference => {
        if (mounted) {
          setFastWalletEnabled(isFastWalletEnabled(preference));
        }
      })
      .catch(() => undefined);
    return () => {
      mounted = false;
    };
  }, [route?.params?.fastWalletEnabled]);

  useEffect(() => {
    if (!isFocused) {
      return;
    }

    let cancelled = false;
    fastWalletSlotEditedRef.current = false;
    Promise.all([
      loadActiveNodeConnectionSettings(),
      loadFastReceiveIdentities(),
      loadRetiredFastWalletSlots(),
    ])
      .then(([settings, identities, retiredSlots]) => {
        if (cancelled || fastWalletSlotEditedRef.current) {
          return;
        }
        const networkIdentities = identities.filter(
          identity => identity.network === settings.network,
        );
        const networkRetiredSlots = retiredSlots
          .filter(item => item.network === settings.network)
          .map(item => item.productSlot);
        const suggestedSlot = nextFastReceiveDerivationIndex(
          networkIdentities,
          networkRetiredSlots,
        );
        setFastWalletSlotInput(String(suggestedSlot));
        setupLog('fastWalletSlot.defaultResolved', {
          productSlot: suggestedSlot,
        });
      })
      .catch(error => {
        setupLog('fastWalletSlot.defaultError', {
          error: errorMessage(error),
        });
      });

    return () => {
      cancelled = true;
    };
  }, [isFocused]);

  const changeFastWalletSlot = useCallback((value: string) => {
    fastWalletSlotEditedRef.current = true;
    setFastWalletSlotInput(value);
  }, []);

  const changeFastWalletEnabled = useCallback((enabled: boolean) => {
    setFastWalletEnabled(enabled);
    saveFastWalletPreference(enabled ? 'enabled' : 'disabled').catch(error => {
      setupLog('fastWalletPreference.saveError', {
        error: errorMessage(error),
      });
    });
  }, []);

  const restoreStartDateReady = isRestoreStartDateValid(restoreStartDate);
  const ledgerRestoreStartDateReady =
    ledgerRestoreStartDate.trim().length > 0 &&
    isRestoreStartDateValid(ledgerRestoreStartDate);
  const canUseBiometric = biometricReady(biometricStatus);
  const currentBiometricLabel = biometricLabel(biometricStatus);
  const hasLocalLedgerView =
    registeredWallet?.kind === 'hardware' &&
    Boolean(
      registeredWallet.viewOnlyPath && registeredWallet.viewOnlyCredentialKey,
    );
  const openUsesStoredSecret =
    passwordPromptMode === 'open' &&
    Boolean(
      (registeredWallet?.kind !== 'hardware' &&
        registeredWallet?.credentialKey) ||
        hasLocalLedgerView,
    );
  const openUsesHardwareWallet =
    passwordPromptMode === 'open' &&
    registeredWallet?.kind === 'hardware' &&
    !hasLocalLedgerView;
  const hardwareTransportReady = ledgerTransportReady(ledgerStatus);
  const waitingForBiometricStatus =
    biometricStatus === undefined && biometricError === undefined;
  // A software wallet's encryption secret is held in the platform secure
  // store. App protection is selected once in Settings; it is deliberately
  // not a separate prompt for every wallet.
  const showBiometricCard = false;
  const passwordReady =
    passwordPromptMode === 'open'
      ? openUsesStoredSecret || openUsesHardwareWallet
      : passwordPromptMode === 'restore'
      ? restoreStartDateReady
      : true;
  const passwordPromptTitle =
    passwordPromptMode === 'open'
      ? t('action.openWallet')
      : passwordPromptMode === 'restore'
      ? t('setup.importWallet')
      : t('action.createWallet');
  const passwordPromptSubtitle =
    passwordPromptMode === 'open'
      ? openUsesStoredSecret
        ? t('setup.prompt.openStored', { biometric: currentBiometricLabel })
        : openUsesHardwareWallet
        ? t('setup.prompt.openHardware')
        : 'This wallet is missing its protected device credential. Restore it from the recovery seed to create a new local copy.'
      : passwordPromptMode === 'restore'
      ? t('setup.prompt.restoreStored')
      : t('setup.prompt.createDeviceNoBiometric');
  const passwordPromptAction =
    passwordPromptMode === 'open'
      ? openUsesStoredSecret
        ? t('action.unlock')
        : openUsesHardwareWallet && !hardwareTransportReady
        ? t('action.search')
        : t('action.open')
      : passwordPromptMode === 'restore'
      ? t('action.import')
      : t('action.create');
  const setupOverlayVisible = creating;
  useEffect(() => {
    Animated.timing(bgOp, {
      toValue: 1,
      duration: 1000,
      useNativeDriver: true,
    }).start();
    Animated.parallel([
      Animated.timing(fadeIn, {
        toValue: 1,
        duration: 600,
        delay: 200,
        useNativeDriver: true,
      }),
      Animated.spring(slideUp, {
        toValue: 0,
        friction: 9,
        tension: 40,
        delay: 200,
        useNativeDriver: true,
      }),
    ]).start();
  }, [bgOp, fadeIn, slideUp]);

  useEffect(() => {
    reloadRegisteredWallet().catch(() => undefined);
  }, [reloadRegisteredWallet]);

  const refreshBiometricStatus = useCallback(async () => {
    setBiometricError(undefined);
    setupLog('refreshBiometricStatus.start');
    try {
      const status = await walletService.getBiometricAuthStatus();
      setBiometricStatus(status);
      setupLog('refreshBiometricStatus.success', {
        available: status.available,
        biometryType: status.biometryType,
        enrolled: status.enrolled,
        platform: status.platform,
        supported: status.supported,
      });
      return status;
    } catch (error) {
      setBiometricError(errorMessage(error));
      setupLog('refreshBiometricStatus.error', {
        error: errorMessage(error),
      });
      return undefined;
    }
  }, []);

  useEffect(() => {
    refreshBiometricStatus().catch(() => undefined);
  }, [refreshBiometricStatus]);

  useEffect(() => {
    if (!openingWalletId) {
      setOpeningElapsedSeconds(0);
      return;
    }
    const startedAt = Date.now();
    setOpeningElapsedSeconds(0);
    const timer = setInterval(() => {
      setOpeningElapsedSeconds(
        Math.max(0, Math.floor((Date.now() - startedAt) / 1000)),
      );
    }, 1000);
    return () => clearInterval(timer);
  }, [openingWalletId]);

  useEffect(() => {
    if (!creating) {
      setCreatingElapsedSeconds(0);
      return;
    }
    const startedAt = Date.now();
    setCreatingElapsedSeconds(0);
    const timer = setInterval(() => {
      setCreatingElapsedSeconds(
        Math.max(0, Math.floor((Date.now() - startedAt) / 1000)),
      );
    }, 1000);
    return () => clearInterval(timer);
  }, [creating]);

  const openPasswordPrompt = useCallback(
    (mode: PasswordPromptMode) => {
      if (creating || nativeWalletOperationPending) {
        setupLog('openPasswordPrompt.skipped', {
          mode,
          reason: creating ? 'creating' : 'native-wallet-operation',
        });
        return;
      }

      setupLog('openPasswordPrompt.start', {
        canUseBiometric,
        mode,
        registeredWalletCount: registeredWallets.length,
      });
      setCreateError(undefined);
      if (mode === 'restore') {
        setRestoreStartDate('');
      }
      if (mode === 'create' || mode === 'open') {
        refreshBiometricStatus().catch(() => undefined);
      }
      setPasswordPromptMode(mode);
    },
    [
      canUseBiometric,
      creating,
      nativeWalletOperationPending,
      refreshBiometricStatus,
      registeredWallets.length,
    ],
  );

  const chooseSavedWallet = useCallback(
    async (walletId: string) => {
      if (creating || openingWalletId || nativeWalletOperationPending) {
        return;
      }
      const diagnosticId = `open-${Date.now().toString(36)}`;
      const startedAt = Date.now();
      let timedOut = false;
      setCreateError(undefined);
      setWalletOpenError(undefined);
      setOpeningWalletId(walletId);
      setNativeWalletOperationPending(true);
      setupLog(`chooseSavedWallet.start.${diagnosticId}`, {
        timeoutMs: WALLET_OPEN_TIMEOUT_MS,
      });
      const openOperation = openRegisteredWalletById(walletId);
      let settled = false;
      const slowTimer = setTimeout(() => {
        if (!settled) {
          setupLog(`chooseSavedWallet.slow.${diagnosticId}`, {
            elapsedMs: Date.now() - startedAt,
          });
        }
      }, WALLET_OPEN_SLOW_MS);
      openOperation.then(
        opened => {
          settled = true;
          clearTimeout(slowTimer);
          setNativeWalletOperationPending(false);
          if (timedOut && opened) {
            setWalletOpenError(
              `Wallet opening completed after the timeout (${diagnosticId}). Tap the wallet once more to continue.`,
            );
            setupLog(`chooseSavedWallet.lateSuccess.${diagnosticId}`, {
              elapsedMs: Date.now() - startedAt,
            });
          }
        },
        error => {
          settled = true;
          clearTimeout(slowTimer);
          setNativeWalletOperationPending(false);
          if (timedOut) {
            const message = errorMessage(error);
            setWalletOpenError(
              `Wallet opening failed after the timeout (${diagnosticId}): ${message}`,
            );
            setupLog(`chooseSavedWallet.lateError.${diagnosticId}`, {
              elapsedMs: Date.now() - startedAt,
            });
          }
        },
      );
      try {
        const opened = await rejectAfter(
          openOperation,
          WALLET_OPEN_TIMEOUT_MS,
          `Wallet opening exceeded 120 seconds (${diagnosticId}). The native operation is still being monitored.`,
          () => {
            timedOut = true;
            setupLog(`chooseSavedWallet.timeout.${diagnosticId}`, {
              elapsedMs: Date.now() - startedAt,
              timeoutMs: WALLET_OPEN_TIMEOUT_MS,
            });
          },
        );
        if (opened) {
          setupLog(`chooseSavedWallet.success.${diagnosticId}`, {
            elapsedMs: Date.now() - startedAt,
          });
          navigation.navigate('Home');
          return;
        }

        const selectedWallet = registeredWallets.find(
          wallet => wallet.id === walletId,
        );
        if (selectedWallet?.kind === 'hardware') {
          openPasswordPrompt('open');
          return;
        }

        // A legacy registration without its secure credential cannot be
        // unlocked by guessing a wallet password. Take the owner directly to
        // recovery without ever trying a different saved wallet.
        setRestoreStartDate('');
        setCreateError(
          'This wallet is missing its protected device credential. Restore it from the recovery seed to create a new local copy.',
        );
        setPasswordPromptMode('restore');
      } catch (error) {
        const message = errorMessage(error);
        setCreateError(message);
        setWalletOpenError(message);
        setupLog(`chooseSavedWallet.error.${diagnosticId}`, {
          elapsedMs: Date.now() - startedAt,
        });
      } finally {
        setOpeningWalletId(undefined);
      }
    },
    [
      creating,
      navigation,
      nativeWalletOperationPending,
      openPasswordPrompt,
      openRegisteredWalletById,
      openingWalletId,
      registeredWallets,
    ],
  );

  const closePasswordPrompt = useCallback(() => {
    const shouldReturnHome =
      passwordPromptMode === 'open' && route?.params?.mode === 'open';
    handledModeRequest.current = undefined;
    setPasswordPromptMode(undefined);
    if (shouldReturnHome) {
      navigation.navigate('Home');
    }
  }, [navigation, passwordPromptMode, route?.params?.mode]);

  const refreshLedgerTransport = useCallback(async (requestAccess = false) => {
    setLedgerBusy(true);
    setLedgerError(undefined);
    setupLog('refreshLedgerTransport.start', {
      requestAccess,
    });
    try {
      const nextStatus = requestAccess
        ? await withSystemUiInterruption('ledger-transport-permission', () =>
            walletService.requestLedgerTransportAccess(),
          )
        : await walletService.getLedgerTransportStatus();
      setLedgerStatus(nextStatus);
      setupLog('refreshLedgerTransport.success', {
        available: nextStatus.available,
        deviceCount: nextStatus.deviceCount,
        permissionGranted: nextStatus.permissionGranted,
        platform: nextStatus.platform,
        requiresUserAction: nextStatus.requiresUserAction,
        supported: nextStatus.supported,
        transport: nextStatus.transport,
      });
      return nextStatus;
    } catch (error) {
      setLedgerError(errorMessage(error));
      setupLog('refreshLedgerTransport.error', {
        error: errorMessage(error),
        requestAccess,
      });
      return undefined;
    } finally {
      setLedgerBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!openUsesHardwareWallet) {
      return;
    }

    setLedgerStatus(undefined);
    setLedgerError(undefined);
    refreshLedgerTransport(true).catch(() => undefined);
  }, [openUsesHardwareWallet, refreshLedgerTransport, registeredWallet?.id]);

  const openLedgerPrompt = () => {
    if (creating || nativeWalletOperationPending) {
      setupLog('openLedgerPrompt.skipped', {
        reason: creating ? 'creating' : 'native-wallet-operation',
      });
      return;
    }

    setupLog('openLedgerPrompt.start');
    setLedgerPromptVisible(true);
    setLedgerStatus(undefined);
    setLedgerError(undefined);
    refreshLedgerTransport(true).catch(() => undefined);
  };

  useEffect(() => {
    if (!isFocused) {
      return;
    }
    const requestedMode = route?.params?.mode;
    const requestKey = `${requestedMode ?? 'none'}:${
      route?.params?.openRequestId ?? 'once'
    }:${registeredWallet?.id ?? 'none'}`;
    if (handledModeRequest.current === requestKey) {
      return;
    }

    if (requestedMode === 'open') {
      if (!registeredWallet) {
        return;
      }
      handledModeRequest.current = requestKey;
      chooseSavedWallet(registeredWallet.id).catch(() => undefined);
      return;
    }

    if (requestedMode === 'create' || requestedMode === 'restore') {
      handledModeRequest.current = requestKey;
      openPasswordPrompt(requestedMode);
    }
  }, [
    isFocused,
    navigation,
    chooseSavedWallet,
    openPasswordPrompt,
    registeredWallet,
    route?.params?.mode,
    route?.params?.openRequestId,
  ]);

  const beginCreateAnimation = (
    steps: readonly TranslationKey[] = CREATE_STEPS,
  ) => {
    setupLog('beginCreateAnimation', {
      firstStep: steps[0],
      stepCount: steps.length,
    });
    setCreateStep(t(steps[0]));
  };

  const finishCreateAnimation = () => {
    setupLog('finishCreateAnimation', {
      currentStep: createStep,
    });
  };

  /**
   * A Fast Wallet is a second, independently generated wallet. It is never a
   * subaddress. Privacy + comfort also enrolls it with the signed official
   * Worker, but only after its own recovery words have been confirmed.
   */
  const createSelectedFastWallet = async (
    source: 'software' | 'restore' | 'hardware',
  ): Promise<boolean> => {
    if (!fastWalletEnabled) {
      return true;
    }

    const normalizedSlot = fastWalletSlotInput.trim();
    const productSlot = Number(normalizedSlot);
    if (
      !/^[1-9][0-9]{0,2}$/.test(normalizedSlot) ||
      !Number.isSafeInteger(productSlot) ||
      productSlot > 999
    ) {
      setupLog('createSelectedFastWallet.invalidSlot', {
        source,
      });
      Alert.alert(t('setup.fastWalletTitle'), t('setup.fastWalletSlotInvalid'));
      return false;
    }

    const startedAt = Date.now();
    setupLog('createSelectedFastWallet.start', {
      source,
      hostedScanning: true,
      productSlot,
    });
    try {
      const result = await walletService.createFastReceiveIdentity({
        // When the owner did not override the suggestion, re-resolve the next
        // safe slot inside WalletService at the moment of creation. This also
        // closes the small race between rendering the form and tapping Create.
        productSlot: fastWalletSlotEditedRef.current ? productSlot : undefined,
      });
      setFastWalletSlotInput(String(result.identity.derivationIndex));
      await reloadRegisteredWallet();
      const backedUp = await backupRegisteredWalletSeed(
        result.identity.id,
        t('settings.recoverySeedWarning'),
      );
      await reloadRegisteredWallet();
      setupLog('createSelectedFastWallet.success', {
        elapsedMs: Date.now() - startedAt,
        identityId: result.identity.id,
        seedBackedUp: backedUp,
      });
      if (!backedUp) {
        Alert.alert(
          t('setup.fastWalletTitle'),
          t('setup.fastWalletBackupRequired'),
        );
        return false;
      }
      try {
        setupLog('createSelectedFastWallet.enrollmentStart', {
          identityId: result.identity.id,
        });
        setFastWalletTransferStatus('transferring');
        setCreateStep(t('setup.fastWalletTransferSending'));
        await walletService.enableEncryptedFastWalletAlerts({
          identityId: result.identity.id,
        });
        setFastWalletTransferStatus('accepted');
        setCreateStep(t('setup.fastWalletTransferAccepted'));
        setupLog('createSelectedFastWallet.enrollmentSuccess', {
          identityId: result.identity.id,
        });
        // Keep the confirmed green state visible long enough to be understood.
        // Network startup still happens only after this setup flow and cannot
        // replace or race the server acknowledgement shown here.
        await new Promise<void>(resolve => setTimeout(resolve, 650));
        return true;
      } catch (error) {
        const message = errorMessage(error);
        setFastWalletTransferStatus('failed');
        setCreateStep(t('setup.fastWalletTransferFailed'));
        setupLog('createSelectedFastWallet.enrollmentError', {
          identityId: result.identity.id,
          error: message,
        });
        Alert.alert(
          t('setup.fastWalletTitle'),
          `The Fast Wallet is safe on this device, but its encrypted payment-alert setup failed: ${message}`,
        );
        return false;
      }
    } catch (error) {
      const message = errorMessage(error);
      const failureCode = classifyDiagnosticFailure(error);
      setupLog('createSelectedFastWallet.error', {
        elapsedMs: Date.now() - startedAt,
        error: message,
        failureCode,
      });
      Alert.alert(
        t('setup.fastWalletTitle'),
        fastWalletCreationFailureText(error, productSlot),
      );
      return false;
    }
  };

  const startCreateWalletWithDeviceSecret = async () => {
    if (creating) {
      setupLog('startCreateWalletWithDeviceSecret.skipped', {
        canUseBiometric,
        creating,
      });
      return;
    }

    const startedAt = Date.now();
    setupLog('startCreateWalletWithDeviceSecret.start', {
      biometryType: biometricStatus?.biometryType,
      usesBiometric: canUseBiometric,
    });
    setCreating(true);
    setCreatingKind('software');
    setFastWalletTransferStatus('idle');
    setPasswordPromptMode(undefined);
    setCreateError(undefined);
    beginCreateAnimation(CREATE_STEPS);

    try {
      const result = await walletService.createNamedWalletWithStoredSecret({
        walletName: DEFAULT_WALLET_NAME,
        language: 'English',
        authentication: 'if-available',
        onProgress: phase => {
          const stepByPhase = {
            settings: 'setup.step.preparingStorage',
            storage: 'setup.step.preparingStorage',
            secret: 'setup.step.generatingEntropy',
            'native-wallet': 'setup.step.derivingKeys',
            registry: 'setup.step.preparingBackup',
          } as const;
          setCreateStep(t(stepByPhase[phase]));
          setupLog(`startCreateWalletWithDeviceSecret.phase.${phase}`, {
            elapsedMs: Date.now() - startedAt,
          });
        },
      });
      setupLog('startCreateWalletWithDeviceSecret.primaryCreated', {
        elapsedMs: Date.now() - startedAt,
      });
      await registerOpenedSession(result.session, result.registration, {
        refresh: false,
        // Seed backup is the next native operation. Starting setDaemon here
        // would occupy the shared native wallet queue for tens of seconds and
        // leave the recovery-seed request stuck behind network initialization.
        startNetwork: false,
      });
      setupLog('startCreateWalletWithDeviceSecret.registered', {
        registrationId: result.registration.id,
        walletName: result.registration.walletName,
      });
      setupLog('startCreateWalletWithDeviceSecret.syncDeferred', {
        reason: 'seedBackupRequired',
        walletId: result.session.walletId,
      });

      finishCreateAnimation();
      const seedBackedUp = await walletService.presentRecoverySeed(
        result.session,
        t('settings.recoverySeedWarning'),
      );
      if (seedBackedUp) {
        await walletService.markRegisteredWalletSeedBackedUp(
          result.registration.id,
        );
        await reloadRegisteredWallet();
        await createSelectedFastWallet('software');
      } else if (fastWalletEnabled) {
        setupLog('createSelectedFastWallet.skipped', {
          reason: 'primary-seed-backup-not-confirmed',
        });
        Alert.alert(
          t('setup.fastWalletTitle'),
          t('setup.fastWalletPrimaryBackupFirst'),
        );
      }
      // Network startup is deliberately scheduled only after every immediate
      // recovery-seed screen has finished. The registration call returns
      // without waiting for setDaemon, so navigation remains instantaneous.
      await registerOpenedSession(result.session, result.registration, {
        refresh: false,
        startNetwork: true,
      });
      setupLog('startCreateWalletWithDeviceSecret.networkScheduled', {
        elapsedMs: Date.now() - startedAt,
      });
      setupLog('startCreateWalletWithDeviceSecret.success', {
        elapsedMs: Date.now() - startedAt,
        seedBackedUp,
      });
      navigation.navigate('Home');
    } catch (error) {
      finishCreateAnimation();
      setCreateError(errorMessage(error));
      setPasswordPromptMode('create');
      refreshBiometricStatus().catch(() => undefined);
      setupLog('startCreateWalletWithDeviceSecret.error', {
        elapsedMs: Date.now() - startedAt,
        error: errorMessage(error),
      });
    } finally {
      setCreating(false);
    }
  };

  const startRestoreWallet = async () => {
    if (creating || !passwordReady) {
      setupLog('startRestoreWallet.skipped', {
        creating,
        passwordReady,
        restoreStartDateReady,
      });
      return;
    }

    const startedAt = Date.now();
    try {
      const settings = await loadActiveNodeConnectionSettings();
      const restoreHeight = restoreHeightFromStartDate(
        restoreStartDate,
        settings.network,
      );
      setupLog('startRestoreWallet.start', {
        restoreHeight: restoreHeight ?? 0,
        restoreStartDate: restoreStartDate || 'automatic',
        seedBoundary: 'native',
      });
      setCreating(true);
      setCreatingKind('restore');
      setFastWalletTransferStatus('idle');
      setPasswordPromptMode(undefined);
      setCreateError(undefined);
      beginCreateAnimation(RESTORE_STEPS);
      const result = await walletService.restoreNamedWalletWithNativeSeed({
        walletName: DEFAULT_WALLET_NAME,
        network: settings.network,
        restoreHeight,
      });
      await registerOpenedSession(result.session, result.registration, {
        refresh: false,
      });
      setupLog('startRestoreWallet.registered', {
        registrationId: result.registration.id,
        walletName: result.registration.walletName,
      });
      setupLog('startRestoreWallet.syncDeferred', {
        reason: 'setupNavigation',
        walletId: result.session.walletId,
      });

      finishCreateAnimation();
      setRestoreStartDate('');
      await createSelectedFastWallet('restore');
      navigation.navigate('Home');
      setupLog('startRestoreWallet.success', {
        elapsedMs: Date.now() - startedAt,
      });
    } catch (error) {
      finishCreateAnimation();
      setCreateError(errorMessage(error));
      setPasswordPromptMode('restore');
      setupLog('startRestoreWallet.error', {
        elapsedMs: Date.now() - startedAt,
        error: errorMessage(error),
      });
    } finally {
      setCreating(false);
    }
  };

  const startCreateHardwareWallet = async () => {
    if (creating || !ledgerRestoreStartDateReady) {
      setupLog('startCreateHardwareWallet.skipped', {
        reason: creating ? 'creating' : 'invalidStartDate',
      });
      if (!ledgerRestoreStartDateReady) {
        setLedgerError(t('setup.scanDateError'));
      }
      return;
    }

    const startedAt = Date.now();
    try {
      const settings = await loadActiveNodeConnectionSettings();
      const restoreHeight = restoreHeightFromStartDate(
        ledgerRestoreStartDate,
        settings.network,
      );
      setupLog('startCreateHardwareWallet.start', {
        fastWalletEnabled,
        persistLedgerViewOnly,
        restoreHeight: restoreHeight ?? 0,
        restoreStartDate: ledgerRestoreStartDate || 'automatic',
      });
      setCreating(true);
      setCreatingKind('hardware');
      setHardwareSetupProgress(undefined);
      setPasswordPromptMode(undefined);
      setCreateError(undefined);
      beginCreateAnimation(HARDWARE_STEPS);
      const transportStatus =
        await walletService.requestLedgerTransportAccess();
      setLedgerStatus(transportStatus);
      setupLog('startCreateHardwareWallet.transport', {
        available: transportStatus.available,
        deviceCount: transportStatus.deviceCount,
        permissionGranted: transportStatus.permissionGranted,
        supported: transportStatus.supported,
        transport: transportStatus.transport,
      });
      if (!ledgerTransportReady(transportStatus)) {
        setupLog('startCreateHardwareWallet.transportNotReady', {
          available: transportStatus.available,
          deviceCount: transportStatus.deviceCount,
          permissionGranted: transportStatus.permissionGranted,
          requiresUserAction: transportStatus.requiresUserAction,
          supported: transportStatus.supported,
          transport: transportStatus.transport,
        });
        throw new Error(transportStatus.message);
      }

      const deviceName =
        transportStatus.transport === 'ble' ? 'Ledger:ble' : 'Ledger';
      // This is the sole native request for the private view key. Keep the
      // Ledger approval instruction visible until that request resolves.
      setLedgerViewKeyExportPending(persistLedgerViewOnly);
      const result = await walletService.createNamedWalletFromDevice({
        walletName: DEFAULT_HARDWARE_WALLET_NAME,
        network: settings.network,
        deviceName,
        restoreHeight,
        enableLocalViewOnly: persistLedgerViewOnly,
      });
      // The initial Ledger/view-wallet operation is complete. Do not keep the
      // device-export message visible while the distinct Worker enrollment
      // runs below.
      setLedgerViewKeyExportPending(false);
      await registerOpenedSession(result.session, result.registration, {
        refresh: false,
        // Do not let daemon startup race the optional Fast Wallet backup
        // flow. The normal WalletState refresh is scheduled immediately
        // before navigation below.
        startNetwork: false,
      });
      setupLog('startCreateHardwareWallet.registered', {
        registrationId: result.registration.id,
        walletName: result.registration.walletName,
      });
      if (fastWalletEnabled) {
        // A Ledger Monero account shares the Ledger root private view key and
        // is never an independently hostable Fast Wallet. Create the same
        // separately backed-up software Fast Wallet offered by software setup.
        await createSelectedFastWallet('hardware');
      }
      // WalletState already owns the long-running refresh and automatically
      // performs Ledger Key-Image reconciliation once the local companion
      // reaches the chain tip. Setup must not duplicate that work or keep the
      // owner on a full-screen "syncing history" barrier for minutes.
      await registerOpenedSession(result.session, result.registration, {
        refresh: false,
        startNetwork: true,
      });
      setupLog('startCreateHardwareWallet.verificationDeferred', {
        phase: 'checking-local-scan',
      });
      setupLog('startCreateHardwareWallet.setupComplete', {
        ledgerVerified: false,
        transactionHistoryReady: false,
      });

      finishCreateAnimation();
      setLedgerPromptVisible(false);
      setLedgerRestoreStartDate('');
      navigation.navigate('Home');
      // Registration and the selected session are already in WalletState.
      // Refreshing the complete list is useful but must not delay navigation.
      void reloadRegisteredWallets().catch(error => {
        setupLog('startCreateHardwareWallet.walletListRefreshDeferred', {
          error: errorMessage(error),
        });
      });
      setupLog('startCreateHardwareWallet.success', {
        elapsedMs: Date.now() - startedAt,
      });
    } catch (error) {
      finishCreateAnimation();
      setCreateError(errorMessage(error));
      setLedgerError(errorMessage(error));
      setLedgerPromptVisible(true);
      setupLog('startCreateHardwareWallet.error', {
        elapsedMs: Date.now() - startedAt,
        error: errorMessage(error),
      });
    } finally {
      setLedgerViewKeyExportPending(false);
      setHardwareSetupProgress(undefined);
      setCreating(false);
    }
  };

  const openExistingWallet = async () => {
    if (creating || !passwordReady) {
      setupLog('openExistingWallet.skipped', {
        creating,
        passwordReady,
      });
      return;
    }

    if (openUsesHardwareWallet && !hardwareTransportReady) {
      const message =
        ledgerError ??
        ledgerStatus?.message ??
        'Connect a Ledger Nano before opening this wallet';
      setCreateError(message);
      refreshLedgerTransport(true).catch(() => undefined);
      return;
    }

    const startedAt = Date.now();
    setCreating(true);
    setCreatingKind(
      registeredWallet?.kind === 'hardware' ? 'hardware' : 'open',
    );
    setPasswordPromptMode(undefined);
    setCreateError(undefined);
    beginCreateAnimation(
      registeredWallet?.kind === 'hardware' ? HARDWARE_STEPS : OPEN_STEPS,
    );
    setCreateStep(t('setup.step.openingWallet'));

    try {
      setupLog('openExistingWallet.start', {
        kind: registeredWallet?.kind,
        walletName: registeredWallet?.walletName,
      });
      const session = await walletService.openRegisteredWallet();
      const wallet = await walletService.loadRegisteredWallet();
      await registerOpenedSession(session, wallet, {
        refresh: false,
      });
      setupLog('openExistingWallet.registered', {
        walletName: wallet?.walletName,
      });
      refreshSnapshot()
        .then(() => setupLog('openExistingWallet.localSnapshot.success'))
        .catch(error =>
          setupLog('openExistingWallet.localSnapshot.error', {
            error: errorMessage(error),
          }),
        );
      refreshTransactions()
        .then(() => setupLog('openExistingWallet.localTransactions.success'))
        .catch(error =>
          setupLog('openExistingWallet.localTransactions.error', {
            error: errorMessage(error),
          }),
        );
      setupLog('openExistingWallet.syncDeferred', {
        reason: 'openedOfflineFirst',
        walletId: session.walletId,
      });
      finishCreateAnimation();
      navigation.navigate('Home');
      setupLog('openExistingWallet.success', {
        elapsedMs: Date.now() - startedAt,
      });
    } catch (error) {
      finishCreateAnimation();
      setCreateError(errorMessage(error));
      setPasswordPromptMode('open');
      refreshBiometricStatus().catch(() => undefined);
      setupLog('openExistingWallet.error', {
        elapsedMs: Date.now() - startedAt,
        error: errorMessage(error),
      });
    } finally {
      setCreating(false);
    }
  };

  const submitPasswordPrompt = () => {
    setupLog('submitPasswordPrompt', {
      mode: passwordPromptMode,
      passwordReady,
    });
    if (passwordPromptMode === 'open') {
      if (openUsesHardwareWallet && !hardwareTransportReady) {
        refreshLedgerTransport(true).catch(() => undefined);
        return;
      }
      openExistingWallet();
      return;
    }

    if (passwordPromptMode === 'restore') {
      startRestoreWallet();
      return;
    }

    startCreateWalletWithDeviceSecret();
  };

  const parsedFastWalletSlot = Number(fastWalletSlotInput);
  const fastWalletSlotDescription =
    Number.isSafeInteger(parsedFastWalletSlot) && parsedFastWalletSlot > 199
      ? t('setup.fastWalletSlotRetiredDescription', {
          slot: parsedFastWalletSlot,
        })
      : t('setup.fastWalletSlotDescription');

  return (
    <LinearGradient
      colors={['#12082A', '#0A0A18', '#07071A']}
      locations={[0, 0.5, 1]}
      style={s.container}
    >
      <StatusBar barStyle="light-content" backgroundColor="#12082A" />

      {/* Background ghost M */}
      <Animated.View
        style={[
          s.bgMonero,
          { opacity: bgOp, transform: [{ rotate: '10deg' }] },
        ]}
      >
        <MoneroCoinGhost size={500} color="rgba(255,255,255,0.035)" />
      </Animated.View>

      <Animated.View
        style={[
          s.content,
          { opacity: fadeIn, transform: [{ translateY: slideUp }] },
        ]}
      >
        {/* Logo */}
        <View style={s.logoWrap}>
          <MoneroCoin size={64} />
        </View>

        <Text style={s.title}>{t('setup.title')}</Text>
        <Text style={s.subtitle}>{t('setup.subtitle')}</Text>

        {registeredWallets.length > 0 ? (
          <View style={s.savedWalletSection}>
            <Text style={s.savedWalletTitle}>{t('setup.existingWallets')}</Text>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              snapToInterval={206}
              decelerationRate="fast"
              disableIntervalMomentum
              contentContainerStyle={s.savedWalletCarousel}
            >
              {registeredWallets.map(wallet => (
                <TouchableOpacity
                  key={wallet.id}
                  style={[
                    s.savedWalletCard,
                    wallet.id === registeredWallet?.id &&
                      s.savedWalletCardActive,
                  ]}
                  onPress={() => {
                    chooseSavedWallet(wallet.id).catch(() => undefined);
                  }}
                  disabled={
                    creating ||
                    openingWalletId !== undefined ||
                    nativeWalletOperationPending
                  }
                  activeOpacity={0.76}
                >
                  {openingWalletId === wallet.id ? (
                    <ActivityIndicator color={colors.orange} size="small" />
                  ) : (
                    <MoneroCoin size={30} />
                  )}
                  <View style={s.savedWalletCopy}>
                    <Text style={s.savedWalletName} numberOfLines={1}>
                      {walletDisplayName(wallet)}
                    </Text>
                    <Text style={s.savedWalletMeta} numberOfLines={1}>
                      {openingWalletId === wallet.id
                        ? `${t(
                            'setup.step.openingWallet',
                          )} · ${openingElapsedSeconds}s`
                        : isFastWalletRegistration(wallet)
                        ? 'Fast Wallet'
                        : wallet.kind === 'hardware'
                        ? 'Ledger'
                        : 'Mainnet'}
                    </Text>
                  </View>
                </TouchableOpacity>
              ))}
            </ScrollView>
            {walletOpenError ? (
              <Text
                accessibilityLiveRegion="assertive"
                style={s.walletOpenError}
              >
                {walletOpenError}
              </Text>
            ) : null}
          </View>
        ) : null}

        {/* Options */}
        <View style={s.options}>
          <SetupOption
            icon={<IcoPlus c={colors.orange} />}
            title={t('action.createWallet')}
            desc={t('setup.createDesc')}
            onPress={() => openPasswordPrompt('create')}
            disabled={creating || nativeWalletOperationPending}
          />
          <SetupOption
            icon={<IcoUsb c={colors.orange} />}
            title="Ledger Nano"
            desc={t('setup.hardware.desc')}
            onPress={openLedgerPrompt}
            disabled={creating || nativeWalletOperationPending}
          />
          <SetupOption
            icon={<IcoImport c={colors.orange} />}
            title={t('setup.importWallet')}
            desc={t('setup.importDesc')}
            onPress={() => openPasswordPrompt('restore')}
            disabled={creating || nativeWalletOperationPending}
          />
        </View>
      </Animated.View>

      {/* Footer */}
      <View style={s.footerBlock}>
        <TouchableOpacity
          accessibilityRole="link"
          accessibilityLabel="Made with love by TEX8"
          onPress={() => void Linking.openURL('https://solutions.tex8.com/en')}
          activeOpacity={0.72}
        >
          <Text style={s.footer}>
            Made with <Text style={{ color: colors.orange }}>❤️</Text> by{' '}
            <Text
              style={{ color: 'rgba(255,255,255,0.62)', fontWeight: '800' }}
            >
              TEX8
            </Text>
          </Text>
        </TouchableOpacity>
        <Text style={s.version}>v{mobileAppVersion.versionName}</Text>
      </View>

      <Modal
        visible={passwordPromptMode !== undefined}
        transparent
        animationType="fade"
        onRequestClose={closePasswordPrompt}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={s.promptKeyboard}
        >
          <View style={s.promptBackdrop}>
            <ScrollView
              style={s.promptScroller}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
              contentContainerStyle={s.promptScroll}
            >
              <View style={s.promptCard}>
                <Text style={s.promptTitle}>{passwordPromptTitle}</Text>
                <Text style={s.promptSubtitle}>{passwordPromptSubtitle}</Text>
                {passwordPromptMode === 'restore' ? (
                  <RestoreStartDateField
                    value={restoreStartDate}
                    onChange={setRestoreStartDate}
                    dateLocale={dateLocale}
                    t={t}
                  />
                ) : null}
                {passwordPromptMode === 'create' ||
                passwordPromptMode === 'restore' ? (
                  <View style={s.fastReceiveRow}>
                    <View style={s.fastReceiveText}>
                      <Text style={s.fastReceiveTitle}>
                        {t('setup.fastWalletToggle')}
                      </Text>
                      <Text style={s.fastReceiveValue}>
                        {t('setup.fastWalletToggleDescription')}
                      </Text>
                    </View>
                    <Switch
                      value={fastWalletEnabled}
                      onValueChange={changeFastWalletEnabled}
                      disabled={creating}
                      trackColor={{
                        false: 'rgba(255,255,255,0.12)',
                        true: colors.orange,
                      }}
                      thumbColor="#FFF"
                    />
                  </View>
                ) : null}
                {fastWalletEnabled &&
                (passwordPromptMode === 'create' ||
                  passwordPromptMode === 'restore') ? (
                  <View style={s.fastWalletSlotRow}>
                    <View style={s.fastReceiveText}>
                      <Text style={s.fastReceiveTitle}>
                        {t('setup.fastWalletSlot')}
                      </Text>
                      <Text style={s.fastReceiveValue}>
                        {fastWalletSlotDescription}
                      </Text>
                    </View>
                    <TextInput
                      accessibilityLabel={t('setup.fastWalletSlot')}
                      value={fastWalletSlotInput}
                      onChangeText={changeFastWalletSlot}
                      editable={!creating}
                      keyboardType="number-pad"
                      maxLength={3}
                      selectTextOnFocus
                      style={s.fastWalletSlotInput}
                    />
                  </View>
                ) : null}
                {showBiometricCard ? (
                  <View style={s.biometricBox}>
                    <View style={s.biometricHeader}>
                      <View
                        style={[
                          s.biometricDot,
                          (canUseBiometric || openUsesStoredSecret) &&
                            s.biometricDotReady,
                        ]}
                      />
                      <Text style={s.biometricTitle}>
                        {waitingForBiometricStatus
                          ? t('setup.biometric.checking')
                          : canUseBiometric
                          ? currentBiometricLabel
                          : t('setup.biometric.secureDeviceKey')}
                      </Text>
                      {waitingForBiometricStatus ? (
                        <ActivityIndicator color={colors.orange} />
                      ) : null}
                    </View>
                    <Text style={s.biometricText}>
                      {canUseBiometric
                        ? biometricError ??
                          biometricStatus?.message ??
                          t('setup.biometric.waiting')
                        : t('setup.biometric.storedSecret')}
                    </Text>
                  </View>
                ) : null}
                {openUsesHardwareWallet ? (
                  <View style={s.biometricBox}>
                    <View style={s.biometricHeader}>
                      <View
                        style={[
                          s.biometricDot,
                          hardwareTransportReady && s.biometricDotReady,
                        ]}
                      />
                      <Text style={s.biometricTitle}>
                        {ledgerBusy
                          ? t('setup.hardware.searching')
                          : ledgerStatusTitle(ledgerStatus, t)}
                      </Text>
                      {ledgerBusy ? (
                        <ActivityIndicator color={colors.orange} />
                      ) : null}
                    </View>
                    <Text style={s.biometricText}>
                      {ledgerError ??
                        ledgerStatus?.message ??
                        t('setup.hardware.looking')}
                    </Text>
                    {ledgerStatus ? (
                      <Text style={s.biometricText}>
                        {ledgerStatus.platform} · {ledgerStatus.transport} ·{' '}
                        {ledgerStatus.deviceCount} device
                        {ledgerStatus.deviceCount === 1 ? '' : 's'}
                      </Text>
                    ) : null}
                  </View>
                ) : null}
                {createError ? (
                  <Text style={s.errorText}>{createError}</Text>
                ) : null}
                <View style={s.promptActions}>
                  <TouchableOpacity
                    style={s.secondaryButton}
                    onPress={closePasswordPrompt}
                    disabled={creating}
                  >
                    <Text style={s.secondaryButtonText}>
                      {t('action.cancel')}
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[
                      s.primaryButton,
                      (!passwordReady ||
                        (openUsesHardwareWallet && ledgerBusy)) &&
                        s.primaryButtonDisabled,
                    ]}
                    onPress={submitPasswordPrompt}
                    disabled={
                      !passwordReady ||
                      creating ||
                      (openUsesHardwareWallet && ledgerBusy)
                    }
                  >
                    <Text
                      style={s.primaryButtonText}
                      numberOfLines={1}
                      adjustsFontSizeToFit
                      minimumFontScale={0.78}
                    >
                      {passwordPromptAction}
                    </Text>
                  </TouchableOpacity>
                </View>
              </View>
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <Modal
        visible={ledgerPromptVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setLedgerPromptVisible(false)}
      >
        <View style={s.promptBackdrop}>
          <ScrollView
            style={s.promptScroller}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
            contentContainerStyle={s.promptScroll}
          >
            <View style={s.promptCard}>
              <Text style={s.promptTitle}>Ledger Nano</Text>
              <Text style={s.promptSubtitle}>
                {t('setup.hardware.instructions')}
              </Text>

              <View style={s.ledgerStatusBox}>
                <View style={s.ledgerStatusHeader}>
                  <View
                    style={[
                      s.ledgerStatusDot,
                      ledgerTransportReady(ledgerStatus) &&
                        s.ledgerStatusDotReady,
                    ]}
                  />
                  <Text style={s.ledgerStatusTitle}>
                    {ledgerBusy
                      ? t('setup.hardware.searching')
                      : ledgerStatusTitle(ledgerStatus, t)}
                  </Text>
                  {ledgerBusy ? (
                    <ActivityIndicator color={colors.orange} />
                  ) : null}
                </View>
                <Text style={s.ledgerStatusText}>
                  {ledgerError ??
                    ledgerStatus?.message ??
                    t('setup.hardware.looking')}
                </Text>
                {ledgerStatus ? (
                  <View style={s.ledgerMetaRow}>
                    <Text style={s.ledgerMetaText}>
                      {ledgerStatus.platform} · {ledgerStatus.transport}
                    </Text>
                    <Text style={s.ledgerMetaText}>
                      {ledgerStatus.deviceCount} device
                      {ledgerStatus.deviceCount === 1 ? '' : 's'}
                    </Text>
                  </View>
                ) : null}
              </View>

              <RestoreStartDateField
                value={ledgerRestoreStartDate}
                onChange={setLedgerRestoreStartDate}
                dateLocale={dateLocale}
                required
                t={t}
              />
              <View style={s.fastReceiveRow}>
                <View style={s.fastReceiveText}>
                  <Text style={s.fastReceiveTitle}>
                    {t('setup.hardware.localViewTitle')}
                  </Text>
                  <Text style={s.fastReceiveValue}>
                    {t('setup.hardware.localViewDescription')}
                  </Text>
                </View>
                <Text style={{ color: colors.orange, fontSize: 20 }}>✓</Text>
              </View>
              <View style={s.fastReceiveRow}>
                <View style={s.fastReceiveText}>
                  <Text style={s.fastReceiveTitle}>
                    {t('setup.fastWalletToggle')}
                  </Text>
                  <Text style={s.fastReceiveValue}>
                    {t('setup.hardware.fastWalletDescription')}
                  </Text>
                </View>
                <Switch
                  value={fastWalletEnabled}
                  onValueChange={changeFastWalletEnabled}
                  trackColor={{
                    false: 'rgba(255,255,255,0.12)',
                    true: colors.orange,
                  }}
                  thumbColor="#FFF"
                />
              </View>
              {fastWalletEnabled ? (
                <View style={s.fastWalletSlotRow}>
                  <View style={s.fastReceiveText}>
                    <Text style={s.fastReceiveTitle}>
                      {t('setup.fastWalletSlot')}
                    </Text>
                    <Text style={s.fastReceiveValue}>
                      {fastWalletSlotDescription}
                    </Text>
                  </View>
                  <TextInput
                    accessibilityLabel={t('setup.fastWalletSlot')}
                    value={fastWalletSlotInput}
                    onChangeText={changeFastWalletSlot}
                    editable={!creating}
                    keyboardType="number-pad"
                    maxLength={3}
                    selectTextOnFocus
                    style={s.fastWalletSlotInput}
                  />
                </View>
              ) : null}
              <View style={s.promptActions}>
                <TouchableOpacity
                  style={s.secondaryButton}
                  onPress={() => setLedgerPromptVisible(false)}
                  disabled={ledgerBusy || creating}
                >
                  <Text style={s.secondaryButtonText}>
                    {t('action.cancel')}
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[
                    s.primaryButton,
                    (ledgerBusy || creating || !ledgerRestoreStartDateReady) &&
                      s.primaryButtonDisabled,
                  ]}
                  onPress={() => {
                    if (ledgerTransportReady(ledgerStatus)) {
                      startCreateHardwareWallet();
                      return;
                    }
                    refreshLedgerTransport(true).catch(() => undefined);
                  }}
                  disabled={
                    ledgerBusy || creating || !ledgerRestoreStartDateReady
                  }
                >
                  <Text style={s.primaryButtonText}>
                    {ledgerTransportReady(ledgerStatus)
                      ? t('action.createWallet')
                      : t('action.search')}
                  </Text>
                </TouchableOpacity>
              </View>
            </View>
          </ScrollView>
        </View>
      </Modal>

      <Modal
        visible={setupOverlayVisible}
        transparent={false}
        animationType="none"
        presentationStyle="fullScreen"
      >
        <View style={s.createModal}>
          <StatusBar barStyle="light-content" backgroundColor="#12082A" />
          <View style={s.createOverlay}>
            <LinearGradient
              colors={['#12082A', '#0A0A18', '#07071A']}
              locations={[0, 0.5, 1]}
              style={s.createOverlayFill}
            >
              <View style={s.createCardSlot}>
                <View style={[s.createCard, { width: createCardWidth }]}>
                  <MoneroCoin size={70} />
                  <Text style={s.createTitle}>
                    {creatingKind === 'hardware'
                      ? hardwareSetupProgress?.phase ===
                          'catching-up-local-scan' ||
                        hardwareSetupProgress?.phase === 'checking-local-scan'
                        ? t('setup.hardware.syncingHistoryTitle')
                        : hardwareSetupProgress?.phase ===
                            'deriving-owned-output-key-images' ||
                          hardwareSetupProgress?.phase ===
                            'saving-ledger-balance'
                        ? t('setup.hardware.verifyingTitle')
                        : t('setup.hardware.connecting')
                      : creatingKind === 'restore'
                      ? t('setup.importing')
                      : creatingKind === 'open'
                      ? t('setup.opening')
                      : t('action.createWallet')}
                  </Text>
                  <View style={s.createLoader}>
                    <ActivityIndicator color={colors.orange} size="large" />
                  </View>
                  <Text style={s.createStep}>
                    {creatingKind === 'hardware' &&
                    hardwareSetupProgress?.phase ===
                      'catching-up-local-scan'
                      ? `${t('setup.hardware.syncingHistory')} ${
                          hardwareSetupProgress.viewHeight ?? '?'
                        } / ${hardwareSetupProgress.targetHeight ?? '?'}`
                      : creatingKind === 'hardware' &&
                        hardwareSetupProgress?.phase === 'checking-local-scan'
                      ? t('setup.hardware.checkingHistory')
                      : creatingKind === 'hardware' &&
                        hardwareSetupProgress?.phase ===
                          'deriving-owned-output-key-images'
                      ? t('setup.hardware.verifyingOutputs')
                      : creatingKind === 'hardware' &&
                        hardwareSetupProgress?.phase === 'saving-ledger-balance'
                      ? t('setup.hardware.savingVerifiedBalance')
                      : createStep}{' '}
                    · {creatingElapsedSeconds}s
                  </Text>
                  {fastWalletTransferStatus !== 'idle' ? (
                    <View
                      accessibilityLiveRegion="polite"
                      accessibilityRole="text"
                      style={s.fastWalletTransferStatus}
                    >
                      <View
                        style={[
                          s.fastWalletTransferLed,
                          fastWalletTransferStatus === 'accepted'
                            ? s.fastWalletTransferLedAccepted
                            : fastWalletTransferStatus === 'failed'
                            ? s.fastWalletTransferLedFailed
                            : s.fastWalletTransferLedTransferring,
                        ]}
                      />
                      <Text style={s.fastWalletTransferText}>
                        {fastWalletTransferStatus === 'accepted'
                          ? t('setup.fastWalletTransferAccepted')
                          : fastWalletTransferStatus === 'failed'
                          ? t('setup.fastWalletTransferFailed')
                          : t('setup.fastWalletTransferSending')}
                      </Text>
                    </View>
                  ) : null}
                </View>
              </View>
            </LinearGradient>
          </View>
        </View>
      </Modal>

      <Modal
        visible={ledgerViewKeyExportPending}
        transparent
        animationType="fade"
        presentationStyle="overFullScreen"
      >
        <View style={s.promptBackdrop}>
          <View style={[s.promptCard, s.ledgerViewKeyExportCard]}>
            <MoneroCoin size={58} />
            <Text style={s.promptTitle}>
              {t('setup.hardware.exportViewKeyTitle')}
            </Text>
            <Text style={s.promptSubtitle}>
              {t('setup.hardware.exportViewKeyInstructions')}
            </Text>
            <View style={s.ledgerViewKeyExportWait}>
              <ActivityIndicator color={colors.orange} />
              <Text style={s.ledgerViewKeyExportWaitText}>
                {t('setup.hardware.exportViewKeyWaiting')}
              </Text>
            </View>
          </View>
        </View>
      </Modal>
    </LinearGradient>
  );
}

const s = StyleSheet.create({
  container: { flex: 1 },

  bgMonero: {
    position: 'absolute',
    top: (SH - 500) / 2,
    left: (SW - 500) / 2 + 150,
  },

  content: { flex: 1, justifyContent: 'center', paddingHorizontal: 24 },

  logoWrap: { alignSelf: 'center', marginBottom: 28 },

  title: {
    color: '#FFF',
    fontSize: 30,
    fontWeight: '800',
    textAlign: 'center',
    marginBottom: 10,
  },
  subtitle: {
    color: 'rgba(255,255,255,0.45)',
    fontSize: 16,
    textAlign: 'center',
    marginBottom: 40,
  },

  options: { gap: 12 },
  savedWalletSection: { marginBottom: 20 },
  savedWalletTitle: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0.8,
    marginBottom: 10,
    textTransform: 'uppercase',
  },
  savedWalletCarousel: { gap: 10, paddingRight: 24 },
  savedWalletCard: {
    width: 196,
    minHeight: 74,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderRadius: 16,
    padding: 13,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.09)',
    backgroundColor: 'rgba(255,255,255,0.045)',
  },
  savedWalletCardActive: {
    borderColor: colors.orange,
    backgroundColor: 'rgba(242,104,34,0.13)',
  },
  savedWalletCopy: { flex: 1 },
  savedWalletName: { color: '#FFF', fontSize: 15, fontWeight: '800' },
  savedWalletMeta: {
    color: 'rgba(255,255,255,0.45)',
    fontSize: 12,
    marginTop: 3,
  },
  walletOpenError: {
    color: colors.error,
    fontSize: 12,
    lineHeight: 17,
    marginTop: 10,
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderRadius: 18,
    padding: 20,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
  },
  optionDisabled: { opacity: 0.55 },
  optionIcon: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: 'rgba(242,104,34,0.1)',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 16,
  },
  optionText: { flex: 1 },
  optionTitle: {
    color: '#FFF',
    fontSize: 17,
    fontWeight: '700',
    marginBottom: 3,
  },
  optionDesc: {
    color: 'rgba(255,255,255,0.4)',
    fontSize: 13,
    fontWeight: '400',
  },
  optionArrow: {
    color: 'rgba(255,255,255,0.2)',
    fontSize: 24,
    fontWeight: '300',
    marginLeft: 8,
  },

  footerBlock: {
    alignItems: 'center',
    paddingBottom: 44,
  },
  footer: {
    color: 'rgba(255,255,255,0.25)',
    fontSize: 13,
    textAlign: 'center',
    fontWeight: '500',
  },
  version: {
    color: 'rgba(255,255,255,0.1)',
    fontSize: 9,
    fontWeight: '500',
    letterSpacing: 0.7,
    marginTop: 7,
  },

  promptKeyboard: { flex: 1 },
  promptBackdrop: {
    flex: 1,
    paddingHorizontal: 24,
    backgroundColor: 'rgba(0,0,0,0.72)',
  },
  promptScroller: { flex: 1, width: '100%' },
  promptScroll: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingTop: SH < 720 ? 20 : 34,
    paddingBottom: SH < 720 ? 44 : 124,
  },
  promptCard: {
    width: '100%',
    maxWidth: 520,
    maxHeight: SH - 170,
    alignSelf: 'center',
    borderRadius: 22,
    paddingTop: 22,
    paddingHorizontal: 22,
    paddingBottom: 22,
    backgroundColor: '#151227',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  promptTitle: {
    color: '#FFF',
    fontSize: 22,
    fontWeight: '800',
    marginBottom: 8,
  },
  promptSubtitle: {
    color: 'rgba(255,255,255,0.48)',
    fontSize: 13,
    lineHeight: 18,
    marginBottom: 18,
  },
  input: {
    height: 52,
    borderRadius: 14,
    paddingHorizontal: 16,
    marginBottom: 10,
    color: '#FFF',
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  restoreStartField: { marginBottom: 12 },
  restoreStartLabel: {
    color: 'rgba(255,255,255,0.8)',
    fontSize: 13,
    fontWeight: '700',
    marginBottom: 8,
  },
  restoreDateButton: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderRadius: 14,
    paddingHorizontal: 16,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  restoreDateButtonText: { color: '#FFF', fontSize: 15, fontWeight: '700' },
  restoreDateChevron: { color: colors.orange, fontSize: 19, fontWeight: '800' },
  restoreDateHint: {
    color: 'rgba(255,255,255,0.43)',
    fontSize: 12,
    lineHeight: 17,
    marginTop: 7,
  },
  restoreCalendar: {
    marginTop: 10,
    borderRadius: 14,
    padding: 12,
    backgroundColor: 'rgba(0,0,0,0.16)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  restoreCalendarHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  restoreCalendarNav: {
    width: 34,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 9,
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  restoreCalendarNavText: { color: '#FFF', fontSize: 24, lineHeight: 26 },
  restoreCalendarMonth: {
    flex: 1,
    color: '#FFF',
    fontSize: 14,
    fontWeight: '800',
    textAlign: 'center',
  },
  restoreCalendarGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  restoreWeekday: {
    width: '14.2857%',
    color: 'rgba(255,255,255,0.4)',
    fontSize: 11,
    fontWeight: '800',
    textAlign: 'center',
    marginBottom: 6,
  },
  restoreCalendarDay: {
    width: '14.2857%',
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 9,
  },
  restoreCalendarDaySelected: { backgroundColor: colors.orange },
  restoreCalendarDayText: {
    color: 'rgba(255,255,255,0.86)',
    fontSize: 13,
    fontWeight: '700',
  },
  restoreCalendarDayTextSelected: { color: '#FFF' },
  restoreCalendarDayTextDisabled: { color: 'rgba(255,255,255,0.18)' },
  restoreAutomaticButton: {
    minHeight: 38,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 8,
    borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  restoreAutomaticText: {
    color: colors.orange,
    fontSize: 13,
    fontWeight: '800',
  },
  errorText: {
    color: '#FF8A80',
    fontSize: 13,
    lineHeight: 18,
    marginBottom: 10,
  },
  fastReceiveRow: {
    minHeight: 68,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginBottom: 12,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  fastReceiveText: { flex: 1, paddingRight: 12 },
  fastReceiveTitle: { color: '#FFF', fontSize: 14, fontWeight: '700' },
  fastReceiveValue: {
    color: 'rgba(255,255,255,0.42)',
    fontSize: 12,
    lineHeight: 17,
    marginTop: 3,
  },
  fastWalletSlotRow: {
    minHeight: 74,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginBottom: 12,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  fastWalletSlotInput: {
    width: 72,
    minHeight: 44,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.2)',
    color: '#FFF',
    fontSize: 18,
    fontWeight: '800',
    textAlign: 'center',
    backgroundColor: 'rgba(0,0,0,0.24)',
  },
  createMethodRow: {
    minHeight: 48,
    flexDirection: 'row',
    gap: 8,
    marginBottom: 12,
    padding: 4,
    borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.055)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  createMethodButton: {
    flex: 1,
    minHeight: 38,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 10,
    paddingHorizontal: 8,
  },
  createMethodButtonActive: {
    backgroundColor: 'rgba(242,104,34,0.92)',
  },
  createMethodText: {
    color: 'rgba(255,255,255,0.55)',
    fontSize: 13,
    fontWeight: '800',
    textAlign: 'center',
  },
  createMethodTextActive: { color: '#FFF' },
  biometricBox: {
    minHeight: 92,
    borderRadius: 16,
    padding: 16,
    marginBottom: 12,
    backgroundColor: 'rgba(255,255,255,0.055)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  biometricHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 8,
  },
  biometricDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: colors.warning,
  },
  biometricDotReady: { backgroundColor: colors.success },
  biometricTitle: {
    flex: 1,
    color: '#FFF',
    fontSize: 15,
    fontWeight: '800',
  },
  biometricText: {
    color: 'rgba(255,255,255,0.55)',
    fontSize: 13,
    lineHeight: 19,
  },
  ledgerStatusBox: {
    minHeight: 118,
    borderRadius: 16,
    padding: 16,
    marginBottom: 14,
    backgroundColor: 'rgba(255,255,255,0.055)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  ledgerStatusHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 10,
  },
  ledgerStatusDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: colors.warning,
  },
  ledgerStatusDotReady: { backgroundColor: colors.success },
  ledgerStatusTitle: {
    flex: 1,
    color: '#FFF',
    fontSize: 15,
    fontWeight: '800',
  },
  ledgerStatusText: {
    color: 'rgba(255,255,255,0.55)',
    fontSize: 13,
    lineHeight: 19,
  },
  ledgerMetaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
    marginTop: 14,
  },
  ledgerMetaText: {
    color: 'rgba(255,255,255,0.34)',
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  ledgerFastHint: {
    color: 'rgba(255,255,255,0.48)',
    fontSize: 12,
    lineHeight: 18,
    marginTop: -2,
    marginBottom: 12,
  },
  ledgerViewKeyExportCard: {
    alignItems: 'center',
    borderColor: 'rgba(255,157,24,0.55)',
  },
  ledgerViewKeyExportWait: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 20,
  },
  ledgerViewKeyExportWaitText: {
    color: colors.orange,
    fontSize: 14,
    fontWeight: '800',
  },
  promptActions: { flexDirection: 'row', gap: 12, marginTop: 10 },
  secondaryButton: {
    flex: 1,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
  },
  secondaryButtonText: {
    color: 'rgba(255,255,255,0.75)',
    fontSize: 15,
    fontWeight: '700',
  },
  primaryButton: {
    flex: 1,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 14,
    backgroundColor: colors.orange,
  },
  primaryButtonDisabled: { opacity: 0.45 },
  primaryButtonText: { color: '#FFF', fontSize: 15, fontWeight: '800' },

  createModal: { flex: 1, backgroundColor: '#0A0A18' },
  createOverlay: { flex: 1, overflow: 'hidden', backgroundColor: '#0A0A18' },
  createOverlayFill: {
    flex: 1,
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: CREATE_CARD_HORIZONTAL_MARGIN,
  },
  createCardSlot: {
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  createCard: {
    alignSelf: 'center',
    borderRadius: 20,
    minHeight: 228,
    paddingHorizontal: 20,
    paddingVertical: 28,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.055)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  createTitle: {
    width: '100%',
    color: '#FFF',
    fontSize: 26,
    fontWeight: '800',
    marginTop: 16,
    marginBottom: 18,
    textAlign: 'center',
  },
  createLoader: {
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 14,
  },
  createStep: {
    width: '100%',
    minHeight: 20,
    color: colors.orange,
    fontSize: 15,
    fontWeight: '700',
    textAlign: 'center',
  },
  fastWalletTransferStatus: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 9,
    marginTop: 14,
    paddingHorizontal: 12,
  },
  fastWalletTransferLed: {
    width: 11,
    height: 11,
    borderRadius: 6,
  },
  fastWalletTransferLedTransferring: {
    backgroundColor: '#FF9D18',
    shadowColor: '#FF9D18',
    shadowOpacity: 0.9,
    shadowRadius: 7,
    elevation: 5,
  },
  fastWalletTransferLedAccepted: {
    backgroundColor: '#25D98B',
    shadowColor: '#25D98B',
    shadowOpacity: 0.9,
    shadowRadius: 7,
    elevation: 5,
  },
  fastWalletTransferLedFailed: {
    backgroundColor: '#FF5A72',
  },
  fastWalletTransferText: {
    flexShrink: 1,
    color: '#E9E4EE',
    fontSize: 13,
    fontWeight: '700',
    textAlign: 'center',
  },
});
