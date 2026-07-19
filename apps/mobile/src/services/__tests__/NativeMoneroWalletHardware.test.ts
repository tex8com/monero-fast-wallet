const mockHardwareStatus = {
  walletId: "wallet-1",
  deviceName: "Ledger",
  deviceType: "ledger",
  connected: true,
  requiresUserAction: false,
  promptKind: "",
  promptCode: 0,
  progress: 0,
  indeterminate: false,
};

const mockLedgerTransportStatus = {
  platform: "android",
  transport: "usb",
  supported: true,
  available: true,
  permissionGranted: true,
  requiresUserAction: false,
  deviceCount: 1,
  deviceName: "Ledger Nano",
  vendorId: 0x2c97,
  productId: 0x0006,
  message: "Android USB permission is granted for the Ledger device",
};

const mockNativeMoneroWalletTurboModule = {
  authenticateBiometric: jest.fn(async () => ({
    success: true,
    biometryType: "biometric",
    message: "Biometric unlock confirmed",
  })),
  createWalletWithStoredSecret: jest.fn(async () => "wallet-1"),
  createWalletFromDevice: jest.fn(async () => "wallet-1"),
  createWalletFromDeviceWithStoredSecret: jest.fn(async () => "wallet-1"),
  createFastReceiveIdentity: jest.fn(async () => ({
    id: "fast-receive-0",
    label: "Fast Receive",
    path: "/tmp/fast-receive-0",
    address: "54A1testAddress",
    network: "stagenet",
    restoreHeight: 10,
    derivationIndex: 0,
    scannerStatus: "local-only",
  })),
  createFastReceiveIdentityWithStoredSecret: jest.fn(async () => ({
    id: "fast-receive-0",
    label: "Fast Receive",
    path: "/tmp/fast-receive-0",
    address: "54A1testAddress",
    network: "stagenet",
    restoreHeight: 10,
    derivationIndex: 0,
    scannerStatus: "local-only",
  })),
  enableFastReceiveIdentity: jest.fn(async () => ({
    id: "fast-receive-0",
    label: "Fast Receive",
    path: "/tmp/fast-receive-0",
    address: "54A1testAddress",
    network: "stagenet",
    restoreHeight: 10,
    derivationIndex: 0,
    scannerStatus: "enabled",
  })),
  disableFastReceiveIdentity: jest.fn(async () => ({
    id: "fast-receive-0",
    label: "Fast Receive",
    path: "/tmp/fast-receive-0",
    address: "54A1testAddress",
    network: "stagenet",
    restoreHeight: 10,
    derivationIndex: 0,
    scannerStatus: "disabled",
  })),
  getBiometricAuthStatus: jest.fn(async () => ({
    platform: "android",
    supported: true,
    available: true,
    enrolled: true,
    biometryType: "biometric",
    message: "Biometric unlock is available",
  })),
  getHardwareWalletStatus: jest.fn(async () => mockHardwareStatus),
  getTransactions: jest.fn(async () => [
    {
      hash: "abc123",
      paymentId: "",
      description: "",
      label: "",
      direction: "in",
      pending: false,
      failed: false,
      coinbase: false,
      amountAtomic: "1000000000000",
      feeAtomic: "0",
      blockHeight: 10,
      confirmations: 2,
      unlockTime: 0,
      timestamp: 1_700_000_000,
      subaddrAccount: 0,
      subaddrIndices: [0],
      transfers: [],
    },
  ]),
  getLedgerTransportStatus: jest.fn(async () => mockLedgerTransportStatus),
  prepareTransaction: jest.fn(async () => ({
    id: "pending-tx-1",
    status: "ok",
    error: "",
    amountAtomic: "1000000000000",
    dustAtomic: "0",
    feeAtomic: "12000000",
    txCount: 1,
    txIds: ["txid-1"],
    subaddrAccounts: [0],
    subaddrIndices: [0],
  })),
  commitTransaction: jest.fn(async () => ({
    id: "pending-tx-1",
    status: "ok",
    error: "",
    amountAtomic: "1000000000000",
    dustAtomic: "0",
    feeAtomic: "12000000",
    txCount: 1,
    txIds: ["txid-1"],
    subaddrAccounts: [0],
    subaddrIndices: [0],
  })),
  requestLedgerTransportAccess: jest.fn(async () => mockLedgerTransportStatus),
  showHardwareWalletAddress: jest.fn(async () => ({
    ...mockHardwareStatus,
    promptKind: "address-confirmed",
  })),
};

jest.mock("react-native", () => {
  return {
    TurboModuleRegistry: {
      get: jest.fn(() => mockNativeMoneroWalletTurboModule),
    },
  };
});

