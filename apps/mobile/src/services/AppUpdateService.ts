import AsyncStorage from '@react-native-async-storage/async-storage';
import {Alert, Linking, Platform} from 'react-native';
import updateConfig from '../../../../config/app-update.json';
import mobileVersion from '../../../../config/mobile-app-version.json';
import {
  buildAppUpdateManifestUrl,
  createAppUpdateCoordinator,
  selectAppUpdate,
  type AppUpdateArchitecture,
  type AppUpdateContext,
  type AppUpdateDelivery,
  type AppUpdateOffer,
} from '../../../../packages/app-update-core/src/index';
import {logWalletEvent} from './WalletLogger';
import {torFetch} from './TorHttp';

// Manifest validation and endpoint/artifact host pinning are owned by the
// shared fail-closed core; this adapter only supplies the mobile platform
// context and OS installation boundary.
const INSTALLATION_ID_KEY = '@mfw/app-update-installation-id/v1';
let initialized = false;

function randomInstallationId(): string {
  const runtimeCrypto = (
    globalThis as unknown as {
      crypto?: {randomUUID?: () => string};
    }
  ).crypto;
  const randomUuid = runtimeCrypto?.randomUUID;
  if (randomUuid) {
    return randomUuid.call(runtimeCrypto);
  }
  return `mfw-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2)}-${Math.random().toString(36).slice(2)}`;
}

async function installationId(): Promise<string> {
  const existing = await AsyncStorage.getItem(INSTALLATION_ID_KEY);
  if (existing) {
    return existing;
  }
  const created = randomInstallationId();
  await AsyncStorage.setItem(INSTALLATION_ID_KEY, created);
  return created;
}

function architecture(): AppUpdateArchitecture {
  // Mobile release packages are universal per store/APK. Native libraries
  // inside the package still select their ABI normally.
  return 'universal';
}

function delivery(): AppUpdateDelivery {
  const configured = Platform.OS === 'ios'
    ? updateConfig.mobile.iosDelivery
    : updateConfig.mobile.androidDelivery;
  if (
    configured !== 'app-store' &&
    configured !== 'play-store' &&
    configured !== 'direct-apk'
  ) {
    throw new Error('Unsupported mobile update delivery');
  }
  return configured;
}

async function context(): Promise<AppUpdateContext> {
  if (Platform.OS !== 'android' && Platform.OS !== 'ios') {
    throw new Error('Unsupported mobile update platform');
  }
  return {
    appId: updateConfig.appId,
    channel: updateConfig.channel,
    currentVersion: mobileVersion.versionName,
    platform: Platform.OS,
    architecture: architecture(),
    delivery: delivery(),
    installationId: await installationId(),
    allowedHosts: updateConfig.mobile.allowedHosts,
  };
}

async function check(): Promise<AppUpdateOffer | null> {
  const startedAt = Date.now();
  if (!updateConfig.mobile.enabled) {
    logWalletEvent('AppUpdate', 'check.skipped', {
      elapsedMs: Date.now() - startedAt,
      status: 'unavailable',
    });
    return null;
  }
  logWalletEvent('AppUpdate', 'check.start', {
    platform: Platform.OS,
  });
  try {
    const updateContext = await context();
    const requestUrl = buildAppUpdateManifestUrl(
      updateConfig.mobile.manifestUrl,
      updateContext,
    );
    const response = await torFetch(requestUrl, {
      headers: {
        Accept: 'application/json',
        'Cache-Control': 'no-cache',
      },
    });
    if (response.status === 204 || response.status === 404) {
      logWalletEvent('AppUpdate', 'check.success', {
        available: false,
        elapsedMs: Date.now() - startedAt,
        httpStatus: response.status,
        status: 'ready',
      });
      return null;
    }
    if (!response.ok) {
      throw new Error(`Update check failed (${response.status})`);
    }
    const offer = selectAppUpdate(await response.json(), updateContext);
    logWalletEvent('AppUpdate', 'check.success', {
      available: Boolean(offer),
      elapsedMs: Date.now() - startedAt,
      httpStatus: response.status,
      status: 'ready',
    });
    return offer;
  } catch (error) {
    logWalletEvent('AppUpdate', 'check.error', {
      elapsedMs: Date.now() - startedAt,
      error,
      platform: Platform.OS,
      status: 'error',
    });
    throw error;
  }
}

async function install(offer: AppUpdateOffer): Promise<void> {
  const startedAt = Date.now();
  logWalletEvent('AppUpdate', 'install.start', {
    platform: Platform.OS,
  });
  try {
    const supported = await Linking.canOpenURL(offer.artifact.url);
    if (!supported) {
      throw new Error('The operating system cannot open the update location');
    }
    // Android/iOS remains the installation trust boundary. A direct Android
    // APK must have the same package signing identity; store builds are
    // verified and installed by their store. JavaScript never replaces the
    // running binary.
    await Linking.openURL(offer.artifact.url);
    logWalletEvent('AppUpdate', 'install.handedOff', {
      elapsedMs: Date.now() - startedAt,
      platform: Platform.OS,
      success: true,
    });
  } catch (error) {
    logWalletEvent('AppUpdate', 'install.error', {
      elapsedMs: Date.now() - startedAt,
      error,
      platform: Platform.OS,
      success: false,
    });
    throw error;
  }
}

const coordinator = createAppUpdateCoordinator({check, install});

function present(offer: AppUpdateOffer): void {
  const actions = [
    ...(!offer.mandatory
      ? [{text: 'Later', style: 'cancel' as const}]
      : []),
    {
      text: 'Update',
      onPress: () => {
        coordinator.install(offer).catch(() => {
          Alert.alert(
            'Update unavailable',
            'The secure update location could not be opened.',
          );
        });
      },
    },
  ];
  Alert.alert(
    offer.mandatory ? 'Security update required' : 'Update available',
    offer.notes?.trim() ||
      `Monero Fast Wallet ${offer.version} is ready to install.`,
    actions,
    {cancelable: !offer.mandatory},
  );
}

export const AppUpdateService = {
  check,
  install,
  getState: coordinator.getState,
  checkAndPresent: async (): Promise<AppUpdateOffer | null> => {
    const offer = await coordinator.check();
    if (offer) {
      present(offer);
    }
    return offer;
  },
  initialize(): void {
    if (
      initialized ||
      !updateConfig.mobile.enabled ||
      (
        globalThis as unknown as {
          process?: {env?: {NODE_ENV?: string}};
        }
      ).process?.env?.NODE_ENV === 'test'
    ) {
      return;
    }
    initialized = true;
    logWalletEvent('AppUpdate', 'initialize.scheduled', {
      timeoutMs: Math.max(5_000, updateConfig.checkDelayMs),
    });
    setTimeout(() => {
      this.checkAndPresent().catch(error => {
        // Update availability is never allowed to block wallet startup, but
        // diagnostics must retain a sanitized reason for later support.
        logWalletEvent('AppUpdate', 'initialize.error', {
          error,
          status: 'error',
        });
      });
    }, Math.max(5_000, updateConfig.checkDelayMs));
  },
};
