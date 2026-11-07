import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';
import {
  defaultMfwResolverPreference,
  isMfwResolverPreference,
  type MfwResolverPreference,
} from '../../../../packages/wallet-shared/src/mfwResolverPreference';

const MFW_RESOLVER_PREFERENCE_KEY = 'monero-fast-wallet.mfw-resolver.v1';
const listeners = new Set<() => void>();
let preferenceRevision = 0;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getMfwResolverPreferenceRevision(): number {
  return preferenceRevision;
}

export function useMfwResolverPreferenceRevision(): number {
  return useSyncExternalStore(subscribe, getMfwResolverPreferenceRevision);
}

export async function loadMfwResolverPreference(): Promise<MfwResolverPreference> {
  const stored = await AsyncStorage.getItem(MFW_RESOLVER_PREFERENCE_KEY);
  return isMfwResolverPreference(stored) ? stored : defaultMfwResolverPreference;
}

export async function saveMfwResolverPreference(
  preference: MfwResolverPreference,
): Promise<void> {
  await AsyncStorage.setItem(MFW_RESOLVER_PREFERENCE_KEY, preference);
  preferenceRevision += 1;
  listeners.forEach(listener => listener());
}
