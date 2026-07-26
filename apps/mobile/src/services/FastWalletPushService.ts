import { NativeModules, PermissionsAndroid, Platform } from 'react-native';
import { checkNotifications, RESULTS } from 'react-native-permissions';

import {
  loadProtectedMetadata,
  storeProtectedMetadata,
} from './ProtectedMetadataStorage';
import { logWalletEvent } from './WalletLogger';

declare const require: (moduleName: string) => any;

const PUSH_REGISTRATION_URL =
  'https://api.tex8.com/api/v1/public/mobile/push-tokens/register';
const TENANT_ID = 'monero-wallet';
const SHOP_ID = 'monero-wallet';
const APP_ID = 'monero-wallet';
const BUNDLE_ID = 'com.tex8.monerowallet';
const EVENT_CONTRACT = 'monero-fast-wallet-push.v2';
const EVENT_TYPE = 'monero.fast_wallet.incoming';
const SUBSCRIPTION_ID_KEY = 'monero-fast-wallet.push.subscription-id.v1';
const LAST_EVENT_KEY = 'monero-fast-wallet.push.last-event.v2';
const LAST_EVENT_ID_KEY = 'monero-fast-wallet.push.last-event-id.v2';
// The scanner historically emits a SHA-256 based `sig_` identifier while the
// gateway emits `fwpush_`. Both are opaque identifiers only, never wallet data.
const OPAQUE_EVENT_ID =
  /^(?:fwpush_[0-9a-f]{32}|sig_[0-9a-f]{64}|evt_[0-9a-f]{64})$/;
const FORBIDDEN_EVENT_FIELDS = [
  'address',
  'amountAtomic',
  'amount_atomic',
  'blockHeight',
  'block_height',
  'confirmations',
  'keyImage',
  'key_image',
  'network',
  'outputIndex',
  'output_index',
  'privateSpendKey',
  'private_spend_key',
  'privateViewKey',
  'private_view_key',
  'seed',
  'spendKey',
  'state',
  'txId',
  'tx_id',
  'walletId',
  'wallet_id',
  'walletAddress',
] as const;

let backgroundHandlerInstalled = false;
let lifecycleStarted = false;
const listeners = new Set<(event: FastWalletPushEvent) => void>();

export interface FastWalletPushEvent {
  type: 'monero.fast_wallet.incoming';
  contractVersion: 'monero-fast-wallet-push.v2';
  eventId: string;
}

export interface FastWalletPushRegistration {
  permissionStatus: string;
  provider: 'fcm';
  subscriptionId: string;
}

export type NotificationAuthorizationStatus =
  | 'authorized'
  | 'denied'
  | 'not_determined';

export async function getNotificationAuthorizationStatus(): Promise<NotificationAuthorizationStatus> {
  if (Platform.OS === 'android') {
    if (Number(Platform.Version) < 33) {
      return 'authorized';
    }
    const granted = await PermissionsAndroid.check(
      PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
    );
    return granted ? 'authorized' : 'denied';
  }

  if (Platform.OS === 'ios') {
    const { status } = await checkNotifications();
    if (status === RESULTS.GRANTED || status === RESULTS.LIMITED) {
      return 'authorized';
    }
    return status === RESULTS.DENIED ? 'not_determined' : 'denied';
  }

  return 'denied';
}

