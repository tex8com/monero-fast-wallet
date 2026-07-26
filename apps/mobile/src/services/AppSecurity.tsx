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
  AppState,
  type AppStateStatus,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useI18n } from '../i18n';
import { colors, radius, spacing } from '../theme/colors';
import { walletService } from './WalletService';

export type AppProtectionMode = 'biometric' | 'password';

type AppSecurityContextValue = {
  configured: boolean;
  ready: boolean;
  locked: boolean;
  mode: AppProtectionMode;
  lock: () => void;
  setMode: (mode: AppProtectionMode, password?: string) => Promise<void>;
};

const AppSecurityContext = createContext<AppSecurityContextValue | undefined>(
  undefined,
);

export function AppSecurityProvider({ children }: { children: React.ReactNode }) {
  const { t } = useI18n();
  const [ready, setReady] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [mode, setModeState] = useState<AppProtectionMode>('password');
  const [locked, setLocked] = useState(true);
  const previousAppState = useRef<AppStateStatus>(AppState.currentState);

  useEffect(() => {
    let active = true;
    walletService
      .getAppProtectionStatus()
      .then(status => {
        if (!active) {
          return;
        }
        setModeState(
          status.mode === 'biometric' ? 'biometric' : 'password',
        );
        setConfigured(status.configured);
        setLocked(status.locked || !status.configured);
      })
      .catch(() => undefined)
      .finally(() => {
        if (active) {
          setReady(true);
        }
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', nextState => {
      if (/inactive|background/.test(nextState)) {
        setLocked(true);
        walletService.lockApp().catch(() => undefined);
      } else if (
        /inactive|background/.test(previousAppState.current) &&
        nextState === 'active'
      ) {
        setLocked(true);
      }
      previousAppState.current = nextState;
    });
    return () => subscription.remove();
  }, []);

  const setMode = useCallback(
    async (nextMode: AppProtectionMode, password?: string) => {
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
        const result = await walletService.unlockApp(
          '',
          t('security.biometricPrompt'),
        );
        if (!result.success) {
          await walletService.lockApp();
          setModeState('biometric');
          setConfigured(true);
          setLocked(true);
          throw new Error(result.message || t('security.unlockFailed'));
        }
      }
      setModeState(nextMode);
      setConfigured(true);
      setLocked(false);
    },
    [t],
  );

  const value = useMemo<AppSecurityContextValue>(
    () => ({
      configured,
      ready,
      locked,
      mode,
      lock: () => {
        setLocked(true);
        walletService.lockApp().catch(() => undefined);
      },
      setMode,
    }),
    [configured, locked, mode, ready, setMode],
  );
  const protectedContentHidden = !ready || locked || !configured;

  return (
    <AppSecurityContext.Provider value={value}>
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
      {!ready ? (
        <View
          accessibilityViewIsModal
          importantForAccessibility="yes"
          style={styles.preparingOverlay}
        >
          <Text accessibilityRole="header" style={styles.preparingText}>
            {t('security.preparingProtection')}
          </Text>
        </View>
      ) : locked || !configured ? (
        <AppSecurityLockScreen
          configured={configured}
          mode={mode}
          onConfigure={setMode}
          onUnlock={() => setLocked(false)}
        />
      ) : null}
    </AppSecurityContext.Provider>
  );
}

function AppSecurityLockScreen({
  configured,
  mode,
  onConfigure,
  onUnlock,
}: {
  configured: boolean;
  mode: AppProtectionMode;
  onConfigure: (
    mode: AppProtectionMode,
    password?: string,
  ) => Promise<void>;
  onUnlock: () => void;
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
  const automaticBiometricAttemptedRef = useRef(false);

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
        const available = status.supported && status.available && status.enrolled;
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

  const unlock = useCallback(async () => {
    setWorking(true);
    setError(undefined);
    try {
      if (!configured) {
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
        return;
      }

      const result = await walletService.unlockApp(
        password,
        t('security.biometricPrompt'),
      );
      if (!result.success) {
        throw new Error(result.message || t('security.unlockFailed'));
      }
      setPassword('');
      onUnlock();
    } catch (unlockError) {
      setError(unlockError instanceof Error ? unlockError.message : String(unlockError));
    } finally {
      setWorking(false);
    }
  }, [confirmation, configured, onConfigure, onUnlock, password, setupMode, t]);

  useEffect(() => {
    if (
      !configured ||
      mode !== 'biometric' ||
      automaticBiometricAttemptedRef.current
    ) {
      return;
    }

    // The lock overlay is already mounted and the React activity is active at
    // this point. Open the operating-system biometric sheet immediately; the
    // button remains only as a retry path after an explicit cancellation.
    automaticBiometricAttemptedRef.current = true;
    const timeout = setTimeout(() => {
      unlock().catch(() => undefined);
    }, 180);
    return () => clearTimeout(timeout);
  }, [configured, mode, unlock]);

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
              accessibilityState={{ selected: setupMode === 'biometric', disabled: !biometricsAvailable }}
              disabled={!biometricsAvailable}
              onPress={() => setSetupMode('biometric')}
              style={[
                styles.choiceButton,
                setupMode === 'biometric' && styles.choiceButtonSelected,
                !biometricsAvailable && styles.choiceButtonDisabled,
              ]}
            >
              <Text style={styles.choiceTitle}>{t('security.useBiometrics')}</Text>
              <Text style={styles.choiceHint}>{t('security.biometricsRecommended')}</Text>
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
              <Text style={styles.choiceTitle}>{t('security.useAppPassword')}</Text>
              <Text style={styles.choiceHint}>{t('security.passwordAlternative')}</Text>
            </TouchableOpacity>
          </View>
        ) : null}
        {!configured && biometricsReady && !biometricsAvailable ? (
          <Text style={styles.choiceUnavailable}>{t('security.biometricUnavailable')}</Text>
        ) : null}
        {!configured && selectedMode === 'biometric' && biometricsAvailable ? (
          <Text style={styles.choiceFallback}>{t('security.biometricsFallback')}</Text>
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
            (!configured && selectedMode === 'biometric' && !biometricsAvailable)
          }
          style={[
            styles.primaryButton,
            (working ||
              (usesPassword && !password) ||
              (!configured && usesPassword && !confirmation) ||
              (!configured && selectedMode === 'biometric' && !biometricsAvailable)) &&
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
  eyebrow: { color: colors.orange, fontSize: 12, fontWeight: '800', letterSpacing: 1 },
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
  showPassword: { alignSelf: 'flex-start', minHeight: 36, justifyContent: 'center' },
  showPasswordText: { color: colors.orangeLight, fontSize: 14, fontWeight: '700' },
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
  choiceButtonSelected: { borderColor: colors.orange, backgroundColor: '#2b1b28' },
  choiceButtonDisabled: { opacity: 0.45 },
  choiceTitle: { color: colors.textPrimary, fontSize: 14, fontWeight: '800', lineHeight: 19 },
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
