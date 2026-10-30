import React from 'react';
import renderer, {act, type ReactTestRenderer} from 'react-test-renderer';
import {Text} from 'react-native';

import SyncStatusBar from '../SyncStatusBar';
import type {NetworkSyncStatus, WalletSnapshot} from '../../services/NativeMoneroWallet';

jest.mock('../../i18n', () => ({
  useI18n: () => ({
    dateLocale: 'en-US',
    t: (key: string, params?: Record<string, string | number>) => {
      if (key === 'sync.percent') return `${params?.percent}%`;
      if (key === 'sync.blocksRemaining') return `remaining ${params?.count}`;
      return key;
    },
  }),
}));

const start = 3_789_205;
const target = 3_793_557;
const network = {
  state: 'fetching-blocks', phase: 'fetching-blocks',
  downloadStartHeight: start, downloadedHeight: target - 3_336,
  chainHeight: target - 3_528, priorityWalletHeight: target - 3_528,
  targetHeight: target, transportStarts: 1, joinedWallets: 1,
  stalledWallets: 0,
} as NetworkSyncStatus;
const snapshot = {
  walletHeight: target - 3_528, daemonHeight: target,
  daemonTargetHeight: target, synchronized: false,
} as WalletSnapshot;

describe('remaining-work progress rows', () => {
  let tree: ReactTestRenderer | undefined;
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    act(() => tree?.unmount());
    jest.useRealTimers();
  });

  function render(overrides: Partial<React.ComponentProps<typeof SyncStatusBar>> = {}) {
    act(() => {
      tree = renderer.create(
        <SyncStatusBar expanded status="syncing" snapshot={snapshot}
          networkStatus={network} syncStartHeight={start} {...overrides} />,
      );
    });
  }

  function texts(testID: string) {
    return tree!.root.findByProps({testID}).findAllByType(Text)
      .map(node => node.props.children);
  }

  it('renders both percentages from session work, not the full chain', () => {
    render();
    expect(texts('blockchain-progress')).toContain('23.3%');
    expect(texts('wallet-progress')).toContain('18%');
    expect(texts('blockchain-progress')).toContain('remaining 3,336');
    expect(texts('wallet-progress')).toContain('remaining 3,528');
  });

  it('starts both remaining work ranges at zero percent', () => {
    render({
      snapshot: {...snapshot, walletHeight: start},
      networkStatus: {...network, downloadedHeight: start,
        chainHeight: start, priorityWalletHeight: start},
    });
    expect(texts('blockchain-progress')).toContain('0%');
    expect(texts('wallet-progress')).toContain('0%');
  });

  it('does not promote shared downloads when the selected wallet is ready', () => {
    render({
      snapshot: {...snapshot, walletHeight: target, synchronized: true},
      networkStatus: {...network, priorityWalletHeight: target},
    });
    expect(texts('wallet-progress')).toContain('100%');
    expect(texts('blockchain-progress')).toContain('23.3%');
  });

  it('does not display wallet completion before Core confirms it', () => {
    render({
      snapshot: {...snapshot, walletHeight: target},
      networkStatus: {...network, priorityWalletHeight: target},
    });
    expect(texts('wallet-progress')).toContain('—');
    expect(texts('wallet-progress')).not.toContain('100%');
  });
});
