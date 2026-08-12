import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ActivityIndicator,
  AppState,
  type AppStateStatus,
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
  withSystemUiInterruption,
} from './SystemUiInterruption';
import { walletService } from './WalletService';
import {
  DEFAULT_AUTO_LOCK_SECONDS,
  loadAutoLockSeconds,
  saveAutoLockSeconds,
} from './AppSecurityPreferences';
import { FastWalletPushService } from './FastWalletPushService';
import {
  deriveAppVaultPresentation,
  validateRecoveryPassword,
} from '../../../../packages/wallet-shared/src/appVaultStateMachine';

export type AppProtectionMode = 'biometric' | 'password';

type AppSecurityContextValue = {
  configured: boolean;
  initialProtectionSetupCompleted: boolean;
  initialProtectionTransitionStartedAtMs?: number;
  ready: boolean;
  locked: boolean;
  mode: AppProtectionMode;
  autoLockSeconds: number;
  consumeInitialProtectionSetup: () => void;
  lock: () => void;
  setMode: (mode: AppProtectionMode, password?: string) => Promise<void>;
  setAutoLockSeconds: (seconds: number) => Promise<void>;
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
  const [autoLockSeconds, setAutoLockSecondsState] = useState<number>(
    DEFAULT_AUTO_LOCK_SECONDS,
  );
  const [initialProtectionSetupCompleted, setInitialProtectionSetupCompleted] =
    useState(false);
  const [
    initialProtectionTransitionStartedAtMs,
    setInitialProtectionTransitionStartedAtMs,
  ] = useState<number | undefined>();
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
  const inactivityTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const lastUserActivityAtMsRef = useRef(Date.now());
  const lastNativeActivityReportAtMsRef = useRef(0);

  useEffect(() => {
    loadAutoLockSeconds()
      .then(async seconds => {
        await walletService.setAppAutoLockSeconds(seconds);
        setAutoLockSecondsState(seconds);
      })
      .catch(() => undefined);
  }, []);

  const commitInactivityLock = useCallback(() => {
    setLocked(true);
    logWalletEvent('AppSecurity', 'inactivity.locked', { autoLockSeconds });
    walletService.lockApp().catch(() => undefined);
  }, [autoLockSeconds]);

  const recordUserActivity = useCallback(() => {
    if (inactivityTimerRef.current) clearTimeout(inactivityTimerRef.current);
    if (!configured || locked) return;
    lastUserActivityAtMsRef.current = Date.now();
    if (
      lastUserActivityAtMsRef.current -
        lastNativeActivityReportAtMsRef.current >=
      1_000
    ) {
      lastNativeActivityReportAtMsRef.current =
        lastUserActivityAtMsRef.current;
      walletService.recordAppUserActivity().catch(() => undefined);
    }
    if (autoLockSeconds === 0) return;
    inactivityTimerRef.current = setTimeout(
      commitInactivityLock,
      autoLockSeconds * 1000,
    );
    // Node-based contract tests expose `unref`; React Native timers do not.
    // Avoid keeping the test process alive without changing device behavior.
    (inactivityTimerRef.current as unknown as { unref?: () => void }).unref?.();
  }, [autoLockSeconds, commitInactivityLock, configured, locked]);

  useEffect(() => {
    recordUserActivity();
    return () => {
      if (inactivityTimerRef.current) clearTimeout(inactivityTimerRef.current);
    };
  }, [recordUserActivity]);

  const loadProtectionStatus = useCallback(async (): Promise<boolean> => {
    statusLoadStartedAtMsRef.current = Date.now();
    try {
      const status = await walletService.getAppProtectionStatus();
        logWalletEvent('AppSecurity', 'protectionStatus.loaded', {
          configured: status.configured,
          elapsedMs: Date.now() - statusLoadStartedAtMsRef.current,
          failedAttempts: status.failedPasswordAttempts ?? 0,
          locked: status.locked,
          mode: status.mode,
          resetRequired: false,
        });
        setModeState(status.mode === 'biometric' ? 'biometric' : 'password');
        setConfigured(status.configured);
        setLocked(status.locked || !status.configured);
        setScreenTransitionStartedAtMs(Date.now());
      return true;
    } catch (error) {
      // A just-launched activity can be behind Android's device keyguard,
      // where the encrypted protection marker is intentionally unavailable.
      // Remain on the fail-closed preparation surface and retry once Android
      // returns the app to the active state. Never fall back to onboarding.
      logWalletEvent('AppSecurity', 'protectionStatus.deferred', {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }, []);

  useEffect(() => {
    let active = true;
    void loadProtectionStatus().then(loaded => {
      if (active && loaded) {
        setReady(true);
      }
    });
    return () => {
      active = false;
    };
  }, [loadProtectionStatus]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', nextState => {
      if (nextState !== 'active' || (ready && !locked)) {
        return;
      }
      void loadProtectionStatus().then(loaded => {
        if (loaded) {
          setReady(true);
        }
      });
    });
    return () => subscription.remove();
  }, [loadProtectionStatus, locked, ready]);

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
        // The security surface deliberately keeps `locked` true while a
        // biometric unlock is in flight. iOS reports its Face ID sheet as an
        // inactive app state. Calling lockApp() again from that transition
        // invalidates the very authorization request that is meant to unlock
        // the app and produces an endless prompt/retry loop. There is nothing
        // else to secure while the protected tree is already unmounted, so do
        // not mutate native authorization until the current unlock settles.
        if (locked) {
          systemUiInterruptionDeferredRef.current = false;
          clearBackgroundLockTimer();
          logWalletEvent('AppSecurity', 'appState.alreadyLocked', {
            nextState,
          });
          previousAppState.current = nextState;
          return;
        }
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
          logWalletEvent('AppSecurity', 'appState.inactive', {
            nextState,
            timeoutSeconds: autoLockSeconds,
          });
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
            recordUserActivity();
          } else {
            commitBackgroundLock('system-ui-expired-on-resume');
          }
        } else {
          const inactiveSeconds =
            (Date.now() - lastUserActivityAtMsRef.current) / 1000;
          if (autoLockSeconds > 0 && inactiveSeconds >= autoLockSeconds) {
            commitBackgroundLock('inactivity-expired-on-resume');
          } else {
            recordUserActivity();
          }
        }
        backgroundLockCommittedRef.current = false;
      }
      previousAppState.current = nextState;
    });
    return () => {
      clearBackgroundLockTimer();
      subscription.remove();
    };
  }, [autoLockSeconds, locked, recordUserActivity]);

  const setMode = useCallback(
    async (nextMode: AppProtectionMode, password?: string) => {
      const startedAt = Date.now();
      const isInitialSetup = !configured;
      logWalletEvent('AppSecurity', 'configure.start', {
        initialSetup: isInitialSetup,
        mode: nextMode,
      });
      if (nextMode === 'password' || (password?.length ?? 0) > 0) {
        try {
          validateRecoveryPassword(password ?? '');
        } catch {
          throw new Error(t('settings.passwordMinimum'));
        }
      }
      if (nextMode === 'biometric') {
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
      autoLockSeconds,
      consumeInitialProtectionSetup: () => {
        setInitialProtectionSetupCompleted(false);
        setInitialProtectionTransitionStartedAtMs(undefined);
      },
      lock: () => {
        setLocked(true);
        walletService.lockApp().catch(() => undefined);
      },
      setMode,
      setAutoLockSeconds: async (seconds: number) => {
        await walletService.setAppAutoLockSeconds(seconds);
        const saved = await saveAutoLockSeconds(seconds);
        setAutoLockSecondsState(saved);
      },
    }),
    [
      configured,
      autoLockSeconds,
      initialProtectionSetupCompleted,
      initialProtectionTransitionStartedAtMs,
      locked,
      mode,
      ready,
      setMode,
    ],
  );
  const presentation = deriveAppVaultPresentation(
    {
      stateVersion: 1,
      ready,
      onboardingComplete: onboardingStage === 'protection',
      configured,
      protectionMode: configured
        ? mode === 'biometric'
          ? 'system'
          : 'password'
        : null,
      sessionAuthorized: configured && !locked,
      migrationState: 0,
      failedAttempts: 0,
      autoLockSeconds,
      blockedUntilUnixSeconds: 0,
      lastActivityMonotonicMs: 0,
    },
    Math.floor(Date.now() / 1000),
  );
  const protectedContentHidden = presentation !== 'content';
  // React Native presents <Modal> children in independent native windows.
  // Hiding the protected root view is therefore insufficient: an already
  // presented scanner or wallet dialog can remain above the lock screen.
  // Unmount the entire protected tree whenever authorization is absent so
  // every native modal is dismissed before the security surface is shown.
  const canMountProtectedContent =
    ready && configured && !locked;
  const securityModalVisible = protectedContentHidden;
  const securitySurface =
    presentation === 'preparing' ? (
      <View
        accessibilityViewIsModal
        importantForAccessibility="yes"
        style={styles.preparingOverlay}
      >
        <Text accessibilityRole="header" style={styles.preparingText}>
          {t('security.preparingProtection')}
        </Text>
      </View>
    ) : presentation === 'welcome' ? (
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
        onUnlock={() => {
          setLocked(false);
          // The startup token refresh is intentionally deferred while this
          // app-wide lock is closed. Resume it once after the one valid
          // unlock instead of accessing protected Fast-Wallet metadata at
          // launch.
          void FastWalletPushService.refreshRegistrationQuietly(undefined, true);
          void walletService.renewExpiringFastWalletAssignmentsQuietly();
        }}
        screenTransitionStartedAtMs={screenTransitionStartedAtMs}
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
          onTouchStart={recordUserActivity}
          onTouchMove={recordUserActivity}
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
  onUnlock,
  screenTransitionStartedAtMs,
}: {
  configured: boolean;
  mode: AppProtectionMode;
  onConfigure: (mode: AppProtectionMode, password?: string) => Promise<void>;
  onProtectionSubmit: (startedAtMs: number) => void;
  onUnlock: () => void;
  screenTransitionStartedAtMs: number;
}) {
  const { t } = useI18n();
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [working, setWorking] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [setupMode, setSetupMode] = useState<AppProtectionMode>('biometric');
  const [usePasswordFallback, setUsePasswordFallback] = useState(false);
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
        mode: configured ? mode : setupMode,
      },
    );
  }, [configured, mode, screenTransitionStartedAtMs, setupMode]);

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
        logWalletEvent('AppSecurity', 'biometricStatus.resolved', {
          available,
          biometryType: status.biometryType,
          enrolled: status.enrolled,
          supported: status.supported,
        });
        setBiometricsAvailable(available);
        setSetupMode(available ? 'biometric' : 'password');
      })
      .catch(error => {
        logWalletEvent('AppSecurity', 'biometricStatus.error', { error });
        setSetupMode('password');
      })
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
  const usesPassword =
    selectedMode === 'password' || (configured && usePasswordFallback);

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

      // Android/iOS can report the native biometric sheet as an inactive app
      // state.  It is an app-initiated, bounded system surface, not an
      // application backgrounding event.  Keep the native authorization alive
      // until the unlock promise has settled so there is no spurious
      // "tap unlock again" recovery path.
      const result = await withSystemUiInterruption(
        'app-unlock',
        () =>
          walletService.unlockApp(
            password,
            t('security.biometricPrompt'),
          ),
      );
      if (!result.success) {
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
    let appStateSubscription:
      | ReturnType<typeof AppState.addEventListener>
      | undefined;

    const beginAutomaticUnlock = () => {
      if (!active || automaticBiometricAttemptedRef.current) {
        return;
      }
      automaticBiometricAttemptedRef.current = true;
      setAutomaticBiometricPending(true);
      // Defer the bridge call until React has committed this state update. The
      // native bridge performs the authoritative wait for a resumed, visible
      // Activity before presenting AndroidX BiometricPrompt. A microtask keeps
      // this path deterministic in tests and avoids deprecated
      // InteractionManager scheduling.
      queueMicrotask(() => {
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
          {!configured && !biometricsReady ? (
            <ActivityIndicator color={colors.orange} size="small" />
          ) : null}
          {!configured && biometricsReady && !biometricsAvailable ? (
            <Text style={styles.choiceUnavailable}>
              {t('security.biometricUnavailable')}
            </Text>
          ) : null}
          {!configured && selectedMode === 'biometric' && biometricsAvailable ? (
            <Text style={styles.choiceFallback}>
              {t('security.biometricsFallback')}
            </Text>
          ) : null}
          {configured && mode === 'biometric' ? (
            <TouchableOpacity
              accessibilityRole="button"
              disabled={working}
              onPress={() => {
                setUsePasswordFallback(value => !value);
                setPassword('');
                setError(undefined);
              }}
              style={styles.showPassword}
            >
              <Text style={styles.showPasswordText}>
                {usePasswordFallback
                  ? t('security.unlockWithBiometrics')
                  : t('security.useAppPassword')}
              </Text>
            </TouchableOpacity>
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
          {!configured && biometricsReady && biometricsAvailable ? (
            <TouchableOpacity
              accessibilityRole="button"
              disabled={working}
              onPress={() => {
                setSetupMode(value =>
                  value === 'biometric' ? 'password' : 'biometric',
                );
                setPassword('');
                setConfirmation('');
                setError(undefined);
              }}
              style={styles.alternativeButton}
            >
              <Text style={styles.alternativeButtonText}>
                {selectedMode === 'biometric'
                  ? t('security.useAppPassword')
                  : t('security.useBiometrics')}
              </Text>
            </TouchableOpacity>
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
            testID="app-security-primary"
            onPress={() => unlock().catch(() => false)}
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
                : configured && mode === 'biometric' && !usePasswordFallback
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
  alternativeButton: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
  },
  alternativeButtonText: {
    color: colors.orangeLight,
    fontSize: 15,
    fontWeight: '700',
  },
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
