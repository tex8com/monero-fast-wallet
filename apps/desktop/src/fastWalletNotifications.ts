import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification';
import { invoke } from '@tauri-apps/api/core';

/**
 * Shared with the mobile FastWalletPushService and notify-scanner. A signal is
 * deliberately insufficient to reveal a payment: the wallet refreshes its
 * own local core before displaying any wallet data.
 */
export const FAST_WALLET_PUSH_CONTRACT = 'monero-fast-wallet-push.v3' as const;
export const FAST_WALLET_PUSH_TYPE = 'monero.fast_wallet.incoming' as const;

const PREFERENCES_KEY = 'monero-fast-wallet.desktop.notifications.v1';
const LAST_EVENT_ID_KEY = 'monero-fast-wallet.desktop.notification-last-event.v1';
const FORBIDDEN_EVENT_FIELDS = new Set([
  'address', 'amountAtomic', 'amount_atomic', 'blockHeight', 'block_height',
  'confirmations', 'keyImage', 'key_image', 'network', 'outputIndex',
  'output_index', 'privateSpendKey', 'private_spend_key', 'privateViewKey',
  'private_view_key', 'seed', 'spendKey', 'state', 'txId', 'tx_id',
  'walletId', 'wallet_id', 'walletAddress',
]);

export type FastWalletPushEvent = {
  type: typeof FAST_WALLET_PUSH_TYPE;
  contractVersion: typeof FAST_WALLET_PUSH_CONTRACT;
  eventId: string;
};

export type DesktopNotificationPreferences = {
  fastWalletSignalsEnabled: boolean;
};

export type DesktopNotificationStatus = DesktopNotificationPreferences & {
  permission: 'granted' | 'denied' | 'unknown';
  delivery: 'disabled' | 'local-while-open' | 'closed-app-apns' | 'background-windows-agent' | 'background-linux-agent';
  platform: 'macos' | 'windows' | 'linux' | 'unknown';
  provider: 'apns' | 'windows-agent' | 'linux-agent' | 'tauri-local';
  providerStatus: 'ready' | 'not-configured' | 'local-fallback' | 'disabled' | string;
  gatewayStatus: 'unregistered' | 'provider-pending' | 'active' | 'needs-refresh' | 'disabled' | string;
  gatewayGeneration?: number;
  gatewayLeaseExpiresAt?: number;
  backgroundModeSupported: boolean;
  backgroundModeEnabled: boolean;
  backgroundAgentConfigPath?: string;
  installationId: string;
};

export type NotificationEvent = {
  id: string;
  category: string;
  deepLink: string;
  receivedAt: string;
  opened: boolean;
};

type NativeNotificationInstallationStatus = {
  installation: {
    installationId: string;
    platform: DesktopNotificationStatus['platform'];
    provider: DesktopNotificationStatus['provider'];
    permissionStatus: 'authorized' | 'denied' | 'provisional' | 'unknown';
    enabled: boolean;
    backgroundModeEnabled: boolean;
    providerStatus: DesktopNotificationStatus['providerStatus'];
    gatewayStatus: DesktopNotificationStatus['gatewayStatus'];
    gatewayGeneration?: number | null;
    gatewayLeaseExpiresAt?: number | null;
  };
  delivery: DesktopNotificationStatus['delivery'];
  backgroundModeSupported: boolean;
  backgroundAgentConfigPath?: string | null;
};

export type NotificationClient = {
  requestPermission(): Promise<DesktopNotificationStatus>;
  refreshInstallation(): Promise<void>;
  disable(): Promise<DesktopNotificationStatus>;
  consumePendingOpen(): Promise<NotificationEvent | null>;
};

function storageGet(key: string): string | null {
  try { return window.localStorage.getItem(key); } catch { return null; }
}

function storageSet(key: string, value: string): void {
  try { window.localStorage.setItem(key, value); } catch { /* Optional local preference storage. */ }
}

export function getDesktopNotificationPreferences(): DesktopNotificationPreferences {
  const raw = storageGet(PREFERENCES_KEY);
  if (!raw) return { fastWalletSignalsEnabled: false };
  try {
    const parsed = JSON.parse(raw) as Partial<DesktopNotificationPreferences>;
    return { fastWalletSignalsEnabled: parsed.fastWalletSignalsEnabled === true };
  } catch {
    return { fastWalletSignalsEnabled: false };
  }
}

export function setDesktopNotificationPreferences(next: DesktopNotificationPreferences): void {
  storageSet(PREFERENCES_KEY, JSON.stringify({ fastWalletSignalsEnabled: next.fastWalletSignalsEnabled === true }));
}

function permissionStatus(granted: boolean): DesktopNotificationStatus['permission'] {
  return granted ? 'granted' : 'denied';
}

function nativePermissionStatus(permission: DesktopNotificationStatus['permission']) {
  return permission === 'granted' ? 'authorized' : permission === 'denied' ? 'denied' : 'unknown';
}

