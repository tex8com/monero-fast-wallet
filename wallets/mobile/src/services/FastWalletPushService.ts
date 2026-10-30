import {
  Linking,
  NativeModules,
  PermissionsAndroid,
  Platform,
} from 'react-native';
import { checkNotifications, RESULTS } from 'react-native-permissions';

import {
  deleteProtectedMetadata,
  loadProtectedMetadata,
  storeProtectedMetadata,
} from './ProtectedMetadataStorage';
import { logWalletEvent } from './WalletLogger';
import { loadFastReceiveIdentities } from './FastReceiveRegistry';
import type { FastWalletTestPushReceipt } from './NativeMoneroWallet';
import { requireNativeMoneroWallet } from './NativeMoneroWallet';
import { withSystemUiInterruption } from './SystemUiInterruption';
import { v1ReleaseFeatures } from '../../../../packages/wallet-shared/src/v1ReleaseFeatures';

declare const require: (moduleName: string) => any;

const EVENT_CONTRACT = 'monero-fast-wallet-push.v3';
const INCOMING_EVENT_TYPE = 'monero.fast_wallet.incoming';
const TEST_EVENT_TYPE = 'monero.fast_wallet.test';
const VANITY_EVENT_TYPE = 'monero.fast_wallet.vanity';
const CLAIM_EVENT_TYPE = 'monero.fast_wallet.mfw-claim';
const EVENT_TYPES = new Set([
  INCOMING_EVENT_TYPE,
  TEST_EVENT_TYPE,
  VANITY_EVENT_TYPE,
  CLAIM_EVENT_TYPE,
]);
const SUBSCRIPTION_ID_KEY = 'monero-fast-wallet.push.subscription-id.v1';
const REGISTRATION_STATE_KEY = 'monero-fast-wallet.push.registration-state.v1';
const TEST_RECEIPT_KEY = 'monero-fast-wallet.push.test-receipt.v1';
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

let lastObservedEvent: FastWalletPushEvent | undefined;
let testPushInFlight: Promise<FastWalletTestPushReceipt> | undefined;
let backgroundHandlerInstalled = false;
let lifecycleStarted = false;
let registrationInFlight: Promise<void> | undefined;
let pendingRegistrationToken: string | undefined;
let registrationRetryTimer: ReturnType<typeof setTimeout> | undefined;
let registrationGeneration = 0;
let optOutRequested = false;
let disableInFlight: Promise<void> | undefined;
const enableAttempts = new Set<Promise<FastWalletPushRegistration>>();
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
  type:
    | typeof INCOMING_EVENT_TYPE
    | typeof TEST_EVENT_TYPE
    | typeof VANITY_EVENT_TYPE
    | typeof CLAIM_EVENT_TYPE;
  contractVersion: 'monero-fast-wallet-push.v3';
  eventId: string;
  orderId?: string;
  jobId?: string;
  deepLink?: string;
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

function registrationIsCurrent(generation: number): boolean {
  return generation === registrationGeneration && !optOutRequested;
}

function requireCurrentRegistration(generation: number): void {
  if (!registrationIsCurrent(generation)) {
    throw new Error(
      'Push registration was superseded by notification settings',
    );
  }
}

