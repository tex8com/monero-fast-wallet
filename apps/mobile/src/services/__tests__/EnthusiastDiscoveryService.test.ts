import AsyncStorage from '@react-native-async-storage/async-storage';
import {NativeModules} from 'react-native';

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
  loadEnthusiastDiscoveryPreference,
  refreshApproximateEnthusiastLocation,
  setEnthusiastDiscoveryEnabled,
  setEnthusiastDiscoveryRadius,
} from '../EnthusiastDiscoveryService';

describe('EnthusiastDiscoveryService', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    delete NativeModules.NearbyLocation;
    (globalThis as any).fetch = jest.fn(async (url: string, options: any = {}) => {
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
    });
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
    const persisted = JSON.stringify(
      await loadEnthusiastDiscoveryPreference(),
    );

    expect(result.locationStatus).toBe('ready');
    expect(persisted).not.toContain('47.0707');
    expect(persisted).not.toContain('15.4395');
    expect(persisted).not.toContain('latitude');
    expect(persisted).not.toContain('longitude');

    const profileRequest = (globalThis.fetch as jest.Mock).mock.calls.find(
      ([url]) => String(url).endsWith('/v1/profile'),
    );
    const uploaded = JSON.parse(profileRequest[1].body);
    expect(uploaded.area_id).toHaveLength(5);
    expect(uploaded).not.toHaveProperty('latitude');
    expect(uploaded).not.toHaveProperty('longitude');
  });
});
