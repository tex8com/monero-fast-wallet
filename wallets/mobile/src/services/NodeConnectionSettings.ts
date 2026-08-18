import { requireNativeMoneroWallet } from './NativeMoneroWallet';
import type { DaemonConfig, MoneroNetwork } from './NativeMoneroWallet';
import { NativeModules } from 'react-native';
import {
  loadProtectedMetadata,
  storeProtectedMetadata,
} from './ProtectedMetadataStorage';
import {
  fixedMainnetNodeConnection,
  PRIMARY_PRIVATE_SERVICE_ORIGIN,
} from '../../../../packages/wallet-shared/src/nodePresets';
export type NodeConnectionMode = 'optimized-grpc' | 'original-rpc' | 'custom';

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

const MFN_DEFAULT_HOST = 'xmr.tex8.com';
const MFN_SCANNER_DEFAULT_ORIGIN = PRIMARY_PRIVATE_SERVICE_ORIGIN;
const LEGACY_MFN_DEFAULT_HOSTS = [
  '152.53.133.188',
  'private-node-ip',
  'private-node-ip',
];
const LEGACY_MONEROD_RPC_PORT_BY_MFN_PORT: Record<string, string> = {
  '18089': '18081',
  '28089': '28081',
  '38089': '38081',
};
export const NODE_CONNECTION_SETTINGS_STORAGE_KEY =
  'monero-fast-wallet.node-connection.v1';
export const NODE_DAEMON_PASSWORD_SECRET_KEY =
  'monero-fast-wallet.node-connection.daemon-password.v1';

const DAEMON_PORTS: Record<MoneroNetwork, number> = {
  mainnet: 18089,
  testnet: 28089,
  stagenet: 38089,
};

const ORIGINAL_RPC_PORTS: Record<MoneroNetwork, number> = {
  mainnet: 18081,
  testnet: 28081,
  stagenet: 38081,
};

const MFN_GRPC_PORTS: Record<MoneroNetwork, number> = {
  mainnet: 18091,
  testnet: 28091,
  stagenet: 38091,
};

let activeSettings = createDefaultNodeConnectionSettings('mainnet');
let activeSettingsLoaded = false;
let activeSettingsLoadPromise: Promise<NodeConnectionSettings> | undefined;
let activeSettingsRevision = 0;