describe("NativeMoneroWallet hardware bridge", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("defaults hardware wallet creation to the official Monero Ledger device name", async () => {
    const { requireNativeMoneroWallet } =
      require("../NativeMoneroWallet") as typeof import("../NativeMoneroWallet");
    const nativeWallet = requireNativeMoneroWallet();

    await expect(
      nativeWallet.createWalletFromDevice({
        path: "/tmp/wallet-from-device",
        password: "local-wallet-password",
        network: "stagenet",
      }),
    ).resolves.toEqual({ walletId: "wallet-1" });

    expect(
      mockNativeMoneroWalletTurboModule.createWalletFromDevice,
    ).toHaveBeenCalledWith(
      "/tmp/wallet-from-device",
      "local-wallet-password",
      "stagenet",
      "Ledger",
      0,
      "",
      0,
    );
  });

  it("passes hardware wallet status DTOs without exposing secrets", async () => {
    const { requireNativeMoneroWallet } =
      require("../NativeMoneroWallet") as typeof import("../NativeMoneroWallet");
    const nativeWallet = requireNativeMoneroWallet();

    await expect(
      nativeWallet.getHardwareWalletStatus("wallet-1"),
    ).resolves.toEqual(mockHardwareStatus);

    await expect(
      nativeWallet.showHardwareWalletAddress("wallet-1", 0, 0, ""),
    ).resolves.toMatchObject({
      deviceType: "ledger",
      promptKind: "address-confirmed",
    });

    expect(
      mockNativeMoneroWalletTurboModule.showHardwareWalletAddress,
    ).toHaveBeenCalledWith("wallet-1", 0, 0, "");
  });

  it("exposes the shared Ledger transport status contract", async () => {
    const { requireNativeMoneroWallet } =
      require("../NativeMoneroWallet") as typeof import("../NativeMoneroWallet");
    const nativeWallet = requireNativeMoneroWallet();

    await expect(nativeWallet.getLedgerTransportStatus()).resolves.toEqual(
      mockLedgerTransportStatus,
    );
    await expect(nativeWallet.requestLedgerTransportAccess()).resolves.toEqual(
      mockLedgerTransportStatus,
    );
  });

  it("creates fast receive identities without exposing view keys to JavaScript", async () => {
    const { requireNativeMoneroWallet } =
      require("../NativeMoneroWallet") as typeof import("../NativeMoneroWallet");
    const nativeWallet = requireNativeMoneroWallet();

    await expect(
      nativeWallet.createFastReceiveIdentity({
        sourceWalletId: "wallet-1",
        identityId: "fast-receive-0",
        path: "/tmp/fast-receive-0",
        password: "local-wallet-password",
        label: "Fast Receive",
        restoreHeight: 10,
        derivationIndex: 0,
      }),
    ).resolves.toEqual({
      id: "fast-receive-0",
      label: "Fast Receive",
      path: "/tmp/fast-receive-0",
      address: "54A1testAddress",
      network: "stagenet",
      restoreHeight: 10,
      derivationIndex: 0,
      scannerStatus: "local-only",
    });

    expect(
      mockNativeMoneroWalletTurboModule.createFastReceiveIdentity,
    ).toHaveBeenCalledWith(
      "wallet-1",
      "fast-receive-0",
      "/tmp/fast-receive-0",
      "local-wallet-password",
      "Fast Receive",
      10,
      0,
    );
  });

  it("passes fast receive scanner registration inputs without a JavaScript view key", async () => {
    const { requireNativeMoneroWallet } =
      require("../NativeMoneroWallet") as typeof import("../NativeMoneroWallet");
    const nativeWallet = requireNativeMoneroWallet();

    await expect(
      nativeWallet.enableFastReceiveIdentity({
        identityId: "fast-receive-0",
        path: "/tmp/fast-receive-0",
        password: "local-wallet-password",
        network: "stagenet",
        restoreHeight: 123,
        scannerUrl: "https://xmr.tex8.com",
        scannerAuthToken: "secret-token",
        pushSubscriptionId: "push-subscription-id",
      }),
    ).resolves.toMatchObject({
      id: "fast-receive-0",
      scannerStatus: "enabled",
    });

    expect(
      mockNativeMoneroWalletTurboModule.enableFastReceiveIdentity,
    ).toHaveBeenCalledWith(
      "fast-receive-0",
      "/tmp/fast-receive-0",
      "local-wallet-password",
      "stagenet",
      123,
      "https://xmr.tex8.com",
      "secret-token",
      "push-subscription-id",
    );
    expect(
      JSON.stringify(
        mockNativeMoneroWalletTurboModule.enableFastReceiveIdentity.mock.calls,
      ),
    ).not.toContain("privateViewKey");
  });

  it("passes transaction history and prepared send DTOs through the wrapper", async () => {
    const { requireNativeMoneroWallet } =
      require("../NativeMoneroWallet") as typeof import("../NativeMoneroWallet");
    const nativeWallet = requireNativeMoneroWallet();

    await expect(nativeWallet.getTransactions("wallet-1", 5)).resolves.toEqual([
      expect.objectContaining({
        hash: "abc123",
        direction: "in",
        amountAtomic: "1000000000000",
      }),
    ]);

    await expect(
      nativeWallet.prepareTransaction({
        walletId: "wallet-1",
        address: "54A1recipient",
        amountAtomic: "1000000000000",
        priority: "low",
      }),
    ).resolves.toMatchObject({
      id: "pending-tx-1",
      status: "ok",
      feeAtomic: "12000000",
    });

    await expect(
      nativeWallet.commitTransaction("wallet-1", "pending-tx-1"),
    ).resolves.toMatchObject({
      status: "ok",
      txIds: ["txid-1"],
    });

    expect(mockNativeMoneroWalletTurboModule.prepareTransaction)
      .toHaveBeenCalledWith(
        "wallet-1",
        "54A1recipient",
        "1000000000000",
        "",
        "low",
        0,
      );
    await nativeWallet.prepareTransaction({
      walletId: "wallet-1",
      address: "54A1recipient",
      sweepAll: true,
      priority: "low",
    });
    expect(mockNativeMoneroWalletTurboModule.prepareTransaction)
      .toHaveBeenLastCalledWith(
        "wallet-1",
        "54A1recipient",
        "",
        "",
        "low",
        0,
      );
    expect(mockNativeMoneroWalletTurboModule.commitTransaction)
      .toHaveBeenCalledWith("wallet-1", "pending-tx-1");
  });
});
