import {NativeModules} from 'react-native';
import type {NodeConnectionSettings} from './NodeConnectionSettings';

export type ConnectionRouteResult = Readonly<{
  status: 'connected' | 'error';
  endpoint: string;
  elapsedMs?: number;
  error?: string;
}>;

export type ConnectionDiagnosticsResult = Readonly<{
  tor: ConnectionRouteResult;
  clearnet: ConnectionRouteResult;
}>;

type NativeConnectionProbe = {
  probeTcp(
    host: string,
    port: number,
    throughTor: boolean,
    timeoutMs: number,
  ): Promise<{connected: boolean; elapsedMs: number}>;
};

const PROBE_TIMEOUT_MS = 8_000;

export async function diagnoseConnectionRoutes(
  settings: NodeConnectionSettings,
  native: NativeConnectionProbe | undefined = NativeModules.EmbeddedTor,
): Promise<ConnectionDiagnosticsResult> {
  if (!native?.probeTcp) {
    const missing = 'The native connection probe is missing from this build.';
    return {
      tor: failure(settings.daemon.address, missing),
      clearnet: failure(settings.grpcEndpoint, missing),
    };
  }

  const [tor, clearnet] = await Promise.all([
    probe(native, settings.daemon.address, true),
    probe(native, settings.grpcEndpoint, false),
  ]);
  return {tor, clearnet};
}

async function probe(
  native: NativeConnectionProbe,
  endpointValue: string,
  throughTor: boolean,
): Promise<ConnectionRouteResult> {
  try {
    const endpoint = parseEndpoint(endpointValue);
    const result = await native.probeTcp(
      endpoint.host,
      endpoint.port,
      throughTor,
      PROBE_TIMEOUT_MS,
    );
    if (!result?.connected || !Number.isFinite(result.elapsedMs)) {
      throw new Error('The connection probe returned an invalid response.');
    }
    return {
      status: 'connected',
      endpoint: endpoint.label,
      elapsedMs: Math.max(0, Math.round(result.elapsedMs)),
    };
  } catch (error) {
    return failure(endpointValue, errorMessage(error));
  }
}

type ParsedEndpoint = Readonly<{
  host: string;
  port: number;
  label: string;
}>;

export function parseConnectionEndpoint(value: string): ParsedEndpoint {
  return parseEndpoint(value);
}

function parseEndpoint(value: string): ParsedEndpoint {
  const label = value.trim();
  if (!label) throw new Error('No endpoint is configured.');
  const withoutScheme = label.replace(/^[a-z][a-z0-9+.-]*:\/\//iu, '');
  const authority = withoutScheme.split('/')[0];
  const separator = authority.lastIndexOf(':');
  if (separator <= 0 || separator === authority.length - 1) {
    throw new Error('The endpoint must include a port.');
  }
  const host = authority.slice(0, separator).trim().toLowerCase();
  const port = Number(authority.slice(separator + 1));
  if (
    !/^[a-z0-9.-]{1,253}$/u.test(host) ||
    host.startsWith('.') ||
    host.endsWith('.') ||
    host.includes('..') ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65_535
  ) {
    throw new Error('The endpoint is invalid.');
  }
  return {host, port, label};
}

function failure(endpoint: string, error: string): ConnectionRouteResult {
  return {status: 'error', endpoint: endpoint.trim(), error};
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
