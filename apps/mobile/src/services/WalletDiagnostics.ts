import { loadActiveNodeConnectionSettings } from './NodeConnectionSettings';
import { walletService } from './WalletService';
import { emitWalletDiagnosticsLine, logWalletEvent } from './WalletLogger';
import {torFetch} from './TorHttp';
import {
  MFW_DIAGNOSTIC_REGISTRY_SHA256,
  MFW_PRODUCT_CORE_ABI_VERSION,
  MFW_PRODUCT_CORE_SCHEMA_SHA256,
} from '../generated/mfwProductCoreContract';
import { MFW_APP_VAULT_STATE_SCHEMA_SHA256 } from '../generated/mfwAppVaultContract';

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
  const hostedFastWallets = activeFastWallets.filter(
    wallet => Boolean(wallet.assignmentHandle),
  );
  // The V3 product path uses opaque Gateway assignments and an encrypted
  // Relay/Worker watch. The legacy plaintext scanner status endpoint must not
  // be queried for those identities: doing so produces a false "view key
  // check failed" warning. The lightweight boot check validates only public
  // assignment metadata; Settings runs the deeper signed-descriptor testbench.
  const now = Math.floor(Date.now() / 1_000);
  const fastWalletChecks = hostedFastWallets.map(wallet => {
    const valid =
      /^[0-9a-f]{64}$/.test(wallet.assignmentHandle ?? '') &&
      Number.isSafeInteger(wallet.assignmentEpoch) &&
      (wallet.assignmentEpoch ?? 0) > 0 &&
      Number.isSafeInteger(wallet.assignmentExpiresAt) &&
      (wallet.assignmentExpiresAt ?? 0) > now &&
      Boolean(wallet.workerKind) &&
      Boolean(wallet.watchMessageId);
    if (!valid) errors.push('fast-wallet-assignment-invalid');
    return { checked: true, hosted: valid };
  });

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

  const networkSync = settings
    ? await walletService.networkSyncStatus(settings.network).catch(() => {
        errors.push('network-sync-status-unavailable');
        return undefined;
      })
    : undefined;

  const daemonBaseUrl = settings
    ? createDaemonBaseUrl(settings.daemon.address, settings.daemon.useSsl)
    : undefined;
  // Android production deliberately blocks clear-text fetch() traffic. The
  // Monero Core still reaches the configured RPC endpoint through its native
  // transport, whose process-wide coordinator status is authoritative. Do
  // not turn that security policy into two false red diagnostics rows.
  const allowDirectJsProbe = daemonBaseUrl?.startsWith('https://') ?? false;
  const daemonGetInfo = daemonBaseUrl && allowDirectJsProbe
    ? await fetchJsonWithTimeout(`${daemonBaseUrl}/get_info`)
    : undefined;
  const daemonJsonRpcGetInfo = daemonBaseUrl && allowDirectJsProbe
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
    productCore: {
      abiVersion: MFW_PRODUCT_CORE_ABI_VERSION,
      schemaSha256: MFW_PRODUCT_CORE_SCHEMA_SHA256,
      diagnosticRegistrySha256: MFW_DIAGNOSTIC_REGISTRY_SHA256,
      appVaultStateSchemaSha256: MFW_APP_VAULT_STATE_SCHEMA_SHA256,
    },
    daemon: {
      getInfo: summarizeGetInfo(daemonGetInfo),
      jsonRpcGetInfo: summarizeGetInfo(daemonJsonRpcGetInfo),
    },
    errors: Array.from(new Set(errors)),
    fastWallet: {
      checkedCount: fastWalletChecks.filter(wallet => wallet.checked).length,
      configuredCount: activeFastWallets.length,
      failedCount: fastWalletChecks.filter(wallet => !wallet.checked).length,
      hostedCount: fastWalletChecks.filter(
        wallet => wallet.checked && wallet.hosted,
      ).length,
      localOnlyCount: activeFastWallets.length - hostedFastWallets.length,
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
    networkSync,
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
    localOnlyCount: diagnostics.fastWallet.localOnlyCount,
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
  const fetchPromise = torFetch(url, {
    body: typeof init?.body === 'string' ? init.body : undefined,
    headers: init?.headers as Record<string, string> | undefined,
    method: init?.method,
    timeoutMs,
  })
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
