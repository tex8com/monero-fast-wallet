import AsyncStorage from "@react-native-async-storage/async-storage";

import { requireNativeMoneroWallet } from "./NativeMoneroWallet";
import type { DaemonConfig, MoneroNetwork } from "./NativeMoneroWallet";

export type NodeConnectionMode = "optimized-grpc" | "original-rpc" | "custom";

export interface NodeConnectionSettings {
  mode: NodeConnectionMode;
  network: MoneroNetwork;
  daemon: DaemonConfig;
  grpcEndpoint: string;
}

export interface NodeConnectionDraft {
  mode: NodeConnectionMode;
  network: MoneroNetwork;
  daemonAddress: string;
  grpcEndpoint: string;
  trusted: boolean;
  useSsl: boolean;
  username: string;
  password: string;
  passwordStored: boolean;
  proxyAddress: string;
}

const CUPRATE_DEFAULT_HOST = "152.53.133.188";
const LEGACY_CUPRATE_DEFAULT_HOSTS = ["private-node-ip", "private-node-ip"];
const LEGACY_MONEROD_RPC_PORT_BY_CUPRATE_PORT: Record<string, string> = {
  "18089": "18081",
  "28089": "28081",
  "38089": "38081",
};
export const NODE_CONNECTION_SETTINGS_STORAGE_KEY =
  "monero-fast-wallet.node-connection.v1";
export const NODE_DAEMON_PASSWORD_SECRET_KEY =
  "monero-fast-wallet.node-connection.daemon-password.v1";

const DAEMON_PORTS: Record<MoneroNetwork, number> = {
  mainnet: 18089,
  testnet: 28089,
  stagenet: 38089,
};

const CUPRATE_GRPC_PORTS: Record<MoneroNetwork, number> = {
  mainnet: 18091,
  testnet: 28091,
  stagenet: 38091,
};

let activeSettings = createDefaultNodeConnectionSettings("mainnet");
let activeSettingsLoaded = false;
let activeSettingsLoadPromise: Promise<NodeConnectionSettings> | undefined;
let activeSettingsRevision = 0;

export function createDefaultNodeConnectionSettings(
  network: MoneroNetwork,
  mode: NodeConnectionMode = "optimized-grpc",
): NodeConnectionSettings {
  const daemonAddress = `${CUPRATE_DEFAULT_HOST}:${DAEMON_PORTS[network]}`;
  const grpcEndpoint =
    mode === "original-rpc"
      ? ""
      : `${CUPRATE_DEFAULT_HOST}:${CUPRATE_GRPC_PORTS[network]}`;

  return {
    mode,
    network,
    daemon: {
      address: daemonAddress,
      trusted: true,
      useSsl: false,
      username: "",
      password: "",
      proxyAddress: "",
    },
    grpcEndpoint,
  };
}

export function getActiveNodeConnectionSettings(
  network?: MoneroNetwork,
): NodeConnectionSettings {
  if (!network || activeSettings.network === network) {
    return cloneNodeConnectionSettings(activeSettings);
  }

  return createDefaultNodeConnectionSettings(network);
}

export function setActiveNodeConnectionSettings(
  settings: NodeConnectionSettings,
): NodeConnectionSettings {
  activeSettings = normalizeNodeConnectionSettings(settings);
  activeSettingsLoaded = true;
  activeSettingsRevision += 1;
  return cloneNodeConnectionSettings(activeSettings);
}

export async function loadActiveNodeConnectionSettings(
  network?: MoneroNetwork,
): Promise<NodeConnectionSettings> {
  await loadPersistedNodeConnectionSettings();
  return getActiveNodeConnectionSettings(network);
}

export async function saveActiveNodeConnectionSettings(
  settings: NodeConnectionSettings,
): Promise<NodeConnectionSettings> {
  const saved = await prepareSettingsForSave(settings);
  setActiveNodeConnectionSettings(saved);
  await AsyncStorage.setItem(
    NODE_CONNECTION_SETTINGS_STORAGE_KEY,
    JSON.stringify(toPersistedSettings(saved)),
  );
  return saved;
}

export function nodeConnectionSettingsToDraft(
  settings: NodeConnectionSettings,
): NodeConnectionDraft {
  return {
    mode: settings.mode,
    network: settings.network,
    daemonAddress: settings.daemon.address,
    grpcEndpoint: settings.grpcEndpoint,
    trusted: settings.daemon.trusted,
    useSsl: settings.daemon.useSsl ?? false,
    username: settings.daemon.username ?? "",
    password: "",
    passwordStored: Boolean(settings.daemon.passwordSecretKey),
    proxyAddress: settings.daemon.proxyAddress ?? "",
  };
}

