import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  APP_VAULT_AUTO_LOCK_SECONDS,
  APP_VAULT_DEFAULT_AUTO_LOCK_SECONDS,
  isAllowedAutoLockSeconds,
} from '../../../../packages/wallet-shared/src/appVaultStateMachine';

const AUTO_LOCK_SECONDS_KEY = 'monero-fast-wallet.security.auto-lock-seconds.v1';
export const DEFAULT_AUTO_LOCK_SECONDS = APP_VAULT_DEFAULT_AUTO_LOCK_SECONDS;
export const AUTO_LOCK_SECONDS_OPTIONS = APP_VAULT_AUTO_LOCK_SECONDS;

export async function loadAutoLockSeconds(): Promise<number> {
  const encoded = await AsyncStorage.getItem(AUTO_LOCK_SECONDS_KEY);
  if (encoded === null) return DEFAULT_AUTO_LOCK_SECONDS;
  const stored = Number(encoded);
  return isAllowedAutoLockSeconds(stored)
    ? stored
    : DEFAULT_AUTO_LOCK_SECONDS;
}

export async function saveAutoLockSeconds(seconds: number): Promise<number> {
  if (!isAllowedAutoLockSeconds(seconds)) {
    throw new Error('Choose a supported inactivity timeout or Never.');
  }
  await AsyncStorage.setItem(AUTO_LOCK_SECONDS_KEY, String(seconds));
  return seconds;
}