export function createDefaultNodeConnectionSettings(
  network: MoneroNetwork,
  _mode: NodeConnectionMode = 'optimized-grpc',
): NodeConnectionSettings {
  const mode: NodeConnectionMode = 'optimized-grpc';
  const mainnetClearnet =
    network === 'mainnet'
      ? fixedMainnetNodeConnection('tex8', 'clearnet')
      : undefined;
  const mainnetOnion = mainnetClearnet
    ? fixedMainnetNodeConnection('tex8', 'onion')
    : undefined;
  const daemonAddress =
    mainnetOnion?.daemonAddress ??
    `${MFN_DEFAULT_HOST}:${defaultDaemonPortForMode(network, mode)}`;
  const grpcEndpoint =
    mainnetClearnet?.grpcEndpoint ??
    `${MFN_DEFAULT_HOST}:${MFN_GRPC_PORTS[network]}`;

  return {
    mode,
    network,
    daemon: {
      address: daemonAddress,
      trusted: true,
      useSsl: false,
      username: '',
      password: '',
      proxyAddress: mainnetOnion?.proxyAddress ?? '127.0.0.1:9050',
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
  await storeProtectedMetadata(
    NODE_CONNECTION_SETTINGS_STORAGE_KEY,
    JSON.stringify(toPersistedSettings(saved)),
  );
  const connectivity = NativeModules.EmbeddedTor as
    | {
        configureConnectivity?(
          torEndpoint: string,
          clearnetEndpoint: string,
        ): Promise<void>;
      }
    | undefined;
  await connectivity?.configureConnectivity?.(
    saved.daemon.address,
    saved.grpcEndpoint,
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
    username: settings.daemon.username ?? '',
    password: '',
    passwordStored: Boolean(settings.daemon.passwordSecretKey),
    proxyAddress: settings.daemon.proxyAddress ?? '',
  };
}

export function nodeConnectionDraftToSettings(
  draft: NodeConnectionDraft,
): NodeConnectionSettings {
  return normalizeNodeConnectionSettings({
    mode: 'optimized-grpc',
    network: draft.network,
    daemon: {
      address: draft.daemonAddress,
      trusted: draft.trusted,
      useSsl: draft.useSsl,
      username: draft.username,
      password: draft.password,
      passwordSecretKey:
        draft.password.length > 0 || draft.passwordStored
          ? NODE_DAEMON_PASSWORD_SECRET_KEY
          : undefined,
      proxyAddress: '127.0.0.1:9050',
    },
    grpcEndpoint: draft.grpcEndpoint,
  });
}

export function normalizeNodeConnectionSettings(
  settings: NodeConnectionSettings,
): NodeConnectionSettings {
  const daemon = settings.daemon;
  const mode: NodeConnectionMode = 'optimized-grpc';
  const daemonPort = defaultDaemonPortForMode(settings.network, mode);
  const defaults = createDefaultNodeConnectionSettings(settings.network, mode);

  return {
    mode,
    network: settings.network,
    daemon: {
      address: normalizeEndpointWithDefaultPort(daemon.address, daemonPort),
      trusted: daemon.trusted,
      useSsl: daemon.useSsl ?? false,
      username: (daemon.username ?? '').trim(),
      password: daemon.password ?? '',
      passwordSecretKey: normalizeSecretKey(daemon.passwordSecretKey),
      proxyAddress: '127.0.0.1:9050',
    },
    grpcEndpoint: normalizeEndpointWithDefaultPort(
      settings.grpcEndpoint || defaults.grpcEndpoint,
      MFN_GRPC_PORTS[settings.network],
    ),
  };
}

export function deriveOptimizedGrpcEndpointFromDaemonAddress(
  daemonAddress: string,
  network: MoneroNetwork,
): string {
  const host = extractEndpointHost(daemonAddress);
  return host ? `${host}:${MFN_GRPC_PORTS[network]}` : '';
}

export function applyNodeModeDefaults(
  draft: NodeConnectionDraft,
  mode: NodeConnectionMode,
): NodeConnectionDraft {
  if (mode === 'custom') {
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
  if (draft.mode === 'custom') {
    return {
      ...draft,
      network,
    };
  }

  return nodeConnectionSettingsToDraft(
    createDefaultNodeConnectionSettings(network, draft.mode),
  );
}

export function fastReceiveScannerUrlForSettings(
  settings: NodeConnectionSettings,
): string | undefined {
  if (settings.mode === 'original-rpc') {
    return undefined;
  }

  const endpoint = settings.grpcEndpoint || settings.daemon.address;
  const trimmed = endpoint.trim().replace(/\/+$/g, '');
  if (!trimmed) {
    return undefined;
  }

  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      return `${url.protocol}//${url.host}`;
    } catch {
      return trimmed;
    }
  }

  const host = stripKnownMfnPort(trimmed);
  if (
    host === MFN_DEFAULT_HOST ||
    LEGACY_MFN_DEFAULT_HOSTS.includes(host)
  ) {
    return MFN_SCANNER_DEFAULT_ORIGIN;
  }

  return `https://${host}`;
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
      username: normalized.daemon.username ?? '',
      ...(passwordSecretKey ? { passwordSecretKey } : {}),
      proxyAddress: normalized.daemon.proxyAddress ?? '',
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
    activeSettingsLoadPromise = loadProtectedMetadata(
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
      mode === 'original-rpc'
        ? ''
        : parseString(parsed.grpcEndpoint, defaults.grpcEndpoint);
    const migratedDaemonAddress = migrateLegacyDefaultEndpoint(
      daemonAddress,
      defaults.daemon.address,
    );
    const migratedGrpcEndpoint =
      mode === 'original-rpc'
        ? ''
        : migrateLegacyDefaultEndpoint(grpcEndpoint, defaults.grpcEndpoint);
    const persistedProxyAddress = parseString(parsed.daemon.proxyAddress, '');
    const proxyAddress =
      mode === 'optimized-grpc' &&
      network === 'mainnet' &&
      migratedDaemonAddress === defaults.daemon.address &&
      migratedGrpcEndpoint === defaults.grpcEndpoint &&
      persistedProxyAddress.length === 0
        ? defaults.daemon.proxyAddress ?? ''
        : persistedProxyAddress;

    return normalizeNodeConnectionSettings({
      mode,
      network,
      daemon: {
        ...defaults.daemon,
        address: migratedDaemonAddress,
        trusted: parseBoolean(parsed.daemon.trusted, defaults.daemon.trusted),
        useSsl: parseBoolean(
          parsed.daemon.useSsl,
          defaults.daemon.useSsl ?? false,
        ),
        username: parseString(parsed.daemon.username, ''),
        password: '',
        passwordSecretKey: parseSecretKey(parsed.daemon.passwordSecretKey),
        proxyAddress,
      },
      grpcEndpoint: migratedGrpcEndpoint,
    });
  } catch {
    return undefined;
  }
}

function migrateLegacyDefaultEndpoint(
  endpoint: string,
  defaultEndpoint: string,
): string {
  const [host, port] = endpoint.split(':');
  const [defaultHost, defaultPort] = defaultEndpoint.split(':');
  const legacyRpcPort = LEGACY_MONEROD_RPC_PORT_BY_MFN_PORT[defaultPort];
  if (
    host === MFN_DEFAULT_HOST &&
    defaultHost !== MFN_DEFAULT_HOST &&
    (port === defaultPort || port === legacyRpcPort)
  ) {
    return defaultEndpoint;
  }
  if (
    LEGACY_MFN_DEFAULT_HOSTS.includes(host) &&
    (port === defaultPort || port === legacyRpcPort)
  ) {
    return defaultEndpoint;
  }

  return endpoint;
}

function defaultDaemonPortForMode(
  network: MoneroNetwork,
  mode: NodeConnectionMode,
): number {
  return mode === 'original-rpc'
    ? ORIGINAL_RPC_PORTS[network]
    : DAEMON_PORTS[network];
}

function normalizeEndpointWithDefaultPort(
  endpoint: string | undefined,
  defaultPort: number,
): string {
  const trimmed = (endpoint ?? '').trim().replace(/\/+$/g, '');
  if (!trimmed) {
    return '';
  }

  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      const authority = url.port ? url.host : `${url.hostname}:${defaultPort}`;
      const path = url.pathname === '/' ? '' : url.pathname;
      return `${url.protocol}//${authority}${path}${url.search}${url.hash}`;
    } catch {
      return trimmed;
    }
  }

  if (/^\[[^\]]+\](:\d+)?$/.test(trimmed)) {
    return trimmed.includes(']:') ? trimmed : `${trimmed}:${defaultPort}`;
  }

  if (/^[^:]+:\d+$/.test(trimmed)) {
    return trimmed;
  }

  if (/^[^:]+:$/.test(trimmed)) {
    return `${trimmed}${defaultPort}`;
  }

  if (!trimmed.includes(':')) {
    return `${trimmed}:${defaultPort}`;
  }

  return trimmed;
}

