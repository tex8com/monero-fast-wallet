import AsyncStorage from '@react-native-async-storage/async-storage';

import { requireNativeMoneroWallet } from './NativeMoneroWallet';

function isTestStorageFallback() {
  return process.env.NODE_ENV === 'test';
}

/**
 * Stores privacy-sensitive, non-secret wallet metadata behind the native app
 * lock. AsyncStorage is read only once to migrate older installations and is
 * deleted immediately after a successful native write.
 */
export async function loadProtectedMetadata(
  key: string,
): Promise<string | null> {
  if (isTestStorageFallback()) {
    return AsyncStorage.getItem(key);
  }

  const native = requireNativeMoneroWallet();
  const protectedValue = await native.loadProtectedMetadata(key);
  if (protectedValue !== '') {
    return protectedValue;
  }

  const legacyValue = await AsyncStorage.getItem(key);
  if (legacyValue === null) {
    return null;
  }
  await native.storeProtectedMetadata(key, legacyValue);
  await AsyncStorage.removeItem(key);
  return legacyValue;
}

export async function storeProtectedMetadata(
  key: string,
  value: string,
): Promise<void> {
  if (isTestStorageFallback()) {
    await AsyncStorage.setItem(key, value);
    return;
  }

  const native = requireNativeMoneroWallet();
  await native.storeProtectedMetadata(key, value);
  await AsyncStorage.removeItem(key);
}

export async function deleteProtectedMetadata(key: string): Promise<void> {
  if (isTestStorageFallback()) {
    await AsyncStorage.removeItem(key);
    return;
  }

  const native = requireNativeMoneroWallet();
  await native.deleteProtectedMetadata(key);
  await AsyncStorage.removeItem(key);
}
