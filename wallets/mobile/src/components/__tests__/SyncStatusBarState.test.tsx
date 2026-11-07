import React from 'react';
import {StyleSheet, Text} from 'react-native';
import renderer, {act, type ReactTestRenderer} from 'react-test-renderer';

import SyncStatusBar from '../SyncStatusBar';
import type {NetworkSyncStatus, WalletSnapshot} from '../../services/NativeMoneroWallet';
import {colors} from '../../theme/colors';

jest.mock('../../i18n', () => ({
  useI18n: () => ({
    dateLocale: 'en-US',
    t: (key: string, params?: Record<string, string | number>) =>
      key === 'sync.percent' ? `${params?.percent}%`
        : key === 'sync.networkRate' ? `${params?.rate} Mbit/s` : key,
  }),
}));

type Props = React.ComponentProps<typeof SyncStatusBar>;
const height = 3_793_557;
const snapshot = {
  id: 'wallet-1', walletHeight: height, daemonHeight: height,
  daemonTargetHeight: height, synchronized: true,
} as WalletSnapshot;
const network = {
  state: 'synced', phase: 'synced', downloadStartHeight: height - 100,
  downloadedHeight: height, chainHeight: height, priorityWalletHeight: height,
  targetHeight: height, transportStarts: 1, joinedWallets: 1, stalledWallets: 0,
  blockTransport: 'grpc', blockTransportReason: 'grpc-active',
} as unknown as NetworkSyncStatus;

// Home owns expanded=true even when it mounts an already synchronized wallet.
function HomeSyncCard(props: Partial<Props>) {
  const [expanded, setExpanded] = React.useState(true);
  return (
    <SyncStatusBar status="open" snapshot={snapshot} networkStatus={network}
      readinessPhase="ready" {...props} expanded={expanded}
      onExpandedChange={setExpanded} />
  );
}

