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

const mockStoreDaemonPassword = jest.fn(async () => undefined);
const mockDeleteDaemonPassword = jest.fn(async () => undefined);

jest.mock("../NativeMoneroWallet", () => ({
  requireNativeMoneroWallet: () => ({
    storeDaemonPassword: mockStoreDaemonPassword,
    deleteDaemonPassword: mockDeleteDaemonPassword,
  }),
}));

import AsyncStorage from "@react-native-async-storage/async-storage";
import { fixedMainnetNodeConnection } from "../../../../../packages/wallet-shared/src/nodePresets";

import {
  applyNodeModeDefaults,
  createDefaultNodeConnectionSettings,
  deriveOptimizedGrpcEndpointFromDaemonAddress,
  fastReceiveScannerUrlForSettings,
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
    mockStoreDaemonPassword.mockClear();
    mockDeleteDaemonPassword.mockClear();
  });

  it("defaults to optimized Monero Fast Node gRPC ports", () => {
    const onion = fixedMainnetNodeConnection("tex8", "onion");
    expect(createDefaultNodeConnectionSettings("mainnet")).toEqual({
      mode: "optimized-grpc",
      network: "mainnet",
      daemon: {
        address: onion.daemonAddress,
        trusted: true,
        useSsl: false,
        username: "",
        password: "",
        proxyAddress: onion.proxyAddress,
      },
      grpcEndpoint: "xmr.tex8.com:18091",
    });

    expect(
      createDefaultNodeConnectionSettings("stagenet").grpcEndpoint,
    ).toBe("xmr.tex8.com:38091");
  });

  it("keeps original Monero RPC free of an MFN gRPC endpoint", () => {
    const original = createDefaultNodeConnectionSettings(
      "testnet",
      "original-rpc",
    );

    expect(original.mode).toBe("original-rpc");
    expect(original.daemon.address).toBe("xmr.tex8.com:28081");
    expect(original.daemon.proxyAddress).toBe("");
    expect(original.grpcEndpoint).toBe("");
  });

  it("migrates persisted VPN defaults to the fast wallet server domain", async () => {
    await AsyncStorage.setItem(
      NODE_CONNECTION_SETTINGS_STORAGE_KEY,
      JSON.stringify({
        mode: "optimized-grpc",
        network: "mainnet",
        daemon: {
          address: "10.0.0.1:18089",
          trusted: true,
          useSsl: false,
          username: "",
          proxyAddress: "",
        },
        grpcEndpoint: "10.0.0.1:18091",
      }),
    );

    const settings = await loadActiveNodeConnectionSettings();

    expect(settings.daemon.address).toBe(
      fixedMainnetNodeConnection("tex8", "onion").daemonAddress,
    );
    expect(settings.daemon.proxyAddress).toBe("127.0.0.1:9050");
    expect(settings.grpcEndpoint).toBe("xmr.tex8.com:18091");
  });

  it("migrates an old VPN monerod RPC port to the fast wallet daemon port", async () => {
    await AsyncStorage.setItem(
      NODE_CONNECTION_SETTINGS_STORAGE_KEY,
      JSON.stringify({
        mode: "optimized-grpc",
        network: "mainnet",
        daemon: {
          address: "192.168.0.1:18081",
          trusted: true,
          useSsl: false,
          username: "",
          proxyAddress: "",
        },
        grpcEndpoint: "192.168.0.1:18091",
      }),
    );

    const settings = await loadActiveNodeConnectionSettings();

    expect(settings.daemon.address).toBe(
      fixedMainnetNodeConnection("tex8", "onion").daemonAddress,
    );
    expect(settings.daemon.proxyAddress).toBe("127.0.0.1:9050");
    expect(settings.grpcEndpoint).toBe("xmr.tex8.com:18091");
  });

  it("migrates a previously persisted direct IP default to the fast wallet server domain", async () => {
    await AsyncStorage.setItem(
      NODE_CONNECTION_SETTINGS_STORAGE_KEY,
      JSON.stringify({
        mode: "optimized-grpc",
        network: "mainnet",
        daemon: {
          address: "152.53.133.188:18089",
          trusted: true,
          useSsl: false,
          username: "",
          proxyAddress: "",
        },
        grpcEndpoint: "152.53.133.188:18091",
      }),
    );

    const settings = await loadActiveNodeConnectionSettings();

    expect(settings.daemon.address).toBe(
      fixedMainnetNodeConnection("tex8", "onion").daemonAddress,
    );
    expect(settings.daemon.proxyAddress).toBe("127.0.0.1:9050");
    expect(settings.grpcEndpoint).toBe("xmr.tex8.com:18091");
  });

  it("removes gRPC when a draft requests original RPC", () => {
    const draft = nodeConnectionSettingsToDraft(
      createDefaultNodeConnectionSettings("mainnet"),
    );

    draft.mode = "original-rpc";
    draft.grpcEndpoint = "fast.example.test:18091";

    const settings = nodeConnectionDraftToSettings(draft);
    expect(settings.mode).toBe("original-rpc");
    expect(settings.grpcEndpoint).toBe("");
    expect(settings.daemon.proxyAddress).toBe("127.0.0.1:9050");
  });

  it("adds optimized Monero Fast Node ports when a bare host is saved", () => {
    const draft = nodeConnectionSettingsToDraft(
      createDefaultNodeConnectionSettings("mainnet"),
    );

    draft.daemonAddress = "xmr.tex8.com";
    draft.grpcEndpoint = "xmr.tex8.com";

    const settings = nodeConnectionDraftToSettings(draft);

    expect(settings.daemon.address).toBe("xmr.tex8.com:18089");
    expect(settings.grpcEndpoint).toBe("xmr.tex8.com:18091");
  });

  it("keeps a user supplied original Monero RPC endpoint", () => {
    const draft = nodeConnectionSettingsToDraft(
      createDefaultNodeConnectionSettings("mainnet", "original-rpc"),
    );

    draft.daemonAddress = "node.example.test";

    const settings = nodeConnectionDraftToSettings(draft);

    expect(settings.mode).toBe("original-rpc");
    expect(settings.daemon.address).toBe("node.example.test:18081");
    expect(settings.grpcEndpoint).toBe("");
  });

  it("derives the optimized gRPC endpoint from the daemon host", () => {
    expect(
      deriveOptimizedGrpcEndpointFromDaemonAddress(
        "xmr.tex8.com:18089",
        "mainnet",
      ),
    ).toBe("xmr.tex8.com:18091");

    expect(
      deriveOptimizedGrpcEndpointFromDaemonAddress("fast.tex8.test", "testnet"),
    ).toBe("fast.tex8.test:28091");
  });

  it("preserves custom endpoints when switching to custom mode", () => {
    const draft = nodeConnectionSettingsToDraft(
      createDefaultNodeConnectionSettings("mainnet"),
    );
    draft.daemonAddress = "node.example.test:18089";
    draft.grpcEndpoint = "fast.example.test:18091";

    const custom = applyNodeModeDefaults(draft, "custom");

    expect(custom.daemonAddress).toBe("node.example.test:18089");
    expect(custom.grpcEndpoint).toBe("");
  });

  it("derives the fast receive scanner URL from the active fast wallet endpoint", () => {
    const expectedScannerUrl =
      "http://fastrelayrpcf3hbc4qvykjgbpwpmcuq5dpcsdxoe7gwfh2zxdib3eid.onion";

    expect(
      fastReceiveScannerUrlForSettings({
        mode: "optimized-grpc",
        network: "mainnet",
        daemon: {
          address: "152.53.133.188:18089",
          trusted: true,
        },
        grpcEndpoint: "152.53.133.188:18091",
      }),
    ).toBe(expectedScannerUrl);

    expect(
      fastReceiveScannerUrlForSettings({
        mode: "custom",
        network: "mainnet",
        daemon: {
          address: "127.0.0.1:18089",
          trusted: true,
        },
        grpcEndpoint: "127.0.0.1:8087",
      }),
    ).toBeUndefined();

    expect(
      fastReceiveScannerUrlForSettings({
        mode: "optimized-grpc",
        network: "mainnet",
        daemon: {
          address: "152.53.133.188:18089",
          trusted: true,
        },
        grpcEndpoint: "https://xmr.tex8.com",
      }),
    ).toBe(expectedScannerUrl);

    expect(
      fastReceiveScannerUrlForSettings({
        mode: "optimized-grpc",
        network: "mainnet",
        daemon: {
          address: "152.53.133.188:18089",
          trusted: true,
        },
        grpcEndpoint: "https://xmr.tex8.com:18091/",
      }),
    ).toBe(expectedScannerUrl);

    expect(
      fastReceiveScannerUrlForSettings({
        mode: "optimized-grpc",
        network: "mainnet",
        daemon: {
          address: "152.53.133.188:18089",
          trusted: true,
        },
        grpcEndpoint: "https://xmr.tex8.com/scanner?tenant=wallet",
      }),
    ).toBe(expectedScannerUrl);
  });

  it("persists node settings without the daemon password", async () => {
    const settings = nodeConnectionDraftToSettings({
      mode: "optimized-grpc",
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
    expect(mockStoreDaemonPassword).toHaveBeenCalledWith("wallet-password");
    expect(JSON.parse(persisted ?? "{}")).toEqual({
      mode: "optimized-grpc",
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