function messagingInstance(): any | undefined {
  try {
    const module = require('@react-native-firebase/messaging');
    const factory = module.default ?? module;
    return typeof factory === 'function' ? factory() : factory;
  } catch (error) {
    logWalletEvent('FastWalletPush', 'messaging.unavailable', {
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

function createSubscriptionId(): string {
  const random = Math.random().toString(36).slice(2, 14);
  return `mwp_${Platform.OS}_${Date.now().toString(36)}_${random}`;
}

async function getOrCreateSubscriptionId(): Promise<string> {
  const current = await loadProtectedMetadata(SUBSCRIPTION_ID_KEY);
  if (current?.trim()) {
    return current.trim();
  }
  const subscriptionId = createSubscriptionId();
  await storeProtectedMetadata(SUBSCRIPTION_ID_KEY, subscriptionId);
  return subscriptionId;
}

async function getStoredSubscriptionId(): Promise<string | undefined> {
  const value = await loadProtectedMetadata(SUBSCRIPTION_ID_KEY);
  return value?.trim() || undefined;
}

function permissionName(value: unknown): string {
  if (typeof value === 'string') {
    return value.toLowerCase();
  }
  switch (value) {
    case -1:
      return 'not_determined';
    case 0:
      return 'denied';
    case 1:
      return 'authorized';
    case 2:
      return 'provisional';
    case 3:
      return 'ephemeral';
    default:
      return 'unknown';
  }
}

async function requestPermission(instance: any): Promise<string> {
  if (Platform.OS === 'android' && Number(Platform.Version) >= 33) {
    const result = await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
    );
    if (result !== PermissionsAndroid.RESULTS.GRANTED) {
      throw new Error('Push permission was not granted');
    }
  }

  await instance.setAutoInitEnabled?.(true);
  await instance.registerDeviceForRemoteMessages?.();
  if (typeof instance.requestPermission !== 'function') {
    return Platform.OS === 'android' ? 'authorized' : 'unknown';
  }
  const status = permissionName(await instance.requestPermission());
  if (status === 'denied' || status === 'not_determined') {
    throw new Error('Push permission was not granted');
  }
  return status;
}

function currentLocale(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale || undefined;
  } catch {
    return undefined;
  }
}

async function registerToken(
  token: string,
  subscriptionId: string,
  permissionStatus: string,
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  const response = await fetch(PUSH_REGISTRATION_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-App-Id': APP_ID,
      'X-Shop-Id': SHOP_ID,
      'X-Tenant-Id': TENANT_ID,
    },
    body: JSON.stringify({
      anonymousDeviceId: subscriptionId,
      appId: APP_ID,
      appVersion: '0.0.1',
      buildNumber: '1',
      bundleId: BUNDLE_ID,
      locale: currentLocale(),
      permissionStatus,
      platform: Platform.OS,
      provider: 'fcm',
      shopId: SHOP_ID,
      source: 'monero-fast-wallet',
      tenantId: TENANT_ID,
      token,
    }),
    signal: controller.signal,
  }).finally(() => clearTimeout(timeout));
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.success) {
    throw new Error(
      body.message ||
        body.error ||
        `Push registration failed with HTTP ${response.status}`,
    );
  }
  if (body.subscriptionId && body.subscriptionId !== subscriptionId) {
    throw new Error('Push service returned a mismatched subscription id');
  }
}

async function enableFastWalletNotifications(): Promise<FastWalletPushRegistration> {
  const instance = messagingInstance();
  if (!instance) {
    throw new Error('Firebase Messaging is not configured');
  }
  const permissionStatus = await requestPermission(instance);
  const token = await instance.getToken();
  if (!token) {
    throw new Error('Firebase returned no push token');
  }
  const subscriptionId = await getOrCreateSubscriptionId();
  await registerToken(token, subscriptionId, permissionStatus);
  logWalletEvent('FastWalletPush', 'registration.success', {
    permissionStatus,
    platform: Platform.OS,
  });
  return { permissionStatus, provider: 'fcm', subscriptionId };
}

