import {relaunch} from '@tauri-apps/plugin-process';
import {check, type Update} from '@tauri-apps/plugin-updater';
import updateConfig from '../../../config/app-update.json';
import {
  createAppUpdateCoordinator,
  type AppUpdateArchitecture,
  type AppUpdateOffer,
  type AppUpdatePlatform,
  type AppUpdateProgress,
} from '../../../packages/app-update-core/src/index';

let pendingUpdate: Update | null = null;
let initialized = false;

function platform(): AppUpdatePlatform {
  const runtime = navigator.userAgent.toLowerCase();
  if (runtime.includes('windows')) {
    return 'windows';
  }
  if (runtime.includes('linux')) {
    return 'linux';
  }
  return 'darwin';
}

function architecture(): AppUpdateArchitecture {
  const runtime = navigator.userAgent.toLowerCase();
  return runtime.includes('arm64') || runtime.includes('aarch64')
    ? 'aarch64'
    : 'x86_64';
}

async function checkDesktopUpdate(): Promise<AppUpdateOffer | null> {
  if (!updateConfig.desktop.enabled) {
    return null;
  }
  const update = await check({
    timeout: 30_000,
    // Update metadata and artifacts follow the same fail-closed Tor route as
    // every other desktop service request. Block synchronization is the sole
    // Clearnet exception.
    proxy: 'socks5h://127.0.0.1:9050',
  });
  pendingUpdate = update;
  if (!update) {
    return null;
  }
  return {
    updateId: `${updateConfig.channel}:${update.version}`,
    version: update.version,
    currentVersion: update.currentVersion,
    minimumVersion: update.currentVersion,
    mandatory: false,
    ...(update.body ? {notes: update.body} : {}),
    artifact: {
      platform: platform(),
      architecture: architecture(),
      delivery: 'tauri',
      // The updater plugin owns and validates the actual artifact URL from its
      // signed updater response. This URL is display-only shared metadata.
      url: 'https://tex8.com/xmr/',
    },
  };
}

async function installDesktopUpdate(
  offer: AppUpdateOffer,
  onProgress?: (progress: AppUpdateProgress) => void,
): Promise<void> {
  const update = pendingUpdate;
  if (!update || update.version !== offer.version) {
    throw new Error('The checked desktop update is no longer available');
  }
  let downloadedBytes = 0;
  let totalBytes: number | undefined;
  await update.downloadAndInstall(event => {
    if (event.event === 'Started') {
      totalBytes = event.data.contentLength ?? undefined;
      onProgress?.({
        phase: 'downloading',
        downloadedBytes,
        totalBytes,
      });
      return;
    }
    if (event.event === 'Progress') {
      downloadedBytes += event.data.chunkLength;
      onProgress?.({
        phase: 'downloading',
        downloadedBytes,
        totalBytes,
      });
      return;
    }
    onProgress?.({phase: 'installing', downloadedBytes, totalBytes});
  });
  pendingUpdate = null;
  onProgress?.({phase: 'restarting'});
  await relaunch();
}

const coordinator = createAppUpdateCoordinator({
  check: checkDesktopUpdate,
  install: installDesktopUpdate,
});

export const DesktopAppUpdateService = {
  check: coordinator.check,
  install: coordinator.install,
  getState: coordinator.getState,
  initialize(): void {
    if (initialized || !updateConfig.desktop.enabled) {
      return;
    }
    initialized = true;
    setTimeout(() => {
      coordinator
        .check()
        .then(offer => {
          if (
            offer &&
            window.confirm(
              `${offer.notes || `Monero Fast Wallet ${offer.version} is available.`}\n\nDownload, verify and install it now?`,
            )
          ) {
            coordinator.install(offer).catch(() => {
              window.alert(
                'The signed update could not be installed. The current wallet version was left unchanged.',
              );
            });
          }
        })
        .catch(() => {
          // Update availability never blocks the wallet startup path.
        });
    }, Math.max(5_000, updateConfig.checkDelayMs));
  },
};
