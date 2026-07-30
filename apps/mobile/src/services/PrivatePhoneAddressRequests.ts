import {
  requireNativeMoneroWallet,
  type MoneroNetwork,
  type NativeMoneroWalletModule,
  type PrivatePhoneAddressRequestResult,
  type PrivatePhoneIncomingAddressRequest,
} from './NativeMoneroWallet';
import {
  deleteProtectedMetadata,
  loadProtectedMetadata,
  storeProtectedMetadata,
} from './ProtectedMetadataStorage';

const TRACKED_REQUESTS_KEY =
  'monero-fast-wallet.private-phone-address-requests.v1';
const E164 = /^\+[1-9][0-9]{6,14}$/;
const REQUEST_HANDLE = /^private-phone-ask_[0-9a-f]{48}$/;
const MONERO_SUBADDRESS =
  /^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]{95}$/;
const MAX_TRACKED_REQUESTS = 64;

export type TrackedPrivatePhoneAddressRequest = Readonly<{
  requestHandle: string;
  phoneNumber: string;
  displayName: string;
  network: MoneroNetwork;
}>;

export type CheckedPrivatePhoneAddressRequest = Readonly<{
  context: TrackedPrivatePhoneAddressRequest;
  result: PrivatePhoneAddressRequestResult;
}>;

type AddressRequestNative = Pick<
  NativeMoneroWalletModule,
  | 'requestPrivatePhoneAddress'
  | 'pollPrivatePhoneAddressRequest'
  | 'pollIncomingPrivatePhoneAddressRequests'
  | 'respondPrivatePhoneAddressRequest'
>;

export type PrivatePhoneAddressRequestService = Readonly<{
  request(input: {
    phoneNumber: string;
    displayName: string;
    network: MoneroNetwork;
  }): Promise<CheckedPrivatePhoneAddressRequest>;
  pollTracked(): Promise<ReadonlyArray<CheckedPrivatePhoneAddressRequest>>;
  forget(requestHandle: string): Promise<void>;
  pollIncoming(): Promise<ReadonlyArray<PrivatePhoneIncomingAddressRequest>>;
  respond(input: {
    requestHandle: string;
    approved: boolean;
    walletId?: string;
    accountIndex?: number;
  }): Promise<void>;
}>;

/**
 * Small public-state adapter for AskEveryTime. All cryptographic material,
 * phone tokens and plaintext request bodies remain below React in native
 * secure storage; this layer persists only opaque handles and local labels.
 */
export function createPrivatePhoneAddressRequestService(
  native: AddressRequestNative = requireNativeMoneroWallet(),
): PrivatePhoneAddressRequestService {
  return Object.freeze({
    request: async input => {
      const phoneNumber = requirePhoneNumber(input.phoneNumber);
      const displayName = boundedLabel(input.displayName);
      const existing = (await loadTrackedRequests()).find(
        item =>
          item.phoneNumber === phoneNumber && item.network === input.network,
      );
      if (existing) {
        const result = validateResult(
          await native.pollPrivatePhoneAddressRequest(existing.requestHandle),
          existing.network,
        );
        if (result.status === 'waiting') {
          return Object.freeze({ context: existing, result });
        }
        await forgetTrackedRequest(existing.requestHandle);
      }

      const result = validateResult(
        await native.requestPrivatePhoneAddress(phoneNumber, input.network),
        input.network,
      );
      if (result.status !== 'waiting') {
        throw new Error('The private address request did not start safely.');
      }
      const context = Object.freeze({
        requestHandle: requireRequestHandle(result.requestHandle),
        phoneNumber,
        displayName,
        network: input.network,
      });
      const current = await loadTrackedRequests();
      await storeTrackedRequests(
        [
          context,
          ...current.filter(
            item => item.requestHandle !== context.requestHandle,
          ),
        ].slice(0, MAX_TRACKED_REQUESTS),
      );
      return Object.freeze({ context, result });
    },

    pollTracked: async () => {
      const tracked = await loadTrackedRequests();
      const results: CheckedPrivatePhoneAddressRequest[] = [];
      for (const context of tracked) {
        const result = validateResult(
          await native.pollPrivatePhoneAddressRequest(context.requestHandle),
          context.network,
        );
        results.push(Object.freeze({ context, result }));
      }
      return Object.freeze(results);
    },

    forget: forgetTrackedRequest,

    pollIncoming: async () => {
      const now = Math.floor(Date.now() / 1_000);
      const requests = await native.pollIncomingPrivatePhoneAddressRequests();
      if (!Array.isArray(requests) || requests.length > MAX_TRACKED_REQUESTS) {
        throw new Error('The private address request inbox is invalid.');
      }
      return Object.freeze(
        requests.map(request => validateIncomingRequest(request, now)),
      );
    },

    respond: async input => {
      const requestHandle = requireRequestHandle(input.requestHandle);
      const accountIndex = input.accountIndex ?? 0;
      if (
        input.approved &&
        (!input.walletId?.trim() ||
          !Number.isSafeInteger(accountIndex) ||
          accountIndex < 0)
      ) {
        throw new Error('Open a wallet before sharing an address.');
      }
      await native.respondPrivatePhoneAddressRequest(
        requestHandle,
        input.approved ? input.walletId!.trim() : '',
        input.approved ? accountIndex : 0,
        input.approved,
      );
    },
  });
}

