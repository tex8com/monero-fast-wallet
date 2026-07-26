import {
  fastReceiveScannerUrlForSettings,
  loadActiveNodeConnectionSettings,
} from './NodeConnectionSettings';
import { walletService } from './WalletService';
import { emitWalletDiagnosticsLine, logWalletEvent } from './WalletLogger';

export { emitWalletDiagnosticsLine };

type JsonRecord = Record<string, unknown>;

interface HttpDiagnosticResult {
  error?: string;
  json?: JsonRecord;
  ok: boolean;
  status?: number;
}

/**
 * User-visible health check. It deliberately returns only coarse state and
 * chain heights: never paths, addresses, balances, wallet ids, scanner URLs,
 * contacts, transaction data, or raw native/network error strings.
 */
export async function runWalletDiagnostics(trigger = 'manual') {
  const errors: string[] = [];
  const settings = await loadActiveNodeConnectionSettings().catch(() => {
    errors.push('settings-unavailable');
    return undefined;
  });
  const registeredWallet = await walletService
    .loadRegisteredWallet()
    .catch(() => {
      errors.push('wallet-registry-unavailable');
      return undefined;
    });
  const fastWallets = await walletService
    .loadFastReceiveIdentities()
    .catch(() => {
      errors.push('fast-wallet-registry-unavailable');
      return [];
    });
  const activeFastWallets = settings
    ? fastWallets.filter(wallet => wallet.network === settings.network)
    : fastWallets;
  const scannerUrl = settings
    ? fastReceiveScannerUrlForSettings(settings)
    : undefined;
  const fastWalletChecks = await Promise.all(
    activeFastWallets.map(async wallet => {
      if (!scannerUrl) {
        return { checked: false, hosted: false };
      }
      try {
        const result = await walletService.checkFastReceiveRegistration(
          wallet.id,
          scannerUrl,
        );
        return { checked: true, hosted: result.registered };
      } catch {
        errors.push('fast-wallet-check-failed');
        return { checked: false, hosted: false };
      }
    }),
  );

  const activeSession = walletService.getActiveSession();
  const rawSnapshot = activeSession
    ? await walletService.snapshot(activeSession).catch(() => {
        errors.push('wallet-snapshot-unavailable');
        return undefined;
      })
    : undefined;
  const linkedWithMonero = await walletService.linkedWithMonero().catch(() => {
    errors.push('native-core-unavailable');
    return false;
  });
  const rawLedgerTransport = await walletService
    .getLedgerTransportStatus()
    .catch(() => {
      errors.push('ledger-status-unavailable');
      return undefined;
    });

  const daemonBaseUrl = settings
    ? createDaemonBaseUrl(settings.daemon.address, settings.daemon.useSsl)
    : undefined;
  const daemonGetInfo = daemonBaseUrl
    ? await fetchJsonWithTimeout(`${daemonBaseUrl}/get_info`)
    : undefined;
  const daemonJsonRpcGetInfo = daemonBaseUrl
    ? await fetchJsonWithTimeout(`${daemonBaseUrl}/json_rpc`, {
        body: JSON.stringify({
          id: 'diagnostics',
          jsonrpc: '2.0',
          method: 'get_info',
          params: {},
        }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      })
    : undefined;

  const diagnostics = {
    daemon: {
      getInfo: summarizeGetInfo(daemonGetInfo),
      jsonRpcGetInfo: summarizeGetInfo(daemonJsonRpcGetInfo),
    },
    errors: Array.from(new Set(errors)),
    fastWallet: {
      checkedCount: fastWalletChecks.filter(wallet => wallet.checked).length,
      configuredCount: activeFastWallets.length,
      hostedCount: fastWalletChecks.filter(
        wallet => wallet.checked && wallet.hosted,
      ).length,
    },
    ledgerTransport: rawLedgerTransport
      ? {
          available: rawLedgerTransport.available,
          deviceCount: rawLedgerTransport.deviceCount,
          deviceName: '',
          message: rawLedgerTransport.permissionGranted
            ? 'Ready'
            : 'Permission required',
          permissionGranted: rawLedgerTransport.permissionGranted,
          platform: rawLedgerTransport.platform,
          requiresUserAction: rawLedgerTransport.requiresUserAction,
          supported: rawLedgerTransport.supported,
          transport: rawLedgerTransport.transport,
        }
      : undefined,
    native: { linkedWithMonero },
    registeredWallet: registeredWallet ? { present: true } : undefined,
    settings: settings
      ? {
          grpcConfigured: settings.grpcEndpoint.length > 0,
          mode: settings.mode,
          network: settings.network,
          trusted: settings.daemon.trusted,
          useSsl: settings.daemon.useSsl ?? false,
        }
      : undefined,
    snapshot: rawSnapshot
      ? {
          daemonHeight: rawSnapshot.daemonHeight,
          synchronized: rawSnapshot.synchronized,
          walletHeight: rawSnapshot.walletHeight,
        }
      : undefined,
  };

  logWalletEvent('WalletDiagnostics', 'health-check.complete', {
    checkedCount: diagnostics.fastWallet.checkedCount,
    configuredCount: diagnostics.fastWallet.configuredCount,
    hostedCount: diagnostics.fastWallet.hostedCount,
    linked: diagnostics.native.linkedWithMonero,
    status: diagnostics.errors.length === 0 ? 'ready' : 'warning',
    trigger: normalizeTrigger(trigger),
  });
  return diagnostics;
}

function normalizeTrigger(trigger: string) {
  return trigger === 'manual' || trigger === 'boot' || trigger === 'url'
    ? trigger
    : 'other';
}

function createDaemonBaseUrl(address: string, useSsl?: boolean): string {
  if (/^https?:\/\//i.test(address)) {
    return address;
  }
  return `${useSsl ? 'https' : 'http'}://${address}`;
}

async function fetchJsonWithTimeout(
  url: string,
  init?: RequestInit,
  timeoutMs = 10000,
): Promise<HttpDiagnosticResult> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<HttpDiagnosticResult>(resolve => {
    timeout = setTimeout(
      () => resolve({ error: 'timeout', ok: false }),
      timeoutMs,
    );
  });
  const fetchPromise = fetch(url, init)
    .then(async response => ({
      json: parseJson(await response.text()),
      ok: response.ok,
      status: response.status,
    }))
    .catch(() => ({ error: 'request-failed', ok: false }))
    .finally(() => {
      if (timeout) {
        clearTimeout(timeout);
      }
    });
  return Promise.race([fetchPromise, timeoutPromise]);
}

function parseJson(value: string): JsonRecord | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function summarizeGetInfo(result: HttpDiagnosticResult | undefined) {
  if (!result) {
    return undefined;
  }
  const payload = isRecord(result.json?.result)
    ? result.json.result
    : result.json;
  return {
    error: result.error,
    height: payload?.height,
    httpStatus: result.status,
    ok: result.ok,
    status: payload?.status,
    synchronized: payload?.synchronized,
    targetHeight: payload?.target_height,
  };
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null;
}
