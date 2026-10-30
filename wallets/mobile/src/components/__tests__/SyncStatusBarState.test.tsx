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
      key === 'sync.percent' ? `${params?.percent}%` : key,
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
} as NetworkSyncStatus;

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

  it.each(['wallet-scan', 'block-sync', 'recovering-session', 'persisting-wallet'] as const)(
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

  it('shows the mempool check when block download is at the target height', () => {
    render({networkStatus: {...network, state: 'checking-mempool', phase: 'checking-mempool'}});
    expect(texts('sync-status-toggle')).toContain('sync.checkingMempool');
    expect(texts('blockchain-progress')).toContain('sync.checkingMempool');
    expect(texts('blockchain-progress')).not.toContain('sync.synced');
    expect(expanded()).toBe(true);
    expect(ledColor()).toBe(colors.warning);
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

  it('keeps Ledger spend-output verification visible until it completes', () => {
    render({readinessPhase: 'scanning-spend-outputs'});
    expect(texts('sync-status-toggle')).toContain('sync.spendOutputsChecking');
    expect(texts('wallet-progress')).not.toContain('100%');
    expect(ledColor()).toBe(colors.warning);
    expect(expanded()).toBe(true);
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
