import { loadActiveNodeConnectionSettings } from "./NodeConnectionSettings";
import { walletService } from "./WalletService";
import {
  emitWalletDiagnosticsLine,
  WALLET_DIAGNOSTIC_LOG_PREFIX,
} from "./WalletLogger";

export { emitWalletDiagnosticsLine };

type JsonRecord = Record<string, unknown>;

interface HttpDiagnosticResult {
  error?: string;
  json?: JsonRecord;
  ok: boolean;
  status?: number;
}

export async function runWalletDiagnostics(trigger = "manual") {
  const errors: string[] = [];
  const settings = await loadActiveNodeConnectionSettings().catch(error => {
    errors.push(errorMessage(error));
    return undefined;
  });
  const registeredWallet = await walletService
    .loadRegisteredWallet()
    .catch(error => {
      errors.push(errorMessage(error));
      return undefined;
    });
  const activeSession = walletService.getActiveSession();
  const snapshot = activeSession
    ? await walletService.snapshot(activeSession).catch(error => {
        errors.push(errorMessage(error));
        return undefined;
      })
    : undefined;
  const hardwareStatus = activeSession?.hardwareDevice
    ? await walletService.getHardwareWalletStatus(activeSession).catch(error => {
        errors.push(errorMessage(error));
        return undefined;
      })
    : undefined;
  const linkedWithMonero = await walletService
    .linkedWithMonero()
    .catch(error => {
      errors.push(errorMessage(error));
      return false;
    });
  const ledgerTransport = await walletService
    .getLedgerTransportStatus()
    .catch(error => {
      errors.push(errorMessage(error));
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
          id: "diagnostics",
          jsonrpc: "2.0",
          method: "get_info",
          params: {},
        }),
        headers: {
          "Content-Type": "application/json",
        },
        method: "POST",
      })
    : undefined;
  const diagnostics = {
    activeSession,
    daemon: {
      getInfo: summarizeGetInfo(daemonGetInfo),
      jsonRpcGetInfo: summarizeGetInfo(daemonJsonRpcGetInfo),
    },
    errors,
    hardwareStatus,
    ledgerTransport,
    native: {
      linkedWithMonero,
    },
    registeredWallet: registeredWallet
      ? {
          createdAt: registeredWallet.createdAt,
          lastOpenedAt: registeredWallet.lastOpenedAt,
          network: registeredWallet.network,
          path: registeredWallet.path,
          walletName: registeredWallet.walletName,
        }
      : undefined,
    settings: settings
      ? {
          daemonAddress: settings.daemon.address,
          grpcEndpoint: settings.grpcEndpoint,
          mode: settings.mode,
          network: settings.network,
          trusted: settings.daemon.trusted,
          useSsl: settings.daemon.useSsl ?? false,
        }
      : undefined,
    snapshot,
    timestamp: new Date().toISOString(),
    trigger,
  };

  await emitWalletDiagnosticsLine(
    `${WALLET_DIAGNOSTIC_LOG_PREFIX} ${JSON.stringify(diagnostics)}`,
  );
  return diagnostics;
}

function createDaemonBaseUrl(address: string, useSsl?: boolean): string {
  if (/^https?:\/\//i.test(address)) {
    return address;
  }

  return `${useSsl ? "https" : "http"}://${address}`;
}

async function fetchJsonWithTimeout(
  url: string,
  init?: RequestInit,
  timeoutMs = 10000,
): Promise<HttpDiagnosticResult> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<HttpDiagnosticResult>(resolve => {
    timeout = setTimeout(() => {
      resolve({
        error: `timeout after ${timeoutMs}ms`,
        ok: false,
      });
    }, timeoutMs);
  });
  const fetchPromise = fetch(url, init)
    .then(async response => {
      const text = await response.text();
      return {
        json: parseJson(text),
        ok: response.ok,
        status: response.status,
      };
    })
    .catch(error => ({
      error: errorMessage(error),
      ok: false,
    }))
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
    if (typeof parsed === "object" && parsed !== null) {
      return parsed as JsonRecord;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function summarizeGetInfo(result: HttpDiagnosticResult | undefined) {
  if (!result) {
    return undefined;
  }

  const payload = isRecord(result.json?.result) ? result.json.result : result.json;
  return {
    error: result.error,
    height: payload?.height,
    nettype: payload?.nettype,
    ok: result.ok,
    restricted: payload?.restricted,
    status: payload?.status,
    synchronized: payload?.synchronized,
    targetHeight: payload?.target_height,
    topBlockHash: payload?.top_block_hash,
    txPoolSize: payload?.tx_pool_size,
    httpStatus: result.status,
  };
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