export function nodeConnectionDraftToSettings(
  draft: NodeConnectionDraft,
): NodeConnectionSettings {
  return normalizeNodeConnectionSettings({
    mode: draft.mode,
    network: draft.network,
    daemon: {
      address: draft.daemonAddress,
      trusted: draft.trusted,
      useSsl: draft.useSsl,
      username: draft.username,
      password: draft.password,
      passwordSecretKey:
        draft.mode === "custom" && (draft.password.length > 0 || draft.passwordStored)
          ? NODE_DAEMON_PASSWORD_SECRET_KEY
          : undefined,
      proxyAddress: draft.proxyAddress,
    },
    grpcEndpoint:
      draft.mode === "original-rpc" ? "" : draft.grpcEndpoint,
  });
}

export function normalizeNodeConnectionSettings(
  settings: NodeConnectionSettings,
): NodeConnectionSettings {
  const daemon = settings.daemon;

  return {
    mode: settings.mode,
    network: settings.network,
    daemon: {
      address: daemon.address.trim(),
      trusted: daemon.trusted,
      useSsl: daemon.useSsl ?? false,
      username: (daemon.username ?? "").trim(),
      password: daemon.password ?? "",
      passwordSecretKey: normalizeSecretKey(daemon.passwordSecretKey),
      proxyAddress: (daemon.proxyAddress ?? "").trim(),
    },
    grpcEndpoint:
      settings.mode === "original-rpc" ? "" : settings.grpcEndpoint.trim(),
  };
}

export function applyNodeModeDefaults(
  draft: NodeConnectionDraft,
  mode: NodeConnectionMode,
): NodeConnectionDraft {
  if (mode === "custom") {
    return {
      ...draft,
      mode,
    };
  }

  return nodeConnectionSettingsToDraft(
    createDefaultNodeConnectionSettings(draft.network, mode),
  );
}

export function applyNodeNetworkDefaults(
  draft: NodeConnectionDraft,
  network: MoneroNetwork,
): NodeConnectionDraft {
  if (draft.mode === "custom") {
    return {
      ...draft,
      network,
    };
  }

  return nodeConnectionSettingsToDraft(
    createDefaultNodeConnectionSettings(network, draft.mode),
  );
}

function cloneNodeConnectionSettings(
  settings: NodeConnectionSettings,
): NodeConnectionSettings {
  return {
    ...settings,
    daemon: {
      ...settings.daemon,
    },
  };
}

function toPersistedSettings(settings: NodeConnectionSettings) {
  const normalized = normalizeNodeConnectionSettings(settings);
  const passwordSecretKey = normalizeSecretKey(
    normalized.daemon.passwordSecretKey,
  );

  return {
    mode: normalized.mode,
    network: normalized.network,
    daemon: {
      address: normalized.daemon.address,
      trusted: normalized.daemon.trusted,
      useSsl: normalized.daemon.useSsl ?? false,
      username: normalized.daemon.username ?? "",
      ...(passwordSecretKey ? { passwordSecretKey } : {}),
      proxyAddress: normalized.daemon.proxyAddress ?? "",
    },
    grpcEndpoint: normalized.grpcEndpoint,
  };
}

async function loadPersistedNodeConnectionSettings(): Promise<NodeConnectionSettings> {
  if (activeSettingsLoaded) {
    return cloneNodeConnectionSettings(activeSettings);
  }

  if (!activeSettingsLoadPromise) {
    const loadRevision = activeSettingsRevision;
    activeSettingsLoadPromise = AsyncStorage.getItem(
      NODE_CONNECTION_SETTINGS_STORAGE_KEY,
    )
      .then(value => {
        const parsed = parsePersistedSettings(value);
        if (parsed && loadRevision === activeSettingsRevision) {
          activeSettings = parsed;
        }
        activeSettingsLoaded = true;
        return cloneNodeConnectionSettings(activeSettings);
      })
      .catch(() => {
        activeSettingsLoaded = true;
        return cloneNodeConnectionSettings(activeSettings);
      })
      .finally(() => {
        activeSettingsLoadPromise = undefined;
      });
  }

  return activeSettingsLoadPromise;
}

