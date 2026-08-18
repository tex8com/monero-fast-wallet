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
const INCOMING_EVENT_TYPE = 'monero.fast_wallet.incoming';
const TEST_EVENT_TYPE = 'monero.fast_wallet.test';
const EVENT_TYPES = new Set([INCOMING_EVENT_TYPE, TEST_EVENT_TYPE]);
const SUBSCRIPTION_ID_KEY = 'monero-fast-wallet.push.subscription-id.v1';
const REGISTRATION_STATE_KEY = 'monero-fast-wallet.push.registration-state.v1';
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
let registrationInFlight: Promise<void> | undefined;
let pendingRegistrationToken: string | undefined;
let registrationRetryTimer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<(event: FastWalletPushEvent) => void>();

const REGISTRATION_REFRESH_MS = 7 * 24 * 60 * 60 * 1_000;
const REGISTRATION_RETRY_MAX_MS = 60 * 60 * 1_000;

type PushRegistrationState = {
  desired: 'enabled' | 'disabled';
  status: 'pending' | 'active' | 'needs-refresh' | 'disabled';
  retryCount: number;
  nextRetryAt?: number;
  lastSuccessAt?: number;
  providerTokenHash?: string;
  generation?: number;
  leaseExpiresAt?: number;
  lastError?: string;
};

export interface FastWalletPushEvent {
  type: typeof INCOMING_EVENT_TYPE | typeof TEST_EVENT_TYPE;
  contractVersion: 'monero-fast-wallet-push.v3';
  eventId: string;
}

