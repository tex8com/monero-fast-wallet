import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import {AppState, NativeModules, Platform} from 'react-native';

import type {NodeConnectionSettings} from './NodeConnectionSettings';
import {
  getActiveNodeConnectionSettings,
  loadActiveNodeConnectionSettings,
} from './NodeConnectionSettings';
import {diagnoseConnectionRoutes} from './ConnectionDiagnostics';

export type ConnectivityPhase =
  | 'idle'
  | 'starting'
  | 'checking'
  | 'connected'
  | 'error';

export type ConnectivityRouteState = Readonly<{
  phase: ConnectivityPhase;
  connected: boolean;
  endpoint: string;
  checkedAtMs: number;
  elapsedMs?: number;
  error?: string;
}>;

export type ConnectivityState = Readonly<{
  tor: ConnectivityRouteState;
  clearnet: ConnectivityRouteState;
}>;

type NativeConnectivityModule = {
  ensureReady?(timeoutMs: number): Promise<string>;
  startConnectivity?(): Promise<void>;
  configureConnectivity?(
    torEndpoint: string,
    clearnetEndpoint: string,
  ): Promise<void>;
  recheckConnectivity?(reconnectTor: boolean): Promise<void>;
  getConnectivityStatus?(): Promise<ConnectivityState>;
};

const initialRoute = (endpoint = ''): ConnectivityRouteState => ({
  phase: 'starting',
  connected: false,
  endpoint,
  checkedAtMs: 0,
});

const initialState: ConnectivityState = {
  tor: initialRoute(),
  clearnet: initialRoute(),
};

const ConnectivityContext = createContext<ConnectivityState>(initialState);
const nativeConnectivity = () =>
  NativeModules.EmbeddedTor as NativeConnectivityModule | undefined;

function validPhase(value: unknown): value is ConnectivityPhase {
  return ['idle', 'starting', 'checking', 'connected', 'error'].includes(
    String(value),
  );
}

function normalizeRoute(
  value: Partial<ConnectivityRouteState> | undefined,
  fallback: ConnectivityRouteState,
): ConnectivityRouteState {
  const phase = validPhase(value?.phase) ? value.phase : fallback.phase;
  return {
    phase,
    connected: value?.connected === true && phase === 'connected',
    endpoint:
      typeof value?.endpoint === 'string' ? value.endpoint : fallback.endpoint,
    checkedAtMs:
      typeof value?.checkedAtMs === 'number' &&
      Number.isFinite(value.checkedAtMs)
        ? Math.max(0, value.checkedAtMs)
        : fallback.checkedAtMs,
    ...(typeof value?.elapsedMs === 'number' && Number.isFinite(value.elapsedMs)
      ? {elapsedMs: Math.max(0, value.elapsedMs)}
      : undefined),
    ...(typeof value?.error === 'string' && value.error.trim()
      ? {error: value.error.trim()}
      : undefined),
  };
}

function endpointLabel(value: string): string {
  return value
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//iu, '')
    .split('/')[0];
}

export async function configureNativeConnectivity(
  settings: NodeConnectionSettings,
): Promise<void> {
  const native = nativeConnectivity();
  if (!native) return;
  if (native.configureConnectivity) {
    await native.configureConnectivity(
      settings.daemon.proxyAddress?.trim()
        ? endpointLabel(settings.daemon.address)
        : '',
      settings.mode === 'optimized-grpc'
        ? endpointLabel(settings.grpcEndpoint)
        : '',
    );
  }
  await native.startConnectivity?.();
}

async function foregroundFallback(
  settings: NodeConnectionSettings,
): Promise<ConnectivityState> {
  const result = await diagnoseConnectionRoutes(settings);
  const checkedAtMs = Date.now();
  const route = (
    value: typeof result.tor,
  ): ConnectivityRouteState => ({
    phase:
      value.status === 'connected'
        ? 'connected'
        : value.status === 'disabled'
          ? 'idle'
          : 'error',
    connected: value.status === 'connected',
    endpoint: value.endpoint,
    checkedAtMs,
    ...(value.elapsedMs === undefined ? undefined : {elapsedMs: value.elapsedMs}),
    ...(value.error ? {error: value.error} : undefined),
  });
  return {tor: route(result.tor), clearnet: route(result.clearnet)};
}

export function ConnectivityProvider({children}: {children: React.ReactNode}) {
  const [state, setState] = useState<ConnectivityState>(initialState);
  const refresh = useCallback(async () => {
    const native = nativeConnectivity();
    if (native?.getConnectivityStatus) {
      const next = await native.getConnectivityStatus();
      setState(current => ({
        tor: normalizeRoute(next?.tor, current.tor),
        clearnet: normalizeRoute(next?.clearnet, current.clearnet),
      }));
      return;
    }
    setState(await foregroundFallback(getActiveNodeConnectionSettings()));
  }, []);

  useEffect(() => {
    let active = true;
    loadActiveNodeConnectionSettings()
      .then(async loaded => {
        if (!active) return;
        setState({
          tor: initialRoute(endpointLabel(loaded.daemon.address)),
          clearnet: initialRoute(endpointLabel(loaded.grpcEndpoint)),
        });
        await configureNativeConnectivity(loaded);
        if (active) await refresh();
      })
      .catch(error => {
        if (!active) return;
        const message = error instanceof Error ? error.message : String(error);
        setState(current => ({
          tor: {...current.tor, phase: 'error', connected: false, error: message},
          clearnet: {
            ...current.clearnet,
            phase: 'error',
            connected: false,
            error: message,
          },
        }));
      });
    return () => {
      active = false;
    };
  }, [refresh]);

  useEffect(() => {
    const timer = setInterval(() => {
      if (AppState.currentState === 'active') {
        refresh().catch(() => undefined);
      }
    }, 1_500);
    const subscription = AppState.addEventListener('change', next => {
      if (next !== 'active') return;
      const native = nativeConnectivity();
      // Read the process-owned snapshot before asking for a fresh probe. A
      // normal foreground transition must not paint both routes as offline,
      // and it must never restart a healthy embedded Tor process.
      refresh()
        .catch(() => undefined)
        .then(() => native?.recheckConnectivity?.(false))
        .catch(() => undefined);
    });
    return () => {
      clearInterval(timer);
      subscription.remove();
    };
  }, [refresh]);

  const value = useMemo(() => state, [state]);
  return (
    <ConnectivityContext.Provider value={value}>
      {children}
    </ConnectivityContext.Provider>
  );
}

export function useConnectivityState(): ConnectivityState {
  return useContext(ConnectivityContext);
}

export const mobileBackgroundConnectivityIsPersistent = Platform.OS === 'android';