function normalizeStatus(
  native: NativeNotificationInstallationStatus | undefined,
  preferences = getDesktopNotificationPreferences(),
): DesktopNotificationStatus {
  const installation = native?.installation;
  return {
    ...preferences,
    permission: installation?.permissionStatus === 'authorized'
      ? 'granted'
      : installation?.permissionStatus === 'denied'
        ? 'denied'
        : 'unknown',
    delivery: native?.delivery ?? 'local-while-open',
    platform: installation?.platform ?? 'unknown',
    provider: installation?.provider ?? 'tauri-local',
    providerStatus: installation?.providerStatus ?? 'not-configured',
    gatewayStatus: installation?.gatewayStatus ?? 'unregistered',
    gatewayGeneration: installation?.gatewayGeneration ?? undefined,
    gatewayLeaseExpiresAt: installation?.gatewayLeaseExpiresAt ?? undefined,
    backgroundModeSupported: native?.backgroundModeSupported === true,
    backgroundModeEnabled: installation?.backgroundModeEnabled === true,
    backgroundAgentConfigPath: native?.backgroundAgentConfigPath ?? undefined,
    // The native OS-secured installation is the sole authority. Never invent
    // a renderer/localStorage identity that the Gateway cannot authenticate.
    installationId: installation?.installationId ?? '',
  };
}

export async function desktopNotificationStatus(): Promise<DesktopNotificationStatus> {
  try {
    const native = await invoke<NativeNotificationInstallationStatus>('notification_installation_status');
    return normalizeStatus(native);
  } catch {
    return normalizeStatus(undefined);
  }
}

/**
 * Must be called from an explicit user action. This registers the desktop
 * installation with the platform provider selected by the native host:
 * APNs on macOS and a private, per-user background agent on Windows and Linux.
 */
export async function enableDesktopFastWalletSignals(): Promise<DesktopNotificationStatus> {
  let granted = await isPermissionGranted();
  if (!granted) granted = (await requestPermission()) === 'granted';
  const permission = permissionStatus(granted);
  if (!granted) {
    setDesktopNotificationPreferences({ fastWalletSignalsEnabled: false });
    const native = await invoke<NativeNotificationInstallationStatus>('request_notification_installation', {
      input: { permissionStatus: nativePermissionStatus(permission), locale: navigator.language },
    });
    return normalizeStatus(native, getDesktopNotificationPreferences());
  }
  setDesktopNotificationPreferences({ fastWalletSignalsEnabled: true });
  const existing = await invoke<NativeNotificationInstallationStatus>('notification_installation_status').catch(() => undefined);
  const native = await invoke<NativeNotificationInstallationStatus>('request_notification_installation', {
    input: {
      permissionStatus: nativePermissionStatus(permission),
      locale: navigator.language,
      backgroundModeEnabled: existing?.installation.platform === 'windows' || existing?.installation.platform === 'linux',
    },
  });
  return normalizeStatus(native);
}

export async function disableDesktopFastWalletSignals(): Promise<DesktopNotificationStatus> {
  setDesktopNotificationPreferences({ fastWalletSignalsEnabled: false });
  const native = await invoke<NativeNotificationInstallationStatus>('disable_notification_installation');
  return normalizeStatus(native);
}

export function createDesktopNotificationClient(): NotificationClient {
  return {
    requestPermission: enableDesktopFastWalletSignals,
    refreshInstallation: async () => { await desktopNotificationStatus(); },
    disable: disableDesktopFastWalletSignals,
    consumePendingOpen: () => invoke<NotificationEvent | null>('consume_pending_notification_open'),
  };
}

/**
 * Rejects any payload with a detail field. In particular, a notification can
 * never carry a wallet name, address, amount, transaction id, or key material.
 */
export function parseFastWalletPushEvent(payload: unknown): FastWalletPushEvent | undefined {
  const data = typeof payload === 'object' && payload !== null && 'data' in payload
    ? (payload as { data?: unknown }).data
    : payload;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;
  const record = data as Record<string, unknown>;
  const fields = Object.keys(record);
  if (
    fields.length !== 3 ||
    fields.some(field => field !== 'type' && field !== 'contractVersion' && field !== 'eventId') ||
    fields.some(field => FORBIDDEN_EVENT_FIELDS.has(field)) ||
    record.type !== FAST_WALLET_PUSH_TYPE ||
    record.contractVersion !== FAST_WALLET_PUSH_CONTRACT ||
    typeof record.eventId !== 'string' ||
    !/^(?:fwpush_[0-9a-f]{32}|sig_[0-9a-f]{64}|evt_[0-9a-f]{64})$/.test(record.eventId)
  ) return undefined;
  return { type: FAST_WALLET_PUSH_TYPE, contractVersion: FAST_WALLET_PUSH_CONTRACT, eventId: record.eventId };
}

export async function showPrivacySafeFastWalletNotification(event: FastWalletPushEvent): Promise<boolean> {
  const preferences = getDesktopNotificationPreferences();
  if (!preferences.fastWalletSignalsEnabled || storageGet(LAST_EVENT_ID_KEY) === event.eventId) return false;
  if (!(await isPermissionGranted())) return false;
  // Keep the macOS notification generic even after local parsing.
  sendNotification({
    title: 'Monero Fast Wallet',
    body: 'New private activity. Open the wallet to refresh.',
  });
  storageSet(LAST_EVENT_ID_KEY, event.eventId);
  return true;
}

/** Manual verification uses the exact same no-detail body as a real signal. */
export async function sendPrivacySafeNotificationTest(): Promise<boolean> {
  const preferences = getDesktopNotificationPreferences();
  if (!preferences.fastWalletSignalsEnabled || !(await isPermissionGranted())) return false;
  sendNotification({ title: 'Monero Fast Wallet', body: 'Private notifications are enabled.' });
  return true;
}
