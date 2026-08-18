import React from 'react';
import { TextInput, TouchableOpacity } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';

import { useWalletState } from '../../backend/WalletState';
import { walletService } from '../../backend/WalletService';
import SendScreen from '../SendScreen';

jest.mock('@react-navigation/native', () => ({
  useFocusEffect: jest.fn(),
}));

jest.mock('react-native-linear-gradient', () => ({
  __esModule: true,
  default: ({ children, ...props }: React.PropsWithChildren<object>) => {
    const ReactModule = require('react');
    const { View: NativeView } = require('react-native');
    return ReactModule.createElement(NativeView, props, children);
  },
}));

jest.mock('../../components/SyncStatusBar', () => () => null);
jest.mock('../../components/TransactionRow', () => () => null);
jest.mock('../../components/WalletSwitcherPill', () => () => null);

jest.mock('../../data/priceService', () => ({
  useXmrPrice: () => ({ price: 300 }),
}));

jest.mock('../../i18n', () => ({
  useI18n: () => ({
    t: (key: string) =>
      ({
        'action.sendNow': 'Send Now',
        'action.working': 'Working...',
        'send.sendXmr': 'Send XMR',
      }[key] ?? key),
  }),
}));

jest.mock('../../backend/NodeConnectionSettings', () => ({
  getActiveNodeConnectionSettings: () => ({ mode: 'optimized-grpc' }),
  loadActiveNodeConnectionSettings: jest.fn(async () => ({
    mode: 'optimized-grpc',
  })),
}));

jest.mock('../../backend/WalletState', () => ({
  useWalletState: jest.fn(),
}));

jest.mock('../../backend/WalletService', () => ({
  walletService: {
    commitTransaction: jest.fn(),
    loadFastReceiveIdentitiesForActiveNode: jest.fn(async () => []),
    prepareTransaction: jest.fn(),
    validateRecipientAddress: jest.fn(async address => address),
  },
}));

const mockedUseWalletState = useWalletState as jest.MockedFunction<
  typeof useWalletState
>;
const mockedWalletService = walletService as jest.Mocked<typeof walletService>;

