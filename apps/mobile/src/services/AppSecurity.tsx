import AsyncStorage from '@react-native-async-storage/async-storage';
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
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useI18n } from '../i18n';
import { colors, radius, spacing } from '../theme/colors';
import { walletService } from './WalletService';

const PROTECTION_MODE_KEY = 'monero_wallet_app_protection_mode_v1';
const PROTECTION_PASSWORD_KEY = 'monero_wallet_app_protection_password_v1';

export type AppProtectionMode = 'none' | 'biometric' | 'password';

type AppSecurityContextValue = {
  ready: boolean;
  locked: boolean;
  mode: AppProtectionMode;
  lock: () => void;
  unlock: () => void;
  setMode: (mode: AppProtectionMode, password?: string) => Promise<void>;
};

const AppSecurityContext = createContext<AppSecurityContextValue | undefined>(
  undefined,
);

function isProtectionMode(value: string | null): value is AppProtectionMode {
  return value === 'none' || value === 'biometric' || value === 'password';
}

export function AppSecurityProvider({ children }: { children: React.ReactNode }) {
  const { t } = useI18n();
  const [ready, setReady] = useState(false);
  const [mode, setModeState] = useState<AppProtectionMode>('none');
  const [locked, setLocked] = useState(false);
  const previousAppState = useRef<AppStateStatus>(AppState.currentState);

  useEffect(() => {
    let active = true;
    AsyncStorage.getItem(PROTECTION_MODE_KEY)
      .then(saved => {
        if (!active) {
          return;
        }
        const nextMode = isProtectionMode(saved) ? saved : 'none';
        setModeState(nextMode);
        setLocked(nextMode !== 'none');
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
      const wasInactive = /inactive|background/.test(previousAppState.current);
      if (wasInactive && nextState === 'active' && mode !== 'none') {
        setLocked(true);
      }
      previousAppState.current = nextState;
    });
    return () => subscription.remove();
  }, [mode]);

  const setMode = useCallback(
    async (nextMode: AppProtectionMode, password?: string) => {
      if (nextMode === 'password') {
        if (!password || password.length < 8) {
          throw new Error(t('settings.passwordMinimum'));
        }
        await walletService.storeSecret(PROTECTION_PASSWORD_KEY, password);
      } else if (nextMode === 'biometric') {
        const status = await walletService.getBiometricAuthStatus();
        if (!status.supported || !status.available || !status.enrolled) {
          throw new Error(status.message || t('security.biometricUnavailable'));
        }
      } else {
        await walletService.deleteSecret(PROTECTION_PASSWORD_KEY);
      }

      await AsyncStorage.setItem(PROTECTION_MODE_KEY, nextMode);
      setModeState(nextMode);
      setLocked(false);
    },
    [t],
  );

  const value = useMemo<AppSecurityContextValue>(
    () => ({
      ready,
      locked,
      mode,
      lock: () => setLocked(true),
      unlock: () => setLocked(false),
      setMode,
    }),
    [locked, mode, ready, setMode],
  );

  return (
    <AppSecurityContext.Provider value={value}>
      {children}
      {ready && locked ? <AppSecurityLockScreen /> : null}
    </AppSecurityContext.Provider>
  );
}

function AppSecurityLockScreen() {
  const { mode, unlock: unlockContext } = useAppSecurity();
  const { t } = useI18n();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [working, setWorking] = useState(false);
  const unlock = async () => {
    setWorking(true);
    setError(undefined);
    try {
      if (mode === 'biometric') {
        const result = await walletService.authenticateBiometric(
          t('security.biometricPrompt'),
        );
        if (!result.success) {
          throw new Error(result.message || t('security.unlockFailed'));
        }
        unlockContext();
        return;
      }

      const valid = await walletService.verifySecret(
        PROTECTION_PASSWORD_KEY,
        password,
      );
      if (!valid) {
        throw new Error(t('security.passwordIncorrect'));
      }
      unlockContext();
    } catch (unlockError) {
      setError(unlockError instanceof Error ? unlockError.message : String(unlockError));
    } finally {
      setWorking(false);
    }
  };

  return (
    <View style={styles.overlay} accessibilityViewIsModal>
      <View style={styles.card}>
        <Text style={styles.eyebrow}>{t('security.appProtection')}</Text>
        <Text style={styles.title}>{t('security.unlockApp')}</Text>
        <Text style={styles.copy}>{t('security.unlockAppHint')}</Text>
        {mode === 'password' ? (
          <TextInput
            value={password}
            onChangeText={setPassword}
            placeholder={t('security.enterPassword')}
            placeholderTextColor={colors.textMuted}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            style={styles.input}
          />
        ) : null}
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <TouchableOpacity
          accessibilityRole="button"
          onPress={() => void unlock()}
          disabled={working || (mode === 'password' && !password)}
          style={[styles.primaryButton, (working || (mode === 'password' && !password)) && styles.disabled]}
        >
          <Text style={styles.primaryText}>
            {working
              ? t('action.working')
              : mode === 'biometric'
                ? t('security.unlockWithBiometrics')
                : t('security.unlockApp')}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
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
  overlay: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    backgroundColor: 'rgba(7, 7, 15, 0.97)',
    justifyContent: 'center',
    padding: spacing.lg,
    zIndex: 99,
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
