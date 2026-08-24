import type { LedgerTransportStatus } from '../NativeMoneroWallet';
import {
  isLedgerSigningCancelledError,
  isLedgerSigningScanHeightMismatchError,
  isLedgerSigningSpendStateMismatchError,
  ledgerTransportReady,
  waitForLedgerSigningSpendReady,
  waitForLedgerSigningSpendReadyWithSingleRebuild,
  waitForLedgerTransport,
} from '../LedgerSigningFlow';
import type { WalletSnapshot } from '../NativeMoneroWallet';

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

const walletSnapshot = (
  overrides: Partial<WalletSnapshot> = {},
): WalletSnapshot => ({
  id: 'wallet-ledger',
  path: '/wallets/ledger',
  primaryAddress: '4'.repeat(95),
  balanceAtomic: '900',
  unlockedBalanceAtomic: '900',
  walletHeight: 100,
  daemonHeight: 100,
  daemonTargetHeight: 100,
  spendAccountIndex: 1,
  spendPrimaryAddress: '8'.repeat(95),
  spendBalanceAtomic: '900',
  spendUnlockedBalanceAtomic: '900',
  synchronized: true,
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

  it('keeps searching until a Ledger powered on after the dialog opened is ready', async () => {
    jest.useFakeTimers();
    const unavailable = transportStatus({
      available: false,
      deviceCount: 0,
      deviceName: '',
      requiresUserAction: true,
      message: 'No live Ledger found',
    });
    const getStatus = jest.fn(async () => unavailable);
    const requestAccess = jest
      .fn<Promise<LedgerTransportStatus>, []>()
      .mockResolvedValueOnce(unavailable)
      .mockResolvedValueOnce(transportStatus({ deviceName: '97A0' }));

    try {
      const discovery = waitForLedgerTransport({ getStatus, requestAccess });
      await Promise.resolve();
      await Promise.resolve();

      expect(requestAccess).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(2_499);
      expect(requestAccess).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1);

      await expect(discovery).resolves.toMatchObject({
        available: true,
        deviceCount: 1,
        deviceName: '97A0',
      });
      expect(getStatus).toHaveBeenCalledTimes(2);
      expect(requestAccess).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
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

  it('waits through a provisional account zero scope until the signing cache reaches the reference height', async () => {
    const onProgress = jest.fn();
    const readSnapshot = jest
      .fn<Promise<WalletSnapshot>, [number, number]>()
      .mockResolvedValueOnce(
        walletSnapshot({
          walletHeight: 40,
          daemonHeight: 100,
          daemonTargetHeight: 100,
          spendAccountIndex: 0,
          spendPrimaryAddress: '4'.repeat(95),
          spendBalanceAtomic: '0',
          spendUnlockedBalanceAtomic: '0',
          synchronized: false,
        }),
      )
      .mockResolvedValueOnce(walletSnapshot());

    await expect(
      waitForLedgerSigningSpendReady({
        readSnapshot,
        referenceSnapshot: walletSnapshot(),
        retryDelayMs: 0,
        control: { onProgress },
      }),
    ).resolves.toMatchObject({
      spendAccountIndex: 1,
      walletHeight: 100,
    });
    expect(readSnapshot).toHaveBeenCalledTimes(2);
    expect(readSnapshot.mock.calls[0][0]).toBe(readSnapshot.mock.calls[1][0]);
    expect(readSnapshot.mock.calls[0][1]).toBe(1);
    expect(readSnapshot.mock.calls[1][1]).toBe(1);
    expect(onProgress).toHaveBeenCalledWith({
      phase: 'synchronizing-wallet',
    });
    expect(onProgress).toHaveBeenCalledWith({
      phase: 'synchronizing-wallet',
      detail: 'Synchronizing signing wallet: block 100 of 100',
    });
    expect(onProgress.mock.calls).toEqual([
      [{ phase: 'synchronizing-wallet' }],
      [
        {
          phase: 'synchronizing-wallet',
          detail: 'Synchronizing signing wallet: block 40 of 100',
        },
      ],
      [
        {
          phase: 'synchronizing-wallet',
          detail: 'Synchronizing signing wallet: block 100 of 100',
        },
      ],
    ]);
  });

  it('rejects a different Ledger account only after the signing cache reaches the target height', async () => {
    await expect(
      waitForLedgerSigningSpendReady({
        readSnapshot: async () =>
          walletSnapshot({
            spendAccountIndex: 0,
            spendPrimaryAddress: '4'.repeat(95),
          }),
        referenceSnapshot: walletSnapshot(),
        retryDelayMs: 0,
      }),
    ).rejects.toThrow('does not match the selected wallet account');
  });

  it('rejects a target-height signing cache whose spend state is zero while the companion is funded', async () => {
    expect.hasAssertions();
    try {
      await waitForLedgerSigningSpendReady({
        readSnapshot: async () =>
          walletSnapshot({
            spendBalanceAtomic: '0',
            spendUnlockedBalanceAtomic: '0',
          }),
        referenceSnapshot: walletSnapshot(),
        retryDelayMs: 0,
      });
    } catch (error) {
      expect(isLedgerSigningSpendStateMismatchError(error)).toBe(true);
      expect(error).toEqual(
        expect.objectContaining({
          message: expect.stringContaining('spend state does not match'),
        }),
      );
    }
  });

  it('rejects equal spend amounts read at a different wallet height', async () => {
    expect.hasAssertions();
    try {
      await waitForLedgerSigningSpendReady({
        readSnapshot: async () =>
          walletSnapshot({
            walletHeight: 101,
            daemonHeight: 101,
            daemonTargetHeight: 101,
          }),
        referenceSnapshot: walletSnapshot(),
        retryDelayMs: 0,
      });
    } catch (error) {
      expect(isLedgerSigningScanHeightMismatchError(error)).toBe(true);
      expect(error).toEqual(
        expect.objectContaining({
          message: expect.stringContaining('same scan height'),
        }),
      );
    }
  });

  it('catches up the lower snapshot before accepting equal spend amounts', async () => {
    const height101 = walletSnapshot({
      walletHeight: 101,
      daemonHeight: 101,
      daemonTargetHeight: 101,
    });
    const readSnapshot = jest
      .fn<Promise<WalletSnapshot>, [number, number]>()
      .mockResolvedValue(height101);
    const refreshReferenceAfterMismatch = jest.fn(async () => height101);
    const rebuild = jest.fn(async () => undefined);

    await expect(
      waitForLedgerSigningSpendReadyWithSingleRebuild({
        readSnapshot,
        referenceSnapshot: walletSnapshot(),
        refreshReferenceAfterMismatch,
        rebuild,
        retryDelayMs: 0,
      }),
    ).resolves.toMatchObject({ walletHeight: 101 });
    expect(refreshReferenceAfterMismatch).toHaveBeenCalledTimes(1);
    expect(rebuild).not.toHaveBeenCalled();
    expect(readSnapshot).toHaveBeenCalledTimes(2);
  });

  it('rebuilds a mismatched signing cache exactly once before requiring strict parity again', async () => {
    const readSnapshot = jest
      .fn<Promise<WalletSnapshot>, [number, number]>()
      .mockResolvedValueOnce(
        walletSnapshot({
          spendBalanceAtomic: '0',
          spendUnlockedBalanceAtomic: '0',
        }),
      )
      .mockResolvedValueOnce(walletSnapshot());
    const rebuild = jest.fn(async () => undefined);

    await expect(
      waitForLedgerSigningSpendReadyWithSingleRebuild({
        readSnapshot,
        referenceSnapshot: walletSnapshot(),
        rebuild,
        retryDelayMs: 0,
      }),
    ).resolves.toMatchObject({
      spendBalanceAtomic: '900',
      spendUnlockedBalanceAtomic: '900',
    });
    expect(rebuild).toHaveBeenCalledTimes(1);
    expect(readSnapshot).toHaveBeenCalledTimes(2);
  });

  it('refreshes a frozen companion to the newer signing height before deciding to rebuild', async () => {
    const newerFundedSnapshot = walletSnapshot({
      balanceAtomic: '1000',
      unlockedBalanceAtomic: '1000',
      walletHeight: 101,
      daemonHeight: 101,
      daemonTargetHeight: 101,
      spendBalanceAtomic: '1000',
      spendUnlockedBalanceAtomic: '1000',
    });
    const readSnapshot = jest
      .fn<Promise<WalletSnapshot>, [number, number]>()
      .mockResolvedValue(newerFundedSnapshot);
    const refreshReferenceAfterMismatch = jest.fn(async () =>
      newerFundedSnapshot,
    );
    const rebuild = jest.fn(async () => undefined);

    await expect(
      waitForLedgerSigningSpendReadyWithSingleRebuild({
        readSnapshot,
        referenceSnapshot: walletSnapshot(),
        refreshReferenceAfterMismatch,
        rebuild,
        retryDelayMs: 0,
      }),
    ).resolves.toMatchObject({
      walletHeight: 101,
      spendBalanceAtomic: '1000',
    });
    expect(refreshReferenceAfterMismatch).toHaveBeenCalledTimes(1);
    expect(rebuild).not.toHaveBeenCalled();
    expect(readSnapshot).toHaveBeenCalledTimes(2);
  });

  it('keeps aligning newer scan heights instead of rebuilding from different-height balances', async () => {
    const height101 = walletSnapshot({
      walletHeight: 101,
      daemonHeight: 101,
      daemonTargetHeight: 101,
      spendBalanceAtomic: '1000',
      spendUnlockedBalanceAtomic: '1000',
    });
    const height102 = walletSnapshot({
      walletHeight: 102,
      daemonHeight: 102,
      daemonTargetHeight: 102,
      spendBalanceAtomic: '1100',
      spendUnlockedBalanceAtomic: '1100',
    });
    const height103 = walletSnapshot({
      walletHeight: 103,
      daemonHeight: 103,
      daemonTargetHeight: 103,
      spendBalanceAtomic: '1200',
      spendUnlockedBalanceAtomic: '1200',
    });
    const readSnapshot = jest
      .fn<Promise<WalletSnapshot>, [number, number]>()
      .mockResolvedValueOnce(height101)
      .mockResolvedValueOnce(height103)
      .mockResolvedValueOnce(height103);
    const refreshReferenceAfterMismatch = jest
      .fn<Promise<WalletSnapshot>, [unknown]>()
      .mockResolvedValueOnce(height102)
      .mockResolvedValueOnce(height103);
    const rebuild = jest.fn(async () => undefined);

    await expect(
      waitForLedgerSigningSpendReadyWithSingleRebuild({
        readSnapshot,
        referenceSnapshot: walletSnapshot(),
        refreshReferenceAfterMismatch,
        rebuild,
        retryDelayMs: 0,
      }),
    ).resolves.toMatchObject({
      walletHeight: 103,
      spendBalanceAtomic: '1200',
    });
    expect(refreshReferenceAfterMismatch).toHaveBeenCalledTimes(2);
    expect(rebuild).not.toHaveBeenCalled();
  });

  it('rebuilds once only after a mismatch remains at the same scan height', async () => {
    const fundedAt101 = walletSnapshot({
      walletHeight: 101,
      daemonHeight: 101,
      daemonTargetHeight: 101,
      spendBalanceAtomic: '1000',
      spendUnlockedBalanceAtomic: '1000',
    });
    const emptyAt101 = walletSnapshot({
      walletHeight: 101,
      daemonHeight: 101,
      daemonTargetHeight: 101,
      spendBalanceAtomic: '0',
      spendUnlockedBalanceAtomic: '0',
    });
    const readSnapshot = jest
      .fn<Promise<WalletSnapshot>, [number, number]>()
      .mockResolvedValueOnce(emptyAt101)
      .mockResolvedValueOnce(emptyAt101)
      .mockResolvedValueOnce(fundedAt101);
    const refreshReferenceAfterMismatch = jest.fn(async () => fundedAt101);
    const rebuild = jest.fn(async () => undefined);

    await expect(
      waitForLedgerSigningSpendReadyWithSingleRebuild({
        readSnapshot,
        referenceSnapshot: walletSnapshot(),
        refreshReferenceAfterMismatch,
        rebuild,
        retryDelayMs: 0,
      }),
    ).resolves.toMatchObject({
      walletHeight: 101,
      spendBalanceAtomic: '1000',
    });
    expect(refreshReferenceAfterMismatch).toHaveBeenCalledTimes(1);
    expect(rebuild).toHaveBeenCalledTimes(1);
  });

  it('never rebuilds when the connected Ledger account identity differs', async () => {
    const rebuild = jest.fn(async () => undefined);

    await expect(
      waitForLedgerSigningSpendReadyWithSingleRebuild({
        readSnapshot: async () =>
          walletSnapshot({
            spendAccountIndex: 0,
            spendPrimaryAddress: '4'.repeat(95),
          }),
        referenceSnapshot: walletSnapshot(),
        rebuild,
        retryDelayMs: 0,
      }),
    ).rejects.toThrow('does not match the selected wallet account');
    expect(rebuild).not.toHaveBeenCalled();
  });

  it('fails closed at a bounded deadline when the signing wallet never catches up', async () => {
    let currentTime = 0;
    await expect(
      waitForLedgerSigningSpendReady({
        readSnapshot: async () =>
          walletSnapshot({
            walletHeight: 40,
            daemonHeight: 100,
            daemonTargetHeight: 100,
            spendAccountIndex: undefined,
            spendPrimaryAddress: undefined,
            spendBalanceAtomic: undefined,
            spendUnlockedBalanceAtomic: undefined,
            synchronized: false,
          }),
        referenceSnapshot: walletSnapshot(),
        timeoutMs: 100,
        retryDelayMs: 25,
        now: () => currentTime,
        wait: async milliseconds => {
          currentTime += milliseconds;
        },
      }),
    ).rejects.toThrow('did not become synchronized in time');
    expect(currentTime).toBe(100);
  });
});
