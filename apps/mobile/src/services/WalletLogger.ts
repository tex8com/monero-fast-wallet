import { requireNativeMoneroWallet } from "./NativeMoneroWallet";

export const WALLET_DIAGNOSTIC_LOG_PREFIX = "MONERO_WALLET_DIAGNOSTICS";

type DiagnosticFields = Record<string, unknown>;

export async function emitWalletDiagnosticsLine(line: string) {
  console.log(line);

  try {
    await requireNativeMoneroWallet().logDiagnostics(line);
  } catch {
    // Console logging is enough when the native module is unavailable in tests.
  }
}

export function logWalletEvent(
  scope: string,
  event: string,
  fields: DiagnosticFields = {},
) {
  emitWalletDiagnosticsLine(formatWalletLogLine(scope, event, fields)).catch(
    () => undefined,
  );
}

export function formatWalletLogLine(
  scope: string,
  event: string,
  fields: DiagnosticFields = {},
) {
  const payload = {
    ...sanitizeFields(fields),
    event,
    scope,
    timestamp: new Date().toISOString(),
  };
  return `${WALLET_DIAGNOSTIC_LOG_PREFIX} ${JSON.stringify(payload)}`;
}

function sanitizeFields(fields: DiagnosticFields) {
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [
      key,
      isSensitiveField(key) ? "[redacted]" : value,
    ]),
  );
}

function isSensitiveField(key: string) {
  const normalized = key.toLowerCase();
  return (
    normalized === "password" ||
    normalized === "mnemonic" ||
    normalized === "seed" ||
    normalized === "seedoffset" ||
    normalized === "privatekey" ||
    normalized === "privateviewkey" ||
    normalized === "secret" ||
    normalized === "secretkey" ||
    normalized === "token" ||
    normalized === "authtoken" ||
    normalized === "scannerauthtoken"
  );
}
