import {
  MONERO_SHARED_ELEMENTS,
  createMoneroAssistantReply,
  createTex8SharedManifestSnapshot,
  parseTex8AssistantPayload,
} from "../Tex8SharedAssistant";
import type { Tex8AssistantContext } from "../Tex8SharedAssistant";

const context: Tex8AssistantContext = {
  walletStatus: "open",
  walletName: "Main",
  network: "stagenet",
  hasOpenWallet: true,
  primaryAddress: "84testaddress1234567890",
  balanceXmr: "1.000000",
  unlockedBalanceXmr: "0.900000",
  hardwareDeviceName: "Ledger",
  hardwareConnected: false,
  fastReceiveCount: 1,
  enabledFastReceiveCount: 0,
  nodeMode: "optimized-grpc",
  daemonAddress: "https://node.example",
  grpcEndpoint: "https://grpc.example",
};

describe("Tex8SharedAssistant", () => {
  it("exposes the Monero shared app-control elements", () => {
    const manifest = createTex8SharedManifestSnapshot();
    const elementTypes = manifest.elements.map(element => element.type);

    expect(elementTypes).toEqual(
      expect.arrayContaining([
        "monero_wallet",
        "monero_send",
        "monero_receive",
        "monero_ledger",
        "monero_hosted_scan",
        "monero_privacy",
        "monero_community",
      ]),
    );
    expect(MONERO_SHARED_ELEMENTS).toHaveLength(7);
    expect(manifest.screens).not.toContain("Marketplace");
  });

  it("parses Tex8 shared assistant control payloads", () => {
    const parsed = parseTex8AssistantPayload(
      JSON.stringify({
        message: "Open Ledger setup",
        commands: [{ type: "open_element", target: "monero_ledger" }],
      }),
    );

    expect(parsed?.source).toBe("tex8-shared-app-control");
    expect(parsed?.commands[0]).toMatchObject({
      type: "open_element",
      elementType: "monero_ledger",
    });
  });

  it("answers hosted scan questions with the hosted view-key guardrail", () => {
    const reply = createMoneroAssistantReply(
      "How does hosted private view key scanning work?",
      context,
    );

    expect(reply.text).toContain("separate fast receive identity");
    expect(reply.text).toContain("private spend key");
    expect(reply.commands[0]).toMatchObject({
      type: "open_element",
      elementType: "monero_hosted_scan",
    });
  });
});
