import {
  NativeModules,
  PermissionsAndroid,
  Platform,
} from 'react-native';

import type { MfwOwnedNameRecord } from './MfwNameRegistrationRegistry';
import {
  loadProtectedMetadata,
  storeProtectedMetadata,
} from './ProtectedMetadataStorage';
import { withSystemUiInterruption } from './SystemUiInterruption';
import { logWalletEvent } from './WalletLogger';

const STORAGE_KEY = 'monero-fast-wallet.mfw-name-claim-reminders.v1';
export const MFW_NAME_CLAIM_DEEP_LINK = 'tex8monero://mfw-claim';

type ReminderEntry = {
  scheduledAtMs?: number;
  notifiedAtMs?: number;
};

type ReminderState = Record<string, ReminderEntry>;

const permissionAttempts = new Set<string>();

function eventId(record: MfwOwnedNameRecord): string | undefined {
  return record.commitTxidHex
    ? `mfw-claim-${record.commitTxidHex.toLowerCase()}`
    : undefined;
}

async function loadState(): Promise<ReminderState> {
  const encoded = await loadProtectedMetadata(STORAGE_KEY);
  if (!encoded) return {};
  try {
    const value: unknown = JSON.parse(encoded);
    return typeof value === 'object' && value !== null
      ? (value as ReminderState)
      : {};
  } catch {
    return {};
  }
}

async function saveState(state: ReminderState): Promise<void> {
  await storeProtectedMetadata(STORAGE_KEY, JSON.stringify(state));
}

async function ensureNotificationPermission(id: string): Promise<boolean> {
  if (Platform.OS !== 'android' || Number(Platform.Version) < 33) {
    return true;
  }
  const permission = PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS;
  if (await PermissionsAndroid.check(permission)) {
    return true;
  }
  if (permissionAttempts.has(id)) {
    return false;
  }
  permissionAttempts.add(id);
  const result = await withSystemUiInterruption('notification-permission', () =>
    PermissionsAndroid.request(permission),
  );
  return result === PermissionsAndroid.RESULTS.GRANTED;
}

export async function scheduleMfwNameClaimReminder(input: {
  record: MfwOwnedNameRecord;
  triggerAtMs: number;
  title: string;
  body: string;
}): Promise<boolean> {
  const id = eventId(input.record);
  const notifier = NativeModules.MoneroLocalNotification;
  if (!id || !notifier?.schedule || !Number.isFinite(input.triggerAtMs)) {
    return false;
  }
  const state = await loadState();
  const existing = state[id];
  if (
    existing?.notifiedAtMs ||
    (existing?.scheduledAtMs !== undefined &&
      Math.abs(existing.scheduledAtMs - input.triggerAtMs) < 30_000)
  ) {
    return true;
  }
  if (!(await ensureNotificationPermission(id))) {
    return false;
  }
  try {
    await notifier.schedule(
      input.title,
      input.body,
      id,
      Math.max(Date.now() + 1_000, input.triggerAtMs),
      MFW_NAME_CLAIM_DEEP_LINK,
    );
    state[id] = { ...existing, scheduledAtMs: input.triggerAtMs };
    await saveState(state);
    return true;
  } catch (error) {
    logWalletEvent('MfwNameReminder', 'schedule.failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export async function notifyMfwNameClaimReady(input: {
  record: MfwOwnedNameRecord;
  title: string;
  body: string;
}): Promise<boolean> {
  const id = eventId(input.record);
  const notifier = NativeModules.MoneroLocalNotification;
  if (!id || !notifier?.showDeepLink) {
    return false;
  }
  const state = await loadState();
  if (state[id]?.notifiedAtMs) {
    return true;
  }
  if (!(await ensureNotificationPermission(id))) {
    return false;
  }
  try {
    await notifier.cancel?.(id);
    await notifier.showDeepLink(
      input.title,
      input.body,
      id,
      MFW_NAME_CLAIM_DEEP_LINK,
    );
    state[id] = { ...state[id], notifiedAtMs: Date.now() };
    await saveState(state);
    return true;
  } catch (error) {
    logWalletEvent('MfwNameReminder', 'notification.failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export async function cancelMfwNameClaimReminder(
  record: MfwOwnedNameRecord,
): Promise<void> {
  const id = eventId(record);
  if (!id) return;
  await NativeModules.MoneroLocalNotification?.cancel?.(id).catch(
    () => undefined,
  );
}
