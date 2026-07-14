import React from "react";
import ReactTestRenderer from "react-test-renderer";
import { TextInput } from "react-native";

import { LanguageProvider } from "../../i18n";
import SettingsScreen from "../SettingsScreen";

jest.mock("@react-native-async-storage/async-storage", () => {
  const storage = new Map<string, string>();

  return {
    __esModule: true,
    default: {
      clear: jest.fn(async () => {
        storage.clear();
      }),
      getItem: jest.fn(async (key: string) => storage.get(key) ?? null),
      setItem: jest.fn(async (key: string, value: string) => {
        storage.set(key, value);
      }),
    },
  };
});

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }),
}));

jest.mock("../../services/NativeMoneroWallet", () => ({
  requireNativeMoneroWallet: () => ({
    deleteSecret: jest.fn(async () => undefined),
    storeSecret: jest.fn(async () => undefined),
  }),
}));

jest.mock("../../services/WalletDiagnostics", () => ({
  runWalletDiagnostics: jest.fn(async () => ({
    daemon: {
      getInfo: { ok: true, height: 1 },
      jsonRpcGetInfo: { ok: true, height: 1 },
    },
    ledgerTransport: undefined,
    native: { linkedWithMonero: true },
    settings: undefined,
    wallet: undefined,
  })),
}));

jest.mock("../../services/WalletService", () => ({
  walletService: {
    applyNodeConnectionToActive: jest.fn(async () => true),
    refreshFastReceiveRegistrationStatusesForSettings: jest.fn(
      async () => undefined,
    ),
  },
}));

describe("SettingsScreen", () => {
  it("shows editable Tex8 daemon and gRPC endpoint fields", async () => {
    let renderer: ReactTestRenderer.ReactTestRenderer | undefined;

    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(
        <LanguageProvider>
          <SettingsScreen />
        </LanguageProvider>,
      );
    });

    const placeholders = renderer!.root
      .findAllByType(TextInput)
      .map(input => input.props.placeholder);

    expect(placeholders).toContain("xmr.tex8.com:18089");
    expect(placeholders).toContain("xmr.tex8.com:18091");
  });
});
