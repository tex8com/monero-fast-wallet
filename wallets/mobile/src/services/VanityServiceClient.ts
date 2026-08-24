import { Platform } from 'react-native';

import {
  loadProtectedMetadata,
  storeProtectedMetadata,
} from './ProtectedMetadataStorage';
import type { VanitySearchDraft } from './VanityRequest';
import { createVanityWorkerSearchInput } from './VanityRequest';
import { VANITY_SERVICE_ONION_ORIGIN } from './VanityServicePayment';
import { torFetch } from './TorHttp';
import { walletService } from './WalletService';

const ORDER_CREDENTIALS_KEY = 'monero-fast-wallet.vanity-orders.v1';
const ORDER_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STATUS_TOKEN = /^[0-9a-f]{64}$/;
const KEY_OFFSET = /^[0-9a-f]{64}$/;
const MAINNET_PRIMARY_ADDRESS =
  /^4[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]{94}$/;
const MAX_STORED_ORDERS = 100;

export type VanityCandidateStatus = Readonly<{
  id: string;
  prefix: string;
  status: string;
  result_address?: string | null;
  result_key_offset?: string | null;
  error?: string | null;
  search_expires_at?: number | null;
}>;

export type VanitySearchGroupStatus = Readonly<{
  id: string;
  status: string;
  prefix_length: number;
  prefixes: readonly string[];
  price_atomic: string;
  started_at?: number | null;
  search_expires_at?: number | null;
  matched_prefix?: string | null;
  result_address?: string | null;
  result_key_offset?: string | null;
  recovery_available?: boolean;
  maximum_search_seconds: number;
  candidates: readonly VanityCandidateStatus[];
}>;

export type VanityOrderStatus = Readonly<{
  id: string;
  status: string;
  prefixes: readonly string[];
  price_atomic: string;
  price_xmr: string;
  payment_address: string;
  quote_expires_at: number;
  observed_atomic: string;
  confirmations: number;
  required_confirmations: number;
  active_prefix_slots: number;
  maximum_prefix_slots: number;
  search_groups: readonly VanitySearchGroupStatus[];
}>;

export type VanityOrderCredentials = Readonly<{
  orderId: string;
  statusToken: string;
  statusDeepLink: string;
  sourceWalletRegistrationId: string;
  sourcePublicAddress?: string;
  recoveryResults?: readonly VanityRecoveryResult[];
  recoveryBackedUpAt?: number;
  createdAt: number;
}>;

export type VanityRecoveryResult = Readonly<{
  matchedPrefix: string;
  resultAddress: string;
  keyOffsetHex: string;
}>;

export type VanityRecoveryBundle = Readonly<{
  version: 1;
  kind: 'mfw-monero-vanity-split-recovery-v1';
  orderId: string;
  sourceWalletRegistrationId: string;
  sourcePublicAddress: string;
  results: readonly VanityRecoveryResult[];
  createdAt: number;
}>;

export type VanityQuote = Readonly<{
  credentials: VanityOrderCredentials;
  order: VanityOrderStatus;
}>;

type StoredCredentials = Record<string, VanityOrderCredentials>;

function serviceOrigin(): string {
  const origin = VANITY_SERVICE_ONION_ORIGIN.trim().replace(/\/$/, '');
  if (!/^http:\/\/[a-z2-7]{56}\.onion(?::\d+)?$/.test(origin)) {
    throw new Error('The Vanity Hidden Service is not configured.');
  }
  return origin;
}

function parseOrder(value: unknown): VanityOrderStatus {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('The Vanity service returned an invalid order.');
  }
  const order = value as Record<string, any>;
  if (
    typeof order.id !== 'string' ||
    !ORDER_ID.test(order.id) ||
    typeof order.status !== 'string' ||
    !Array.isArray(order.prefixes) ||
    typeof order.price_atomic !== 'string' ||
    typeof order.price_xmr !== 'string' ||
    typeof order.payment_address !== 'string' ||
    !Number.isSafeInteger(order.quote_expires_at) ||
    typeof order.observed_atomic !== 'string' ||
    !Number.isSafeInteger(order.confirmations) ||
    !Number.isSafeInteger(order.required_confirmations) ||
    !Number.isSafeInteger(order.active_prefix_slots) ||
    order.maximum_prefix_slots !== 2000 ||
    !Array.isArray(order.search_groups)
  ) {
    throw new Error('The Vanity service returned an invalid order.');
  }
  return order as VanityOrderStatus;
}

async function loadCredentials(): Promise<StoredCredentials> {
  const raw = await loadProtectedMetadata(ORDER_CREDENTIALS_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, VanityOrderCredentials>;
    return Object.fromEntries(
      Object.entries(parsed).filter(
        ([id, value]) =>
          ORDER_ID.test(id) &&
          value?.orderId === id &&
          STATUS_TOKEN.test(value.statusToken) &&
          value.statusDeepLink === `mfw://vanity/order/${id}`,
      ),
    );
  } catch {
    return {};
  }
}

