import { requireNativeMoneroWallet } from './NativeMoneroWallet';

export const WALLET_DIAGNOSTIC_LOG_PREFIX = 'MONERO_WALLET_DIAGNOSTICS';

type DiagnosticFields = Record<string, unknown>;

const SAFE_FIELDS = new Set([
  'available',
  'biometryType',
  'checkedCount',
  'configuredCount',
  'count',
  'deviceCount',
  'elapsedMs',
  'enrolled',
  'hostedCount',
  'httpStatus',
  'linked',
  'mode',
  'network',
  'permissionGranted',
  'platform',
  'published',
  'queuedMs',
  'refreshedWalletCount',
  'requiresUserAction',
  'status',
  'success',
  'supported',
  'synchronized',
  'transport',
  'trusted',
  'txCount',
  'useSsl',
  'walletCount',
]);

const SAFE_STRING_VALUES: Readonly<Record<string, ReadonlySet<string>>> = {
  biometryType: new Set([
    'biometric',
    'face',
    'face-id',
    'fingerprint',
    'iris',
    'none',
    'touch-id',
    'unknown',
  ]),
  mode: new Set(['biometric', 'custom', 'optimized-grpc', 'password']),
  network: new Set(['mainnet', 'stagenet', 'testnet']),
  platform: new Set([
    'android',
    'ios',
    'linux',
    'macos',
    'unknown',
    'windows',
  ]),
  status: new Set([
    'error',
    'failed',
    'ok',
    'pending',
    'ready',
    'success',
    'unavailable',
    'warning',
  ]),
  transport: new Set(['ble', 'none', 'unknown', 'usb']),
};

const SESSION_CORRELATION_ID = `diag_${Date.now().toString(36)}_${Math.random()
  .toString(36)
  .slice(2, 10)}`;

function diagnosticsLoggingEnabled() {
  return __DEV__ && typeof jest === 'undefined';
}

export async function emitWalletDiagnosticsLine(line: string) {
  if (!diagnosticsLoggingEnabled()) {
    return;
  }
  const sanitized = sanitizePreformattedLine(line);
  if (!sanitized) {
    return;
  }
  console.log(sanitized);

  try {
    await requireNativeMoneroWallet().logDiagnostics(sanitized);
  } catch {
    // Debug console logging is enough when the native module is unavailable.
  }
}

export function logWalletEvent(
  scope: string,
  event: string,
  fields: DiagnosticFields = {},
) {
  if (!diagnosticsLoggingEnabled()) {
    return;
  }
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
    correlationId: SESSION_CORRELATION_ID,
    event: safeToken(event),
    scope: safeToken(scope),
    timestamp: new Date().toISOString(),
  };
  return `${WALLET_DIAGNOSTIC_LOG_PREFIX} ${JSON.stringify(payload)}`;
}

function sanitizePreformattedLine(line: string): string | undefined {
  if (!line.startsWith(`${WALLET_DIAGNOSTIC_LOG_PREFIX} `)) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(
      line.slice(WALLET_DIAGNOSTIC_LOG_PREFIX.length + 1),
    ) as DiagnosticFields;
    return formatWalletLogLine(
      typeof parsed.scope === 'string' ? parsed.scope : 'diagnostics',
      typeof parsed.event === 'string' ? parsed.event : 'status',
      parsed,
    );
  } catch {
    return undefined;
  }
}

function sanitizeFields(fields: DiagnosticFields) {
  return Object.fromEntries(
    Object.entries(fields)
      .filter(([key, value]) => isAllowedField(key, value))
      .map(([key, value]) => [
        key,
        typeof value === 'string' ? safeToken(value) : value,
      ]),
  );
}

function isAllowedField(key: string, value: unknown) {
  if (SAFE_FIELDS.has(key)) {
    if (typeof value === 'boolean') {
      return true;
    }
    if (typeof value === 'number') {
      return Number.isFinite(value);
    }
    if (typeof value === 'string') {
      return SAFE_STRING_VALUES[key]?.has(value) === true;
    }
    return false;
  }
  return /^(?:has|is|can|uses)[A-Z]/.test(key) && typeof value === 'boolean';
}

function safeToken(value: string) {
  const normalized = value.replace(/[^0-9A-Za-z_.-]/g, '-').slice(0, 64);
  return normalized || 'unknown';
}
