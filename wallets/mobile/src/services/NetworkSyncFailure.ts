import type { TranslationKey } from '../i18n';
import type { NetworkSyncStatus } from './NativeMoneroWallet';

// Native errors remain inside the diagnostic boundary. The UI and standard
// logs use this fixed vocabulary so an endpoint or wallet-specific detail can
// never leak into a notification, screenshot, or support request.
export type NetworkSyncFailureCode =
  | 'node-configuration'
  | 'node-timeout'
  | 'node-unreachable'
  | 'node-security'
  | 'optimized-service'
  | 'server-response'
  | 'wallet-scan'
  | 'retrying';

type NetworkSyncFailureSource = Pick<
  NetworkSyncStatus,
  'lastError' | 'phase' | 'state'
>;

export function networkSyncFailureCode(
  status: NetworkSyncFailureSource | undefined,
): NetworkSyncFailureCode | undefined {
  if (!status || !isFailureState(status)) return undefined;

  // A scanner retry is local wallet work. It must never be presented as a
  // failed node connection merely because the native layer has no transport
  // error text to classify.
  if (
    status.state === 'scanner-backoff' ||
    status.phase === 'scanner-backoff'
  ) {
    return 'wallet-scan';
  }

  const error = status.lastError.toLowerCase();
  if (
    /not configured|must not be empty|missing.*(?:daemon|endpoint|node)/.test(
      error,
    )
  ) {
    return 'node-configuration';
  }
  if (/certificate|tls|ssl|unauthori[sz]ed|authentication failed/.test(error)) {
    return 'node-security';
  }
  if (/timed? ?out|timeout|deadline exceeded/.test(error)) {
    return 'node-timeout';
  }
  if (/grpc|scanpack|optimized service/.test(error)) {
    return 'optimized-service';
  }
  if (
    /batch|decode|malformed|invalid.*(?:block|response)|verification|response too large|rpc byte limit|message too large|resource exhausted/.test(error)
  ) {
    return 'server-response';
  }
  if (/wallet.*(?:scan|stalled)|scan.*wallet/.test(error)) {
    return 'wallet-scan';
  }
  if (
    /connect|connection|socket|network is unreachable|refused|host not found|resolve/.test(
      error,
    )
  ) {
    return 'node-unreachable';
  }
  return 'retrying';
}

export function networkSyncFailureTranslationKey(
  code: NetworkSyncFailureCode | undefined,
): TranslationKey {
  switch (code) {
    case 'node-configuration':
      return 'sync.failureNodeConfiguration';
    case 'node-timeout':
      return 'sync.failureNodeTimeout';
    case 'node-unreachable':
      return 'sync.failureNodeUnreachable';
    case 'node-security':
      return 'sync.failureNodeSecurity';
    case 'optimized-service':
      return 'sync.failureOptimizedService';
    case 'server-response':
      return 'sync.failureServerResponse';
    case 'wallet-scan':
      return 'sync.failureWalletScan';
    default:
      return 'sync.retryingNode';
  }
}

function isFailureState(status: NetworkSyncFailureSource) {
  return (
    [
      'degraded',
      'provider-backoff',
      'retrying',
      'scanner-backoff',
      'stopped',
    ].includes(status.state) ||
    [
      'degraded',
      'provider-backoff',
      'retrying',
      'scanner-backoff',
      'stopped',
    ].includes(status.phase)
  );
}