async function rememberCredentials(
  next: VanityOrderCredentials,
): Promise<void> {
  const current = await loadCredentials();
  const unique = new Map(
    [...Object.values(current), next].map(value => [value.orderId, value]),
  );
  const ordered = [...unique.values()]
    .sort((left, right) => right.createdAt - left.createdAt)
    .slice(0, MAX_STORED_ORDERS);
  await storeProtectedMetadata(
    ORDER_CREDENTIALS_KEY,
    JSON.stringify(
      Object.fromEntries(ordered.map(value => [value.orderId, value])),
    ),
  );
}

export async function createVanityQuote(
  draft: VanitySearchDraft,
  installationId: string,
): Promise<VanityQuote> {
  const installation = installationId.trim();
  if (installation.length < 24 || installation.length > 128) {
    throw new Error('Notifications must be enabled before creating the quote.');
  }
  const sourceAddress = await walletService.validateRecipientAddress(
    draft.sourcePublicAddress,
    'mainnet',
  );
  if (sourceAddress !== draft.sourcePublicAddress) {
    throw new Error('The Vanity source address is invalid.');
  }
  const response = await torFetch(`${serviceOrigin()}/api/v1/quotes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      ...createVanityWorkerSearchInput(draft),
      notification: {
        installation_id: installation,
        platform: Platform.OS,
      },
    }),
    timeoutMs: 20_000,
    maximumResponseBytes: 256 * 1024,
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload?.error || 'The Vanity quote could not be created.');
  }
  const order = parseOrder(payload?.order);
  const statusToken = payload?.status_token;
  const statusDeepLink = payload?.status_deep_link;
  if (
    !STATUS_TOKEN.test(statusToken) ||
    statusDeepLink !== `mfw://vanity/order/${order.id}`
  ) {
    throw new Error('The Vanity service returned invalid status credentials.');
  }
  const credentials: VanityOrderCredentials = Object.freeze({
    orderId: order.id,
    statusToken,
    statusDeepLink,
    sourceWalletRegistrationId: draft.sourceWalletRegistrationId,
    sourcePublicAddress: draft.sourcePublicAddress,
    createdAt: Date.now(),
  });
  await rememberCredentials(credentials);
  return Object.freeze({ credentials, order });
}

