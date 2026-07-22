import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  NativeModules,
  PermissionsAndroid,
  Platform,
} from 'react-native';
import {logWalletEvent} from './WalletLogger';

const STORAGE_KEY = 'monero-wallet.enthusiast-discovery.v1';
const ACCOUNT_STORAGE_KEY = 'monero-wallet.enthusiast-account.v1';
const COMMUNITY_API_BASE_URL = 'https://xmr.tex8.com/community';
const GEOHASH_ALPHABET = '0123456789bcdefghjkmnpqrstuvwxyz';

export type EnthusiastRadiusKm = 5 | 10 | 25;
export type EnthusiastLocationStatus =
  | 'not_requested'
  | 'requesting'
  | 'ready'
  | 'denied'
  | 'unavailable'
  | 'error';

export interface EnthusiastDiscoveryPreference {
  enabled: boolean;
  radiusKm: EnthusiastRadiusKm;
  locationStatus: EnthusiastLocationStatus;
  serverStatus?: 'ready' | 'offline';
  updatedAt?: string;
}

export type CommunityRelationship =
  | 'none'
  | 'outgoing'
  | 'incoming'
  | 'connected';

export interface CommunityProfile {
  identityId: string;
  displayName: string;
  bio: string;
  visible: boolean;
  radiusKm: EnthusiastRadiusKm;
}

export interface NearbyEnthusiast extends CommunityProfile {
  approximateDistanceKm: number;
  relationship: CommunityRelationship;
}

export interface CommunityContact extends CommunityProfile {
  status: Exclude<CommunityRelationship, 'none'>;
}

export interface CommunityMessage {
  id: string;
  senderId: string;
  recipientId: string;
  body: string;
  sentAtMs: number;
}

interface CommunityAccount {
  identityId: string;
  accessToken: string;
  displayName: string;
}

type NativeLocationSnapshot = {
  latitude: number;
  longitude: number;
  accuracy?: number;
  timestamp?: number;
};

type NearbyLocationModule = {
  getCurrentLocation(): Promise<NativeLocationSnapshot>;
};

const DEFAULT_PREFERENCE: EnthusiastDiscoveryPreference = {
  enabled: false,
  radiusKm: 10,
  locationStatus: 'not_requested',
};

let approximateAreaId: string | undefined;

function parseAccount(raw: string | null): CommunityAccount | undefined {
  if (!raw) {
    return undefined;
  }
  try {
    const value = JSON.parse(raw) as Partial<CommunityAccount>;
    if (
      typeof value.identityId === 'string' &&
      typeof value.accessToken === 'string' &&
      typeof value.displayName === 'string'
    ) {
      return value as CommunityAccount;
    }
  } catch {
    // A malformed anonymous session is replaced on the next connection.
  }
  return undefined;
}

async function loadAccount(): Promise<CommunityAccount | undefined> {
  return parseAccount(await AsyncStorage.getItem(ACCOUNT_STORAGE_KEY));
}

