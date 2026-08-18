export interface FastReceiveWatchStatusResult {
  identityId: string;
  registered: boolean;
  scannerStatus: string;
  notificationsEnabled: boolean;
  network?: string;
  restoreHeight?: number;
  lastScannedHeight?: number;
}

export type ScannerFetch = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

/**
 * Confirms that the selected endpoint is a Fast Receive service before any
 * private-view-key registration is attempted. This endpoint returns only a
 * public health response; it deliberately carries no wallet metadata.
 */
export async function verifyFastReceiveScannerCapability(
  scannerUrlInput: string,
  fetchImpl: ScannerFetch = defaultFetch(),
): Promise<void> {
  const scannerUrl = normalizeScannerUrl(scannerUrlInput);
  const response = await fetchImpl(`${scannerUrl}/healthz`, {
    method: 'GET',
    headers: { accept: 'application/json' },
  });
  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(
      `Fast receive scanner capability check failed with HTTP ${response.status}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    throw new Error('Fast receive scanner capability response was invalid');
  }
  if (!isRecord(parsed) || parsed.ok !== true) {
    throw new Error('The selected server is not a Fast Receive scanner');
  }
}

export function parseWatchStatusResponse(
  bodyText: string,
  expectedIdentityId: string,
): FastReceiveWatchStatusResult {
  const parsed: unknown = JSON.parse(bodyText);
  if (!isRecord(parsed)) {
    throw new Error("Fast receive scanner returned an invalid watch response");
  }

  const identityId = parseString(parsed.identity_id);
  if (identityId !== expectedIdentityId) {
    throw new Error("Fast receive scanner returned a mismatched watch identity");
  }

  return {
    identityId,
    registered: true,
    scannerStatus:
      parseString(parsed.scanner_status) ?? parseString(parsed.status) ?? "enabled",
    notificationsEnabled: parsed.notifications_enabled === true,
    network: parseString(parsed.network),
    restoreHeight: parseNonNegativeNumber(parsed.restore_height),
    lastScannedHeight: parseNonNegativeNumber(parsed.last_scanned_height),
  };
}

export function normalizeScannerUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/g, "");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("scannerUrl must be a valid private-service origin");
  }
  const authenticatedOnion =
    parsed.protocol === 'http:' &&
    /^[a-z2-7]{56}\.onion$/.test(parsed.hostname.toLowerCase());
  if (
    (parsed.protocol !== 'https:' && !authenticatedOnion) ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname !== '' && parsed.pathname !== '/')
  ) {
    throw new Error(
      'scannerUrl must be an HTTPS or Tor v3 Onion origin without credentials, paths, queries, or fragments',
    );
  }
  return parsed.origin;
}

function parseString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parseNonNegativeNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.floor(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function defaultFetch(): ScannerFetch {
  const fetchImpl = globalThis.fetch as unknown as ScannerFetch | undefined;
  if (!fetchImpl) {
    throw new Error("fetch is not available for fast receive scanner calls");
  }
  return fetchImpl;
}
