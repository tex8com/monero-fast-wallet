import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  ActivityIndicator,
  AppState,
  type AppStateStatus,
  InteractionManager,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import LinearGradient from 'react-native-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import MoneroCoin from '../components/MoneroCoin';
import MoneroCoinGhost from '../components/MoneroCoinGhost';
import { useI18n } from '../i18n';
import { colors, radius, spacing } from '../theme/colors';
import { logWalletEvent } from './WalletLogger';
import {
  activeSystemUiInterruptionDeadlineMs,
  recentlyCompletedSystemUiInterruption,
} from './SystemUiInterruption';
import { walletService } from './WalletService';

export type AppProtectionMode = 'biometric' | 'password';

type AppSecurityContextValue = {
  configured: boolean;
  initialProtectionSetupCompleted: boolean;
  initialProtectionTransitionStartedAtMs?: number;
  ready: boolean;
  locked: boolean;
  mode: AppProtectionMode;
  consumeInitialProtectionSetup: () => void;
  lock: () => void;
  setMode: (mode: AppProtectionMode, password?: string) => Promise<void>;
};

const AppSecurityContext = createContext<AppSecurityContextValue | undefined>(
  undefined,
);

export function AppSecurityProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const { t } = useI18n();
  const [ready, setReady] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [mode, setModeState] = useState<AppProtectionMode>('password');
  const [locked, setLocked] = useState(true);
  const [initialProtectionSetupCompleted, setInitialProtectionSetupCompleted] =
    useState(false);
  const [
    initialProtectionTransitionStartedAtMs,
    setInitialProtectionTransitionStartedAtMs,
  ] = useState<number | undefined>();
  const [securityResetInProgress, setSecurityResetInProgress] = useState(false);
  const [onboardingStage, setOnboardingStage] = useState<
    'welcome' | 'protection'
  >('welcome');
  const [screenTransitionStartedAtMs, setScreenTransitionStartedAtMs] =
    useState(Date.now());
  const previousAppState = useRef<AppStateStatus>(AppState.currentState);
  const backgroundLockTimerRef = useRef<ReturnType<
    typeof setTimeout
  > | undefined>(undefined);
  const backgroundLockCommittedRef = useRef(false);
  const systemUiInterruptionDeferredRef = useRef(false);
  const statusLoadStartedAtMsRef = useRef(Date.now());

  const beginSecurityReset = useCallback(() => {
    const startedAt = Date.now();
    setSecurityResetInProgress(true);
    setConfigured(false);
    setLocked(true);
    logWalletEvent('AppSecurity', 'reset.start', {
      elapsedMs: 0,
      resetTriggered: true,
    });
    AsyncStorage.clear().catch(error => {
      logWalletEvent('AppSecurity', 'reset.javascriptStorageError', {
        elapsedMs: Date.now() - startedAt,
        error,
        resetTriggered: true,
      });
    });

    if (Platform.OS !== 'ios') {
      return;
    }
    const pollForResetCompletion = async (attempt: number) => {
      try {
        const status = await walletService.getAppProtectionStatus();
        if (!status.configured && !status.resetRequired) {
          setOnboardingStage('welcome');
          setScreenTransitionStartedAtMs(Date.now());
          setSecurityResetInProgress(false);
          logWalletEvent('AppSecurity', 'reset.complete', {
            elapsedMs: Date.now() - startedAt,
            resetTriggered: true,
          });
          return;
        }
      } catch {
        // The native storage is intentionally changing underneath this poll.
      }
      if (attempt < 40) {
        setTimeout(() => {
          pollForResetCompletion(attempt + 1).catch(() => undefined);
        }, 250);
      }
    };
    setTimeout(() => {
      pollForResetCompletion(0).catch(() => undefined);
    }, 250);
  }, []);

  useEffect(() => {
    let active = true;
    walletService
      .getAppProtectionStatus()
      .then(status => {
        if (!active) {
          return;
        }
        logWalletEvent('AppSecurity', 'protectionStatus.loaded', {
          configured: status.configured,
          elapsedMs: Date.now() - statusLoadStartedAtMsRef.current,
          failedAttempts: status.failedPasswordAttempts ?? 0,
          locked: status.locked,
          mode: status.mode,
          remainingAttempts: status.remainingPasswordAttempts ?? 3,
          resetTriggered: status.resetRequired === true,
        });
        if (status.resetRequired) {
          beginSecurityReset();
          return;
        }
        setModeState(status.mode === 'biometric' ? 'biometric' : 'password');
        setConfigured(status.configured);
        setLocked(status.locked || !status.configured);
        setScreenTransitionStartedAtMs(Date.now());
      })
      .catch(error => {
        logWalletEvent('AppSecurity', 'protectionStatus.error', {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        if (active) {
          setReady(true);
        }
      });
    return () => {
      active = false;
    };
  }, [beginSecurityReset]);

  useEffect(() => {
    const clearBackgroundLockTimer = () => {
      if (backgroundLockTimerRef.current) {
        clearTimeout(backgroundLockTimerRef.current);
        backgroundLockTimerRef.current = undefined;
      }
    };
    const commitBackgroundLock = (reason: string) => {
      if (backgroundLockCommittedRef.current) {
        return;
      }
      backgroundLockCommittedRef.current = true;
      setLocked(true);
      logWalletEvent('AppSecurity', 'appState.locked', { reason });
      walletService.lockApp().catch(() => undefined);
    };
    const scheduleDeferredLock = (deadlineMs: number) => {
      clearBackgroundLockTimer();
      backgroundLockTimerRef.current = setTimeout(() => {
        backgroundLockTimerRef.current = undefined;
        if (AppState.currentState === 'active') {
          return;
        }
        const nextDeadlineMs = activeSystemUiInterruptionDeadlineMs();
        if (nextDeadlineMs) {
          scheduleDeferredLock(nextDeadlineMs);
          return;
        }
        systemUiInterruptionDeferredRef.current = false;
        commitBackgroundLock('system-ui-timeout');
      }, Math.max(1, deadlineMs - Date.now() + 25));
    };
    const subscription = AppState.addEventListener('change', nextState => {
      if (/inactive|background/.test(nextState)) {
        const deadlineMs = activeSystemUiInterruptionDeadlineMs();
        if (deadlineMs) {
          systemUiInterruptionDeferredRef.current = true;
          scheduleDeferredLock(deadlineMs);
          logWalletEvent('AppSecurity', 'appState.lockDeferred', {
            deadlineMs,
            nextState,
            reason: 'trusted-system-ui',
          });
        } else {
          systemUiInterruptionDeferredRef.current = false;
          clearBackgroundLockTimer();
          commitBackgroundLock('app-background');
        }
      } else if (
        /inactive|background/.test(previousAppState.current) &&
        nextState === 'active'
      ) {
        clearBackgroundLockTimer();
        if (systemUiInterruptionDeferredRef.current) {
          systemUiInterruptionDeferredRef.current = false;
          if (
            activeSystemUiInterruptionDeadlineMs() ||
            recentlyCompletedSystemUiInterruption()
          ) {
            logWalletEvent('AppSecurity', 'appState.systemUiResumed');
          } else {
            commitBackgroundLock('system-ui-expired-on-resume');
          }
        } else {
          setLocked(true);
        }
        backgroundLockCommittedRef.current = false;
      }
      previousAppState.current = nextState;
    });
    return () => {
      clearBackgroundLockTimer();
      subscription.remove();
    };
  }, []);

  const setMode = useCallback(
    async (nextMode: AppProtectionMode, password?: string) => {
      const startedAt = Date.now();
      const isInitialSetup = !configured;
      logWalletEvent('AppSecurity', 'configure.start', {
        initialSetup: isInitialSetup,
        mode: nextMode,
      });
      if (nextMode === 'password') {
        if (!password || password.length < 12) {
          throw new Error(t('settings.passwordMinimum'));
        }
      } else {
        const status = await walletService.getBiometricAuthStatus();
        if (!status.supported || !status.available || !status.enrolled) {
          throw new Error(status.message || t('security.biometricUnavailable'));
        }
      }

      await walletService.configureAppProtection(nextMode, password ?? '');
      if (nextMode === 'biometric') {
        // Native biometric configuration locks authorization immediately.
        // Close every live wallet through the native lock path before exposing
        // the biometric overlay; WalletState will discard its matching JS
        // session handles when it observes the locked provider state.
        await walletService.lockApp();
      }
      setModeState(nextMode);
      setConfigured(true);
      if (isInitialSetup) {
        setInitialProtectionSetupCompleted(true);
      }
      // Native biometric configuration deliberately locks the process. Publish
      // that authoritative state immediately and let the lock screen's single
      // automatic path present the operating-system prompt. This avoids a
      // half-configured UI if the first prompt is cancelled or interrupted.
      setScreenTransitionStartedAtMs(startedAt);
      setLocked(nextMode === 'biometric');
      logWalletEvent('AppSecurity', 'configure.complete', {
        elapsedMs: Date.now() - startedAt,
        initialSetup: isInitialSetup,
        locked: nextMode === 'biometric',
        mode: nextMode,
      });
    },
    [configured, t],
  );

  const value = useMemo<AppSecurityContextValue>(
    () => ({
      configured,
      initialProtectionSetupCompleted,
      initialProtectionTransitionStartedAtMs,
      ready,
      locked,
      mode,
      consumeInitialProtectionSetup: () => {
        setInitialProtectionSetupCompleted(false);
        setInitialProtectionTransitionStartedAtMs(undefined);
      },
      lock: () => {
        setLocked(true);
        walletService.lockApp().catch(() => undefined);
      },
      setMode,
    }),
    [
      configured,
      initialProtectionSetupCompleted,
      initialProtectionTransitionStartedAtMs,
      locked,
      mode,
      ready,
      setMode,
    ],
  );
  const protectedContentHidden = !ready || locked || !configured;
  const canMountProtectedContent = ready && configured;
  const securityModalVisible =
    protectedContentHidden || securityResetInProgress;
  const securitySurface =
    !ready || securityResetInProgress ? (
      <View
        accessibilityViewIsModal
        importantForAccessibility="yes"
        style={styles.preparingOverlay}
      >
        <Text accessibilityRole="header" style={styles.preparingText}>
          {securityResetInProgress
            ? t('security.passwordResetInProgress')
            : t('security.preparingProtection')}
        </Text>
      </View>
    ) : !configured && onboardingStage === 'welcome' ? (
      <InitialProtectionWelcome
        screenTransitionStartedAtMs={screenTransitionStartedAtMs}
        onContinue={startedAtMs => {
          logWalletEvent('AppSecurity', 'onboardingWelcome.getStarted', {
            elapsedMs: 0,
          });
          setScreenTransitionStartedAtMs(startedAtMs);
          setOnboardingStage('protection');
        }}
      />
    ) : (
      <AppSecurityLockScreen
        configured={configured}
        mode={mode}
        onConfigure={setMode}
        onProtectionSubmit={startedAtMs => {
          setInitialProtectionTransitionStartedAtMs(startedAtMs);
          setScreenTransitionStartedAtMs(startedAtMs);
        }}
        onUnlock={() => setLocked(false)}
        screenTransitionStartedAtMs={screenTransitionStartedAtMs}
        onSecurityReset={beginSecurityReset}
      />
    );

  return (
    <AppSecurityContext.Provider value={value}>
      {canMountProtectedContent ? (
        <View
          accessibilityElementsHidden={protectedContentHidden}
          importantForAccessibility={
            protectedContentHidden ? 'no-hide-descendants' : 'auto'
          }
          pointerEvents={protectedContentHidden ? 'none' : 'auto'}
          style={[
            styles.protectedContent,
            protectedContentHidden && styles.protectedContentHidden,
          ]}
        >
          {children}
        </View>
      ) : null}
      <Modal
        animationType="none"
        hardwareAccelerated
        navigationBarTranslucent
        onRequestClose={() => undefined}
        statusBarTranslucent
        transparent={false}
        visible={securityModalVisible}
      >
        <View style={styles.securityModal}>
          {securityModalVisible ? securitySurface : null}
        </View>
      </Modal>
    </AppSecurityContext.Provider>
  );
}

function InitialProtectionWelcome({
  onContinue,
  screenTransitionStartedAtMs,
}: {
  onContinue: (startedAtMs: number) => void;
  screenTransitionStartedAtMs: number;
}) {
  const insets = useSafeAreaInsets();
  const { t } = useI18n();

  useEffect(() => {
    logWalletEvent('AppSecurity', 'onboardingWelcome.presented', {
      elapsedMs: Date.now() - screenTransitionStartedAtMs,
    });
  }, [screenTransitionStartedAtMs]);

  return (
    <LinearGradient
      accessibilityViewIsModal
      colors={['#12082A', '#0A0A18', '#07071A']}
      locations={[0, 0.52, 1]}
      style={styles.welcomeContainer}
    >
      <StatusBar barStyle="light-content" backgroundColor="#12082A" />
      <View pointerEvents="none" style={styles.welcomeGhost}>
        <MoneroCoinGhost size={340} color="rgba(255,255,255,0.026)" />
      </View>
      <View style={styles.welcomeCenter}>
        <View style={styles.welcomeLogo}>
          <MoneroCoin size={116} />
        </View>
        <View style={styles.welcomeTitleRow}>
          <Text style={[styles.welcomeTitle, styles.welcomeTitleWhite]}>
            Monero
          </Text>
          <Text style={[styles.welcomeTitle, styles.welcomeTitleOrange]}>
            {' Fast Wallet'}
          </Text>
        </View>
        <Text style={styles.welcomeSubtitle}>{t('welcome.subtitle')}</Text>
      </View>
      <View
        style={[
          styles.welcomeBottom,
          { paddingBottom: Math.max(insets.bottom + 88, 106) },
        ]}
      >
        <TouchableOpacity
          accessibilityRole="button"
          activeOpacity={0.85}
          onPress={() => onContinue(Date.now())}
          style={styles.welcomeButton}
        >
          <LinearGradient
            colors={['#F26822', '#D4551A']}
            end={{ x: 1, y: 0 }}
            start={{ x: 0, y: 0 }}
            style={styles.welcomeButtonGradient}
          >
            <Text style={styles.welcomeButtonText}>
              {t('action.getStarted')}
            </Text>
          </LinearGradient>
        </TouchableOpacity>
      </View>
    </LinearGradient>
  );
}

function AppSecurityLockScreen({
  configured,
  mode,
  onConfigure,
  onProtectionSubmit,
  onSecurityReset,
  onUnlock,
  screenTransitionStartedAtMs,
}: {
  configured: boolean;
  mode: AppProtectionMode;
  onConfigure: (mode: AppProtectionMode, password?: string) => Promise<void>;
  onProtectionSubmit: (startedAtMs: number) => void;
  onSecurityReset: () => void;
  onUnlock: () => void;
  screenTransitionStartedAtMs: number;
}) {
  const { t } = useI18n();
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [working, setWorking] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [setupMode, setSetupMode] = useState<AppProtectionMode>('password');
  const [biometricsAvailable, setBiometricsAvailable] = useState(false);
  const [biometricsReady, setBiometricsReady] = useState(false);
  const [automaticBiometricPending, setAutomaticBiometricPending] = useState(
    configured && mode === 'biometric',
  );
  const automaticBiometricAttemptedRef = useRef(false);
  const lastPresentationKeyRef = useRef('');

  useEffect(() => {
    const presentationKey = configured ? `unlock-${mode}` : 'protection';
    if (lastPresentationKeyRef.current === presentationKey) {
      return;
    }
    lastPresentationKeyRef.current = presentationKey;
    logWalletEvent(
      'AppSecurity',
      configured ? 'unlockScreen.presented' : 'protectionSetup.presented',
      {
        elapsedMs: Date.now() - screenTransitionStartedAtMs,
        mode: configured ? mode : 'password',
      },
    );
  }, [configured, mode, screenTransitionStartedAtMs]);

  useEffect(() => {
    let active = true;
    if (configured) {
      return () => {
        active = false;
      };
    }
    walletService
      .getBiometricAuthStatus()
      .then(status => {
        if (!active) {
          return;
        }
        const available =
          status.supported && status.available && status.enrolled;
        setBiometricsAvailable(available);
        if (available) {
          setSetupMode('biometric');
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (active) {
          setBiometricsReady(true);
        }
      });
    return () => {
      active = false;
    };
  }, [configured]);

  const selectedMode = configured ? mode : setupMode;
  const usesPassword = selectedMode === 'password';

  const unlock = useCallback(async (): Promise<boolean> => {
    const startedAt = Date.now();
    onProtectionSubmit(startedAt);
    setWorking(true);
    setError(undefined);
    logWalletEvent(
      'AppSecurity',
      configured ? 'unlock.start' : 'configure.submit',
      {
        configured,
        mode: selectedMode,
      },
    );
    try {
      if (!configured) {
        if (setupMode === 'biometric') {
          // Keep the setup card hidden while the provider changes to the
          // configured-and-locked state. Its automatic effect owns the one and
          // only biometric request.
          setAutomaticBiometricPending(true);
        }
        if (setupMode === 'password') {
          if (password.length < 12) {
            throw new Error(t('settings.passwordMinimum'));
          }
          if (password !== confirmation) {
            throw new Error(t('settings.passwordMismatch'));
          }
        }
        await onConfigure(
          setupMode,
          setupMode === 'password' ? password : undefined,
        );
        setPassword('');
        setConfirmation('');
        return true;
      }

      const result = await walletService.unlockApp(
        password,
        t('security.biometricPrompt'),
      );
      if (!result.success) {
        if (result.resetTriggered) {
          logWalletEvent('AppSecurity', 'unlock.resetTriggered', {
            elapsedMs: Date.now() - startedAt,
            failedAttempts: result.failedPasswordAttempts ?? 3,
            remainingAttempts: 0,
            resetTriggered: true,
          });
          onSecurityReset();
          return false;
        }
        if (typeof result.remainingPasswordAttempts === 'number') {
          throw new Error(
            result.remainingPasswordAttempts === 1
              ? t('security.passwordAttemptRemaining')
              : t('security.passwordAttemptsRemaining', {
                  count: result.remainingPasswordAttempts,
                }),
          );
        }
        throw new Error(result.message || t('security.unlockFailed'));
      }
      setPassword('');
      onUnlock();
      logWalletEvent('AppSecurity', 'unlock.complete', {
        configured: true,
        elapsedMs: Date.now() - startedAt,
        mode,
        success: true,
      });
      return true;
    } catch (unlockError) {
      if (configured && mode === 'biometric') {
        // Also clear this inside the operation itself. The automatic effect can
        // be torn down by a native dialog/AppState transition before its
        // promise continuation runs; the retry card must still become visible.
        setAutomaticBiometricPending(false);
      }
      logWalletEvent(
        'AppSecurity',
        configured ? 'unlock.error' : 'configure.error',
        {
          configured,
          elapsedMs: Date.now() - startedAt,
          error: unlockError,
          mode: selectedMode,
          success: false,
        },
      );
      setError(
        unlockError instanceof Error
          ? unlockError.message
          : String(unlockError),
      );
      return false;
    } finally {
      setWorking(false);
    }
  }, [
    confirmation,
    configured,
    mode,
    onConfigure,
    onProtectionSubmit,
    onSecurityReset,
    onUnlock,
    password,
    selectedMode,
    setupMode,
    t,
  ]);

  useEffect(() => {
    if (
      !configured ||
      mode !== 'biometric' ||
      automaticBiometricAttemptedRef.current
    ) {
      return;
    }

    let active = true;
    let interaction:
      | ReturnType<typeof InteractionManager.runAfterInteractions>
      | undefined;
    let appStateSubscription:
      | ReturnType<typeof AppState.addEventListener>
      | undefined;

    const beginAutomaticUnlock = () => {
      if (!active || automaticBiometricAttemptedRef.current) {
        return;
      }
      automaticBiometricAttemptedRef.current = true;
      setAutomaticBiometricPending(true);
      interaction = InteractionManager.runAfterInteractions(() => {
        if (!active) {
          return;
        }
        void unlock().then(success => {
          if (active && !success) {
            // Only expose the manual retry card after Android explicitly
            // cancelled or rejected the automatic biometric prompt.
            setAutomaticBiometricPending(false);
          }
        });
      });
    };

    // React Native may mount while Android still reports an inactive app
    // state. Wait for the first active transition, then invoke the native
    // biometric prompt without requiring an intermediate tap.
    if (AppState.currentState === 'active') {
      beginAutomaticUnlock();
    } else {
      appStateSubscription = AppState.addEventListener('change', nextState => {
        if (nextState === 'active') {
          appStateSubscription?.remove();
          appStateSubscription = undefined;
          beginAutomaticUnlock();
        }
      });
    }

    return () => {
      active = false;
      interaction?.cancel();
      appStateSubscription?.remove();
    };
  }, [configured, mode, unlock]);

  if (configured && mode === 'biometric' && automaticBiometricPending) {
    return (
      <View
        accessibilityViewIsModal
        importantForAccessibility="yes"
        style={styles.automaticUnlockOverlay}
      >
        <ActivityIndicator color={colors.orange} size="small" />
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={styles.overlay}
    >
      <ScrollView
        accessibilityViewIsModal
        contentContainerStyle={styles.overlayContent}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.card}>
          <Text style={styles.eyebrow}>Monero Fast Wallet</Text>
          <Text style={styles.title}>
            {configured ? t('security.unlockApp') : t('settings.appProtection')}
          </Text>
          <Text style={styles.copy}>
            {configured
              ? t('security.unlockAppHint')
              : t('security.setUpAppProtectionHint')}
          </Text>
          {!configured ? (
            <View style={styles.choiceGroup}>
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityState={{
                  selected: setupMode === 'biometric',
                  disabled: !biometricsAvailable,
                }}
                disabled={!biometricsAvailable}
                onPress={() => setSetupMode('biometric')}
                style={[
                  styles.choiceButton,
                  setupMode === 'biometric' && styles.choiceButtonSelected,
                  !biometricsAvailable && styles.choiceButtonDisabled,
                ]}
              >
                <Text style={styles.choiceTitle}>
                  {t('security.useBiometrics')}
                </Text>
                <Text style={styles.choiceHint}>
                  {t('security.biometricsRecommended')}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityState={{ selected: setupMode === 'password' }}
                onPress={() => setSetupMode('password')}
                style={[
                  styles.choiceButton,
                  setupMode === 'password' && styles.choiceButtonSelected,
                ]}
              >
                <Text style={styles.choiceTitle}>
                  {t('security.useAppPassword')}
                </Text>
                <Text style={styles.choiceHint}>
                  {t('security.passwordAlternative')}
                </Text>
              </TouchableOpacity>
            </View>
          ) : null}
          {!configured && biometricsReady && !biometricsAvailable ? (
            <Text style={styles.choiceUnavailable}>
              {t('security.biometricUnavailable')}
            </Text>
          ) : null}
          {!configured &&
          selectedMode === 'biometric' &&
          biometricsAvailable ? (
            <Text style={styles.choiceFallback}>
              {t('security.biometricsFallback')}
            </Text>
          ) : null}
          {usesPassword ? (
            <>
              <Text style={styles.fieldLabel}>{t('settings.appPassword')}</Text>
              <TextInput
                accessibilityLabel={t('settings.appPassword')}
                value={password}
                onChangeText={setPassword}
                placeholder={t('security.enterPassword')}
                placeholderTextColor={colors.textMuted}
                secureTextEntry={!showPassword}
                autoCapitalize="none"
                autoCorrect={false}
                style={styles.input}
              />
            </>
          ) : null}
          {!configured && usesPassword ? (
            <>
              <Text style={styles.fieldLabel}>
                {t('settings.confirmAppPassword')}
              </Text>
              <TextInput
                accessibilityLabel={t('settings.confirmAppPassword')}
                value={confirmation}
                onChangeText={setConfirmation}
                placeholder={t('settings.confirmAppPassword')}
                placeholderTextColor={colors.textMuted}
                secureTextEntry={!showPassword}
                autoCapitalize="none"
                autoCorrect={false}
                style={styles.input}
              />
            </>
          ) : null}
          {usesPassword ? (
            <>
              {!configured ? (
                <Text style={styles.passwordHelp}>
                  {t('security.passwordRule')}
                </Text>
              ) : null}
              <TouchableOpacity
                accessibilityRole="button"
                onPress={() => setShowPassword(value => !value)}
                style={styles.showPassword}
              >
                <Text style={styles.showPasswordText}>
                  {showPassword
                    ? t('security.hidePassword')
                    : t('security.showPassword')}
                </Text>
              </TouchableOpacity>
              <Text style={styles.passwordHelp}>
                {t('security.passwordRecoveryHelp')}
              </Text>
            </>
          ) : null}
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <TouchableOpacity
            accessibilityRole="button"
            onPress={() => {
              unlock().catch(() => undefined);
            }}
            disabled={
              working ||
              (usesPassword && !password) ||
              (!configured && usesPassword && !confirmation) ||
              (!configured &&
                selectedMode === 'biometric' &&
                !biometricsAvailable)
            }
            style={[
              styles.primaryButton,
              (working ||
                (usesPassword && !password) ||
                (!configured && usesPassword && !confirmation) ||
                (!configured &&
                  selectedMode === 'biometric' &&
                  !biometricsAvailable)) &&
                styles.disabled,
            ]}
          >
            <Text style={styles.primaryText}>
              {working
                ? t('action.working')
                : configured && mode === 'biometric'
                ? t('security.unlockWithBiometrics')
                : configured
                ? t('security.unlockApp')
                : selectedMode === 'biometric'
                ? t('security.continueWithBiometrics')
                : t('settings.saveAppProtection')}
            </Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

export function useAppSecurity() {
  const context = useContext(AppSecurityContext);
  if (!context) {
    throw new Error('useAppSecurity must be used inside AppSecurityProvider');
  }
  return context;
}

const styles = StyleSheet.create({
  protectedContent: { flex: 1 },
  protectedContentHidden: { display: 'none' },
  securityModal: { flex: 1, backgroundColor: colors.bg },
  welcomeContainer: {
    ...StyleSheet.absoluteFill,
    zIndex: 100,
  },
  welcomeGhost: {
    alignItems: 'center',
    left: 0,
    position: 'absolute',
    right: 0,
    top: '30%',
  },
  welcomeCenter: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  welcomeLogo: {
    alignItems: 'center',
    borderRadius: 72,
    height: 144,
    justifyContent: 'center',
    marginBottom: 30,
    width: 144,
  },
  welcomeTitleRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'center',
    marginBottom: 12,
    width: '100%',
  },
  welcomeTitle: {
    fontSize: 30,
    fontWeight: '800',
    letterSpacing: 0,
    lineHeight: 38,
  },
  welcomeTitleWhite: { color: '#FFFFFF' },
  welcomeTitleOrange: { color: '#F26822' },
  welcomeSubtitle: {
    color: 'rgba(255,255,255,0.45)',
    fontSize: 16,
    lineHeight: 24,
    textAlign: 'center',
  },
  welcomeBottom: {
    bottom: 0,
    left: 0,
    paddingHorizontal: 24,
    position: 'absolute',
    right: 0,
  },
  welcomeButton: {
    borderRadius: 16,
    overflow: 'hidden',
  },
  welcomeButtonGradient: {
    alignItems: 'center',
    minHeight: 56,
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  welcomeButtonText: {
    color: '#FFFFFF',
    fontSize: 17,
    fontWeight: '800',
  },
  preparingOverlay: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    backgroundColor: colors.bg,
    justifyContent: 'center',
    padding: spacing.lg,
    zIndex: 100,
  },
  preparingText: {
    color: colors.textPrimary,
    fontSize: 18,
    fontWeight: '700',
    textAlign: 'center',
  },
  automaticUnlockOverlay: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    backgroundColor: colors.bg,
    justifyContent: 'center',
    zIndex: 100,
  },
  overlay: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(7, 7, 15, 0.97)',
    zIndex: 99,
  },
  overlayContent: {
    alignItems: 'center',
    flexGrow: 1,
    justifyContent: 'center',
    padding: spacing.lg,
  },
  card: {
    backgroundColor: colors.bgCard,
    borderColor: colors.border,
    borderRadius: radius.lg,
    borderWidth: 1,
    gap: 12,
    maxWidth: 420,
    padding: spacing.lg,
    width: '100%',
  },
  eyebrow: {
    color: colors.orange,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1,
  },
  title: { color: colors.textPrimary, fontSize: 26, fontWeight: '800' },
  copy: { color: colors.textSecondary, fontSize: 15, lineHeight: 22 },
  input: {
    backgroundColor: colors.bgInput,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: 1,
    color: colors.textPrimary,
    fontSize: 16,
    minHeight: 50,
    paddingHorizontal: 14,
  },
  error: { color: colors.error, fontSize: 13, lineHeight: 19 },
  fieldLabel: { color: colors.textPrimary, fontSize: 14, fontWeight: '700' },
  passwordHelp: { color: colors.textSecondary, fontSize: 13, lineHeight: 19 },
  showPassword: {
    alignSelf: 'flex-start',
    minHeight: 36,
    justifyContent: 'center',
  },
  showPasswordText: {
    color: colors.orangeLight,
    fontSize: 14,
    fontWeight: '700',
  },
  choiceGroup: { gap: 9 },
  choiceButton: {
    backgroundColor: colors.bgInput,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: 1,
    gap: 4,
    minHeight: 78,
    padding: 12,
  },
  choiceButtonSelected: {
    borderColor: colors.orange,
    backgroundColor: '#2b1b28',
  },
  choiceButtonDisabled: { opacity: 0.45 },
  choiceTitle: {
    color: colors.textPrimary,
    fontSize: 14,
    fontWeight: '800',
    lineHeight: 19,
  },
  choiceHint: { color: colors.textSecondary, fontSize: 12, lineHeight: 17 },
  choiceUnavailable: { color: colors.textMuted, fontSize: 12, lineHeight: 17 },
  choiceFallback: { color: colors.textMuted, fontSize: 12, lineHeight: 17 },
  primaryButton: {
    alignItems: 'center',
    backgroundColor: colors.orange,
    borderRadius: radius.md,
    justifyContent: 'center',
    minHeight: 50,
    paddingHorizontal: 18,
  },
  primaryText: { color: '#fff', fontSize: 16, fontWeight: '800' },
  disabled: { opacity: 0.45 },
});
