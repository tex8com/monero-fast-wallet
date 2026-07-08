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
  defaultWalletPath: jest.fn(async (walletName: string, network: string) =>
    `/current-container/wallets/${network}/${walletName}`,
  ),
  logDiagnostics: jest.fn(async () => undefined),
  openWallet: jest.fn(async () => ({ walletId: "wallet-1" })),
  setDaemon: jest.fn(async () => undefined),
  setGrpcEndpoint: jest.fn(async () => undefined),
};

jest.mock("../NativeMoneroWallet", () => {
  return {
    requireNativeMoneroWallet: jest.fn(() => mockNativeWallet),
  };
});

import AsyncStorage from "@react-native-async-storage/async-storage";

import {
  createRegisteredWallet,
  loadRegisteredWallet,
  saveRegisteredWallet,
} from "../WalletRegistry";
import { WalletService } from "../WalletService";

describe("WalletService registered wallet opening", () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    await AsyncStorage.clear();
  });

  it("relocates registered wallet paths when the iOS app container changes", async () => {
    await saveRegisteredWallet(
      createRegisteredWallet({
        walletName: "primary-2",
        path: "/old-container/Library/Application Support/MoneroWallet/wallets/mainnet/primary-2",
        network: "mainnet",
        now: "2026-07-08T20:06:07.217Z",
      }),
    );

    const service = new WalletService();
    const session = await service.openRegisteredWallet("local-password");

    expect(session).toEqual({
      walletId: "wallet-1",
      network: "mainnet",
    });
    expect(mockNativeWallet.openWallet).toHaveBeenCalledWith({
      path: "/current-container/wallets/mainnet/primary-2",
      password: "local-password",
      network: "mainnet",
    });
    await expect(loadRegisteredWallet()).resolves.toMatchObject({
      walletName: "primary-2",
      path: "/current-container/wallets/mainnet/primary-2",
    });
  });
});