async function communityRequest<T>(
  path: string,
  options: RequestInit = {},
  account?: CommunityAccount,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(`${COMMUNITY_API_BASE_URL}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        ...(options.body ? {'Content-Type': 'application/json'} : {}),
        ...(account
          ? {Authorization: `Bearer ${account.accessToken}`}
          : {}),
        ...options.headers,
      },
    });
    if (!response.ok) {
      const error = await response
        .json()
        .catch(() => ({message: `Community server returned ${response.status}`}));
      throw new Error(
        typeof error?.message === 'string'
          ? error.message
          : `Community server returned ${response.status}`,
      );
    }
    if (response.status === 204) {
      return undefined as T;
    }
    return (await response.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}

function profileFromApi(value: any): CommunityProfile {
  return {
    identityId: String(value.identity_id),
    displayName: String(value.display_name),
    bio: typeof value.bio === 'string' ? value.bio : '',
    visible: value.visible === true,
    radiusKm: isRadius(value.radius_km) ? value.radius_km : 10,
  };
}

function generatedDisplayName(): string {
  return `Monero ${String(Math.floor(1000 + Math.random() * 9000))}`;
}

async function ensureCommunityAccount(): Promise<CommunityAccount> {
  const existing = await loadAccount();
  if (existing) {
    return existing;
  }
  const displayName = generatedDisplayName();
  const created = await communityRequest<any>('/v1/identities', {
    method: 'POST',
    body: JSON.stringify({display_name: displayName}),
  });
  const account: CommunityAccount = {
    identityId: String(created.identity_id),
    accessToken: String(created.access_token),
    displayName,
  };
  await AsyncStorage.setItem(ACCOUNT_STORAGE_KEY, JSON.stringify(account));
  return account;
}

async function publishCommunityProfile(
  preference: EnthusiastDiscoveryPreference,
  areaId: string | undefined,
): Promise<CommunityProfile> {
  const account = await ensureCommunityAccount();
  const profile = await communityRequest<any>(
    '/v1/profile',
    {
      method: 'PUT',
      body: JSON.stringify({
        display_name: account.displayName,
        bio: '',
        area_id: preference.enabled ? areaId : null,
        visible: preference.enabled && Boolean(areaId),
        radius_km: preference.radiusKm,
      }),
    },
    account,
  );
  return profileFromApi(profile);
}

function isRadius(value: unknown): value is EnthusiastRadiusKm {
  return value === 5 || value === 10 || value === 25;
}

function isLocationStatus(value: unknown): value is EnthusiastLocationStatus {
  return (
    value === 'not_requested' ||
    value === 'requesting' ||
    value === 'ready' ||
    value === 'denied' ||
    value === 'unavailable' ||
    value === 'error'
  );
}

function parsePreference(raw: string | null): EnthusiastDiscoveryPreference {
  if (!raw) {
    return {...DEFAULT_PREFERENCE};
  }

  try {
    const parsed = JSON.parse(raw) as Partial<EnthusiastDiscoveryPreference>;
    return {
      enabled: parsed.enabled === true,
      radiusKm: isRadius(parsed.radiusKm) ? parsed.radiusKm : 10,
      locationStatus: isLocationStatus(parsed.locationStatus)
        ? parsed.locationStatus === 'requesting' || parsed.locationStatus === 'ready'
          ? 'not_requested'
          : parsed.locationStatus
        : 'not_requested',
      updatedAt:
        typeof parsed.updatedAt === 'string' ? parsed.updatedAt : undefined,
      serverStatus:
        parsed.serverStatus === 'ready' || parsed.serverStatus === 'offline'
          ? parsed.serverStatus
          : undefined,
    };
  } catch {
    return {...DEFAULT_PREFERENCE};
  }
}

async function savePreference(
  preference: EnthusiastDiscoveryPreference,
): Promise<EnthusiastDiscoveryPreference> {
  const next = {
    ...preference,
    updatedAt: new Date().toISOString(),
  };
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  return next;
}

export async function loadEnthusiastDiscoveryPreference(): Promise<EnthusiastDiscoveryPreference> {
  return parsePreference(await AsyncStorage.getItem(STORAGE_KEY));
}

export async function setEnthusiastDiscoveryEnabled(
  enabled: boolean,
): Promise<EnthusiastDiscoveryPreference> {
  const current = await loadEnthusiastDiscoveryPreference();
  if (!enabled) {
    approximateAreaId = undefined;
    const account = await loadAccount();
    if (account) {
      communityRequest(
        '/v1/profile',
        {
          method: 'PUT',
          body: JSON.stringify({
            display_name: account.displayName,
            bio: '',
            area_id: null,
            visible: false,
            radius_km: current.radiusKm,
          }),
        },
        account,
      ).catch(() => undefined);
    }
  }
  return savePreference({
    ...current,
    enabled,
    locationStatus: enabled ? current.locationStatus : 'not_requested',
  });
}

export async function setEnthusiastDiscoveryRadius(
  radiusKm: EnthusiastRadiusKm,
): Promise<EnthusiastDiscoveryPreference> {
  const current = await loadEnthusiastDiscoveryPreference();
  return savePreference({...current, radiusKm});
}

async function requestAndroidLocationPermission(): Promise<boolean> {
  if (Platform.OS !== 'android') {
    logWalletEvent('community-location', 'permission.not-required', {
      platform: Platform.OS,
    });
    return true;
  }
  const fine = PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION;
  const coarse = PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION;
  if (
    (await PermissionsAndroid.check(fine)) ||
    (await PermissionsAndroid.check(coarse))
  ) {
    logWalletEvent('community-location', 'permission.already-granted');
    return true;
  }
  const result = await PermissionsAndroid.requestMultiple([fine, coarse]);
  const granted =
    result[fine] === PermissionsAndroid.RESULTS.GRANTED ||
    result[coarse] === PermissionsAndroid.RESULTS.GRANTED;
  logWalletEvent('community-location', 'permission.request-result', {
    granted,
    fine: result[fine],
    coarse: result[coarse],
  });
  return granted;
}

function validLocation(value: unknown): value is NativeLocationSnapshot {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Partial<NativeLocationSnapshot>;
  return (
    typeof candidate.latitude === 'number' &&
    Number.isFinite(candidate.latitude) &&
    Math.abs(candidate.latitude) <= 90 &&
    typeof candidate.longitude === 'number' &&
    Number.isFinite(candidate.longitude) &&
    Math.abs(candidate.longitude) <= 180
  );
}

export function approximateAreaForCoordinates(
  latitude: number,
  longitude: number,
): string {
  let latitudeRange: [number, number] = [-90, 90];
  let longitudeRange: [number, number] = [-180, 180];
  let bits = 0;
  let value = 0;
  let useLongitude = true;
  let result = '';

  while (result.length < 5) {
    const range = useLongitude ? longitudeRange : latitudeRange;
    const coordinate = useLongitude ? longitude : latitude;
    const midpoint = (range[0] + range[1]) / 2;
    value = value * 2 + (coordinate >= midpoint ? 1 : 0);
    if (coordinate >= midpoint) {
      range[0] = midpoint;
    } else {
      range[1] = midpoint;
    }
    useLongitude = !useLongitude;
    bits += 1;

    if (bits === 5) {
      result += GEOHASH_ALPHABET[value];
      bits = 0;
      value = 0;
    }
  }

  return result;
}

function locationErrorStatus(error: unknown): EnthusiastLocationStatus {
  const message = error instanceof Error ? error.message : String(error);
  if (/denied|permission|restricted/i.test(message)) {
    return 'denied';
  }
  if (/unavailable|timeout|module/i.test(message)) {
    return 'unavailable';
  }
  return 'error';
}

export async function refreshApproximateEnthusiastLocation(): Promise<EnthusiastDiscoveryPreference> {
  const current = await loadEnthusiastDiscoveryPreference();
  // Request one fresh location as Community opens, even before the user
  // chooses visibility. Exact coordinates never leave this function: only a
  // coarse geohash is kept in memory and it is uploaded only when discovery
  // has explicitly been enabled.
  logWalletEvent('community-location', 'request.started', {
    discoveryEnabled: current.enabled,
  });
  await savePreference({...current, locationStatus: 'requesting'});
  try {
    if (!(await requestAndroidLocationPermission())) {
      logWalletEvent('community-location', 'request.denied');
      return savePreference({...current, locationStatus: 'denied'});
    }

    const module = NativeModules.NearbyLocation as
      | NearbyLocationModule
      | undefined;
    if (!module?.getCurrentLocation) {
      logWalletEvent('community-location', 'request.native-module-unavailable');
      return savePreference({...current, locationStatus: 'unavailable'});
    }

    const location = await module.getCurrentLocation();
    if (!validLocation(location)) {
      logWalletEvent('community-location', 'request.invalid-result');
      return savePreference({...current, locationStatus: 'unavailable'});
    }

    // Only this coarse cell remains in memory. Exact coordinates are discarded.
    approximateAreaId = approximateAreaForCoordinates(
      location.latitude,
      location.longitude,
    );
    const ready = await savePreference({...current, locationStatus: 'ready'});
    logWalletEvent('community-location', 'request.ready', {
      accuracyMeters:
        typeof location.accuracy === 'number' ? Math.round(location.accuracy) : undefined,
      published: current.enabled,
    });
    if (!current.enabled) {
      return ready;
    }
    try {
      await publishCommunityProfile(ready, approximateAreaId);
      logWalletEvent('community-location', 'community-profile.published');
      return savePreference({...ready, serverStatus: 'ready'});
    } catch {
      logWalletEvent('community-location', 'community-profile.publish-failed');
      return savePreference({...ready, serverStatus: 'offline'});
    }
  } catch (error) {
    approximateAreaId = undefined;
    logWalletEvent('community-location', 'request.failed', {
      status: locationErrorStatus(error),
      message: error instanceof Error ? error.message : String(error),
    });
    return savePreference({
      ...current,
      locationStatus: locationErrorStatus(error),
    });
  }
}

export function getCurrentApproximateAreaId(): string | undefined {
  return approximateAreaId;
}

export async function getCommunityIdentityId(): Promise<string | undefined> {
  return (await loadAccount())?.identityId;
}

export async function loadCommunityProfile(): Promise<CommunityProfile> {
  const account = await ensureCommunityAccount();
  return profileFromApi(
    await communityRequest('/v1/profile', {method: 'GET'}, account),
  );
}

export async function updateCommunityDisplayName(
  displayName: string,
  preference: EnthusiastDiscoveryPreference,
): Promise<CommunityProfile> {
  const account = await ensureCommunityAccount();
  const updatedAccount = {...account, displayName: displayName.trim()};
  const response = await communityRequest<any>(
    '/v1/profile',
    {
      method: 'PUT',
      body: JSON.stringify({
        display_name: updatedAccount.displayName,
        bio: '',
        area_id: preference.enabled ? approximateAreaId ?? null : null,
        visible: preference.enabled && Boolean(approximateAreaId),
        radius_km: preference.radiusKm,
      }),
    },
    updatedAccount,
  );
  await AsyncStorage.setItem(
    ACCOUNT_STORAGE_KEY,
    JSON.stringify(updatedAccount),
  );
  return profileFromApi(response);
}

export async function listNearbyEnthusiasts(
  radiusKm: EnthusiastRadiusKm,
): Promise<NearbyEnthusiast[]> {
  const account = await ensureCommunityAccount();
  const response = await communityRequest<any[]>(
    `/v1/nearby?radius_km=${radiusKm}`,
    {method: 'GET'},
    account,
  );
  return response.map(value => ({
    ...profileFromApi(value),
    approximateDistanceKm:
      typeof value.approximate_distance_km === 'number'
        ? value.approximate_distance_km
        : 0,
    relationship: value.relationship as CommunityRelationship,
  }));
}

export async function listCommunityContacts(): Promise<CommunityContact[]> {
  const account = await ensureCommunityAccount();
  const response = await communityRequest<any[]>(
    '/v1/contacts',
    {method: 'GET'},
    account,
  );
  return response.map(value => ({
    ...profileFromApi(value),
    status: value.status as CommunityContact['status'],
  }));
}

export async function requestCommunityContact(peerId: string): Promise<void> {
  const account = await ensureCommunityAccount();
  await communityRequest(
    `/v1/contacts/${encodeURIComponent(peerId)}`,
    {method: 'POST'},
    account,
  );
}

export async function acceptCommunityContact(peerId: string): Promise<void> {
  const account = await ensureCommunityAccount();
  await communityRequest(
    `/v1/contacts/${encodeURIComponent(peerId)}/accept`,
    {method: 'POST'},
    account,
  );
}

export async function listCommunityMessages(
  peerId: string,
  afterMs = 0,
): Promise<CommunityMessage[]> {
  const account = await ensureCommunityAccount();
  const response = await communityRequest<any[]>(
    `/v1/conversations/${encodeURIComponent(peerId)}/messages?after_ms=${afterMs}`,
    {method: 'GET'},
    account,
  );
  return response.map(value => ({
    id: String(value.id),
    senderId: String(value.sender_id),
    recipientId: String(value.recipient_id),
    body: String(value.body),
    sentAtMs: Number(value.sent_at_ms),
  }));
}

export async function sendCommunityMessage(
  peerId: string,
  body: string,
): Promise<CommunityMessage> {
  const account = await ensureCommunityAccount();
  const value = await communityRequest<any>(
    `/v1/conversations/${encodeURIComponent(peerId)}/messages`,
    {method: 'POST', body: JSON.stringify({body})},
    account,
  );
  return {
    id: String(value.id),
    senderId: String(value.sender_id),
    recipientId: String(value.recipient_id),
    body: String(value.body),
    sentAtMs: Number(value.sent_at_ms),
  };
}

export async function blockCommunityProfile(peerId: string): Promise<void> {
  const account = await ensureCommunityAccount();
  await communityRequest(
    `/v1/blocks/${encodeURIComponent(peerId)}`,
    {method: 'POST'},
    account,
  );
}

export async function reportCommunityProfile(
  peerId: string,
  reason: string,
): Promise<void> {
  const account = await ensureCommunityAccount();
  await communityRequest(
    `/v1/reports/${encodeURIComponent(peerId)}`,
    {method: 'POST', body: JSON.stringify({reason})},
    account,
  );
}

export async function deleteCommunityIdentity(): Promise<void> {
  const account = await loadAccount();
  if (account) {
    await communityRequest('/v1/profile', {method: 'DELETE'}, account);
  }
  await AsyncStorage.removeItem(ACCOUNT_STORAGE_KEY);
  approximateAreaId = undefined;
}
