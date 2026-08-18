import { createPrivatePhoneAddressRequestService } from '../PrivatePhoneAddressRequests';
import {
  deleteProtectedMetadata,
  loadProtectedMetadata,
  storeProtectedMetadata,
} from '../ProtectedMetadataStorage';

jest.mock('../ProtectedMetadataStorage', () => ({
  deleteProtectedMetadata: jest.fn(),
  loadProtectedMetadata: jest.fn(),
  storeProtectedMetadata: jest.fn(),
}));

const mockedDelete = deleteProtectedMetadata as jest.MockedFunction<
  typeof deleteProtectedMetadata
>;
const mockedLoad = loadProtectedMetadata as jest.MockedFunction<
  typeof loadProtectedMetadata
>;
const mockedStore = storeProtectedMetadata as jest.MockedFunction<
  typeof storeProtectedMetadata
>;

const requestHandle = `private-phone-ask_${'a'.repeat(48)}`;
const address = `8${'1'.repeat(94)}`;

function nativeFixture() {
  return {
    requestPrivatePhoneAddress: jest.fn(async () => ({
      requestHandle,
      status: 'waiting',
      network: 'mainnet',
      address: '',
      issuedAt: 90,
      expiresAt: 110,
      sequence: 1,
    })),
    pollPrivatePhoneAddressRequest: jest.fn(async () => ({
      requestHandle,
      status: 'waiting',
      network: 'mainnet',
      address: '',
      issuedAt: 90,
      expiresAt: 110,
      sequence: 1,
    })),
    pollIncomingPrivatePhoneAddressRequests: jest.fn(async () => []),
    respondPrivatePhoneAddressRequest: jest.fn(async () => undefined),
  };
}

describe('PrivatePhoneAddressRequests', () => {
  let stored: string | null;

  beforeEach(() => {
    stored = null;
    jest.spyOn(Date, 'now').mockReturnValue(100_000);
    mockedLoad.mockImplementation(async () => stored);
    mockedStore.mockImplementation(async (_key, value) => {
      stored = value;
    });
    mockedDelete.mockImplementation(async () => {
      stored = null;
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('persists only an opaque handle and reuses an active request', async () => {
    const native = nativeFixture();
    const service = createPrivatePhoneAddressRequestService(native as any);

    await expect(
      service.request({
        phoneNumber: '+15551234567',
        displayName: 'Alice',
        network: 'mainnet',
      }),
    ).resolves.toMatchObject({
      context: {
        requestHandle,
        phoneNumber: '+15551234567',
        displayName: 'Alice',
      },
      result: { status: 'waiting' },
    });
    await service.request({
      phoneNumber: '+15551234567',
      displayName: 'Alice',
      network: 'mainnet',
    });

    expect(native.requestPrivatePhoneAddress).toHaveBeenCalledTimes(1);
    expect(native.pollPrivatePhoneAddressRequest).toHaveBeenCalledWith(
      requestHandle,
    );
    expect(stored).not.toMatch(
      /phoneToken|pairId|privateKey|requestState|envelope/i,
    );
  });

  it('accepts a current native-validated approval and can forget it', async () => {
    const native = nativeFixture();
    const service = createPrivatePhoneAddressRequestService(native as any);
    await service.request({
      phoneNumber: '+15551234567',
      displayName: 'Alice',
      network: 'mainnet',
    });
    native.pollPrivatePhoneAddressRequest.mockResolvedValueOnce({
      requestHandle,
      status: 'approved',
      network: 'mainnet',
      address,
      issuedAt: 99,
      expiresAt: 109,
      sequence: 2,
    });

    await expect(service.pollTracked()).resolves.toMatchObject([
      {
        context: { displayName: 'Alice' },
        result: { status: 'approved', address },
      },
    ]);
    await service.forget(requestHandle);
    await expect(service.pollTracked()).resolves.toEqual([]);
  });

  it('rejects malformed or expired approved addresses', async () => {
    const native = nativeFixture();
    native.requestPrivatePhoneAddress.mockResolvedValueOnce({
      requestHandle,
      status: 'approved',
      network: 'mainnet',
      address: 'not-an-address',
      issuedAt: 90,
      expiresAt: 110,
      sequence: 1,
    });
    const service = createPrivatePhoneAddressRequestService(native as any);

    await expect(
      service.request({
        phoneNumber: '+15551234567',
        displayName: 'Alice',
        network: 'mainnet',
      }),
    ).rejects.toThrow('invalid or expired');
  });

  it('validates the inbox and requires an open wallet only for approval', async () => {
    const native = nativeFixture();
    native.pollIncomingPrivatePhoneAddressRequests.mockResolvedValueOnce([
      {
        requestHandle,
        phoneNumber: '+15551234567',
        network: 'mainnet',
        issuedAt: 95,
        expiresAt: 110,
      },
    ] as any);
    const service = createPrivatePhoneAddressRequestService(native as any);

    await expect(service.pollIncoming()).resolves.toHaveLength(1);
    await service.respond({ requestHandle, approved: false });
    await expect(
      service.respond({ requestHandle, approved: true }),
    ).rejects.toThrow('Open a wallet');
    await service.respond({
      requestHandle,
      approved: true,
      walletId: 'wallet-1',
      accountIndex: 0,
    });
    expect(native.respondPrivatePhoneAddressRequest).toHaveBeenLastCalledWith(
      requestHandle,
      'wallet-1',
      0,
      true,
    );
  });
});