describe('sync card completion state', () => {
  let tree: ReactTestRenderer;
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    act(() => tree?.unmount());
    jest.useRealTimers();
  });

  function render(props: Partial<Props> = {}) {
    act(() => { tree = renderer.create(<HomeSyncCard {...props} />); });
  }

  function update(props: Partial<Props> = {}) {
    act(() => { tree.update(<HomeSyncCard {...props} />); });
  }

  function toggle() {
    act(() => tree.root.findByProps({testID: 'sync-status-toggle'}).props.onPress());
  }

  function expanded() {
    return tree.root.findByProps({testID: 'sync-status-toggle'})
      .props.accessibilityState.expanded;
  }

  function ledColor() {
    return StyleSheet.flatten(
      tree.root.findByProps({testID: 'sync-connection-led'}).props.style,
    ).backgroundColor;
  }

  function texts(testID: string) {
    return tree.root.findByProps({testID}).findAllByType(Text)
      .map(node => node.props.children);
  }

  it('starts green and collapsed when Home mounts an already completed wallet', () => {
    render();
    expect(ledColor()).toBe(colors.success);
    expect(expanded()).toBe(false);
    expect(tree.root.findAllByProps({testID: 'sync-status-details'})).toHaveLength(0);
  });

  it('expires a measured rate even when no further native status object arrives', () => {
    const downloading = {...network, state: 'fetching-blocks', phase: 'fetching-blocks',
      downloadedHeight: height - 80, chainHeight: height - 80,
      payloadBytesReceived: 1_000_000, networkBytesReceived: 1_200,
    } as NetworkSyncStatus;
    const props: Partial<Props> = {networkStatus: downloading,
      snapshot: {...snapshot, walletHeight: height - 80, synchronized: false},
      readinessPhase: 'wallet-scan', syncStartHeight: height - 100};
    render(props);
    const rateTexts = () => tree.root.findAllByType(Text)
      .map(node => node.props.children).filter(value => typeof value === 'string' && value.includes('Mbit/s'));
    expect(rateTexts()).toHaveLength(0);
    act(() => jest.advanceTimersByTime(750));
    update({...props, networkStatus: {...downloading, payloadBytesReceived: 7_000_000}});
    expect(rateTexts()).toContain('64.00 Mbit/s');
    act(() => jest.advanceTimersByTime(3_000));
    expect(rateTexts()).toHaveLength(0);
  });

  it('identifies a failed Tor route without claiming the synced node is offline', () => {
    render({torStatus: {connected: false, phase: 'error', endpoint: 'node.onion:18089', checkedAtMs: 1}});
    expect(texts('sync-status-toggle')).toContain('sync.torUnavailable');
    expect(texts('sync-status-toggle')).not.toContain('sync.nodeOffline');
    expect(ledColor()).not.toBe(colors.success);
    expect(tree.root.findByProps({testID: 'sync-connection-led'}).props.accessibilityLabel)
      .toBe('sync.torUnavailable');
    expect(expanded()).toBe(true);
    update({torStatus: {connected: true, phase: 'connected', endpoint: 'node.onion:18089', checkedAtMs: 2}});
    expect(ledColor()).toBe(colors.success);
    expect(expanded()).toBe(false);
  });

  it('collapses after Core confirms completion, not just equal heights', () => {
    render({snapshot: {...snapshot, synchronized: false}, readinessPhase: 'wallet-scan'});
    expect(expanded()).toBe(true);
    expect(ledColor()).toBe(colors.warning);
    update();
    expect(expanded()).toBe(false);
    expect(ledColor()).toBe(colors.success);
  });

  it('preserves a manual expansion across unchanged completed status polls', () => {
    render();
    toggle();
    expect(expanded()).toBe(true);
    update({networkStatus: {...network}});
    expect(expanded()).toBe(true);
  });

  it.each(['wallet-scan', 'block-sync', 'recovering-session'] as const)(
    'does not claim Synced while the %s readiness gate is still pending',
    readinessPhase => {
      render({readinessPhase});
      expect(expanded()).toBe(true);
      expect(ledColor()).toBe(colors.warning);
      expect(texts('sync-status-toggle')).not.toContain('sync.synced');
      expect(texts('wallet-progress')).not.toContain('100%');
      expect(texts('wallet-progress')).not.toContain('sync.synced');
      update();
      expect(ledColor()).toBe(colors.success);
      expect(expanded()).toBe(false);
    },
  );

  it('keeps the completed sync card stable during routine mempool checks', () => {
    render();
    update({networkStatus: {...network, state: 'checking-mempool', phase: 'checking-mempool'}});
    expect(texts('sync-status-toggle')).toContain('sync.synced');
    expect(expanded()).toBe(false);
    expect(ledColor()).toBe(colors.success);
    toggle();
    expect(texts('blockchain-progress')).toContain('100%');
    expect(texts('blockchain-progress')).not.toContain('sync.checkingMempool');
  });

  it('keeps two compact progress bars and the measured transport without an explanatory card', () => {
    render({snapshot: {...snapshot, synchronized: false}, readinessPhase: 'wallet-scan'});
    expect(tree.root.findAllByProps({testID: 'blockchain-progress'}, {deep: false})).toHaveLength(1);
    expect(tree.root.findAllByProps({testID: 'wallet-progress'}, {deep: false})).toHaveLength(1);
    expect(tree.root.findAllByProps({testID: 'sync-block-transport'})).toHaveLength(0);
    expect(texts('sync-transport-badge')).toContain('gRPC');
    expect(texts('sync-status-toggle')).toContain('sync.verifyingRecent');
    expect(texts('wallet-progress')).not.toContain('sync.verifyingRecent');
    expect(texts('wallet-progress')).not.toContain('100%');
  });

  it('keeps the real fallback warning visible in the compact download row', () => {
    render({networkStatus: {...network, blockTransport: 'rpc', blockTransportReason: 'rpc-fallback'}});
    toggle();
    const badge = tree.root.findByProps({testID: 'sync-transport-badge'});
    expect(StyleSheet.flatten(badge.props.style).color).toBe(colors.warning);
    expect(badge.props.accessibilityLabel).toContain('sync.transport.fallback');
    expect(ledColor()).not.toBe(colors.success);
  });

  it.each([
    ['selecting-provider', 'sync.selectingSource'],
    ['initializing-transport', 'sync.startingConnection'],
  ])('shows the initial %s phase before a wallet scan can start', (phase, message) => {
    render({
      status: 'opening', snapshot: undefined, readinessPhase: 'block-sync',
      networkStatus: {...network, state: phase, phase, transportStarts: 0,
        chainHeight: 0, targetHeight: 0, downloadedHeight: 0},
    });
    expect(texts('sync-status-toggle')).toContain(message);
    expect(texts('sync-status-toggle')).not.toContain('sync.synced');
    expect(tree.root.findAllByProps({testID: 'wallet-progress'})).toHaveLength(0);
    expect(expanded()).toBe(true);
  });

  it('keeps the Ledger instruction visible alongside a completed scan', () => {
    render({readinessPhase: 'waiting-ledger'});
    expect(texts('sync-status-toggle')).toContain('sync.synced');
    expect(expanded()).toBe(false);
    expect(texts('ledger-verification-status')).toContain('sync.waitingLedger');
    toggle();
    expect(texts('wallet-progress')).toContain('100%');
    update({readinessPhase: 'scanning-spend-outputs'});
    expect(texts('ledger-verification-status')).toContain('sync.spendOutputsChecking');
    expect(texts('wallet-progress')).toContain('100%');
    toggle();
    update({readinessPhase: 'waiting-ledger'});
    expect(expanded()).toBe(false);
    expect(texts('ledger-verification-status')).toContain('sync.waitingLedger');
    update();
    expect(tree.root.findAllByProps({testID: 'ledger-verification-status'})).toHaveLength(0);
  });

  it('shows scan progress with no hardware hint until the viewing wallet catches up', () => {
    render({
      readinessPhase: 'wallet-scan',
      snapshot: {...snapshot, walletHeight: height - 5, synchronized: false},
    });
    expect(texts('wallet-progress')).not.toContain('100%');
    expect(tree.root.findAllByProps({testID: 'ledger-verification-status'})).toHaveLength(0);
  });

  it('resets the details when switching to another wallet', () => {
    render();
    toggle();
    update({snapshot: {...snapshot, id: 'wallet-2'}});
    expect(expanded()).toBe(false);
    update({snapshot: {...snapshot, id: 'wallet-3', synchronized: false}, readinessPhase: 'wallet-scan'});
    expect(expanded()).toBe(true);
  });
});