describe('SendScreen', () => {
  it('shows name lookup progress and disables Continue while resolving', async () => {
    mockedUseWalletState.mockReturnValue({
      error: undefined,
      registeredWallet: {
        id: 'primary',
        kind: 'software',
        walletName: 'primary',
        network: 'mainnet',
      },
      registeredWallets: [],
      session: { walletId: 'wallet-1', network: 'mainnet' },
      setActiveRegisteredWallet: jest.fn(),
      snapshot: {
        balanceAtomic: '0',
        unlockedBalanceAtomic: '0',
        synchronized: true,
      },
      status: 'open',
      syncProgress: 100,
      transactions: [],
      walletSnapshots: {},
    } as unknown as ReturnType<typeof useWalletState>);

    let renderer: ReactTestRenderer.ReactTestRenderer | undefined;
    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(
        <SendScreen navigation={{ navigate: jest.fn() }} />,
      );
    });

    const manualRecipientButton = renderer!.root
      .findAllByType(TouchableOpacity)
      .find(node => node.props.accessibilityLabel === 'send.manualRecipient');
    await ReactTestRenderer.act(async () =>
      manualRecipientButton!.props.onPress(),
    );

    const recipientInput = renderer!.root.findAllByType(TextInput)[0];
    await ReactTestRenderer.act(async () => {
      recipientInput.props.onChangeText('tex8.mfw');
    });

    expect(
      renderer!.root.findByProps({ testID: 'mfw-name-lookup-spinner' }),
    ).toBeDefined();
    const continueButton = renderer!.root
      .findAllByType(TouchableOpacity)
      .find(node => node.props.accessibilityLabel === 'action.continue');
    expect(continueButton!.props.disabled).toBe(true);
    expect(continueButton!.props.accessibilityState).toEqual({
      disabled: true,
    });

    await ReactTestRenderer.act(async () => renderer!.unmount());
  });

  it('prepares MAX as sweep-all and commits with one review tap', async () => {
    const recipientAddress = `4${'1'.repeat(94)}`;
    const refreshSnapshot = jest.fn(async () => undefined);
    const refreshTransactions = jest.fn(async () => []);
    mockedUseWalletState.mockReturnValue({
      error: undefined,
      refreshSnapshot,
      refreshTransactions,
      registeredWallet: {
        id: 'primary',
        kind: 'software',
        walletName: 'primary',
        network: 'mainnet',
      },
      registeredWallets: [],
      session: { walletId: 'wallet-1', network: 'mainnet' },
      setActiveRegisteredWallet: jest.fn(),
      snapshot: {
        balanceAtomic: '1000000000',
        unlockedBalanceAtomic: '1000000000',
        synchronized: true,
      },
      status: 'open',
      syncProgress: 100,
      transactions: [],
      walletSnapshots: {},
    } as unknown as ReturnType<typeof useWalletState>);
    mockedWalletService.prepareTransaction.mockResolvedValue({
      id: 'pending-max',
      status: 'ok',
      error: '',
      amountAtomic: '970000000',
      dustAtomic: '0',
      feeAtomic: '30000000',
      txCount: 1,
      txIds: ['prepared-id'],
      subaddrAccounts: [0],
      subaddrIndices: [0],
    });
    mockedWalletService.commitTransaction.mockResolvedValue({
      id: 'pending-max',
      status: 'ok',
      error: '',
      amountAtomic: '970000000',
      dustAtomic: '0',
      feeAtomic: '30000000',
      txCount: 1,
      txIds: ['committed-id'],
      subaddrAccounts: [0],
      subaddrIndices: [0],
    });

    let renderer: ReactTestRenderer.ReactTestRenderer | undefined;
    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(
        <SendScreen navigation={{ navigate: jest.fn() }} />,
      );
    });

    const manualRecipientButton = renderer!.root
      .findAllByType(TouchableOpacity)
      .find(node => node.props.accessibilityLabel === 'send.manualRecipient');
    await ReactTestRenderer.act(async () =>
      manualRecipientButton!.props.onPress(),
    );

    const recipientInput = renderer!.root.findAllByType(TextInput)[0];
    await ReactTestRenderer.act(async () => {
      recipientInput.props.onChangeText(recipientAddress);
    });
    const continueButton = renderer!.root
      .findAllByType(TouchableOpacity)
      .find(node => node.props.accessibilityLabel === 'action.continue');
    await ReactTestRenderer.act(async () => continueButton!.props.onPress());
    const useRecipientButton = renderer!.root
      .findAllByType(TouchableOpacity)
      .find(node => node.props.accessibilityLabel === 'send.useThisRecipient');
    await ReactTestRenderer.act(async () =>
      useRecipientButton!.props.onPress(),
    );
    const maxButton = renderer!.root
      .findAllByType(TouchableOpacity)
      .find(node => node.props.accessibilityLabel === 'send.all');
    await ReactTestRenderer.act(async () => maxButton!.props.onPress());

    const sendButton = renderer!.root
      .findAllByType(TouchableOpacity)
      .find(node => node.props.accessibilityLabel === 'Send XMR');
    await ReactTestRenderer.act(async () => sendButton!.props.onPress());

    expect(mockedWalletService.prepareTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ walletId: 'wallet-1' }),
      {
        address: recipientAddress,
        amountAtomic: undefined,
        priority: 'low',
        sweepAll: true,
      },
    );

    const confirmButton = renderer!.root
      .findAllByType(TouchableOpacity)
      .find(node => node.props.accessibilityLabel === 'Send Now');
    expect(confirmButton).toBeDefined();
    await ReactTestRenderer.act(async () => confirmButton!.props.onPress());

    expect(mockedWalletService.commitTransaction).toHaveBeenCalledTimes(1);
    expect(mockedWalletService.commitTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ walletId: 'wallet-1' }),
      'pending-max',
    );
  });
});