async function registerToken(
  token: string,
  generation: number,
): Promise<string> {
  requireCurrentRegistration(generation);
  const startedAt = Date.now();
  logWalletEvent('FastWalletPush', 'registration.appIntegrity.start');
  try {
    const appCheckToken = await appIntegrityToken();
    requireCurrentRegistration(generation);
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
    requireCurrentRegistration(generation);
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
    requireCurrentRegistration(generation);
    await storeRegistrationState({
      desired: 'enabled',
      status: 'active',
      retryCount: 0,
      lastSuccessAt: Date.now(),
      providerTokenHash: registration.providerTokenHash,
      generation: registration.generation,
      leaseExpiresAt: registration.leaseExpiresAt,
    });
    requireCurrentRegistration(generation);
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
  // An explicit re-enable starts only after a preceding disable has finished.
  if (disableInFlight) await disableInFlight;
  optOutRequested = false;
  const attempt = performNotificationEnable(registrationGeneration);
  enableAttempts.add(attempt);
  try {
    return await attempt;
  } finally {
    enableAttempts.delete(attempt);
  }
}

async function performNotificationEnable(
  generation: number,
): Promise<FastWalletPushRegistration> {
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
    requireCurrentRegistration(generation);
    permissionStatus = await requestPermission(instance);
    requireCurrentRegistration(generation);
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
    subscriptionId = await registerToken(token, generation);
  } catch (error) {
    if (!registrationIsCurrent(generation)) throw error;
    const nextRetryAt = Date.now() + retryDelayMs(1);
    await storeRegistrationState({
      desired: 'enabled',
      status: 'needs-refresh',
      retryCount: 1,
      nextRetryAt,
      lastError: error instanceof Error ? error.message : String(error),
    });
    if (!registrationIsCurrent(generation)) throw error;
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
  token: string | undefined,
  forceRefresh: boolean,
  generation: number,
): Promise<void> {
  requireCurrentRegistration(generation);
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
  requireCurrentRegistration(generation);
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
    await registerToken(nextToken, generation);
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
  if (optOutRequested) return;
  if (registrationInFlight) {
    // Token rotations may race an ordinary lease refresh. Keep only the most
    // recent provider token and drain it before releasing the single-flight
    // registration. A raw token is deliberately never persisted.
    if (token) pendingRegistrationToken = token;
    await registrationInFlight;
    return;
  }
  const generation = registrationGeneration;
  registrationInFlight = (async () => {
    let nextToken = token;
    do {
      await performRegistrationRefresh(nextToken, forceRefresh, generation);
      nextToken = pendingRegistrationToken;
      pendingRegistrationToken = undefined;
    } while (nextToken);
  })()
    .catch(async error => {
      if (!registrationIsCurrent(generation)) return;
      const previous = await loadRegistrationState().catch(() => undefined);
      if (
        !registrationIsCurrent(generation) ||
        previous?.desired === 'disabled'
      )
        return;
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
      if (!registrationIsCurrent(generation)) return;
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
  if (disableInFlight) return disableInFlight;
  // Invalidate every older attempt immediately, including one still waiting
  // for permission or a native Onion request. Its success/error must not
  // restore enabled metadata or arm another retry after this user action.
  optOutRequested = true;
  registrationGeneration += 1;
  pendingRegistrationToken = undefined;
  if (registrationRetryTimer) {
    clearTimeout(registrationRetryTimer);
    registrationRetryTimer = undefined;
  }
  const attempts: Promise<unknown>[] = [...enableAttempts];
  if (registrationInFlight) attempts.push(registrationInFlight);
  const disabling = (async () => {
    // Protected metadata writes may already be in progress. Finish them
    // before persisting the authoritative disabled state, never after it.
    await Promise.allSettled(attempts);
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
  })().finally(() => {
    if (disableInFlight === disabling) disableInFlight = undefined;
  });
  disableInFlight = disabling;
  return disabling;
}

export function parseFastWalletPushEvent(
  message: any,
): FastWalletPushEvent | undefined {
  const data = message?.data;
  const allowedFields = new Set([
    'type',
    'contractVersion',
    'eventId',
    'orderId',
    'jobId',
    'deepLink',
  ]);
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

  const vanity = data.type === VANITY_EVENT_TYPE;
  const claim = data.type === CLAIM_EVENT_TYPE;
  if (claim) {
    if (
      data.orderId !== undefined ||
      typeof data.jobId !== 'string' ||
      !/^[0-9a-f]{48}$/.test(data.jobId) ||
      data.deepLink !== `tex8monero://mfw-claim/${data.jobId}`
    )
      return undefined;
    return {
      type: CLAIM_EVENT_TYPE,
      contractVersion: EVENT_CONTRACT,
      eventId: data.eventId,
      jobId: data.jobId,
      deepLink: data.deepLink,
    };
  }
  if (data.jobId !== undefined) return undefined;
  if (vanity && !v1ReleaseFeatures.vanityAddress) {
    return undefined;
  }
  if (
    vanity !==
      (typeof data.orderId === 'string' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
          data.orderId,
        ) &&
        data.deepLink === `mfw://vanity/order/${data.orderId}`) ||
    (!vanity && (data.orderId !== undefined || data.deepLink !== undefined))
  ) {
    return undefined;
  }

  return {
    type: data.type,
    contractVersion: EVENT_CONTRACT,
    eventId: data.eventId,
    ...(vanity ? { orderId: data.orderId, deepLink: data.deepLink } : {}),
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
      : event.type === VANITY_EVENT_TYPE
      ? 'Your Vanity address status changed.'
      : event.type === CLAIM_EVENT_TYPE
      ? 'Your name registration status changed. Open the app to check.'
      : 'Open the app to check for a new payment.';

  try {
    await notifier.show(title, body, event.eventId);
    logWalletEvent('FastWalletPush', 'foregroundNotification.shown', {
      eventId: event.eventId,
    });
  } catch (error) {
    logWalletEvent('FastWalletPush', 'foregroundNotification.error', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function handleRemoteMessage(
  message: any,
  options: { foreground?: boolean; opened?: boolean } = {},
): Promise<void> {
  const event = parseFastWalletPushEvent(message);
  if (!event) {
    return;
  }
  // Retain only the validated opaque hint while protected storage is locked.
  // WalletState replays it after the existing app-wide unlock boundary.
  lastObservedEvent = event;
  logWalletEvent(
    'FastWalletPush',
    options.opened
      ? 'remoteMessage.opened'
      : options.foreground
      ? 'remoteMessage.foreground'
      : 'remoteMessage.background',
    { eventId: event.eventId },
  );
  const previousId = await loadProtectedMetadata(LAST_EVENT_ID_KEY).catch(
    () => null,
  );
  if (previousId === event.eventId) {
    if (
      options.opened &&
      (event.type === VANITY_EVENT_TYPE || event.type === CLAIM_EVENT_TYPE) &&
      event.deepLink
    ) {
      await Linking.openURL(event.deepLink).catch(() => undefined);
    }
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
  if (
    options.opened &&
    (event.type === VANITY_EVENT_TYPE || event.type === CLAIM_EVENT_TYPE) &&
    event.deepLink
  ) {
    await Linking.openURL(event.deepLink).catch(() => undefined);
  }
  logWalletEvent(
    'FastWalletPush',
    event.type === TEST_EVENT_TYPE
      ? 'testSignal.received'
      : 'incomingSignal.received',
    { eventId: event.eventId },
  );
}

export function parseTestPushReceipt(
  value: unknown,
): FastWalletTestPushReceipt {
  const receipt = value as Partial<FastWalletTestPushReceipt> | undefined;
  if (
    !receipt ||
    receipt.accepted !== true ||
    typeof receipt.eventId !== 'string' ||
    !OPAQUE_EVENT_ID.test(receipt.eventId) ||
    !Number.isSafeInteger(receipt.scheduledAt) ||
    (receipt.scheduledAt ?? 0) <= 0 ||
    !Number.isSafeInteger(receipt.deliverAfter) ||
    receipt.deliverAfter! - receipt.scheduledAt! !== 10
  ) {
    throw new Error('Invalid scheduled test notification receipt');
  }
  return receipt as FastWalletTestPushReceipt;
}

async function getLastScheduledTestPush(): Promise<
  FastWalletTestPushReceipt | undefined
> {
  const raw = await loadProtectedMetadata(TEST_RECEIPT_KEY);
  if (!raw) return undefined;
  try {
    return parseTestPushReceipt(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

async function testNotificationReady(): Promise<boolean> {
  if (optOutRequested || disableInFlight) return false;
  const [state, subscriptionId, identities, permission] = await Promise.all([
    loadRegistrationState(),
    getStoredSubscriptionId(),
    loadFastReceiveIdentities(),
    getNotificationAuthorizationStatus(),
  ]);
  const now = Math.floor(Date.now() / 1000);
  return (
    !optOutRequested &&
    !disableInFlight &&
    permission === 'authorized' &&
    Boolean(subscriptionId) &&
    state?.desired === 'enabled' &&
    state.status === 'active' &&
    (state.leaseExpiresAt ?? 0) > now &&
    identities.some(
      identity =>
        identity.notificationsEnabled === true &&
        identity.workerReceiptVerified === true &&
        Boolean(identity.assignmentHandle) &&
        (identity.assignmentExpiresAt ?? 0) > now,
    )
  );
}

async function sendTestNotification(): Promise<FastWalletTestPushReceipt> {
  if (testPushInFlight) return testPushInFlight;
  const generation = registrationGeneration;
  const request = (async () => {
    if (!(await testNotificationReady())) {
      throw new Error(
        'Enable payment alerts for a backed-up Fast Wallet in Wallets and allow notifications before testing.',
      );
    }
    requireCurrentRegistration(generation);
    logWalletEvent('FastWalletPush', 'testPush.request.start');
    const receipt = parseTestPushReceipt(
      await requireNativeMoneroWallet().sendFastWalletTestPush(),
    );
    requireCurrentRegistration(generation);
    logWalletEvent('FastWalletPush', 'testPush.scheduled', {
      eventId: receipt.eventId,
      scheduledAt: receipt.scheduledAt,
      deliverAfter: receipt.deliverAfter,
    });
    // The server receipt is authoritative even if the owner backgrounds and
    // locks the app before optional local receipt persistence completes.
    storeProtectedMetadata(TEST_RECEIPT_KEY, JSON.stringify(receipt)).catch(
      error => {
        logWalletEvent('FastWalletPush', 'testPush.persist.error', {
          eventId: receipt.eventId,
          error,
        });
      },
    );
    return receipt;
  })()
    .catch(error => {
      logWalletEvent('FastWalletPush', 'testPush.request.error', { error });
      throw error;
    })
    .finally(() => {
      if (testPushInFlight === request) testPushInFlight = undefined;
    });
  testPushInFlight = request;
  return request;
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
    unsubscribers.push(
      instance.onNotificationOpenedApp((message: any) =>
        handleRemoteMessage(message, { opened: true }),
      ),
    );
  }
  if (instance.getInitialNotification) {
    instance
      .getInitialNotification()
      .then((message: any) =>
        message ? handleRemoteMessage(message, { opened: true }) : undefined,
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
  if (lastObservedEvent) return lastObservedEvent;
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
  testNotificationReady,
  getLastScheduledTestPush,
  startLifecycle,
  subscribe,
};
