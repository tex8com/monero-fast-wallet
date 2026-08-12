import { requireNativeMoneroWallet } from './NativeMoneroWallet';

export const WALLET_DIAGNOSTIC_LOG_PREFIX = 'MONERO_WALLET_DIAGNOSTICS';

type DiagnosticFields = Record<string, unknown>;

const SAFE_FIELDS = new Set([
  'available',
  'biometryType',
  'chainHeight',
  'checkedCount',
  'configured',
  'configuredCount',
  'count',
  'derivedOutputCount',
  'deviceCount',
  'displayedTransactionCount',
  'downloadedHeight',
  'downloadStartHeight',
  'elapsedMs',
  'enrolled',
  'failureCode',
  'failedAttempts',
  'fastRegistrationCreated',
  'fastWalletEnabled',
  'generation',
  'hostedCount',
  'httpStatus',
  'initialSetup',
  'importedOutputCount',
  'importHeight',
  'incomingTransactionCount',
  'linked',
  'locked',
  'mode',
  'network',
  'ownerCount',
  'joinedWallets',
  'phaseElapsedMs',
  'phaseSequence',
  'lastProviderSelectionMs',
  'lastTransportInitializationMs',
  'lastBlockFetchMs',
  'lastWalletScanMs',
  'lastMempoolMs',
  'lastCheckpointMs',
  'lastIterationMs',
  'nativeTransactionCount',
  'outgoingRpcDurationMs',
  'outgoingTransactionCount',
  'pendingOutputCount',
  'pendingOutputKeyImageCount',
  'permissionGranted',
  'productSlot',
  'providerTokenLength',
  'providerGeneration',
  'persistLedgerViewOnly',
  'phase',
  'platform',
  'published',
  'hostingRequested',
  'queuedMs',
  'remainingAttempts',
  'remainingPendingOutputCount',
  'reopenAttempt',
  'requestedLimit',
  'retryCount',
  'refreshedWalletCount',
  'requiresUserAction',
  'resetTriggered',
  'status',
  'state',
  'stateUpdateDurationMs',
  'sessionGeneration',
  'spentStatusBlockchainOutputCount',
  'spentStatusPoolOutputCount',
  'spentStatusRpcDurationMs',
  'spentStatusUnspentOutputCount',
  'storeDurationMs',
  'success',
  'supported',
  'synchronized',
  'timeoutMs',
  'transport',
  'transportStarts',
  'trusted',
  'txCount',
  'verificationDurationMs',
  'verifiedOutputCount',
  'viewHeight',
  'walletHeight',
  'useSsl',
  'walletCount',
  'targetHeight',
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
  failureCode: new Set([
    'app-locked',
    'app-attestation',
    'slot-occupied',
    'authentication-cancelled',
    'authentication-failed',
    'credential',
    'file-exists',
    'node-configuration',
    'node-security',
    'node-timeout',
    'node-unreachable',
    'session-stale',
    'optimized-service',
    'hardware-unavailable',
    'invalid-data',
    'missing-data',
    'native',
    'network',
    'permission',
    'storage',
    'server-response',
    'timeout',
    'unsupported',
    'unknown',
    'wallet-scan',
  ]),
  mode: new Set(['biometric', 'custom', 'optimized-grpc', 'password']),
  network: new Set(['mainnet', 'stagenet', 'testnet']),
  phase: new Set([
    'block-sync',
    'catching-up-local-scan',
    'checking-mempool',
    'checking-local-scan',
    'checkpointing-wallets',
    'degraded',
    'fetching-blocks',
    'idle',
    'connecting-ledger',
    'deriving-owned-output-key-images',
    'persisting-wallet',
    'ready',
    'recoverable-error',
    'recovering-session',
    'scanning-spend-outputs',
    'initializing-transport',
    'provider-backoff',
    'retrying',
    'scanner-backoff',
    'scanning-wallets',
    'selecting-provider',
    'saving-ledger-balance',
    'stopped',
    'synced',
    'waiting-ledger',
    'wallet-scan',
    'waiting-next-batch',
  ]),
  state: new Set([
    'idle',
    'ready',
    'selecting-provider',
    'fetching-blocks',
    'fanout',
    'scanning',
    'synced',
    'retrying',
    'provider-backoff',
    'stopped',
  ]),
  platform: new Set(['android', 'ios', 'linux', 'macos', 'unknown', 'windows']),
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
  // Native code owns the fail-closed release switch. Keeping the sanitized
  // bridge call reachable lets a deliberately flagged release APK produce
  // diagnostics without enabling arbitrary console logging in production.
  return typeof jest === 'undefined';
}

export async function emitWalletDiagnosticsLine(line: string) {
  if (!diagnosticsLoggingEnabled()) {
    return;
  }
  const sanitized = sanitizePreformattedLine(line);
  if (!sanitized) {
    return;
  }
  if (__DEV__) {
    console.log(sanitized);
  }

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
  const failureCode =
    fields.error === undefined
      ? {}
      : { failureCode: classifyDiagnosticFailure(fields.error) };
  const payload = {
    ...sanitizeFields(fields),
    ...failureCode,
    correlationId: SESSION_CORRELATION_ID,
    event: safeToken(event),
    scope: safeToken(scope),
    timestamp: new Date().toISOString(),
  };
  return `${WALLET_DIAGNOSTIC_LOG_PREFIX} ${JSON.stringify(payload)}`;
}

export function classifyDiagnosticFailure(error: unknown): string {
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: unknown }).code === 'monero_wallet_session_stale'
  ) {
    return 'session-stale';
  }
  const message = String(
    error instanceof Error ? `${error.name} ${error.message}` : error,
  ).toLowerCase();
  if (/wallet session is no longer open|session-stale/.test(message))
    return 'session-stale';
  if (/timed? ?out|timeout|deadline/.test(message)) return 'timeout';
  if (/already exists|file.*exist|overwrite/.test(message))
    return 'file-exists';
  if (/slot.*(?:occupied|in use|used)/.test(message)) return 'slot-occupied';
  if (/sync.*source wallet|source wallet.*sync|restore height/.test(message))
    return 'wallet-scan';
  if (/app.*lock|session.*lock|native.*lock/.test(message)) return 'app-locked';
  if (/app attestation failed|app.?check|play.?integrity/.test(message))
    return 'app-attestation';
  if (/cancel|canceled|cancelled|negative button/.test(message))
    return 'authentication-cancelled';
  if (/auth|biometric|fingerprint|face.*unlock/.test(message))
    return 'authentication-failed';
  if (/password|credential|secret|decrypt/.test(message)) return 'credential';
  if (/permission|denied|not authorized/.test(message)) return 'permission';
  if (/ledger|hardware|usb|bluetooth|ble/.test(message))
    return 'hardware-unavailable';
  if (/unsupported|not support|unavailable on this device/.test(message))
    return 'unsupported';
  if (/network|connect|socket|dns|tls|http|grpc|daemon|offline/.test(message))
    return 'network';
  if (/not found|missing|no such/.test(message)) return 'missing-data';
  if (/invalid|malformed|parse|decode|corrupt/.test(message))
    return 'invalid-data';
  if (/storage|keystore|keychain|database|read|write|persist/.test(message))
    return 'storage';
  if (/native|jni|monero|walletmanager/.test(message)) return 'native';
  return 'unknown';
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
