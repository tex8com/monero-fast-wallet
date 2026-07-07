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

const mockStoreSecret = jest.fn(async () => undefined);
const mockDeleteSecret = jest.fn(async () => undefined);

jest.mock("../NativeMoneroWallet", () => ({
  requireNativeMoneroWallet: () => ({
    storeSecret: mockStoreSecret,
    deleteSecret: mockDeleteSecret,
  }),
}));

import AsyncStorage from "@react-native-async-storage/async-storage";

import {
  applyNodeModeDefaults,
  createDefaultNodeConnectionSettings,
  loadActiveNodeConnectionSettings,
  NODE_DAEMON_PASSWORD_SECRET_KEY,
  NODE_CONNECTION_SETTINGS_STORAGE_KEY,
  nodeConnectionDraftToSettings,
  nodeConnectionSettingsToDraft,
  saveActiveNodeConnectionSettings,
} from "../NodeConnectionSettings";

describe("NodeConnectionSettings", () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    mockStoreSecret.mockClear();
    mockDeleteSecret.mockClear();
  });

  it("defaults to optimized Cuprate gRPC ports", () => {
    expect(createDefaultNodeConnectionSettings("mainnet")).toEqual({
      mode: "optimized-grpc",
      network: "mainnet",
      daemon: {
        address: "152.53.133.188:18089",
        trusted: true,
        useSsl: false,
        username: "",
        password: "",
        proxyAddress: "",
      },
      grpcEndpoint: "152.53.133.188:18091",
    });

    expect(
      createDefaultNodeConnectionSettings("stagenet").grpcEndpoint,
    ).toBe("152.53.133.188:38091");
  });

  it("disables gRPC for original Monero RPC mode", () => {
    const original = createDefaultNodeConnectionSettings(
      "testnet",
      "original-rpc",
    );

    expect(original.daemon.address).toBe("152.53.133.188:28089");
    expect(original.grpcEndpoint).toBe("");
  });

  it("migrates persisted VPN defaults to the public Cuprate host", async () => {
    await AsyncStorage.setItem(
      NODE_CONNECTION_SETTINGS_STORAGE_KEY,
      JSON.stringify({
        mode: "optimized-grpc",
        network: "mainnet",
        daemon: {
          address: "private-node-ip:18089",
          trusted: true,
          useSsl: false,
          username: "",
          proxyAddress: "",
        },
        grpcEndpoint: "private-node-ip:18091",
      }),
    );

    const settings = await loadActiveNodeConnectionSettings();

    expect(settings.daemon.address).toBe("152.53.133.188:18089");
    expect(settings.grpcEndpoint).toBe("152.53.133.188:18091");
  });

  it("migrates an old VPN monerod RPC port to the public Cuprate daemon port", async () => {
    await AsyncStorage.setItem(
      NODE_CONNECTION_SETTINGS_STORAGE_KEY,
      JSON.stringify({
        mode: "optimized-grpc",
        network: "mainnet",
        daemon: {
          address: "private-node-ip:18081",
          trusted: true,
          useSsl: false,
          username: "",
          proxyAddress: "",
        },
        grpcEndpoint: "private-node-ip:18091",
      }),
    );

    const settings = await loadActiveNodeConnectionSettings();

    expect(settings.daemon.address).toBe("152.53.133.188:18089");
    expect(settings.grpcEndpoint).toBe("152.53.133.188:18091");
  });

  it("clears gRPC when a draft is saved as original RPC", () => {
    const draft = nodeConnectionSettingsToDraft(
      createDefaultNodeConnectionSettings("mainnet"),
    );

    draft.mode = "original-rpc";
    draft.grpcEndpoint = "fast.example.test:18091";

    expect(nodeConnectionDraftToSettings(draft).grpcEndpoint).toBe("");
  });

  it("preserves custom endpoints when switching to custom mode", () => {
    const draft = nodeConnectionSettingsToDraft(
      createDefaultNodeConnectionSettings("mainnet"),
    );
    draft.daemonAddress = "node.example.test:18089";
    draft.grpcEndpoint = "fast.example.test:18091";

    const custom = applyNodeModeDefaults(draft, "custom");

    expect(custom.daemonAddress).toBe("node.example.test:18089");
    expect(custom.grpcEndpoint).toBe("fast.example.test:18091");
  });

  it("persists node settings without the daemon password", async () => {
    const settings = nodeConnectionDraftToSettings({
      mode: "custom",
      network: "mainnet",
      daemonAddress: "node.example.test:18089",
      grpcEndpoint: "fast.example.test:18091",
      trusted: true,
      useSsl: true,
      username: "wallet-user",
      password: "wallet-password",
      passwordStored: false,
      proxyAddress: "127.0.0.1:9050",
    });

    await saveActiveNodeConnectionSettings(settings);

    const persisted = await AsyncStorage.getItem(
      NODE_CONNECTION_SETTINGS_STORAGE_KEY,
    );

    expect(persisted).not.toBeNull();
    expect(persisted).not.toContain("wallet-password");
    expect(mockStoreSecret).toHaveBeenCalledWith(
      NODE_DAEMON_PASSWORD_SECRET_KEY,
      "wallet-password",
    );
    expect(JSON.parse(persisted ?? "{}")).toEqual({
      mode: "custom",
      network: "mainnet",
      daemon: {
        address: "node.example.test:18089",
        trusted: true,
        useSsl: true,
        username: "wallet-user",
        passwordSecretKey: NODE_DAEMON_PASSWORD_SECRET_KEY,
        proxyAddress: "127.0.0.1:9050",
      },
      grpcEndpoint: "fast.example.test:18091",
    });
  });
});
