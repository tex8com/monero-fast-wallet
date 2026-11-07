import React from 'react';
import {StyleSheet, Text, TextInput} from 'react-native';
import renderer, {act, type ReactTestRenderer} from 'react-test-renderer';

import NodeStatusScreen from '../NodeStatusScreen';
import {colors} from '../../theme/colors';

const mockSettings = {
  network: 'mainnet', mode: 'optimized-grpc', grpcEndpoint: 'node.example:18091',
  daemon: {address: 'daemon.onion:18089', trusted: true, useSsl: false, proxyAddress: '127.0.0.1:9050'},
};
const mockNative = {
  networkSyncStatus: jest.fn(),
  getPublicBlockSpoolPreferenceMiB: jest.fn(async () => 1024),
};
const mockConnectivity = {
  tor: {phase: 'connected', connected: true, endpoint: mockSettings.daemon.address, checkedAtMs: 1},
  clearnet: {phase: 'connected', connected: true, endpoint: mockSettings.grpcEndpoint, checkedAtMs: 1},
};

jest.mock('../../components/Icon', () => ({Icon: 'Icon'}));
jest.mock('../../i18n', () => ({useI18n: () => ({t: (key: string) => key})}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({top: 0, bottom: 0, left: 0, right: 0}),
}));
jest.mock('../../services/NativeMoneroWallet', () => ({
  requireNativeMoneroWallet: () => mockNative,
}));
jest.mock('../../services/NodeConnectionSettings', () => ({
  getActiveNodeConnectionSettings: () => mockSettings,
  loadActiveNodeConnectionSettings: async () => mockSettings,
  nodeConnectionSettingsToDraft: (settings: typeof mockSettings) => ({
    ...settings, daemonAddress: settings.daemon.address,
  }),
  nodeConnectionDraftToSettings: (draft: typeof mockSettings & {daemonAddress: string}) => ({
    network: draft.network, mode: draft.mode, grpcEndpoint: draft.grpcEndpoint,
    daemon: {...draft.daemon, address: draft.daemonAddress},
  }),
  saveActiveNodeConnectionSettings: async (value: unknown) => value,
}));
jest.mock('../../services/ConnectivityState', () => ({
  useConnectivityState: () => mockConnectivity,
}));
jest.mock('../../services/ConnectionDiagnostics', () => ({
  diagnoseConnectionRoutes: async () => ({
    tor: {status: 'connected', endpoint: mockSettings.daemon.address},
    clearnet: {status: 'connected', endpoint: mockSettings.grpcEndpoint},
  }),
}));
jest.mock('../../services/WalletService', () => ({
  walletService: {
    applyNodeConnectionToActive: jest.fn(async () => undefined),
    refreshFastReceiveRegistrationStatusesForSettings: jest.fn(async () => undefined),
  },
}));

const fallbackStatus = {
  network: 'mainnet', state: 'fetching-blocks', phase: 'fetching-blocks',
  blockTransport: 'rpc', blockTransportReason: 'rpc-fallback',
  chainHeight: 150, downloadedHeight: 150, targetHeight: 200,
  transportStarts: 1, joinedWallets: 1, stalledWallets: 0,
};

describe('connection check actual block transport', () => {
  let tree: ReactTestRenderer;
  beforeEach(() => {
    jest.useFakeTimers();
    mockNative.networkSyncStatus.mockReset().mockResolvedValue(fallbackStatus);
  });
  afterEach(() => {
    act(() => tree?.unmount());
    jest.useRealTimers();
  });
  const label = () => tree.root.findByProps({testID: 'node-block-transport-label'});
  async function render() {
    await act(async () => {
      tree = renderer.create(<NodeStatusScreen navigation={{goBack: jest.fn()}} />);
    });
  }

  it('shows live RPC fallback despite a successful Clearnet endpoint check', async () => {
    await render();
    expect(mockNative.networkSyncStatus).toHaveBeenCalledWith('mainnet');
    expect(label().props.children).toBe('sync.transport.fallback');
    expect(StyleSheet.flatten(label().props.style).color).toBe(colors.warning);
    const probe = tree.root.findAllByType(Text)
      .find(node => node.props.children === 'nodeStatus.endpointReachable');
    expect(probe).toBeDefined();
    expect(StyleSheet.flatten(probe!.props.style).color).not.toBe(colors.success);
  });

  it('discards an old runtime result when the endpoint is edited', async () => {
    let finish: (value: unknown) => void = () => undefined;
    mockNative.networkSyncStatus.mockImplementationOnce(() => new Promise(resolve => {finish = resolve;}));
    await render();
    expect(label().props.children).toBe('sync.transport.unknown');
    await act(async () => {
      tree.root.findAllByType(TextInput).find(node => node.props.value === mockSettings.grpcEndpoint)!
        .props.onChangeText('different.example:18091');
      finish(fallbackStatus);
    });
    expect(label().props.children).toBe('sync.transport.unknown');
  });

  it('does not show another network’s transport as the selected profile', async () => {
    mockNative.networkSyncStatus.mockResolvedValue({...fallbackStatus, network: 'testnet'});
    await render();
    expect(label().props.children).toBe('sync.transport.unknown');
    expect(StyleSheet.flatten(label().props.style).color).toBe(colors.textMuted);
  });
});
