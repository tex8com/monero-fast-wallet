import AsyncStorage from '@react-native-async-storage/async-storage';
import { NativeModules } from 'react-native';

jest.mock('@react-native-async-storage/async-storage', () => {
  const storage = new Map<string, string>();
  return {
    __esModule: true,
    default: {
      clear: jest.fn(async () => storage.clear()),
      getItem: jest.fn(async (key: string) => storage.get(key) ?? null),
      setItem: jest.fn(async (key: string, value: string) => {
        storage.set(key, value);
      }),
      removeItem: jest.fn(async (key: string) => storage.delete(key)),
    },
  };
});

import {
  approximateAreaForCoordinates,
  getEnthusiastLocationDebug,
  loadEnthusiastDiscoveryPreference,
  refreshApproximateEnthusiastLocation,
  removeCommunityListing,
  setEnthusiastDiscoveryEnabled,
  setEnthusiastDiscoveryRadius,
} from '../EnthusiastDiscoveryService';

describe('EnthusiastDiscoveryService', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    await AsyncStorage.clear();
    delete NativeModules.NearbyLocation;
    (globalThis as any).fetch = jest.fn(
      async (url: string, options: any = {}) => {
        if (url.endsWith('/v1/identities')) {
          return {
            ok: true,
            status: 201,
            json: async () => ({
              identity_id: 'anonymous-1',
              access_token: 'community-token',
            }),
          };
        }
        const body = options.body ? JSON.parse(options.body) : {};
        return {
          ok: true,
          status: 200,
          json: async () => ({
            identity_id: 'anonymous-1',
            display_name: body.display_name ?? 'Monero 1234',
            bio: '',
            visible: body.visible ?? true,
            radius_km: body.radius_km ?? 10,
          }),
        };
      },
    );
    NativeModules.EmbeddedTor = {
      request: jest.fn(async (url: string, method: string, headers: Record<string, string>, body: string | null) => {
        const result = await globalThis.fetch(url, {method, headers, body: body ?? undefined});
        const responseBody =
          typeof (result as any).text === 'function'
            ? await (result as any).text()
            : typeof (result as any).json === 'function'
              ? JSON.stringify(await (result as any).json())
              : '';
        return {status: result.status, body: responseBody};
      }),
    };
  });

  it('defaults to disabled while onboarding can explicitly opt in', async () => {
    expect(await loadEnthusiastDiscoveryPreference()).toEqual({
      enabled: false,
      radiusKm: 10,
      locationStatus: 'not_requested',
    });

    await setEnthusiastDiscoveryEnabled(true);
    await setEnthusiastDiscoveryRadius(25);

    expect(await loadEnthusiastDiscoveryPreference()).toMatchObject({
      enabled: true,
      radiusKm: 25,
    });
  });

  it('reduces nearby coordinates to the same approximate area', () => {
    const first = approximateAreaForCoordinates(47.0707, 15.4395);
    const nearby = approximateAreaForCoordinates(47.071, 15.441);
    const distant = approximateAreaForCoordinates(48.2082, 16.3738);

    expect(first).toHaveLength(5);
    expect(nearby).toBe(first);
    expect(distant).not.toBe(first);
  });

  it('never persists exact native coordinates', async () => {
    NativeModules.NearbyLocation = {
      getCurrentLocation: jest.fn(async () => ({
        latitude: 47.0707,
        longitude: 15.4395,
        accuracy: 8,
      })),
    };
    await setEnthusiastDiscoveryEnabled(true);

    const result = await refreshApproximateEnthusiastLocation();
    const persisted = JSON.stringify(await loadEnthusiastDiscoveryPreference());

    expect(result.locationStatus).toBe('ready');
    expect(persisted).not.toContain('47.0707');
    expect(persisted).not.toContain('15.4395');
    expect(persisted).not.toContain('latitude');
    expect(persisted).not.toContain('longitude');
    expect(getEnthusiastLocationDebug()).toMatchObject({
      status: 'ready',
      latitude: 47.0707,
      longitude: 15.4395,
      accuracyMeters: 8,
    });

    const profileRequest = (globalThis.fetch as jest.Mock).mock.calls.find(
      ([url]) => String(url).endsWith('/v1/profile'),
    );
    const uploaded = JSON.parse(profileRequest[1].body);
    expect(uploaded.area_id).toHaveLength(5);
    expect(uploaded).not.toHaveProperty('latitude');
    expect(uploaded).not.toHaveProperty('longitude');
  });

  it('ends a native location request that never resolves', async () => {
    jest.useFakeTimers();
    NativeModules.NearbyLocation = {
      getCurrentLocation: jest.fn(() => new Promise(() => undefined)),
    };

    try {
      const pending = refreshApproximateEnthusiastLocation(true);
      await jest.advanceTimersByTimeAsync(12_001);

      await expect(pending).resolves.toMatchObject({
        locationStatus: 'unavailable',
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('reuses the in-memory approximate area when visibility is enabled', async () => {
    NativeModules.NearbyLocation = {
      getCurrentLocation: jest.fn(async () => ({
        latitude: 47.0707,
        longitude: 15.4395,
        accuracy: 500,
      })),
    };

    await refreshApproximateEnthusiastLocation(true);
    await setEnthusiastDiscoveryEnabled(true);
    const result = await refreshApproximateEnthusiastLocation();

    expect(result.locationStatus).toBe('ready');
    expect(
      NativeModules.NearbyLocation.getCurrentLocation,
    ).toHaveBeenCalledTimes(1);
  });

  it('removes only the public listing and keeps the anonymous account', async () => {
    NativeModules.NearbyLocation = {
      getCurrentLocation: jest.fn(async () => ({
        latitude: 47.0707,
        longitude: 15.4395,
        accuracy: 8,
      })),
    };

    await setEnthusiastDiscoveryEnabled(true);
    await refreshApproximateEnthusiastLocation();
    const result = await removeCommunityListing();

    expect(result).toMatchObject({
      enabled: false,
      locationStatus: 'not_requested',
    });
    const profileRequests = (globalThis.fetch as jest.Mock).mock.calls.filter(
      ([url]) => String(url).endsWith('/v1/profile'),
    );
    const removedListing = JSON.parse(
      profileRequests[profileRequests.length - 1][1].body,
    );
    expect(removedListing).toMatchObject({
      area_id: null,
      visible: false,
    });
    expect(AsyncStorage.removeItem).not.toHaveBeenCalled();
  });
});
