import {NativeModules} from 'react-native';

const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_MAXIMUM_RESPONSE_BYTES = 256 * 1024;

type NativeTorHttpResult = {
  status: number;
  body: string;
};

type NativeTorModule = {
  request(
    url: string,
    method: string,
    headers: Record<string, string>,
    body: string | null,
    timeoutMs: number,
    maximumResponseBytes: number,
  ): Promise<NativeTorHttpResult>;
};

export type TorFetchInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string | null;
  signal?: AbortSignal;
  timeoutMs?: number;
  maximumResponseBytes?: number;
};

export type TorFetchResponse = {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<any>;
};

/**
 * Fail-closed service transport. Mobile requests are sent by the native
 * app-private Tor runtime; React Native's ordinary fetch is never a fallback.
 * The high-throughput MFN gRPC block stream is intentionally separate.
 */
export async function torFetch(
  url: string,
  init: TorFetchInit = {},
): Promise<TorFetchResponse> {
  if (init.signal?.aborted) {
    throw new Error('Tor HTTP request was cancelled');
  }
  const native = NativeModules.EmbeddedTor as NativeTorModule | undefined;
  if (!native?.request) {
    throw new Error('The embedded Tor HTTP transport is missing from this build');
  }
  const method = (init.method ?? 'GET').toUpperCase();
  const headers = normalizeHeaders(init.headers);
  const timeoutMs = init.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maximumResponseBytes =
    init.maximumResponseBytes ?? DEFAULT_MAXIMUM_RESPONSE_BYTES;
  const result = await awaitNativeRequest(
    native.request(
      url,
      method,
      headers,
      init.body ?? null,
      timeoutMs,
      maximumResponseBytes,
    ),
    init.signal,
  );
  if (
    !result ||
    !Number.isSafeInteger(result.status) ||
    result.status < 100 ||
    result.status > 599 ||
    typeof result.body !== 'string'
  ) {
    throw new Error('The embedded Tor HTTP response is malformed');
  }
  return {
    ok: result.status >= 200 && result.status < 300,
    status: result.status,
    text: async () => result.body,
    json: async () => JSON.parse(result.body),
  };
}

/**
 * React callers may stop waiting when their AbortSignal fires. The native
 * bridge has no per-request cancellation handle, so its connection remains
 * independently bounded by the exact timeout passed to `native.request`.
 * Attaching both completion handlers also consumes a late native rejection.
 */
function awaitNativeRequest<T>(
  request: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return request;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      reject(new Error('Tor HTTP request was cancelled'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    request.then(
      value => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      error => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
    if (signal.aborted) onAbort();
  });
}

function normalizeHeaders(value: Record<string, string> | undefined): Record<string, string> {
  if (!value) return {};
  return Object.fromEntries(
    Object.entries(value).map(([name, headerValue]) => [name, String(headerValue)]),
  );
}
