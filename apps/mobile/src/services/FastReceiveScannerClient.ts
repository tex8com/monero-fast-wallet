export type KeyImageSpendStatus = "unknown" | "unspent" | "spent";

export interface KeyImageStatusItem {
  keyImage: string;
  status: KeyImageSpendStatus;
  checkedHeight: number;
}

export interface KeyImageStatusResult {
  identityId: string;
  items: KeyImageStatusItem[];
}

export interface FastReceiveWatchStatusResult {
  identityId: string;
  registered: boolean;
  scannerStatus: string;
  notificationsEnabled: boolean;
  network?: string;
  restoreHeight?: number;
  lastScannedHeight?: number;
}

export interface CheckKeyImageStatusInput {
  scannerUrl: string;
  scannerAuthToken?: string;
  identityId: string;
  keyImages: string[];
}

export interface CheckWatchRegistrationInput {
  scannerUrl: string;
  scannerAuthToken?: string;
  identityId: string;
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

export async function checkFastReceiveKeyImages(
  input: CheckKeyImageStatusInput,
  fetchImpl: ScannerFetch = defaultFetch(),
): Promise<KeyImageStatusResult> {
  const scannerUrl = normalizeScannerUrl(input.scannerUrl);
  const identityId = cleanRequired(input.identityId, "identityId");
  const keyImages = validateKeyImages(input.keyImages);
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  const token = input.scannerAuthToken?.trim();
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }

  const response = await fetchImpl(
    `${scannerUrl}/v1/fast-receive/key-images/status`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        identity_id: identityId,
        key_images: keyImages,
      }),
    },
  );
  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(`Fast receive scanner key-image check failed with HTTP ${response.status}`);
  }

  return parseKeyImageStatusResponse(bodyText, identityId, keyImages);
}

export async function checkFastReceiveWatchRegistration(
  input: CheckWatchRegistrationInput,
  fetchImpl: ScannerFetch = defaultFetch(),
): Promise<FastReceiveWatchStatusResult> {
  const scannerUrl = normalizeScannerUrl(input.scannerUrl);
  const identityId = cleanRequired(input.identityId, "identityId");
  const headers = scannerHeaders(input.scannerAuthToken);

  const response = await fetchImpl(
    `${scannerUrl}/v1/fast-receive/watch/${encodeURIComponent(identityId)}`,
    {
      method: "GET",
      headers,
    },
  );
  const bodyText = await response.text();
  if (response.status === 404) {
    return {
      identityId,
      registered: false,
      scannerStatus: "missing",
      notificationsEnabled: false,
    };
  }
  if (!response.ok) {
    throw new Error(`Fast receive scanner watch check failed with HTTP ${response.status}`);
  }

  return parseWatchStatusResponse(bodyText, identityId);
}

export function parseKeyImageStatusResponse(
  bodyText: string,
  expectedIdentityId: string,
  expectedKeyImages: string[],
): KeyImageStatusResult {
  const parsed: unknown = JSON.parse(bodyText);
  if (!isRecord(parsed)) {
    throw new Error("Fast receive scanner returned an invalid response");
  }

  const identityId = parseString(parsed.identity_id);
  if (identityId !== expectedIdentityId) {
    throw new Error("Fast receive scanner returned a mismatched identity");
  }
  if (!Array.isArray(parsed.items)) {
    throw new Error("Fast receive scanner returned no key-image items");
  }
  if (parsed.items.length !== expectedKeyImages.length) {
    throw new Error("Fast receive scanner returned a mismatched key-image count");
  }

  const items = parsed.items.map((item, index) =>
    parseKeyImageStatusItem(item, expectedKeyImages[index]),
  );

  return {
    identityId,
    items,
  };
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

function parseKeyImageStatusItem(
  value: unknown,
  expectedKeyImage: string,
): KeyImageStatusItem {
  if (!isRecord(value)) {
    throw new Error("Fast receive scanner returned an invalid key-image item");
  }

  const keyImage = parseString(value.key_image)?.toLowerCase();
  const status = parseSpendStatus(value.status);
  const checkedHeight = parseNonNegativeNumber(value.checked_height);
  if (!keyImage || keyImage !== expectedKeyImage || !status || checkedHeight === undefined) {
    throw new Error("Fast receive scanner returned an invalid key-image status");
  }

  return {
    keyImage,
    status,
    checkedHeight,
  };
}

function normalizeScannerUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/g, "");
  if (!/^https?:\/\/[^/]+/i.test(trimmed)) {
    throw new Error("scannerUrl must be an HTTP(S) URL");
  }
  return trimmed;
}

function cleanRequired(value: string, name: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${name} must not be empty`);
  }
  return trimmed;
}

function validateKeyImages(keyImages: string[]): string[] {
  if (keyImages.length === 0 || keyImages.length > 1024) {
    throw new Error("keyImages must contain between 1 and 1024 items");
  }

  return keyImages.map(keyImage => {
    const normalized = keyImage.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(normalized)) {
      throw new Error("keyImages must contain 64-character hex key images");
    }
    return normalized;
  });
}

function parseSpendStatus(value: unknown): KeyImageSpendStatus | undefined {
  if (value === "unknown" || value === "unspent" || value === "spent") {
    return value;
  }
  return undefined;
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

function scannerHeaders(scannerAuthToken?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  const token = scannerAuthToken?.trim();
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  return headers;
}
