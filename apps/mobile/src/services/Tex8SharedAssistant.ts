import type { AppControlCommand } from "../../../../../tex8/products/mobile-platform/shared-app/src/core/chat/appControlCommands";
import {
  extractAppControlCommandsFromPayload,
  parseAssistantControlPayload,
} from "../../../../../tex8/products/mobile-platform/shared-app/src/core/chat/appControlCommands";

export const TEX8_SHARED_APP_CONTROL_SOURCE =
  "$HOME/Documents/Projects/tex8/products/mobile-platform/shared-app/src/core/chat/appControlCommands.ts";

export type MoneroSharedElementType =
  | "monero_wallet"
  | "monero_send"
  | "monero_receive"
  | "monero_ledger"
  | "monero_hosted_scan"
  | "monero_privacy"
  | "monero_community";

export interface MoneroSharedElement {
  type: MoneroSharedElementType;
  label: string;
  description: string;
  route: string;
  enabled: boolean;
}

export interface Tex8AssistantContext {
  walletStatus: string;
  walletName?: string;
  network?: string;
  hasOpenWallet: boolean;
  primaryAddress?: string;
  balanceXmr?: string;
  unlockedBalanceXmr?: string;
  hardwareDeviceName?: string;
  hardwareConnected?: boolean;
  fastReceiveCount: number;
  enabledFastReceiveCount: number;
  nodeMode?: string;
  daemonAddress?: string;
  grpcEndpoint?: string;
}

export interface Tex8AssistantReply {
  text: string;
  commands: AppControlCommand[];
  source: "tex8-shared-app-control" | "monero-local-assistant";
}

export const MONERO_SHARED_ELEMENTS: MoneroSharedElement[] = [
  {
    type: "monero_wallet",
    label: "Wallet",
    description: "Balance, sync status, native wallet core, and Cuprate node mode.",
    route: "Home",
    enabled: true,
  },
  {
    type: "monero_send",
    label: "Send",
    description: "Two-step prepare and commit flow through the native wallet core.",
    route: "Send",
    enabled: true,
  },
  {
    type: "monero_receive",
    label: "Receive",
    description: "Primary address, QR view, copy/share, and Ledger address confirmation.",
    route: "Receive",
    enabled: true,
  },
  {
    type: "monero_ledger",
    label: "Ledger Nano",
    description: "Shared hardware wallet contract for transport, reconnect, and show-address.",
    route: "WalletSetup",
    enabled: true,
  },
  {
    type: "monero_hosted_scan",
    label: "Hosted Scan",
    description: "Opt-in fast receive identity for server-side notifications without spend keys.",
    route: "Settings",
    enabled: true,
  },
  {
    type: "monero_privacy",
    label: "Privacy",
    description: "Native secret boundary, local spend authority, and hosted-view-key guardrails.",
    route: "Settings",
    enabled: true,
  },
  {
    type: "monero_community",
    label: "Monero Enthusiasts",
    description: "Opt-in discovery using only an approximate area for private conversations and meetups.",
    route: "FindEnthusiasts",
    enabled: true,
  },
];

export function createTex8SharedManifestSnapshot() {
  return {
    contractVersion: "mobile-app-control.v1",
    sourceFile: TEX8_SHARED_APP_CONTROL_SOURCE,
    screens: [
      "Home",
      "Send",
      "Receive",
      "Settings",
      "WalletSetup",
      "FindEnthusiasts",
      "Tex8Assistant",
    ],
    elements: MONERO_SHARED_ELEMENTS.map(element => ({
      type: element.type,
      label: element.label,
      description: element.description,
    })),
  };
}

export function parseTex8AssistantPayload(
  text: string,
): Tex8AssistantReply | null {
  const parsed = parseAssistantControlPayload(text);
  if (!parsed) {
    return null;
  }

  return {
    text: parsed.message,
    commands: parsed.commands,
    source: "tex8-shared-app-control",
  };
}

export function extractTex8CommandsFromPayload(
  payload: unknown,
): AppControlCommand[] {
  return extractAppControlCommandsFromPayload(payload);
}

