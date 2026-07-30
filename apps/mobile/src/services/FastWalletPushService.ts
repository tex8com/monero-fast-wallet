import { NativeModules, PermissionsAndroid, Platform } from 'react-native';
import { checkNotifications, RESULTS } from 'react-native-permissions';

import {
  deleteProtectedMetadata,
  loadProtectedMetadata,
  storeProtectedMetadata,
} from './ProtectedMetadataStorage';
import { logWalletEvent } from './WalletLogger';
import { requireNativeMoneroWallet } from './NativeMoneroWallet';
import { withSystemUiInterruption } from './SystemUiInterruption';

declare const require: (moduleName: string) => any;

const EVENT_CONTRACT = 'monero-fast-wallet-push.v3';
const EVENT_TYPE = 'monero.fast_wallet.incoming';
const SUBSCRIPTION_ID_KEY = 'monero-fast-wallet.push.subscription-id.v1';
const LAST_EVENT_KEY = 'monero-fast-wallet.push.last-event.v2';
const LAST_EVENT_ID_KEY = 'monero-fast-wallet.push.last-event-id.v2';
const OPAQUE_EVENT_ID = /^evt_[0-9a-f]{64}$/;
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
  contractVersion: 'monero-fast-wallet-push.v3';
  eventId: string;
}

export interface FastWalletPushRegistration {
  permissionStatus: string;
  provider: 'fcm';
  subscriptionId: string;
}

export interface MobilePushProviderToken {
  permissionStatus: string;
  provider: 'fcm';
  token: string;
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
    const result = await withSystemUiInterruption(
      'notification-permission',
      () =>
        PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
        ),
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
  const status = permissionName(
    await withSystemUiInterruption(
      'notification-permission',
      () => instance.requestPermission(),
    ),
  );
  if (status === 'denied' || status === 'not_determined') {
    throw new Error('Push permission was not granted');
  }
  return status;
}

let appCheckInstancePromise: Promise<any> | undefined;

async function appIntegrityToken(): Promise<string> {
  if (!appCheckInstancePromise) {
    appCheckInstancePromise = (async () => {
      const module = require('@react-native-firebase/app-check');
      const Provider = module.ReactNativeFirebaseAppCheckProvider;
      if (
        typeof Provider !== 'function' ||
        typeof module.initializeAppCheck !== 'function'
      ) {
        throw new Error('Firebase App Check is not configured');
      }
      const provider = new Provider();
      provider.configure({
        android: {
          provider: __DEV__ ? 'debug' : 'playIntegrity',
        },
        apple: {
          provider: __DEV__
            ? 'debug'
            : 'appAttestWithDeviceCheckFallback',
        },
        isTokenAutoRefreshEnabled: false,
      });
      return module.initializeAppCheck(undefined, {
        provider,
        isTokenAutoRefreshEnabled: false,
      });
    })().catch(error => {
      appCheckInstancePromise = undefined;
      throw error;
    });
  }
  const module = require('@react-native-firebase/app-check');
  const instance = await appCheckInstancePromise;
  const result = await module.getToken(instance, true);
  if (!result?.token || typeof result.token !== 'string') {
    throw new Error('App integrity verification returned no token');
  }
  return result.token;
}

async function registerToken(token: string): Promise<string> {
  const appCheckToken = await appIntegrityToken();
  const registration =
    await requireNativeMoneroWallet().registerFastWalletProvider(
      token,
      appCheckToken,
    );
  await storeProtectedMetadata(
    SUBSCRIPTION_ID_KEY,
    registration.installationId,
  );
  return registration.installationId;
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
  const subscriptionId = await registerToken(token);
  logWalletEvent('FastWalletPush', 'registration.success', {
    permissionStatus,
    platform: Platform.OS,
  });
  return { permissionStatus, provider: 'fcm', subscriptionId };
}

/**
 * Requests the platform notification permission and returns the current FCM
 * token to the immediate native caller. The token is never persisted in
 * React storage and must not be logged.
 */
export async function requestMobilePushProviderToken(): Promise<MobilePushProviderToken> {
  const instance = messagingInstance();
  if (!instance) {
    throw new Error('Firebase Messaging is not configured');
  }
  const permissionStatus = await requestPermission(instance);
  const token = await instance.getToken();
  if (typeof token !== 'string' || token.length < 16) {
    throw new Error('Firebase returned no push token');
  }
  return { permissionStatus, provider: 'fcm', token };
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
      await registerToken(nextToken);
    }
  } catch (error) {
    logWalletEvent('FastWalletPush', 'registration.refreshError', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function disableFastWalletNotifications(): Promise<void> {
  await requireNativeMoneroWallet().disableFastWalletDelivery();
  await deleteProtectedMetadata(SUBSCRIPTION_ID_KEY);
  const instance = messagingInstance();
  await instance?.setAutoInitEnabled?.(false);
  await instance?.deleteToken?.();
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

  // Defense in depth: provider-supplied display text is ignored. Even a
  // malformed or compromised upstream message cannot inject wallet details,
  // links, advertising, or frightening copy into the foreground notice.
  const title = 'Monero Fast Wallet';
  const body = 'Open the app to check for a new payment.';

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
  disableFastWalletNotifications,
  enableFastWalletNotifications,
  getNotificationAuthorizationStatus,
  getLastEvent,
  getStoredSubscriptionId,
  installBackgroundHandler,
  refreshRegistrationQuietly,
  startLifecycle,
  subscribe,
};