function extractEndpointHost(endpoint: string): string {
  const trimmed = endpoint.trim().replace(/\/+$/g, '');
  if (!trimmed) {
    return '';
  }

  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      return url.hostname.includes(':') ? `[${url.hostname}]` : url.hostname;
    } catch {
      return '';
    }
  }

  const slashIndex = trimmed.indexOf('/');
  const authority = slashIndex >= 0 ? trimmed.slice(0, slashIndex) : trimmed;
  const bracketMatch = authority.match(/^(\[[^\]]+\])(?::\d+)?$/);
  if (bracketMatch) {
    return bracketMatch[1];
  }

  const colonIndex = authority.lastIndexOf(':');
  if (colonIndex > 0 && /^\d+$/.test(authority.slice(colonIndex + 1))) {
    return authority.slice(0, colonIndex);
  }

  return authority;
}

function stripKnownMfnPort(endpoint: string): string {
  const slashIndex = endpoint.indexOf('/');
  const authority = slashIndex >= 0 ? endpoint.slice(0, slashIndex) : endpoint;
  const rest = slashIndex >= 0 ? endpoint.slice(slashIndex) : '';
  const colonIndex = authority.lastIndexOf(':');
  if (colonIndex <= 0) {
    return endpoint;
  }

  const host = authority.slice(0, colonIndex);
  const port = authority.slice(colonIndex + 1);
  if (
    [
      '18081',
      '18089',
      '18091',
      '28081',
      '28089',
      '28091',
      '38081',
      '38089',
      '38091',
    ].includes(port)
  ) {
    return `${host}${rest}`;
  }

  return endpoint;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseMode(value: unknown): NodeConnectionMode | undefined {
  if (
    value === 'optimized-grpc' ||
    value === 'original-rpc' ||
    value === 'custom'
  ) {
    return value;
  }

  return undefined;
}

function parseNetwork(value: unknown): MoneroNetwork | undefined {
  if (value === 'mainnet' || value === 'testnet' || value === 'stagenet') {
    return value;
  }

  return undefined;
}

function parseString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function parseBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

async function prepareSettingsForSave(
  settings: NodeConnectionSettings,
): Promise<NodeConnectionSettings> {
  const normalized = normalizeNodeConnectionSettings(settings);
  const password = normalized.daemon.password ?? '';
  const existingSecretKey = activeSettings.daemon.passwordSecretKey;
  const wantsStoredPassword =
    normalized.daemon.passwordSecretKey === NODE_DAEMON_PASSWORD_SECRET_KEY;

  if (password.length > 0) {
    await requireNativeMoneroWallet().storeDaemonPassword(password);
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
    await requireNativeMoneroWallet().deleteDaemonPassword();
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
      password: '',
      passwordSecretKey,
    },
  });
}

function normalizeSecretKey(value: string | undefined): string | undefined {
  return value === NODE_DAEMON_PASSWORD_SECRET_KEY ? value : undefined;
}

function parseSecretKey(value: unknown): string | undefined {
  return typeof value === 'string' ? normalizeSecretKey(value) : undefined;
}