function parsePersistedSettings(
  value: string | null,
): NodeConnectionSettings | undefined {
  if (!value) {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed)) {
      return undefined;
    }

    const mode = parseMode(parsed.mode);
    const network = parseNetwork(parsed.network);
    if (!mode || !network || !isRecord(parsed.daemon)) {
      return undefined;
    }

    const defaults = createDefaultNodeConnectionSettings(network, mode);
    const daemonAddress = parseString(
      parsed.daemon.address,
      defaults.daemon.address,
    );
    const grpcEndpoint =
      mode === "original-rpc"
        ? ""
        : parseString(parsed.grpcEndpoint, defaults.grpcEndpoint);

    return normalizeNodeConnectionSettings({
      mode,
      network,
      daemon: {
        ...defaults.daemon,
        address: migrateLegacyDefaultEndpoint(
          daemonAddress,
          defaults.daemon.address,
        ),
        trusted: parseBoolean(
          parsed.daemon.trusted,
          defaults.daemon.trusted,
        ),
        useSsl: parseBoolean(
          parsed.daemon.useSsl,
          defaults.daemon.useSsl ?? false,
        ),
        username: parseString(parsed.daemon.username, ""),
        password: "",
        passwordSecretKey: parseSecretKey(parsed.daemon.passwordSecretKey),
        proxyAddress: parseString(parsed.daemon.proxyAddress, ""),
      },
      grpcEndpoint:
        mode === "original-rpc"
          ? ""
          : migrateLegacyDefaultEndpoint(grpcEndpoint, defaults.grpcEndpoint),
    });
  } catch {
    return undefined;
  }
}

function migrateLegacyDefaultEndpoint(
  endpoint: string,
  defaultEndpoint: string,
): string {
  const [host, port] = endpoint.split(":");
  const [, defaultPort] = defaultEndpoint.split(":");
  const legacyRpcPort = LEGACY_MONEROD_RPC_PORT_BY_CUPRATE_PORT[defaultPort];
  if (
    LEGACY_CUPRATE_DEFAULT_HOSTS.includes(host) &&
    (port === defaultPort || port === legacyRpcPort)
  ) {
    return defaultEndpoint;
  }

  return endpoint;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseMode(value: unknown): NodeConnectionMode | undefined {
  if (
    value === "optimized-grpc" ||
    value === "original-rpc" ||
    value === "custom"
  ) {
    return value;
  }

  return undefined;
}

function parseNetwork(value: unknown): MoneroNetwork | undefined {
  if (value === "mainnet" || value === "testnet" || value === "stagenet") {
    return value;
  }

  return undefined;
}

function parseString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function parseBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

async function prepareSettingsForSave(
  settings: NodeConnectionSettings,
): Promise<NodeConnectionSettings> {
  const normalized = normalizeNodeConnectionSettings(settings);
  const password = normalized.daemon.password ?? "";
  const existingSecretKey = activeSettings.daemon.passwordSecretKey;
  const wantsStoredPassword =
    normalized.daemon.passwordSecretKey === NODE_DAEMON_PASSWORD_SECRET_KEY;

  if (password.length > 0) {
    await requireNativeMoneroWallet().storeSecret(
      NODE_DAEMON_PASSWORD_SECRET_KEY,
      password,
    );
    return withDaemonPasswordSecretKey(
      normalized,
      NODE_DAEMON_PASSWORD_SECRET_KEY,
    );
  }

  if (wantsStoredPassword) {
    return withDaemonPasswordSecretKey(
      normalized,
      NODE_DAEMON_PASSWORD_SECRET_KEY,
    );
  }

  if (existingSecretKey === NODE_DAEMON_PASSWORD_SECRET_KEY) {
    await requireNativeMoneroWallet().deleteSecret(
      NODE_DAEMON_PASSWORD_SECRET_KEY,
    );
  }

  return withDaemonPasswordSecretKey(normalized, undefined);
}

function withDaemonPasswordSecretKey(
  settings: NodeConnectionSettings,
  passwordSecretKey: string | undefined,
): NodeConnectionSettings {
  return normalizeNodeConnectionSettings({
    ...settings,
    daemon: {
      ...settings.daemon,
      password: "",
      passwordSecretKey,
    },
  });
}

function normalizeSecretKey(value: string | undefined): string | undefined {
  return value === NODE_DAEMON_PASSWORD_SECRET_KEY ? value : undefined;
}

function parseSecretKey(value: unknown): string | undefined {
  return typeof value === "string" ? normalizeSecretKey(value) : undefined;
}
