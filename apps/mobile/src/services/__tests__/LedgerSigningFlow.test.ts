import type { LedgerTransportStatus } from '../NativeMoneroWallet';
import {
  isLedgerSigningCancelledError,
  ledgerTransportReady,
  waitForLedgerTransport,
} from '../LedgerSigningFlow';

const transportStatus = (
  overrides: Partial<LedgerTransportStatus> = {},
): LedgerTransportStatus => ({
  platform: 'android',
  transport: 'ble',
  supported: true,
  available: true,
  permissionGranted: true,
  requiresUserAction: false,
  deviceCount: 1,
  deviceName: 'Ledger Nano',
  vendorId: 0,
  productId: 0,
  message: 'Ledger ready',
  ...overrides,
});

describe('LedgerSigningFlow', () => {
  it('only treats a permitted, available device as ready', () => {
    expect(ledgerTransportReady(transportStatus())).toBe(true);
    expect(
      ledgerTransportReady(transportStatus({ permissionGranted: false })),
    ).toBe(false);
    expect(ledgerTransportReady(transportStatus({ deviceCount: 0 }))).toBe(
      false,
    );
  });

  it('returns an already connected Ledger without requesting access', async () => {
    const getStatus = jest.fn(async () => transportStatus());
    const requestAccess = jest.fn(async () => transportStatus());

    await expect(
      waitForLedgerTransport({ getStatus, requestAccess, retryDelayMs: 0 }),
    ).resolves.toMatchObject({ deviceName: 'Ledger Nano' });
    expect(requestAccess).not.toHaveBeenCalled();
  });

  it('requests access when the Ledger is visible but not yet permitted', async () => {
    const getStatus = jest.fn(async () =>
      transportStatus({ permissionGranted: false }),
    );
    const requestAccess = jest.fn(async () => transportStatus());

    await expect(
      waitForLedgerTransport({ getStatus, requestAccess, retryDelayMs: 0 }),
    ).resolves.toMatchObject({ permissionGranted: true });
    expect(requestAccess).toHaveBeenCalledTimes(1);
  });

  it('stops cleanly when the user cancels device discovery', async () => {
    expect.hasAssertions();
    let cancelled = false;
    const requestAccess = jest.fn(async () => {
      cancelled = true;
      return transportStatus({ available: false, deviceCount: 0 });
    });

    try {
      await waitForLedgerTransport({
        getStatus: async () =>
          transportStatus({ available: false, deviceCount: 0 }),
        requestAccess,
        retryDelayMs: 0,
        control: { isCancelled: () => cancelled },
      });
    } catch (error) {
      expect(isLedgerSigningCancelledError(error)).toBe(true);
    }
  });
});
