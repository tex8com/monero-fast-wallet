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
  TextInput,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Switch,
  ActivityIndicator,
  Linking,
  useWindowDimensions,
} from 'react-native';
import LinearGradient from 'react-native-linear-gradient';
import Svg, { Path, Rect, Circle, Line } from 'react-native-svg';
import { colors } from '../theme/colors';
import MoneroCoinGhost from '../components/MoneroCoinGhost';
import MoneroCoin from '../components/MoneroCoin';
import { walletService } from '../services/WalletService';
import { type TranslationKey, useI18n } from '../i18n';
import { useWalletState } from '../services/WalletState';
import { logWalletEvent } from '../services/WalletLogger';
import { FastWalletPushService } from '../services/FastWalletPushService';
import { verifyFastReceiveScannerCapability } from '../services/FastReceiveScannerClient';
import {
  loadEnthusiastDiscoveryPreference,
  refreshApproximateEnthusiastLocation,
  setEnthusiastDiscoveryEnabled,
} from '../services/EnthusiastDiscoveryService';
import {
  fastReceiveScannerUrlForSettings,
  loadActiveNodeConnectionSettings,
} from '../services/NodeConnectionSettings';
import type {
  BiometricAuthStatus,
  LedgerTransportStatus,
} from '../services/NativeMoneroWallet';
import {
  isFastWalletRegistration,
  walletDisplayName,
} from '../services/WalletRegistry';
import {
  dateInputValue,
  isRestoreStartDateValid,
  parseRestoreStartDate,
  restoreHeightFromStartDate,
  todayRestoreDate,
} from '../services/RestoreStart';
import { useAppSecurity } from '../services/AppSecurity';

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
const MONERO_SEED_WORD_COUNT = 25;
const CREATE_CARD_HORIZONTAL_MARGIN = 20;
const CREATE_CARD_MAX_WIDTH = 360;
type PasswordPromptMode = 'create' | 'open' | 'restore';
type CreationKind = 'software' | 'hardware' | 'restore' | 'open';
type CreateCredentialMode = 'device' | 'password';
type FastReceiveRegistrationCredentials = {
  password?: string;
  secretKey?: string;
};
type PendingSeedBackup = {
  registrationId: string;
  seed: string;
};

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function setupLog(event: string, fields: Record<string, unknown> = {}) {
  logWalletEvent('WalletSetup', event, fields);
}

function normalizeSeed(seed: string): string {
  return seed.trim().replace(/\s+/g, ' ');
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
  if (!status.available) {
    return t('setup.hardware.waiting');
  }
  if (status.requiresUserAction || !status.permissionGranted) {
    return t('setup.hardware.permissionRequired');
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
  t,
}: {
  value: string;
  onChange: (value: string) => void;
  dateLocale: string;
  t: (key: TranslationKey) => string;
}) {
  const [calendarVisible, setCalendarVisible] = useState(false);
  const [calendarMonth, setCalendarMonth] = useState(() => new Date());
  const valid = isRestoreStartDateValid(value);
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
      <Text style={s.restoreDateHint}>{t('setup.scanDateHint')}</Text>
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
        </View>
      ) : null}
    </View>
  );
}

