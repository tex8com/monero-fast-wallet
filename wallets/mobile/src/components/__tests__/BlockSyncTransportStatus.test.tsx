import React from 'react';
import {StyleSheet, Text} from 'react-native';
import renderer, {act, type ReactTestRenderer} from 'react-test-renderer';

import BlockSyncTransportStatus from '../BlockSyncTransportStatus';
import AppTopBar from '../AppTopBar';
import type {NetworkSyncStatus} from '../../services/NativeMoneroWallet';
import {colors} from '../../theme/colors';

const mockWalletState: {
  snapshot: {synchronized: boolean};
  status: string;
  networkSyncStatus?: NetworkSyncStatus;
} = {snapshot: {synchronized: false}, status: 'syncing'};

jest.mock('../../i18n', () => ({
  useI18n: () => ({t: (key: string) => key}),
}));
jest.mock('../../services/WalletState', () => ({
  useWalletState: () => mockWalletState,
}));
jest.mock('../../services/ConnectivityState', () => ({
  useConnectivityState: () => ({
    tor: {phase: 'connected', connected: true},
    clearnet: {phase: 'connected', connected: true},
  }),
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({top: 0, bottom: 0, left: 0, right: 0}),
}));
jest.mock('../MoneroLogo', () => 'MoneroLogo');

const status = (transport: 'grpc' | 'rpc' | 'unknown', reason = '') => ({
  state: 'fetching-blocks', phase: 'fetching-blocks',
  blockTransport: transport, blockTransportReason: reason,
  downloadStartHeight: 100, downloadedHeight: 150, chainHeight: 150,
  targetHeight: 200, transportStarts: 1, joinedWallets: 1, stalledWallets: 0,
} as unknown as NetworkSyncStatus);

describe('actual block download transport', () => {
  let tree: ReactTestRenderer;
  afterEach(() => act(() => tree?.unmount()));

  it.each([
    ['grpc', 'grpc-active', 'grpc', colors.success],
    ['rpc', 'rpc-fallback', 'fallback', colors.warning],
    ['rpc', 'rpc-selected', 'rpc', colors.warning],
    ['unknown', '', 'unknown', colors.textMuted],
  ] as const)('shows %s / %s with explicit text and color', (transport, reason, key, color) => {
    act(() => {tree = renderer.create(<BlockSyncTransportStatus status={status(transport, reason)} />);});
    const label = tree.root.findByProps({testID: 'block-sync-transport-label'});
    expect(label.props.children).toBe(`sync.transport.${key}`);
    expect(StyleSheet.flatten(label.props.style).color).toBe(color);
    expect(tree.root.findByProps({testID: 'block-sync-transport'}).props.accessibilityLabel)
      .toContain(`sync.transport.${key}Hint`);
  });

  it('does not claim a fallback for a deliberately selected RPC node', () => {
    act(() => {tree = renderer.create(<BlockSyncTransportStatus status={status('rpc', 'rpc-selected')} />);});
    expect(tree.root.findAllByType(Text).map(node => node.props.children))
      .not.toContain('sync.transport.fallback');
  });

  it('does not show green from a synced wallet or reachable gRPC endpoint alone', () => {
    mockWalletState.snapshot.synchronized = true;
    mockWalletState.status = 'open';
    mockWalletState.networkSyncStatus = status('unknown');
    act(() => {tree = renderer.create(<AppTopBar safeAreaHandledByTicker onLogoPress={jest.fn()} onStatusPress={jest.fn()} />);});
    const badge = tree.root.findByProps({testID: 'top-bar-sync-status'});
    expect(StyleSheet.flatten(badge.props.style).borderColor).toBe(`${colors.textMuted}55`);
  });

  it('updates the top badge from gRPC green to RPC fallback yellow while the wallet keeps scanning', () => {
    mockWalletState.snapshot.synchronized = false;
    mockWalletState.status = 'syncing';
    mockWalletState.networkSyncStatus = status('grpc', 'grpc-active');
    const render = () => <AppTopBar safeAreaHandledByTicker onLogoPress={jest.fn()} onStatusPress={jest.fn()} />;
    act(() => {tree = renderer.create(render());});
    expect(StyleSheet.flatten(tree.root.findByProps({testID: 'top-bar-sync-status'}).props.style).borderColor)
      .toBe(`${colors.success}55`);
    mockWalletState.networkSyncStatus = status('rpc', 'rpc-fallback');
    act(() => tree.update(render()));
    expect(StyleSheet.flatten(tree.root.findByProps({testID: 'top-bar-sync-status'}).props.style).borderColor)
      .toBe(`${colors.warning}55`);
    expect(tree.root.findAll(node => typeof node.props.accessibilityLabel === 'string')
      .some(node => node.props.accessibilityLabel.includes('sync.transport.fallback'))).toBe(true);
  });

  it('shows connection failures red even when the previous transport was gRPC', () => {
    act(() => {tree = renderer.create(<BlockSyncTransportStatus status={{...status('grpc'), state: 'provider-backoff', phase: 'provider-backoff'}} />);});
    const label = tree.root.findByProps({testID: 'block-sync-transport-label'});
    expect(label.props.children).toBe('sync.transport.unavailable');
    expect(StyleSheet.flatten(label.props.style).color).toBe(colors.error);
  });
});
