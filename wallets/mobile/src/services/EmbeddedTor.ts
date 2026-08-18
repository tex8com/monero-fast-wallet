import { NativeModules, Platform } from 'react-native';
import type { DaemonConfig } from './NativeMoneroWallet';

const EMBEDDED_TOR_BOOTSTRAP_TIMEOUT_MS = 120_000;
const MANAGED_PROXY_ADDRESSES = new Set([
  '127.0.0.1:9050',
  'localhost:9050',
  '[::1]:9050',
]);

type EmbeddedTorNativeModule = {
  ensureReady(timeoutMs: number): Promise<string>;
};

export type EmbeddedTorRuntime = {
  platform: string;
  nativeModule?: EmbeddedTorNativeModule;
};

function daemonHost(address: string): string {
  return address
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//iu, '')
    .split('/')[0]
    .replace(/:\d+$/u, '')
    .toLowerCase();
}

export function daemonRequiresEmbeddedTor(config: DaemonConfig): boolean {
  return (
    daemonHost(config.address).length > 0 &&
    MANAGED_PROXY_ADDRESSES.has((config.proxyAddress ?? '').trim().toLowerCase())
  );
}

export async function prepareDaemonForConnection(
  config: DaemonConfig,
  runtime: EmbeddedTorRuntime = {
    platform: Platform.OS,
    nativeModule: NativeModules.EmbeddedTor as EmbeddedTorNativeModule | undefined,
  },
): Promise<DaemonConfig> {
  if (
    !daemonRequiresEmbeddedTor(config) ||
    !['android', 'ios'].includes(runtime.platform)
  ) {
    return { ...config };
  }
  if (!runtime.nativeModule) {
    throw new Error('The embedded Tor runtime is missing from this mobile build.');
  }

  const proxyAddress = (
    await runtime.nativeModule.ensureReady(EMBEDDED_TOR_BOOTSTRAP_TIMEOUT_MS)
  ).trim();
  if (!/^127\.0\.0\.1:(?:[1-9]\d{0,4})$/u.test(proxyAddress)) {
    throw new Error('The embedded Tor runtime returned an invalid SOCKS address.');
  }
  const port = Number(proxyAddress.slice(proxyAddress.lastIndexOf(':') + 1));
  if (port > 65535) {
    throw new Error('The embedded Tor runtime returned an invalid SOCKS port.');
  }

  return {
    ...config,
    proxyAddress,
  };
}
