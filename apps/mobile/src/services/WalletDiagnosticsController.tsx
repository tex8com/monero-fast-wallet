import { useEffect } from 'react';
import { Linking } from 'react-native';

import {
  emitWalletDiagnosticsLine,
  runWalletDiagnostics,
} from './WalletDiagnostics';

const DIAGNOSTICS_URL_PATTERN = /^[a-z][a-z0-9+.-]*:\/\/diagnostics(?:\/|$)/i;
const BOOT_DIAGNOSTICS_DELAY_MS = 1500;

export function WalletDiagnosticsController() {
  useEffect(() => {
    const runDiagnostics = (trigger: string) => {
      runWalletDiagnostics(trigger).catch(error => {
        logDiagnosticsError(trigger, error);
      });
    };

    const bootDiagnosticsTimeout = shouldRunBootDiagnostics()
      ? setTimeout(() => {
          runDiagnostics('boot');
        }, BOOT_DIAGNOSTICS_DELAY_MS)
      : undefined;

    const handleUrl = (url: string | null) => {
      if (!url || !isDiagnosticsUrl(url)) {
        return;
      }

      runDiagnostics('url');
    };

    Linking.getInitialURL()
      .then(handleUrl)
      .catch(() => undefined);

    const subscription = Linking.addEventListener('url', event => {
      handleUrl(event.url);
    });

    return () => {
      if (bootDiagnosticsTimeout) {
        clearTimeout(bootDiagnosticsTimeout);
      }
      subscription.remove();
    };
  }, []);

  return null;
}

function isDiagnosticsUrl(url: string): boolean {
  return DIAGNOSTICS_URL_PATTERN.test(url);
}

function shouldRunBootDiagnostics(): boolean {
  return __DEV__ && typeof jest === 'undefined';
}

function logDiagnosticsError(trigger: string, error: unknown) {
  const line = `MONERO_WALLET_DIAGNOSTICS ${JSON.stringify({
    error: error instanceof Error ? error.message : String(error),
    timestamp: new Date().toISOString(),
    trigger,
  })}`;
  emitWalletDiagnosticsLine(line).catch(() => undefined);
}