export interface FastWalletPushRegistration {
  permissionStatus: string;
  provider: 'fcm';
  subscriptionId: string;
  providerTokenLength: number;
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
  // Do not evaluate the Firebase JavaScript package when its native app
  // module is intentionally absent (for example in the isolated simulator
  // acceptance build). Requiring the package first makes its native event
  // emitter throw and opens React Native's error overlay even if that error
  // is caught below.
  if (!NativeModules.RNFBAppModule) {
    logWalletEvent('FastWalletPush', 'messaging.unavailable', {
      error: 'Firebase native app module is missing',
    });
    return undefined;
  }
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

async function loadRegistrationState(): Promise<
  PushRegistrationState | undefined
> {
  const encoded = await loadProtectedMetadata(REGISTRATION_STATE_KEY);
  if (!encoded) return undefined;
  try {
    const value = JSON.parse(encoded) as Partial<PushRegistrationState>;
    if (
      !['enabled', 'disabled'].includes(value.desired ?? '') ||
      !['pending', 'active', 'needs-refresh', 'disabled'].includes(
        value.status ?? '',
      ) ||
      !Number.isInteger(value.retryCount) ||
      (value.retryCount ?? -1) < 0
    ) {
      return undefined;
    }
    return value as PushRegistrationState;
  } catch {
    return undefined;
  }
}

async function storeRegistrationState(
  state: PushRegistrationState,
): Promise<void> {
  await storeProtectedMetadata(REGISTRATION_STATE_KEY, JSON.stringify(state));
}

function retryDelayMs(retryCount: number): number {
  const exponential = Math.min(
    REGISTRATION_RETRY_MAX_MS,
    1_000 * 2 ** Math.min(retryCount, 12),
  );
  // Deterministic bounded jitter prevents a fleet-wide reconnect wave while
  // keeping tests and diagnostics reproducible.
  return exponential + Math.floor(exponential * 0.15);
}

function scheduleRegistrationRetry(nextRetryAt: number): void {
  if (registrationRetryTimer) clearTimeout(registrationRetryTimer);
  const delay = Math.max(
    250,
    Math.min(nextRetryAt - Date.now(), REGISTRATION_RETRY_MAX_MS),
  );
  registrationRetryTimer = setTimeout(() => {
    registrationRetryTimer = undefined;
    refreshRegistrationQuietly();
  }, delay);
  // Node/Jest timers expose `unref`; React Native timers do not. Background
  // retry must never keep a test process (or a headless JS runtime) alive.
  const timer = registrationRetryTimer as unknown as { unref?: () => void };
  timer.unref?.();
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
    await withSystemUiInterruption('notification-permission', () =>
      instance.requestPermission(),
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
          provider: __DEV__ ? 'debug' : 'appAttestWithDeviceCheckFallback',
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
  // A forced refresh on every retry trips Firebase App Check's attempt
  // throttle before the Gateway can receive the installation registration.
  // A cached token remains cryptographically valid and Firebase refreshes it
  // when needed, so normal registration must use the non-forced path.
  const result = await module.getToken(instance, false);
  if (!result?.token || typeof result.token !== 'string') {
    throw new Error('App integrity verification returned no token');
  }
  return result.token;
}

async function registerToken(token: string): Promise<string> {
  const startedAt = Date.now();
  logWalletEvent('FastWalletPush', 'registration.appIntegrity.start');
  try {
    const appCheckToken = await appIntegrityToken();
    logWalletEvent('FastWalletPush', 'registration.appIntegrity.success', {
      elapsedMs: Date.now() - startedAt,
      hasIntegrityToken: true,
    });
    const nativeStartedAt = Date.now();
    logWalletEvent('FastWalletPush', 'registration.gateway.start', {
      hasProviderToken: true,
    });
    const registration =
      await requireNativeMoneroWallet().registerFastWalletProvider(
        token,
        appCheckToken,
      );
    logWalletEvent('FastWalletPush', 'registration.gateway.success', {
      elapsedMs: Date.now() - nativeStartedAt,
      generation: registration.generation,
      success: true,
    });
    const persistStartedAt = Date.now();
    await storeProtectedMetadata(
      SUBSCRIPTION_ID_KEY,
      registration.installationId,
    );
    await storeRegistrationState({
      desired: 'enabled',
      status: 'active',
      retryCount: 0,
      lastSuccessAt: Date.now(),
      providerTokenHash: registration.providerTokenHash,
      generation: registration.generation,
      leaseExpiresAt: registration.leaseExpiresAt,
    });
    logWalletEvent('FastWalletPush', 'registration.persist.success', {
      elapsedMs: Date.now() - persistStartedAt,
      success: true,
    });
    return registration.installationId;
  } catch (error) {
    logWalletEvent('FastWalletPush', 'registration.provider.error', {
      elapsedMs: Date.now() - startedAt,
      error,
    });
    throw error;
  }
}

async function enableFastWalletNotifications(): Promise<FastWalletPushRegistration> {
  const startedAt = Date.now();
  logWalletEvent('FastWalletPush', 'registration.start', {
    platform: Platform.OS,
  });
  const instance = messagingInstance();
  if (!instance) {
    throw new Error('Firebase Messaging is not configured');
  }
  await storeRegistrationState({
    desired: 'enabled',
    status: 'pending',
    retryCount: 0,
  });
  let permissionStatus = 'unknown';
  let subscriptionId: string;
  let providerTokenLength = 0;
  try {
    permissionStatus = await requestPermission(instance);
    logWalletEvent('FastWalletPush', 'registration.permission.complete', {
      permissionGranted:
        permissionStatus === 'authorized' || permissionStatus === 'granted',
      platform: Platform.OS,
    });
    const token = await instance.getToken();
    if (!token) {
      throw new Error('Firebase returned no push token');
    }
    providerTokenLength = token.length;
    logWalletEvent('FastWalletPush', 'registration.providerToken.obtained', {
      providerTokenLength,
    });
    subscriptionId = await registerToken(token);
  } catch (error) {
    const nextRetryAt = Date.now() + retryDelayMs(1);
    await storeRegistrationState({
      desired: 'enabled',
      status: 'needs-refresh',
      retryCount: 1,
      nextRetryAt,
      lastError: error instanceof Error ? error.message : String(error),
    });
    scheduleRegistrationRetry(nextRetryAt);
    logWalletEvent('FastWalletPush', 'registration.error', {
      elapsedMs: Date.now() - startedAt,
      error,
      platform: Platform.OS,
      retryCount: 1,
    });
    throw error;
  }
  logWalletEvent('FastWalletPush', 'registration.success', {
    elapsedMs: Date.now() - startedAt,
    permissionGranted:
      permissionStatus === 'authorized' || permissionStatus === 'granted',
    platform: Platform.OS,
    success: true,
  });
  return {
    permissionStatus,
    provider: 'fcm',
    subscriptionId,
    providerTokenLength,
  };
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

async function performRegistrationRefresh(
  token?: string,
  forceRefresh = false,
): Promise<void> {
  const startedAt = Date.now();
  logWalletEvent('FastWalletPush', 'registration.refresh.start', {
    hasProviderToken: Boolean(token),
  });
  // The FCM token is not wallet data, but the subscription identifier is
  // protected metadata. Do not attempt to read it before the one app-wide
  // unlock; otherwise an entirely normal cold start is recorded as a
  // misleading native "app-locked" failure.
  const protection = await requireNativeMoneroWallet()
    .getAppProtectionStatus()
    .catch(() => undefined);
  if (!protection || protection.locked) {
    logWalletEvent('FastWalletPush', 'registration.refreshDeferred', {
      reason: protection ? 'appLocked' : 'protectionStatusUnavailable',
    });
    return;
  }
  const state = await loadRegistrationState();
  const subscriptionId = await getStoredSubscriptionId();
  if (state?.desired === 'disabled') {
    return;
  }
  // First-time installs have neither protected registration metadata nor a
  // subscription id yet.  The old early return made the post-unlock refresh
  // a no-op forever unless a separate UI action happened to call `enable`.
  // Bootstrap the registration after every valid app unlock instead.  Raw FCM
  // tokens remain in memory only and registration still requires App Check.
  if (!subscriptionId && state?.desired !== 'enabled') {
    logWalletEvent('FastWalletPush', 'registration.bootstrapAfterUnlock');
  }
  const now = Date.now();
  if (
    !forceRefresh &&
    !token &&
    state?.nextRetryAt &&
    state.nextRetryAt > now
  ) {
    scheduleRegistrationRetry(state.nextRetryAt);
    return;
  }
  if (
    !forceRefresh &&
    !token &&
    state?.status === 'active' &&
    state.lastSuccessAt &&
    now - state.lastSuccessAt < REGISTRATION_REFRESH_MS
  )
    return;
  const instance = messagingInstance();
  if (!instance) {
    return;
  }
  await instance.setAutoInitEnabled?.(true);
  await instance.registerDeviceForRemoteMessages?.();
  const nextToken = token || (await instance.getToken());
  if (nextToken) {
    await registerToken(nextToken);
    logWalletEvent('FastWalletPush', 'registration.refresh.success', {
      elapsedMs: Date.now() - startedAt,
      success: true,
    });
  }
}

async function refreshRegistrationQuietly(
  token?: string,
  forceRefresh = false,
): Promise<void> {
  if (registrationInFlight) {
    // Token rotations may race an ordinary lease refresh. Keep only the most
    // recent provider token and drain it before releasing the single-flight
    // registration. A raw token is deliberately never persisted.
    if (token) pendingRegistrationToken = token;
    await registrationInFlight;
    return;
  }
  registrationInFlight = (async () => {
    let nextToken = token;
    do {
      await performRegistrationRefresh(nextToken, forceRefresh);
      nextToken = pendingRegistrationToken;
      pendingRegistrationToken = undefined;
    } while (nextToken);
  })()
    .catch(async error => {
      const previous = await loadRegistrationState().catch(() => undefined);
      if (previous?.desired === 'disabled') return;
      const retryCount = Math.min((previous?.retryCount ?? 0) + 1, 32);
      const nextRetryAt = Date.now() + retryDelayMs(retryCount);
      await storeRegistrationState({
        desired: 'enabled',
        status: 'needs-refresh',
        retryCount,
        nextRetryAt,
        lastSuccessAt: previous?.lastSuccessAt,
        lastError: error instanceof Error ? error.message : String(error),
      }).catch(() => undefined);
      scheduleRegistrationRetry(nextRetryAt);
      logWalletEvent('FastWalletPush', 'registration.refreshError', {
        error: error instanceof Error ? error.message : String(error),
        retryCount,
        nextRetryAt,
      });
    })
    .finally(() => {
      pendingRegistrationToken = undefined;
      registrationInFlight = undefined;
    });
  await registrationInFlight;
}

async function disableFastWalletNotifications(): Promise<void> {
  if (registrationRetryTimer) {
    clearTimeout(registrationRetryTimer);
    registrationRetryTimer = undefined;
  }
  await requireNativeMoneroWallet().disableFastWalletDelivery();
  await deleteProtectedMetadata(SUBSCRIPTION_ID_KEY);
  await storeRegistrationState({
    desired: 'disabled',
    status: 'disabled',
    retryCount: 0,
  });
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
    !EVENT_TYPES.has(data.type) ||
    data.contractVersion !== EVENT_CONTRACT ||
    typeof data.eventId !== 'string' ||
    !OPAQUE_EVENT_ID.test(data.eventId)
  ) {
    return undefined;
  }

  return {
    type: data.type,
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
  const body =
    event.type === TEST_EVENT_TYPE
      ? 'Test notification: notifications are ready.'
      : 'Open the app to check for a new payment.';

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
  logWalletEvent(
    'FastWalletPush',
    event.type === TEST_EVENT_TYPE ? 'testSignal.received' : 'incomingSignal.received',
  );
}

async function sendTestNotification(): Promise<FastWalletPushRegistration> {
  // A test push is also the first-run transport check.  It must not assume
  // that an earlier Fast Wallet enrollment happened: otherwise a fresh app
  // installation always reaches the Gateway without a provider registration
  // and receives the opaque, but unhelpful, HTTP 409 response.
  //
  // This is an explicit user action, so it is the right moment to request
  // notification permission, obtain the FCM token, verify App Check and
  // register the installation before asking the Gateway to deliver the test.
  // Neither token is persisted in JavaScript or emitted to diagnostics.
  const startedAt = Date.now();
  logWalletEvent('FastWalletPush', 'testPush.registration.start');
  const registration = await enableFastWalletNotifications();
  logWalletEvent('FastWalletPush', 'testPush.registration.success', {
    elapsedMs: Date.now() - startedAt,
    success: true,
  });
  await requireNativeMoneroWallet().sendFastWalletTestPush();
  logWalletEvent('FastWalletPush', 'testPush.accepted');
  return registration;
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
        refreshRegistrationQuietly(token);
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
    instance
      .getInitialNotification()
      .then((message: any) =>
        message ? handleRemoteMessage(message) : undefined,
      )
      .catch(() => undefined);
  }
  // Every cold app start quietly validates the current FCM token through App
  // Check and the Gateway. Raw provider/App Check tokens are never persisted,
  // displayed, or announced through diagnostic alerts.
  refreshRegistrationQuietly(undefined, true);

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
  sendTestNotification,
  startLifecycle,
  subscribe,
};