export function createMoneroAssistantReply(
  input: string,
  context: Tex8AssistantContext,
): Tex8AssistantReply {
  const sharedPayload = parseTex8AssistantPayload(input);
  if (sharedPayload) {
    return {
      ...sharedPayload,
      text:
        sharedPayload.text ||
        "I received a Tex8 shared app-control command and can route it inside the wallet.",
    };
  }

  const normalized = normalize(input);
  if (matches(normalized, ["ledger", "nano", "hardware", "device"])) {
    const connected = context.hardwareConnected
      ? "The current hardware wallet session reports a connected Ledger."
      : "Connect and unlock the Ledger Nano, open the Monero app on the device, then start the Ledger setup or reconnect flow.";
    return localReply(
      `${connected} Signing authority stays on the Ledger; React Native only receives sanitized status, prompt, address, and transaction DTOs.`,
      "monero_ledger",
    );
  }

  if (
    matches(normalized, [
      "hosted",
      "view key",
      "viewkey",
      "private view",
      "fast receive",
      "scanner",
      "notification",
    ])
  ) {
    return localReply(
      `Hosted scan is opt-in. The app creates a separate fast receive identity for notification scanning; the main wallet and every private spend key remain local. Local identities: ${context.fastReceiveCount}, enabled for scanner: ${context.enabledFastReceiveCount}.`,
      "monero_hosted_scan",
    );
  }

  if (matches(normalized, ["cuprate", "grpc", "node", "sync", "daemon"])) {
    const grpc = context.grpcEndpoint ? ` gRPC: ${context.grpcEndpoint}.` : "";
    return localReply(
      `The wallet can use optimized Cuprate gRPC or original daemon RPC through the same native wallet core. Current mode: ${context.nodeMode || "unknown"}; daemon: ${context.daemonAddress || "not configured"}.${grpc}`,
      "monero_wallet",
    );
  }

  if (matches(normalized, ["send", "pay", "zahlung", "transfer"])) {
    return localReply(
      context.hasOpenWallet
        ? `Send is wired through native prepareTransaction and commitTransaction. Available balance shown by the wallet: ${context.unlockedBalanceXmr || "unknown"} XMR.`
        : "Open or create a wallet first, then the Send screen can prepare and review a native Monero transaction.",
      "monero_send",
    );
  }

  if (matches(normalized, ["receive", "address", "qr", "empfangen"])) {
    return localReply(
      context.primaryAddress
        ? `Receive is ready. The current primary address ends with ${context.primaryAddress.slice(-6)} and can be copied, shared, or confirmed on Ledger.`
        : "Open or create a wallet first, then Receive can show the address, QR, and Ledger confirmation action.",
      "monero_receive",
    );
  }

  if (matches(normalized, ["privacy", "private", "key", "seed", "spend"])) {
    return localReply(
      "Privacy boundary: seed words, wallet files, private spend keys, and the main wallet private view key stay native/local. The server scanner may only receive an opt-in fast receive identity, never spend authority.",
      "monero_privacy",
    );
  }

  if (
    matches(normalized, [
      "enthusiast",
      "community",
      "nearby",
      "meet",
      "treffen",
      "umgebung",
    ])
  ) {
    return localReply(
      "Nearby discovery is optional and uses only an approximate area. Exact location and wallet addresses are not part of the public profile.",
      "monero_community",
    );
  }

  return {
    text:
      `I can route Tex8 shared wallet elements for Wallet, Send, Receive, Ledger Nano, Hosted Scan, Privacy, and Monero Enthusiasts. Current wallet status: ${context.walletStatus}; network: ${context.network || "unknown"}.`,
    commands: [],
    source: "monero-local-assistant",
  };
}

function localReply(
  text: string,
  elementType: MoneroSharedElementType,
): Tex8AssistantReply {
  return {
    text,
    commands: [
      {
        type: "open_element",
        elementType,
        target: elementType,
      } as AppControlCommand,
    ],
    source: "monero-local-assistant",
  };
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ß/g, "ss");
}

function matches(value: string, terms: string[]): boolean {
  return terms.some(term => value.includes(term));
}