function validateResult(
  value: PrivatePhoneAddressRequestResult,
  expectedNetwork: MoneroNetwork,
): PrivatePhoneAddressRequestResult {
  const now = Math.floor(Date.now() / 1_000);
  const status =
    value.status === 'waiting' ||
    value.status === 'approved' ||
    value.status === 'declined' ||
    value.status === 'expired'
      ? value.status
      : undefined;
  const address = value.address.trim();
  if (
    !status ||
    !REQUEST_HANDLE.test(value.requestHandle) ||
    value.network !== expectedNetwork ||
    !Number.isSafeInteger(value.issuedAt) ||
    !Number.isSafeInteger(value.expiresAt) ||
    !Number.isSafeInteger(value.sequence) ||
    value.issuedAt > now ||
    value.sequence < 1 ||
    ((status === 'waiting' || status === 'approved') &&
      value.expiresAt <= now) ||
    (status === 'approved'
      ? !MONERO_SUBADDRESS.test(address)
      : address.length !== 0)
  ) {
    throw new Error('The private address response is invalid or expired.');
  }
  return Object.freeze({
    requestHandle: value.requestHandle,
    status,
    network: expectedNetwork,
    address,
    issuedAt: value.issuedAt,
    expiresAt: value.expiresAt,
    sequence: value.sequence,
  });
}

function validateIncomingRequest(
  value: PrivatePhoneIncomingAddressRequest,
  now: number,
): PrivatePhoneIncomingAddressRequest {
  if (
    !REQUEST_HANDLE.test(value.requestHandle) ||
    !E164.test(value.phoneNumber) ||
    !isMoneroNetwork(value.network) ||
    !Number.isSafeInteger(value.issuedAt) ||
    !Number.isSafeInteger(value.expiresAt) ||
    value.issuedAt > now ||
    value.expiresAt <= now
  ) {
    throw new Error('The private address request is invalid or expired.');
  }
  return Object.freeze({
    requestHandle: value.requestHandle,
    phoneNumber: value.phoneNumber,
    network: value.network,
    issuedAt: value.issuedAt,
    expiresAt: value.expiresAt,
  });
}

async function loadTrackedRequests(): Promise<
  TrackedPrivatePhoneAddressRequest[]
> {
  const stored = await loadProtectedMetadata(TRACKED_REQUESTS_KEY);
  if (stored === null) {
    return [];
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(stored);
  } catch {
    throw new Error('Saved private address requests are invalid.');
  }
  if (!Array.isArray(decoded) || decoded.length > MAX_TRACKED_REQUESTS) {
    throw new Error('Saved private address requests are invalid.');
  }
  return decoded.map(value => {
    if (
      !isRecord(value) ||
      typeof value.requestHandle !== 'string' ||
      typeof value.phoneNumber !== 'string' ||
      typeof value.displayName !== 'string' ||
      typeof value.network !== 'string' ||
      !REQUEST_HANDLE.test(value.requestHandle) ||
      !E164.test(value.phoneNumber) ||
      !isMoneroNetwork(value.network)
    ) {
      throw new Error('Saved private address requests are invalid.');
    }
    return Object.freeze({
      requestHandle: value.requestHandle,
      phoneNumber: value.phoneNumber,
      displayName: boundedLabel(value.displayName),
      network: value.network,
    });
  });
}

async function storeTrackedRequests(
  requests: ReadonlyArray<TrackedPrivatePhoneAddressRequest>,
): Promise<void> {
  if (requests.length === 0) {
    await deleteProtectedMetadata(TRACKED_REQUESTS_KEY);
    return;
  }
  await storeProtectedMetadata(TRACKED_REQUESTS_KEY, JSON.stringify(requests));
}

async function forgetTrackedRequest(requestHandle: string): Promise<void> {
  const checked = requireRequestHandle(requestHandle);
  await storeTrackedRequests(
    (
      await loadTrackedRequests()
    ).filter(item => item.requestHandle !== checked),
  );
}

function requirePhoneNumber(value: string): string {
  const phoneNumber = value.trim();
  if (!E164.test(phoneNumber)) {
    throw new Error('Enter a valid international phone number.');
  }
  return phoneNumber;
}

function requireRequestHandle(value: string): string {
  if (!REQUEST_HANDLE.test(value)) {
    throw new Error('The private address request handle is invalid.');
  }
  return value;
}

function boundedLabel(value: string): string {
  const label = value.trim();
  if (
    Array.from(label).length > 160 ||
    Array.from(label).some(character => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  ) {
    throw new Error('The contact name is invalid.');
  }
  return label;
}

function isMoneroNetwork(value: string): value is MoneroNetwork {
  return value === 'mainnet' || value === 'testnet' || value === 'stagenet';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
