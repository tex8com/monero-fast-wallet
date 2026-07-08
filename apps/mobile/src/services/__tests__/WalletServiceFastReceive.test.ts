jest.mock("@react-native-async-storage/async-storage", () => {
  const storage = new Map<string, string>();
  const mock = {
    clear: jest.fn(async () => {
      storage.clear();
    }),
    getItem: jest.fn(async (key: string) => storage.get(key) ?? null),
    setItem: jest.fn(async (key: string, value: string) => {
      storage.set(key, value);
    }),
  };

  return {
    __esModule: true,
    default: mock,
  };
});

const mockNativeWallet = {
  enableFastReceiveIdentity: jest.fn(async () => ({
    id: "fast-receive-7",
    label: "Native Default",
    path: "/native/reopened-fast-receive",
    address: "54A1updatedAddress",
    network: "stagenet",
    restoreHeight: 0,
    derivationIndex: 0,
    scannerStatus: "enabled",
  })),
  disableFastReceiveIdentity: jest.fn(async () => ({
    id: "fast-receive-7",
    label: "",
    path: "",
    address: "",
    network: "stagenet",
    restoreHeight: 0,
    derivationIndex: 0,
    scannerStatus: "disabled",
  })),
};

jest.mock("../NativeMoneroWallet", () => {
  return {
    requireNativeMoneroWallet: jest.fn(() => mockNativeWallet),
  };
});

import AsyncStorage from "@react-native-async-storage/async-storage";

import {
  createFastReceiveIdentityRecord,
  loadFastReceiveIdentities,
  upsertFastReceiveIdentity,
} from "../FastReceiveRegistry";
import { WalletService } from "../WalletService";

describe("WalletService fast receive scanner flow", () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    await AsyncStorage.clear();
  });

  it("enables scanner hosting without replacing local identity metadata", async () => {
    await upsertFastReceiveIdentity(
      createFastReceiveIdentityRecord(
        {
          id: "fast-receive-7",
          label: "Shop Notifications",
          path: "/local/fast-receive-7",
          address: "54A1oldAddress",
          network: "mainnet",
          restoreHeight: 777,
          derivationIndex: 7,
          scannerStatus: "local-only",
        },
        "2026-07-08T00:00:00.000Z",
      ),
    );

    const service = new WalletService();
    const result = await service.enableFastReceiveIdentity({
      identityId: "fast-receive-7",
      password: "local-wallet-password",
      scannerUrl: "https://scanner.tex8.com",
      scannerAuthToken: "secret-token",
      pushToken: "push-token",
    });

    expect(
      mockNativeWallet.enableFastReceiveIdentity,
    ).toHaveBeenCalledWith(
      {
        identityId: "fast-receive-7",
        path: "/local/fast-receive-7",
        password: "local-wallet-password",
        network: "mainnet",
        scannerUrl: "https://scanner.tex8.com",
        scannerAuthToken: "secret-token",
        pushToken: "push-token",
      },
    );
    expect(result.identity).toMatchObject({
      id: "fast-receive-7",
      label: "Shop Notifications",
      path: "/local/fast-receive-7",
      address: "54A1updatedAddress",
      network: "mainnet",
      restoreHeight: 777,
      derivationIndex: 7,
      status: "enabled",
      scannerStatus: "enabled",
      createdAt: "2026-07-08T00:00:00.000Z",
    });
  });

  it("disables scanner hosting while preserving the local receive wallet", async () => {
    await upsertFastReceiveIdentity(
      {
        ...createFastReceiveIdentityRecord(
          {
            id: "fast-receive-7",
            label: "Shop Notifications",
            path: "/local/fast-receive-7",
            address: "54A1oldAddress",
            network: "mainnet",
            restoreHeight: 777,
            derivationIndex: 7,
            scannerStatus: "enabled",
          },
          "2026-07-08T00:00:00.000Z",
        ),
        status: "enabled",
      },
    );

    const service = new WalletService();
    const result = await service.disableFastReceiveIdentity({
      identityId: "fast-receive-7",
      scannerUrl: "https://scanner.tex8.com",
      scannerAuthToken: "secret-token",
    });

    expect(
      mockNativeWallet.disableFastReceiveIdentity,
    ).toHaveBeenCalledWith(
      {
        identityId: "fast-receive-7",
        scannerUrl: "https://scanner.tex8.com",
        scannerAuthToken: "secret-token",
      },
    );
    expect(result.identity).toMatchObject({
      id: "fast-receive-7",
      label: "Shop Notifications",
      path: "/local/fast-receive-7",
      network: "mainnet",
      restoreHeight: 777,
      derivationIndex: 7,
      status: "disabled",
      scannerStatus: "disabled",
    });

    await expect(loadFastReceiveIdentities()).resolves.toEqual([
      expect.objectContaining({
        id: "fast-receive-7",
        status: "disabled",
        scannerStatus: "disabled",
      }),
    ]);
  });
});