async function refreshRegistrationQuietly(token?: string): Promise<void> {
  const subscriptionId = await getStoredSubscriptionId();
  if (!subscriptionId) {
    return;
  }
  const instance = messagingInstance();
  if (!instance) {
    return;
  }
  try {
    await instance.setAutoInitEnabled?.(true);
    await instance.registerDeviceForRemoteMessages?.();
    const nextToken = token || (await instance.getToken());
    if (nextToken) {
      await registerToken(
        nextToken,
        subscriptionId,
        await getNotificationAuthorizationStatus(),
      );
    }
  } catch (error) {
    logWalletEvent('FastWalletPush', 'registration.refreshError', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function parseFastWalletPushEvent(
  message: any,
): FastWalletPushEvent | undefined {
  const data = message?.data;
  const allowedFields = new Set(['type', 'contractVersion', 'eventId']);
  if (
    !data ||
    Object.keys(data).some(field => !allowedFields.has(field)) ||
    FORBIDDEN_EVENT_FIELDS.some(field => data[field] !== undefined) ||
    data.type !== EVENT_TYPE ||
    data.contractVersion !== EVENT_CONTRACT ||
    typeof data.eventId !== 'string' ||
    !OPAQUE_EVENT_ID.test(data.eventId)
  ) {
    return undefined;
  }

  return {
    type: EVENT_TYPE,
    contractVersion: EVENT_CONTRACT,
    eventId: data.eventId,
  };
}

async function showAndroidForegroundNotification(
  message: any,
  event: FastWalletPushEvent,
): Promise<void> {
  if (Platform.OS !== 'android') {
    return;
  }

  const notifier = NativeModules.MoneroLocalNotification;
  if (!notifier?.show) {
    logWalletEvent('FastWalletPush', 'foregroundNotification.unavailable');
    return;
  }

  // Never derive notification text from wallet data. The server owns this
  // generic, privacy-safe wording and the opaque event id only deduplicates.
  const title =
    typeof message?.notification?.title === 'string'
      ? message.notification.title
      : 'Monero Fast Wallet';
  const body =
    typeof message?.notification?.body === 'string'
      ? message.notification.body
      : 'A private payment update is available.';

  try {
    await notifier.show(title, body, event.eventId);
    logWalletEvent('FastWalletPush', 'foregroundNotification.shown');
  } catch (error) {
    logWalletEvent('FastWalletPush', 'foregroundNotification.error', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function handleRemoteMessage(
  message: any,
  options: { foreground?: boolean } = {},
): Promise<void> {
  const event = parseFastWalletPushEvent(message);
  if (!event) {
    return;
  }
  const previousId = await loadProtectedMetadata(LAST_EVENT_ID_KEY).catch(
    () => null,
  );
  if (previousId === event.eventId) {
    return;
  }
  await Promise.all([
    storeProtectedMetadata(LAST_EVENT_KEY, JSON.stringify(event)),
    storeProtectedMetadata(LAST_EVENT_ID_KEY, event.eventId),
  ]).catch(() => undefined);
  listeners.forEach(listener => listener(event));
  if (options.foreground) {
    await showAndroidForegroundNotification(message, event);
  }
  logWalletEvent('FastWalletPush', 'incomingSignal.received');
}

function installBackgroundHandler(): void {
  if (backgroundHandlerInstalled) {
    return;
  }
  const instance = messagingInstance();
  if (!instance?.setBackgroundMessageHandler) {
    return;
  }
  instance.setBackgroundMessageHandler(handleRemoteMessage);
  backgroundHandlerInstalled = true;
}

function startLifecycle(): () => void {
  if (lifecycleStarted) {
    return () => undefined;
  }
  const instance = messagingInstance();
  if (!instance) {
    return () => undefined;
  }
  lifecycleStarted = true;
  const unsubscribers: Array<() => void> = [];
  if (instance.onTokenRefresh) {
    unsubscribers.push(
      instance.onTokenRefresh((token: string) => {
        void refreshRegistrationQuietly(token);
      }),
    );
  }
  if (instance.onMessage) {
    unsubscribers.push(
      instance.onMessage((message: any) =>
        handleRemoteMessage(message, { foreground: true }),
      ),
    );
  }
  if (instance.onNotificationOpenedApp) {
    unsubscribers.push(instance.onNotificationOpenedApp(handleRemoteMessage));
  }
  if (instance.getInitialNotification) {
    void instance
      .getInitialNotification()
      .then((message: any) =>
        message ? handleRemoteMessage(message) : undefined,
      )
      .catch(() => undefined);
  }
  void refreshRegistrationQuietly();

  return () => {
    unsubscribers.forEach(unsubscribe => unsubscribe());
    lifecycleStarted = false;
  };
}

function subscribe(listener: (event: FastWalletPushEvent) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

async function getLastEvent(): Promise<FastWalletPushEvent | undefined> {
  const raw = await loadProtectedMetadata(LAST_EVENT_KEY);
  if (!raw) {
    return undefined;
  }
  try {
    return parseFastWalletPushEvent({ data: JSON.parse(raw) });
  } catch {
    return undefined;
  }
}

export const FastWalletPushService = {
  enableFastWalletNotifications,
  getNotificationAuthorizationStatus,
  getLastEvent,
  getStoredSubscriptionId,
  installBackgroundHandler,
  refreshRegistrationQuietly,
  startLifecycle,
  subscribe,
};