export async function getVanityOrderStatus(
  orderId: string,
): Promise<VanityOrderStatus> {
  if (!ORDER_ID.test(orderId))
    throw new Error('The Vanity order ID is invalid.');
  const credentials = (await loadCredentials())[orderId];
  if (!credentials)
    throw new Error('This Vanity order is not stored on this device.');
  const response = await torFetch(
    `${serviceOrigin()}/api/v1/orders/${orderId}`,
    {
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${credentials.statusToken}`,
      },
      timeoutMs: 20_000,
      maximumResponseBytes: 256 * 1024,
    },
  );
  const payload = await response.json();
  if (!response.ok)
    throw new Error(payload?.error || 'The Vanity status is unavailable.');
  const order = parseOrder(payload?.order);
  if (order.id !== orderId || payload?.status_token !== undefined) {
    throw new Error('The Vanity status response is invalid.');
  }
  await rememberVanityRecoveryResults(orderId, order);
  return stripVanityRecoverySecrets(order);
}

export function stripVanityRecoverySecrets(
  order: VanityOrderStatus,
): VanityOrderStatus {
  return Object.freeze({
    ...order,
    search_groups: Object.freeze(
      order.search_groups.map(group => {
        const { result_key_offset, candidates, ...publicGroup } = group;
        return Object.freeze({
          ...publicGroup,
          recovery_available:
            group.status === 'completed' && Boolean(result_key_offset),
          candidates: Object.freeze(
            candidates.map(candidate => {
              const publicCandidate = { ...candidate };
              delete publicCandidate.result_key_offset;
              return Object.freeze(publicCandidate);
            }),
          ),
        });
      }),
    ),
  });
}

export async function createVanityRecoveryBackup(
  orderId: string,
): Promise<string> {
  if (!ORDER_ID.test(orderId)) {
    throw new Error('The Vanity order ID is invalid.');
  }
  const credentials = (await loadCredentials())[orderId];
  if (
    !credentials?.sourcePublicAddress ||
    !MAINNET_PRIMARY_ADDRESS.test(credentials.sourcePublicAddress) ||
    !credentials.recoveryResults?.length ||
    !credentials.recoveryResults.every(validVanityRecoveryResult)
  ) {
    throw new Error(
      'No completed Vanity recovery data is stored for this order.',
    );
  }
  await validateRecoveryAddresses(
    credentials.sourcePublicAddress,
    credentials.recoveryResults,
  );
  const bundle: VanityRecoveryBundle = Object.freeze({
    version: 1,
    kind: 'mfw-monero-vanity-split-recovery-v1',
    orderId,
    sourceWalletRegistrationId: credentials.sourceWalletRegistrationId,
    sourcePublicAddress: credentials.sourcePublicAddress,
    results: Object.freeze(
      credentials.recoveryResults.map(result => ({ ...result })),
    ),
    createdAt: Date.now(),
  });
  await rememberCredentials({
    ...credentials,
    recoveryBackedUpAt: bundle.createdAt,
  });
  return `MFW Vanity recovery v1\n${JSON.stringify(bundle)}\n`;
}

export function parseVanityRecoveryBackup(value: string): VanityRecoveryBundle {
  const match = value.match(/^MFW Vanity recovery v1\n([^\n]+)\n?$/);
  if (!match) throw new Error('The Vanity recovery backup is invalid.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]);
  } catch {
    throw new Error('The Vanity recovery backup is invalid.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('The Vanity recovery backup is invalid.');
  }
  const bundle = parsed as Record<string, any>;
  if (
    Object.keys(bundle).sort().join(',') !==
      'createdAt,kind,orderId,results,sourcePublicAddress,sourceWalletRegistrationId,version' ||
    bundle.version !== 1 ||
    bundle.kind !== 'mfw-monero-vanity-split-recovery-v1' ||
    !ORDER_ID.test(bundle.orderId) ||
    typeof bundle.sourceWalletRegistrationId !== 'string' ||
    !bundle.sourceWalletRegistrationId.trim() ||
    !MAINNET_PRIMARY_ADDRESS.test(bundle.sourcePublicAddress) ||
    !Number.isSafeInteger(bundle.createdAt) ||
    bundle.createdAt <= 0 ||
    !Array.isArray(bundle.results) ||
    bundle.results.length < 1 ||
    bundle.results.length > 100 ||
    !bundle.results.every(validVanityRecoveryResult)
  ) {
    throw new Error('The Vanity recovery backup is invalid.');
  }
  return bundle as VanityRecoveryBundle;
}

async function rememberVanityRecoveryResults(
  orderId: string,
  order: VanityOrderStatus,
): Promise<void> {
  const results = order.search_groups
    .filter(group => group.status === 'completed')
    .map(group => ({
      matchedPrefix: group.matched_prefix ?? '',
      resultAddress: group.result_address ?? '',
      keyOffsetHex: group.result_key_offset ?? '',
    }));
  if (results.length === 0) return;
  if (!results.every(validVanityRecoveryResult)) {
    throw new Error('The Vanity service returned invalid recovery data.');
  }
  const current = (await loadCredentials())[orderId];
  if (!current) {
    throw new Error('This Vanity order is not stored on this device.');
  }
  await validateRecoveryAddresses(current.sourcePublicAddress, results);
  await rememberCredentials({
    ...current,
    recoveryResults: Object.freeze(
      results.map(result => Object.freeze(result)),
    ),
  });
}

async function validateRecoveryAddresses(
  sourcePublicAddress: string | undefined,
  results: readonly VanityRecoveryResult[],
): Promise<void> {
  if (!sourcePublicAddress) {
    throw new Error('The Vanity source address is unavailable.');
  }
  const addresses = [
    sourcePublicAddress,
    ...results.map(result => result.resultAddress),
  ];
  const validated = await Promise.all(
    addresses.map(address =>
      walletService.validateRecipientAddress(address, 'mainnet'),
    ),
  );
  if (validated.some((address, index) => address !== addresses[index])) {
    throw new Error('The Vanity recovery contains an invalid Monero address.');
  }
}

function validVanityRecoveryResult(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  return (
    Object.keys(result).sort().join(',') ===
      'keyOffsetHex,matchedPrefix,resultAddress' &&
    typeof result.matchedPrefix === 'string' &&
    result.matchedPrefix.length >= 2 &&
    result.matchedPrefix.length <= 10 &&
    typeof result.resultAddress === 'string' &&
    MAINNET_PRIMARY_ADDRESS.test(result.resultAddress) &&
    result.resultAddress.startsWith(result.matchedPrefix) &&
    typeof result.keyOffsetHex === 'string' &&
    KEY_OFFSET.test(result.keyOffsetHex) &&
    !/^0+$/.test(result.keyOffsetHex)
  );
}

export async function getLatestVanityOrderId(): Promise<string | undefined> {
  return Object.values(await loadCredentials()).sort(
    (left, right) => right.createdAt - left.createdAt,
  )[0]?.orderId;
}

export function parseVanityOrderDeepLink(
  value: string | null | undefined,
): string | undefined {
  const orderId = value?.match(/^mfw:\/\/vanity\/order\/([0-9a-f-]{36})$/)?.[1];
  return orderId && ORDER_ID.test(orderId) ? orderId : undefined;
}
