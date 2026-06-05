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

import AsyncStorage from "@react-native-async-storage/async-storage";

import {
  applyNodeModeDefaults,
  createDefaultNodeConnectionSettings,
  NODE_CONNECTION_SETTINGS_STORAGE_KEY,
  nodeConnectionDraftToSettings,
  nodeConnectionSettingsToDraft,
  saveActiveNodeConnectionSettings,
} from "../NodeConnectionSettings";

describe("NodeConnectionSettings", () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  it("defaults to optimized Cuprate gRPC ports", () => {
    expect(createDefaultNodeConnectionSettings("mainnet")).toEqual({
      mode: "optimized-grpc",
      network: "mainnet",
      daemon: {
        address: "152.53.133.188:18089",
        trusted: false,
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
      proxyAddress: "127.0.0.1:9050",
    });

    await saveActiveNodeConnectionSettings(settings);

    const persisted = await AsyncStorage.getItem(
      NODE_CONNECTION_SETTINGS_STORAGE_KEY,
    );

    expect(persisted).not.toBeNull();
    expect(JSON.parse(persisted ?? "{}")).toEqual({
      mode: "custom",
      network: "mainnet",
      daemon: {
        address: "node.example.test:18089",
        trusted: true,
        useSsl: true,
        username: "wallet-user",
        proxyAddress: "127.0.0.1:9050",
      },
      grpcEndpoint: "fast.example.test:18091",
    });
  });
});
