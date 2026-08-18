import AsyncStorage from '@react-native-async-storage/async-storage';
import { Linking, NativeModules, Platform } from 'react-native';
import mobileAppVersion from '../../../../../config/mobile-app-version.json';
import { AppUpdateService } from '../AppUpdateService';

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(),
  setItem: jest.fn(),
}));

const manifest = {
  schemaVersion: 1,
  appId: 'com.tex8.monerowallet',
  channel: 'stable',
  version: '99.0.0',
  minimumVersion: '1.0.7',
  updateId: 'mfw-mobile-test-newer',
  publishedAt: '2026-07-28T17:00:00.000Z',
  mandatory: false,
  rolloutPercentage: 100,
  rolloutSalt: 'mfw-stable-test',
  artifacts: [
    {
      platform: 'android',
      architecture: 'universal',
      delivery: 'direct-apk',
      url: 'https://tex8.com/xmr.apk?v=99.0.0-test',
      sha256: 'a'.repeat(64),
      size: 100,
    },
  ],
};

describe('AppUpdateService', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    Object.defineProperty(Platform, 'OS', {
      configurable: true,
      value: 'android',
    });
    (AsyncStorage.getItem as jest.Mock).mockResolvedValue('installation-test');
    (AsyncStorage.setItem as jest.Mock).mockResolvedValue(undefined);
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

  it('checks the pinned Onion manifest and selects a newer Android APK', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => manifest,
    });
    global.fetch = fetchMock;

    const offer = await AppUpdateService.check();

    expect(offer?.version).toBe('99.0.0');
    expect(offer?.artifact.url).toBe('https://tex8.com/xmr.apk?v=99.0.0-test');
    const requested = new URL(fetchMock.mock.calls[0][0]);
    expect(requested.protocol).toBe('http:');
    expect(requested.hostname).toMatch(/^[a-z2-7]{56}\.onion$/u);
    expect(requested.searchParams.get('currentVersion')).toBe(
      mobileAppVersion.versionName,
    );
    expect(requested.searchParams.get('platform')).toBe('android');
  });

  it('treats 204 and 404 as no update without touching installation state', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 404 });
    await expect(AppUpdateService.check()).resolves.toBeNull();
    expect(AsyncStorage.setItem).not.toHaveBeenCalled();
  });

  it('selects only an App Store artifact on iOS', async () => {
    Object.defineProperty(Platform, 'OS', {
      configurable: true,
      value: 'ios',
    });
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        ...manifest,
        artifacts: [
          {
            platform: 'ios',
            architecture: 'universal',
            delivery: 'app-store',
            url: 'https://apps.apple.com/app/id0000000000',
          },
        ],
      }),
    });

    const offer = await AppUpdateService.check();

    expect(offer?.artifact.delivery).toBe('app-store');
    expect(offer?.artifact.url).toBe('https://apps.apple.com/app/id0000000000');
  });

  it('hands installation to the operating system URL handler', async () => {
    jest.spyOn(Linking, 'canOpenURL').mockResolvedValue(true);
    jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined as never);
    const offer = {
      updateId: 'mfw-mobile-test-newer',
      version: '99.0.0',
      currentVersion: mobileAppVersion.versionName,
      minimumVersion: '1.0.7',
      mandatory: false,
      artifact: manifest.artifacts[0] as never,
    };

    await AppUpdateService.install(offer);

    expect(Linking.openURL).toHaveBeenCalledWith(
      'https://tex8.com/xmr.apk?v=99.0.0-test',
    );
  });
});