/* ── Screen ─────────────────────────────────────────────────────────── */
export default function WalletSetupScreen({ navigation, route }: any) {
  const { dateLocale, t } = useI18n();
  const { width: windowWidth } = useWindowDimensions();
  const createCardWidth = Math.min(
    CREATE_CARD_MAX_WIDTH,
    Math.max(280, windowWidth - CREATE_CARD_HORIZONTAL_MARGIN * 2),
  );
  const fadeIn = useRef(new Animated.Value(0)).current;
  const slideUp = useRef(new Animated.Value(30)).current;
  const bgOp = useRef(new Animated.Value(0)).current;
  const seedBackupTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handledModeRequest = useRef<string | undefined>(undefined);
  const [creating, setCreating] = useState(false);
  const [creatingKind, setCreatingKind] = useState<CreationKind>('software');
  const [passwordPromptMode, setPasswordPromptMode] = useState<
    PasswordPromptMode | undefined
  >();
  const [createCredentialMode, setCreateCredentialMode] =
    useState<CreateCredentialMode>('device');
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
  const [walletPassword, setWalletPassword] = useState('');
  const [walletPasswordConfirm, setWalletPasswordConfirm] = useState('');
  const [restoreSeed, setRestoreSeed] = useState('');
  const [restoreStartDate, setRestoreStartDate] = useState('');
  const [ledgerRestoreStartDate, setLedgerRestoreStartDate] = useState('');
  const [pendingWalletOpenId, setPendingWalletOpenId] = useState<
    string | undefined
  >();
  const [createStep, setCreateStep] = useState(() => t(CREATE_STEPS[0]));
  const [createError, setCreateError] = useState<string | undefined>();
  const [createdSeed, setCreatedSeed] = useState('');
  const [createdSeedWalletId, setCreatedSeedWalletId] = useState<
    string | undefined
  >();
  const [pendingSeedBackup, setPendingSeedBackup] = useState<
    PendingSeedBackup | undefined
  >();
  const [seedConfirmed, setSeedConfirmed] = useState(false);
  const [createFastReceiveOnSetup, setCreateFastReceiveOnSetup] =
    useState(true);
  const [persistLedgerViewOnly, setPersistLedgerViewOnly] = useState(false);
  const [
    enableEnthusiastDiscoveryOnSetup,
    setEnableEnthusiastDiscoveryOnSetup,
  ] = useState(true);
  const { mode: appProtectionMode } = useAppSecurity();
  const {
    registeredWallet,
    registeredWallets,
    refreshSnapshot,
    refreshTransactions,
    registerOpenedSession,
    reloadRegisteredWallet,
    reloadRegisteredWallets,
    setActiveRegisteredWallet,
  } = useWalletState();

  const changePersistLedgerViewOnly = useCallback(
    (enabled: boolean) => {
      if (enabled && appProtectionMode === 'none') {
        setPersistLedgerViewOnly(false);
        setLedgerError(t('setup.hardware.localViewProtectionRequired'));
        return;
      }

      setLedgerError(undefined);
      setPersistLedgerViewOnly(enabled);
    },
    [appProtectionMode, t],
  );

  useEffect(() => {
    let mounted = true;
    loadEnthusiastDiscoveryPreference()
      .then(preference => {
        if (mounted && preference.updatedAt) {
          setEnableEnthusiastDiscoveryOnSetup(preference.enabled);
        }
      })
      .catch(() => undefined);
    return () => {
      mounted = false;
    };
  }, []);
  const normalizedRestoreSeed = normalizeSeed(restoreSeed);
  const restoreSeedWordCount = normalizedRestoreSeed
    ? normalizedRestoreSeed.split(' ').length
    : 0;
  const restoreStartDateReady = isRestoreStartDateValid(restoreStartDate);
  const ledgerRestoreStartDateReady = isRestoreStartDateValid(
    ledgerRestoreStartDate,
  );
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
  const showCreateMethodChoices = false;
  const showBiometricCard = false;
  const showPasswordFields =
    passwordPromptMode === 'open' &&
    !openUsesStoredSecret &&
    !openUsesHardwareWallet;
  const passwordReady =
    passwordPromptMode === 'open'
      ? openUsesStoredSecret ||
        openUsesHardwareWallet ||
        walletPassword.length > 0
      : passwordPromptMode === 'restore'
        ? restoreSeedWordCount === MONERO_SEED_WORD_COUNT &&
          restoreStartDateReady
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
          : t('setup.prompt.openPassword')
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
  const seedWords = createdSeed.trim().split(/\s+/).filter(Boolean);
  const seedSubtitle =
    seedWords.length === MONERO_SEED_WORD_COUNT
      ? t('setup.seedSubtitle')
      : t('setup.seedSubtitleDynamic', { count: seedWords.length });
  const setupOverlayVisible =
    creating || Boolean(pendingSeedBackup) || createdSeed.length > 0;
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

  const clearSeedBackupTimer = () => {
    if (seedBackupTimer.current) {
      clearTimeout(seedBackupTimer.current);
      seedBackupTimer.current = null;
    }
  };

  useEffect(() => () => clearSeedBackupTimer(), []);

  const openPasswordPrompt = useCallback(
    (mode: PasswordPromptMode) => {
      if (creating) {
        setupLog('openPasswordPrompt.skipped', {
          mode,
          reason: 'creating',
        });
        return;
      }

      setupLog('openPasswordPrompt.start', {
        canUseBiometric,
        createCredentialMode,
        mode,
        registeredWalletCount: registeredWallets.length,
      });
      setCreateError(undefined);
      setWalletPassword('');
      setWalletPasswordConfirm('');
      if (mode === 'restore') {
        setRestoreSeed('');
        setRestoreStartDate('');
      }
      if (mode === 'create') {
        setCreateCredentialMode('device');
      }
      if (mode === 'create' || mode === 'open') {
        refreshBiometricStatus().catch(() => undefined);
      }
      setPasswordPromptMode(mode);
    },
    [
      canUseBiometric,
      createCredentialMode,
      creating,
      refreshBiometricStatus,
      registeredWallets.length,
    ],
  );

  const chooseSavedWallet = useCallback(
    async (walletId: string) => {
      if (creating) {
        return;
      }
      setCreateError(undefined);
      setPendingWalletOpenId(walletId);
      await setActiveRegisteredWallet(walletId);
      await reloadRegisteredWallets();
    },
    [creating, reloadRegisteredWallets, setActiveRegisteredWallet],
  );

  useEffect(() => {
    if (!pendingWalletOpenId || registeredWallet?.id !== pendingWalletOpenId) {
      return;
    }
    setPendingWalletOpenId(undefined);
    if (
      registeredWallet.credentialKey &&
      registeredWallet.kind !== 'hardware'
    ) {
      navigation.navigate('Home');
      return;
    }
    openPasswordPrompt('open');
  }, [navigation, openPasswordPrompt, pendingWalletOpenId, registeredWallet]);

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
        ? await walletService.requestLedgerTransportAccess()
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
    if (creating) {
      setupLog('openLedgerPrompt.skipped', {
        reason: 'creating',
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
    const requestedMode = route?.params?.mode;
    const requestKey = `${requestedMode ?? 'none'}:${route?.params?.openRequestId ?? 'once'}:${registeredWallet?.id ?? 'none'}`;
    if (handledModeRequest.current === requestKey) {
      return;
    }

    if (requestedMode === 'open') {
      if (!registeredWallet) {
        return;
      }
      handledModeRequest.current = requestKey;
      if (
        registeredWallet.credentialKey &&
        registeredWallet.kind !== 'hardware'
      ) {
        navigation.navigate('Home');
        return;
      }
      openPasswordPrompt('open');
      return;
    }

    if (requestedMode === 'create' || requestedMode === 'restore') {
      handledModeRequest.current = requestKey;
      openPasswordPrompt(requestedMode);
    }
  }, [
    navigation,
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

  const queueSeedBackupAfterCreate = (registrationId: string, seed: string) => {
    const seedWordCount = seed.trim().split(/\s+/).filter(Boolean).length;
    clearSeedBackupTimer();
    setupLog('seedBackup.queued', {
      registrationId,
      seedWordCount,
    });
    setCreatedSeedWalletId(registrationId);
    setPendingSeedBackup({
      registrationId,
      seed,
    });
  };

  const presentPendingSeedBackup = useCallback(
    (reason: string) => {
      if (!pendingSeedBackup) {
        setupLog('seedBackup.presentSkipped', {
          reason,
        });
        return;
      }

      clearSeedBackupTimer();
      const seedWordCount = pendingSeedBackup.seed
        .trim()
        .split(/\s+/)
        .filter(Boolean).length;
      setupLog('seedBackup.visible', {
        reason,
        registrationId: pendingSeedBackup.registrationId,
        seedWordCount,
      });
      setPendingSeedBackup(undefined);
      setCreatedSeedWalletId(pendingSeedBackup.registrationId);
      setCreatedSeed(pendingSeedBackup.seed);
    },
    [pendingSeedBackup],
  );

  const schedulePendingSeedBackup = useCallback(
    (reason: string, delayMs: number) => {
      if (!pendingSeedBackup) {
        return;
      }

      clearSeedBackupTimer();
      setupLog('seedBackup.scheduled', {
        delayMs,
        reason,
        registrationId: pendingSeedBackup.registrationId,
      });
      seedBackupTimer.current = setTimeout(() => {
        presentPendingSeedBackup(reason);
      }, delayMs);
    },
    [pendingSeedBackup, presentPendingSeedBackup],
  );

  useEffect(() => {
    if (!creating && pendingSeedBackup) {
      schedulePendingSeedBackup('creatingStateCleared', 120);
    }
  }, [creating, pendingSeedBackup, schedulePendingSeedBackup]);

  const onCreateModalDismissed = useCallback(() => {
    setupLog('createModal.dismissed', {
      hasPendingSeedBackup: Boolean(pendingSeedBackup),
    });
    schedulePendingSeedBackup('createModalDismissed', 80);
  }, [pendingSeedBackup, schedulePendingSeedBackup]);

  const clearQueuedSeedBackup = () => {
    clearSeedBackupTimer();
    setPendingSeedBackup(undefined);
  };

  const enableFastReceiveOnActiveScanner = async (
    identityId: string,
    credentials: FastReceiveRegistrationCredentials,
  ) => {
    const settings = await loadActiveNodeConnectionSettings();
    const scannerUrl = fastReceiveScannerUrlForSettings(settings);
    if (!scannerUrl) {
      setupLog('fastReceiveScannerRegistration.skipped', {
        identityId,
        reason: 'noScannerUrl',
      });
      return;
    }

    // A URL inferred from a node is not proof that it exposes the Fast Wallet
    // service. Verify the public health endpoint before any registration
    // payload (and therefore any isolated private view key) leaves the device.
    await verifyFastReceiveScannerCapability(scannerUrl);

    setupLog('fastReceiveScannerRegistration.start', {
      identityId,
      scannerUrl,
    });
    const pushSubscriptionId =
      await FastWalletPushService.enableFastWalletNotifications()
        .then(registration => registration.subscriptionId)
        .catch(error => {
          setupLog('fastReceivePushRegistration.skipped', {
            error: errorMessage(error),
            identityId,
          });
          return undefined;
        });
    await walletService.enableFastReceiveIdentity({
      identityId,
      password: credentials.password,
      secretKey: credentials.secretKey,
      scannerUrl,
      pushSubscriptionId,
    });
    setupLog('fastReceiveScannerRegistration.success', {
      identityId,
      scannerUrl,
    });
  };

  const registerFastReceiveInBackground = (
    source: string,
    identityId: string,
    credentials: FastReceiveRegistrationCredentials,
  ) => {
    const startedAt = Date.now();
    setupLog(`${source}.fastReceive.registrationQueued`, { identityId });

    reloadRegisteredWallets()
      .then(() => {
        setupLog(`${source}.fastReceive.localReady`, { identityId });
      })
      .catch(error => {
        setupLog(`${source}.fastReceive.localRegistryError`, {
          error: errorMessage(error),
          identityId,
        });
      });

    const register = async () => {
      try {
        await enableFastReceiveOnActiveScanner(identityId, credentials);
        await reloadRegisteredWallets();
        setupLog(`${source}.fastReceive.registrationSuccess`, {
          elapsedMs: Date.now() - startedAt,
          identityId,
        });
      } catch (error) {
        await reloadRegisteredWallets().catch(() => undefined);
        setupLog(`${source}.fastReceive.registrationError`, {
          elapsedMs: Date.now() - startedAt,
          error: errorMessage(error),
          identityId,
        });
      }
    };

    register().catch(error => {
      setupLog(`${source}.fastReceive.unhandledRegistrationError`, {
        error: errorMessage(error),
        identityId,
      });
    });
  };

  const fastReceiveSetupToggle = (
    <View style={s.fastReceiveRow}>
      <View style={s.fastReceiveText}>
        <Text style={s.fastReceiveTitle}>{t('setup.fastWalletTitle')}</Text>
        <Text style={s.fastReceiveValue}>
          {t('setup.fastWalletDescription')}
        </Text>
      </View>
      <Switch
        value={createFastReceiveOnSetup}
        onValueChange={setCreateFastReceiveOnSetup}
        trackColor={{ false: 'rgba(255,255,255,0.12)', true: colors.orange }}
        thumbColor="#FFF"
      />
    </View>
  );

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
      createFastReceiveOnSetup,
      enableEnthusiastDiscoveryOnSetup,
      usesBiometric: canUseBiometric,
    });
    setCreating(true);
    setCreatingKind('software');
    setPasswordPromptMode(undefined);
    setCreateError(undefined);
    setCreatedSeed('');
    setCreatedSeedWalletId(undefined);
    clearQueuedSeedBackup();
    setSeedConfirmed(false);
    beginCreateAnimation(CREATE_STEPS);

    try {
      const result = await walletService.createNamedWalletWithStoredSecret({
        walletName: DEFAULT_WALLET_NAME,
        language: 'English',
        authentication: 'if-available',
      });
      setupLog('startCreateWalletWithDeviceSecret.primaryCreated', {
        elapsedMs: Date.now() - startedAt,
      });
      let fastReceiveIdentityId: string | undefined;
      if (createFastReceiveOnSetup) {
        setCreateStep(t('setup.createFastReceive'));
        setupLog('startCreateWalletWithDeviceSecret.fastReceive.start');
        const fastReceive = await walletService.createFastReceiveIdentity({
          restoreHeight: 0,
        });
        fastReceiveIdentityId = fastReceive.identity.id;
        setupLog('startCreateWalletWithDeviceSecret.fastReceive.localReady', {
          elapsedMs: Date.now() - startedAt,
          identityId: fastReceive.identity.id,
        });
      }
      const seed = await walletService.getSeed(result.session);
      setupLog('startCreateWalletWithDeviceSecret.seedLoaded', {
        seedWordCount: seed.trim().split(/\s+/).filter(Boolean).length,
      });
      await registerOpenedSession(result.session, result.registration, {
        refresh: false,
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
      queueSeedBackupAfterCreate(result.registration.id, seed);
      if (fastReceiveIdentityId) {
        registerFastReceiveInBackground(
          'startCreateWalletWithDeviceSecret',
          fastReceiveIdentityId,
          { secretKey: result.session.credentialKey },
        );
      }
      setupLog('startCreateWalletWithDeviceSecret.success', {
        elapsedMs: Date.now() - startedAt,
      });
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
        restoreSeedWordCount,
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
        createFastReceiveOnSetup,
        restoreHeight: restoreHeight ?? 0,
        restoreStartDate: restoreStartDate || 'automatic',
        restoreSeedWordCount,
      });
      setCreating(true);
      setCreatingKind('restore');
      setPasswordPromptMode(undefined);
      setCreateError(undefined);
      setCreatedSeed('');
      setCreatedSeedWalletId(undefined);
      clearQueuedSeedBackup();
      setSeedConfirmed(false);
      beginCreateAnimation(RESTORE_STEPS);
      const result = await walletService.restoreNamedWalletWithStoredSecret({
        walletName: DEFAULT_WALLET_NAME,
        mnemonic: normalizedRestoreSeed,
        network: settings.network,
        restoreHeight,
      });
      let fastReceiveIdentityId: string | undefined;
      if (createFastReceiveOnSetup) {
        setCreateStep(t('setup.createFastReceive'));
        setupLog('startRestoreWallet.fastReceive.start');
        const fastReceive = await walletService.createFastReceiveIdentity({
          restoreHeight,
        });
        fastReceiveIdentityId = fastReceive.identity.id;
        setupLog('startRestoreWallet.fastReceive.localReady', {
          elapsedMs: Date.now() - startedAt,
          identityId: fastReceive.identity.id,
        });
      }
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
      setWalletPassword('');
      setWalletPasswordConfirm('');
      setRestoreSeed('');
      setRestoreStartDate('');
      if (fastReceiveIdentityId) {
        registerFastReceiveInBackground(
          'startRestoreWallet',
          fastReceiveIdentityId,
          { secretKey: result.session.credentialKey },
        );
      }
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
        createFastReceiveOnSetup,
        persistLedgerViewOnly,
        restoreHeight: restoreHeight ?? 0,
        restoreStartDate: ledgerRestoreStartDate || 'automatic',
      });
      setCreating(true);
      setCreatingKind('hardware');
      setPasswordPromptMode(undefined);
      setCreateError(undefined);
      setCreatedSeed('');
      setCreatedSeedWalletId(undefined);
      clearQueuedSeedBackup();
      setSeedConfirmed(false);
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
      if (
        !transportStatus.supported ||
        !transportStatus.available ||
        !transportStatus.permissionGranted
      ) {
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
      await registerOpenedSession(result.session, result.registration, {
        refresh: false,
      });
      setupLog('startCreateHardwareWallet.registered', {
        registrationId: result.registration.id,
        walletName: result.registration.walletName,
      });
      setupLog('startCreateHardwareWallet.syncDeferred', {
        reason: 'setupNavigation',
        walletId: result.session.walletId,
      });

      finishCreateAnimation();
      setLedgerPromptVisible(false);
      setLedgerRestoreStartDate('');
      setPersistLedgerViewOnly(false);
      navigation.navigate('Home');
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
    setCreatedSeed('');
    setCreatedSeedWalletId(undefined);
    clearQueuedSeedBackup();
    setSeedConfirmed(false);
    beginCreateAnimation(
      registeredWallet?.kind === 'hardware' ? HARDWARE_STEPS : OPEN_STEPS,
    );
    setCreateStep(t('setup.step.openingWallet'));

    try {
      setupLog('openExistingWallet.start', {
        kind: registeredWallet?.kind,
        walletName: registeredWallet?.walletName,
      });
      const session = await walletService.openRegisteredWallet(walletPassword);
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
      setWalletPassword('');
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
      createCredentialMode,
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

  const finishSeedBackup = async () => {
    if (!seedConfirmed) {
      setupLog('finishSeedBackup.skipped', {
        reason: 'notConfirmed',
      });
      return;
    }

    try {
      setupLog('finishSeedBackup.start', {
        createdSeedWalletId,
      });
      if (createdSeedWalletId) {
        await walletService.markRegisteredWalletSeedBackedUp(
          createdSeedWalletId,
        );
        await reloadRegisteredWallet();
      }
      clearQueuedSeedBackup();
      setCreatedSeed('');
      setCreatedSeedWalletId(undefined);
      navigation.navigate('Home');
      setEnthusiastDiscoveryEnabled(enableEnthusiastDiscoveryOnSetup)
        .then(preference =>
          preference.enabled
            ? refreshApproximateEnthusiastLocation()
            : preference,
        )
        .then(preference => {
          setupLog('finishSeedBackup.enthusiastDiscovery', {
            enabled: preference.enabled,
            locationStatus: preference.locationStatus,
          });
        })
        .catch(error => {
          setupLog('finishSeedBackup.enthusiastDiscoveryError', {
            error: errorMessage(error),
          });
        });
      setupLog('finishSeedBackup.success', {
        createdSeedWalletId,
      });
    } catch (error) {
      setCreateError(errorMessage(error));
      setupLog('finishSeedBackup.error', {
        createdSeedWalletId,
        error: errorMessage(error),
      });
    }
  };

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
            <Text style={s.savedWalletTitle}>{t('home.allWallets')}</Text>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
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
                    void chooseSavedWallet(wallet.id);
                  }}
                  disabled={creating}
                  activeOpacity={0.76}
                >
                  <MoneroCoin size={30} />
                  <View style={s.savedWalletCopy}>
                    <Text style={s.savedWalletName} numberOfLines={1}>
                      {walletDisplayName(wallet)}
                    </Text>
                    <Text style={s.savedWalletMeta} numberOfLines={1}>
                      {isFastWalletRegistration(wallet)
                        ? 'Fast Wallet'
                        : wallet.kind === 'hardware'
                          ? 'Ledger'
                          : 'Mainnet'}
                    </Text>
                  </View>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
        ) : null}

        {/* Options */}
        <View style={s.options}>
          <SetupOption
            icon={<IcoPlus c={colors.orange} />}
            title={t('action.createWallet')}
            desc={t('setup.createDesc')}
            onPress={() => openPasswordPrompt('create')}
            disabled={creating}
          />
          <SetupOption
            icon={<IcoUsb c={colors.orange} />}
            title="Ledger Nano"
            desc={t('setup.hardware.desc')}
            onPress={openLedgerPrompt}
            disabled={creating}
          />
          <SetupOption
            icon={<IcoImport c={colors.orange} />}
            title={t('setup.importWallet')}
            desc={t('setup.importDesc')}
            onPress={() => openPasswordPrompt('restore')}
            disabled={creating}
          />
        </View>
      </Animated.View>

      {/* Footer */}
      <TouchableOpacity
        accessibilityRole="link"
        accessibilityLabel="Made with love by TEX8"
        onPress={() => void Linking.openURL('https://solutions.tex8.com/en')}
        activeOpacity={0.72}
      >
        <Text style={s.footer}>
          Made with <Text style={{ color: colors.orange }}>❤️</Text> by{' '}
          <Text style={{ color: 'rgba(255,255,255,0.62)', fontWeight: '800' }}>
            TEX8
          </Text>
        </Text>
      </TouchableOpacity>

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
                  <>
                    <TextInput
                      value={restoreSeed}
                      onChangeText={setRestoreSeed}
                      placeholder={t('setup.seedPhrase')}
                      placeholderTextColor="rgba(255,255,255,0.28)"
                      multiline
                      autoCapitalize="none"
                      autoCorrect={false}
                      style={[s.input, s.seedInput]}
                    />
                    <RestoreStartDateField
                      value={restoreStartDate}
                      onChange={setRestoreStartDate}
                      dateLocale={dateLocale}
                      t={t}
                    />
                  </>
                ) : null}
                {showCreateMethodChoices ? (
                  <View style={s.createMethodRow}>
                    <TouchableOpacity
                      style={[
                        s.createMethodButton,
                        createCredentialMode === 'device' &&
                          s.createMethodButtonActive,
                      ]}
                      activeOpacity={0.75}
                      onPress={() => setCreateCredentialMode('device')}
                    >
                      <Text
                        style={[
                          s.createMethodText,
                          createCredentialMode === 'device' &&
                            s.createMethodTextActive,
                        ]}
                      >
                        {t('setup.device')}
                      </Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[
                        s.createMethodButton,
                        createCredentialMode === 'password' &&
                          s.createMethodButtonActive,
                      ]}
                      activeOpacity={0.75}
                      onPress={() => setCreateCredentialMode('password')}
                    >
                      <Text
                        style={[
                          s.createMethodText,
                          createCredentialMode === 'password' &&
                            s.createMethodTextActive,
                        ]}
                      >
                        {t('setup.method.password')}
                      </Text>
                    </TouchableOpacity>
                  </View>
                ) : null}
                {showBiometricCard ? (
                  <View style={s.biometricBox}>
                    <View style={s.biometricHeader}>
                      <View
                        style={[
                          s.biometricDot,
                          (canUseBiometric ||
                            (passwordPromptMode === 'create' &&
                              createCredentialMode === 'device') ||
                            openUsesStoredSecret) &&
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
                        ? (biometricError ??
                          biometricStatus?.message ??
                          t('setup.biometric.waiting'))
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
                {showPasswordFields ? (
                  <>
                    <TextInput
                      value={walletPassword}
                      onChangeText={setWalletPassword}
                      placeholder={t('settings.password')}
                      placeholderTextColor="rgba(255,255,255,0.28)"
                      secureTextEntry
                      style={s.input}
                    />
                    {passwordPromptMode !== 'open' ? (
                      <TextInput
                        value={walletPasswordConfirm}
                        onChangeText={setWalletPasswordConfirm}
                        placeholder={t('setup.passwordConfirm')}
                        placeholderTextColor="rgba(255,255,255,0.28)"
                        secureTextEntry
                        style={s.input}
                      />
                    ) : null}
                  </>
                ) : null}
                {createError ? (
                  <Text style={s.errorText}>{createError}</Text>
                ) : null}
                {showPasswordFields &&
                passwordPromptMode !== 'open' &&
                walletPasswordConfirm.length > 0 &&
                walletPassword !== walletPasswordConfirm ? (
                  <Text style={s.errorText}>{t('setup.passwordMismatch')}</Text>
                ) : null}
                {passwordPromptMode === 'restore' &&
                restoreSeed.length > 0 &&
                restoreSeedWordCount !== MONERO_SEED_WORD_COUNT ? (
                  <Text style={s.errorText}>{t('setup.seedFullError')}</Text>
                ) : null}
                {passwordPromptMode === 'create' ||
                passwordPromptMode === 'restore' ? (
                  <>
                    {fastReceiveSetupToggle}
                    {passwordPromptMode === 'create' ? (
                      <View style={s.fastReceiveRow}>
                        <View style={s.fastReceiveText}>
                          <Text style={s.fastReceiveTitle}>
                            {t('setup.enthusiastsTitle')}
                          </Text>
                          <Text style={s.fastReceiveValue}>
                            {t('setup.enthusiastsDescription')}
                          </Text>
                        </View>
                        <Switch
                          value={enableEnthusiastDiscoveryOnSetup}
                          onValueChange={setEnableEnthusiastDiscoveryOnSetup}
                          trackColor={{
                            false: 'rgba(255,255,255,0.12)',
                            true: colors.orange,
                          }}
                          thumbColor="#FFF"
                        />
                      </View>
                    ) : null}
                  </>
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
                <Switch
                  value={persistLedgerViewOnly}
                  onValueChange={changePersistLedgerViewOnly}
                  trackColor={{
                    false: 'rgba(255,255,255,0.12)',
                    true: colors.orange,
                  }}
                  thumbColor="#FFF"
                />
              </View>
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
        onDismiss={onCreateModalDismissed}
      >
        {createdSeed.length > 0 ? (
          <LinearGradient
            colors={['#12082A', '#0A0A18', '#07071A']}
            locations={[0, 0.5, 1]}
            style={s.seedModal}
          >
            <StatusBar barStyle="light-content" backgroundColor="#12082A" />
            <ScrollView contentContainerStyle={s.seedContent}>
              <MoneroCoin size={62} />
              <Text style={s.seedTitle}>{t('setup.seedTitle')}</Text>
              <Text style={s.seedSubtitle}>{seedSubtitle}</Text>

              <View style={s.seedGrid}>
                {seedWords.map((word, index) => (
                  <View key={`${index}-${word}`} style={s.seedWord}>
                    <Text style={s.seedIndex}>{index + 1}</Text>
                    <Text style={s.seedWordText}>{word}</Text>
                  </View>
                ))}
              </View>

              <TouchableOpacity
                style={s.seedConfirmRow}
                activeOpacity={0.75}
                onPress={() => setSeedConfirmed(value => !value)}
              >
                <View
                  style={[s.seedCheckBox, seedConfirmed && s.seedCheckBoxOn]}
                >
                  {seedConfirmed ? (
                    <Text style={s.seedCheckText}>OK</Text>
                  ) : null}
                </View>
                <Text style={s.seedConfirmText}>{t('setup.seedConfirm')}</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[
                  s.seedContinueButton,
                  !seedConfirmed && s.primaryButtonDisabled,
                ]}
                onPress={finishSeedBackup}
                disabled={!seedConfirmed}
              >
                <Text style={s.primaryButtonText}>{t('action.continue')}</Text>
              </TouchableOpacity>
            </ScrollView>
          </LinearGradient>
        ) : (
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
                        ? t('setup.hardware.connecting')
                        : creatingKind === 'restore'
                          ? t('setup.importing')
                          : creatingKind === 'open'
                            ? t('setup.opening')
                            : t('action.createWallet')}
                    </Text>
                    <View style={s.createLoader}>
                      <ActivityIndicator color={colors.orange} size="large" />
                    </View>
                    <Text style={s.createStep}>{createStep}</Text>
                  </View>
                </View>
              </LinearGradient>
            </View>
          </View>
        )}
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

  footer: {
    color: 'rgba(255,255,255,0.25)',
    fontSize: 13,
    textAlign: 'center',
    paddingBottom: 50,
    fontWeight: '500',
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
  seedInput: {
    height: 118,
    paddingTop: 14,
    textAlignVertical: 'top',
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

  seedModal: { flex: 1 },
  seedContent: {
    minHeight: SH,
    paddingHorizontal: 20,
    paddingTop: 72,
    paddingBottom: 42,
    alignItems: 'center',
  },
  seedTitle: {
    color: '#FFF',
    fontSize: 28,
    fontWeight: '800',
    marginTop: 18,
    marginBottom: 8,
  },
  seedSubtitle: {
    color: 'rgba(255,255,255,0.5)',
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
    marginBottom: 22,
  },
  seedGrid: {
    width: '100%',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 22,
  },
  seedWord: {
    width: '48.5%',
    minHeight: 42,
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 12,
    paddingHorizontal: 10,
    backgroundColor: 'rgba(255,255,255,0.055)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  seedIndex: {
    width: 24,
    color: colors.orange,
    fontSize: 12,
    fontWeight: '800',
  },
  seedWordText: { flex: 1, color: '#FFF', fontSize: 14, fontWeight: '700' },
  seedConfirmRow: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 16,
  },
  seedCheckBox: {
    width: 28,
    height: 28,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.24)',
  },
  seedCheckBoxOn: {
    backgroundColor: colors.orange,
    borderColor: colors.orange,
  },
  seedCheckText: { color: '#FFF', fontSize: 10, fontWeight: '900' },
  seedConfirmText: {
    flex: 1,
    color: 'rgba(255,255,255,0.72)',
    fontSize: 14,
    fontWeight: '600',
  },
  seedContinueButton: {
    width: '100%',
    height: 52,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 15,
    backgroundColor: colors.orange,
  },
});
