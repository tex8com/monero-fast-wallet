import AsyncStorage from "@react-native-async-storage/async-storage";

import type {
  FastReceiveIdentity,
  MoneroNetwork,
} from "./NativeMoneroWallet";

export const FAST_RECEIVE_IDENTITIES_STORAGE_KEY =
  "monero-fast-wallet.fast-receive-identities.v1";

export type FastReceiveIdentityStatus =
  | "local-only"
  | "enabled"
  | "disabled"
  | "registration-error";

export interface FastReceiveIdentityRecord {
  id: string;
  label: string;
  path: string;
  address: string;
  network: MoneroNetwork;
  restoreHeight: number;
  derivationIndex: number;
  status: FastReceiveIdentityStatus;
  scannerStatus: string;
  createdAt: string;
  updatedAt: string;
}

export async function loadFastReceiveIdentities(): Promise<
  FastReceiveIdentityRecord[]
> {
  const value = await AsyncStorage.getItem(FAST_RECEIVE_IDENTITIES_STORAGE_KEY);
  return parseFastReceiveIdentities(value);
}

export async function saveFastReceiveIdentities(
  identities: FastReceiveIdentityRecord[],
): Promise<FastReceiveIdentityRecord[]> {
  const normalized = identities.map(normalizeFastReceiveIdentity);
  await AsyncStorage.setItem(
    FAST_RECEIVE_IDENTITIES_STORAGE_KEY,
    JSON.stringify(normalized),
  );
  return normalized;
}

export async function upsertFastReceiveIdentity(
  identity: FastReceiveIdentityRecord,
): Promise<FastReceiveIdentityRecord[]> {
  const current = await loadFastReceiveIdentities();
  const normalized = normalizeFastReceiveIdentity(identity);
  const next = current.some(item => item.id === normalized.id)
    ? current.map(item => (item.id === normalized.id ? normalized : item))
    : [...current, normalized];

  return saveFastReceiveIdentities(next);
}

export function createFastReceiveIdentityRecord(
  identity: FastReceiveIdentity,
  now = new Date().toISOString(),
): FastReceiveIdentityRecord {
  return normalizeFastReceiveIdentity({
    id: identity.id,
    label: identity.label,
    path: identity.path,
    address: identity.address,
    network: parseNetwork(identity.network) ?? "stagenet",
    restoreHeight: identity.restoreHeight,
    derivationIndex: identity.derivationIndex,
    status: "local-only",
    scannerStatus: identity.scannerStatus || "local-only",
    createdAt: now,
    updatedAt: now,
  });
}

export function nextFastReceiveDerivationIndex(
  identities: FastReceiveIdentityRecord[],
): number {
  if (identities.length === 0) {
    return 0;
  }

  return (
    Math.max(...identities.map(identity => identity.derivationIndex)) + 1
  );
}

export function createFastReceiveIdentityId(
  derivationIndex: number,
  now = new Date(),
): string {
  const stamp = now.toISOString().replace(/[^0-9A-Za-z]/g, "").slice(0, 15);
  return `fast-receive-${derivationIndex}-${stamp}`;
}

function normalizeFastReceiveIdentity(
  identity: FastReceiveIdentityRecord,
): FastReceiveIdentityRecord {
  return {
    id: cleanRequired(identity.id, "id"),
    label: identity.label.trim() || "Fast Receive",
    path: cleanRequired(identity.path, "path"),
    address: cleanRequired(identity.address, "address"),
    network: identity.network,
    restoreHeight: nonNegativeNumber(identity.restoreHeight),
    derivationIndex: nonNegativeNumber(identity.derivationIndex),
    status: normalizeStatus(identity.status),
    scannerStatus: identity.scannerStatus.trim() || identity.status,
    createdAt: cleanRequired(identity.createdAt, "createdAt"),
    updatedAt: cleanRequired(identity.updatedAt, "updatedAt"),
  };
}

function parseFastReceiveIdentities(
  value: string | null,
): FastReceiveIdentityRecord[] {
  if (!value) {
    return [];
  }

  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .map(parseFastReceiveIdentity)
      .filter((item): item is FastReceiveIdentityRecord => item !== undefined);
  } catch {
    return [];
  }
}

function parseFastReceiveIdentity(
  value: unknown,
): FastReceiveIdentityRecord | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const id = parseString(value.id);
  const label = parseString(value.label);
  const path = parseString(value.path);
  const address = parseString(value.address);
  const network = parseNetwork(value.network);
  const restoreHeight = parseNumber(value.restoreHeight);
  const derivationIndex = parseNumber(value.derivationIndex);
  const status = parseStatus(value.status);
  const scannerStatus = parseString(value.scannerStatus);
  const createdAt = parseString(value.createdAt);
  const updatedAt = parseString(value.updatedAt);

  if (
    !id ||
    !label ||
    !path ||
    !address ||
    !network ||
    restoreHeight === undefined ||
    derivationIndex === undefined ||
    !createdAt ||
    !updatedAt
  ) {
    return undefined;
  }

  return normalizeFastReceiveIdentity({
    id,
    label,
    path,
    address,
    network,
    restoreHeight,
    derivationIndex,
    status: status ?? "local-only",
    scannerStatus: scannerStatus ?? status ?? "local-only",
    createdAt,
    updatedAt,
  });
}

function cleanRequired(value: string, name: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${name} must not be empty`);
  }
  return trimmed;
}

function nonNegativeNumber(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.floor(value);
}

function normalizeStatus(
  status: FastReceiveIdentityStatus,
): FastReceiveIdentityStatus {
  return parseStatus(status) ?? "local-only";
}

function parseString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parseNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function parseNetwork(value: unknown): MoneroNetwork | undefined {
  if (value === "mainnet" || value === "testnet" || value === "stagenet") {
    return value;
  }

  return undefined;
}

function parseStatus(
  value: unknown,
): FastReceiveIdentityStatus | undefined {
  if (
    value === "local-only" ||
    value === "enabled" ||
    value === "disabled" ||
    value === "registration-error"
  ) {
    return value;
  }

  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
