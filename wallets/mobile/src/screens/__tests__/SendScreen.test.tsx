import React from 'react';
import { Text, TextInput, TouchableOpacity } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';

import { useWalletState } from '../../services/WalletState';
import { walletService } from '../../services/WalletService';
import { createPaymentLinkSendPreset } from '../../services/IncomingPaymentLink';
import { IncomingPaymentLinkAcknowledgementProvider } from '../../services/IncomingPaymentLinkController';
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

jest.mock('../../services/NodeConnectionSettings', () => ({
  getActiveNodeConnectionSettings: () => ({ mode: 'optimized-grpc' }),
  loadActiveNodeConnectionSettings: jest.fn(async () => ({
    mode: 'optimized-grpc',
  })),
}));

jest.mock('../../services/WalletState', () => ({
  useWalletState: jest.fn(),
}));

jest.mock('../../services/WalletService', () => ({
  walletService: {
    commitTransaction: jest.fn(),
    getHardwareWalletStatus: jest.fn(async () => ({
      requiresUserAction: false,
    })),
    loadFastReceiveIdentitiesForActiveNode: jest.fn(async () => []),
    prepareTransaction: jest.fn(),
    validateRecipientAddress: jest.fn(async address => address),
  },
}));

const mockedUseWalletState = useWalletState as jest.MockedFunction<
  typeof useWalletState
>;
const mockedWalletService = walletService as jest.Mocked<typeof walletService>;

async function prepareMaxTransaction(
  renderer: ReactTestRenderer.ReactTestRenderer,
  recipientAddress: string,
) {
  const manualRecipientButton = renderer.root
    .findAllByType(TouchableOpacity)
    .find(node => node.props.accessibilityLabel === 'send.manualRecipient');
  await ReactTestRenderer.act(async () =>
    manualRecipientButton!.props.onPress(),
  );
  const recipientInput = renderer.root.findAllByType(TextInput)[0];
  await ReactTestRenderer.act(async () => {
    recipientInput.props.onChangeText(recipientAddress);
  });
  const continueButton = renderer.root
    .findAllByType(TouchableOpacity)
    .find(node => node.props.accessibilityLabel === 'action.continue');
  await ReactTestRenderer.act(async () => continueButton!.props.onPress());
  const useRecipientButton = renderer.root
    .findAllByType(TouchableOpacity)
    .find(node => node.props.accessibilityLabel === 'send.useThisRecipient');
  await ReactTestRenderer.act(async () => useRecipientButton!.props.onPress());
  const maxButton = renderer.root
    .findAllByType(TouchableOpacity)
    .find(node => node.props.accessibilityLabel === 'send.all');
  await ReactTestRenderer.act(async () => maxButton!.props.onPress());
  const sendButton = renderer.root
    .findAllByType(TouchableOpacity)
    .find(node => node.props.accessibilityLabel === 'Send XMR');
  await ReactTestRenderer.act(async () => sendButton!.props.onPress());
}

describe('SendScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('routes a payment link through native recipient review without preparing or sending', async () => {
    const recipientAddress = `4${'2'.repeat(94)}`;
    mockedUseWalletState.mockReturnValue({
      error: undefined,
      refreshSnapshot: jest.fn(async () => undefined),
      refreshTransactions: jest.fn(async () => []),
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
        balanceAtomic: '3000000000000',
        unlockedBalanceAtomic: '3000000000000',
        spendAccountIndex: 0,
        spendPrimaryAddress: '4'.repeat(95),
        spendBalanceAtomic: '3000000000000',
        spendUnlockedBalanceAtomic: '3000000000000',
        synchronized: true,
      },
      status: 'open',
      syncProgress: 100,
      transactions: [],
      walletSnapshots: {},
    } as unknown as ReturnType<typeof useWalletState>);
    const preset = createPaymentLinkSendPreset({
      flowId: 'payment-link-test',
      requestId: 'AbCdEfGhIjKlMnOpQrStUv',
      uri: `monero:${recipientAddress}?tx_amount=2`,
      resolvedAtMs: Date.now(),
      expiresAtMs: Date.now() + 60_000,
    });
    const acknowledgePaymentLink = jest.fn();
    const setParams = jest.fn();

    let renderer: ReactTestRenderer.ReactTestRenderer | undefined;
    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(
        <IncomingPaymentLinkAcknowledgementProvider
          onAcknowledged={acknowledgePaymentLink}
        >
          <SendScreen
            navigation={{ navigate: jest.fn(), setParams }}
            route={{ params: { paymentLinkSendPreset: preset } }}
          />
        </IncomingPaymentLinkAcknowledgementProvider>,
      );
      await Promise.resolve();
    });

    expect(mockedWalletService.validateRecipientAddress).toHaveBeenCalledWith(
      recipientAddress,
      'mainnet',
    );
    expect(
      renderer!.root.findByProps({
        accessibilityLabel: 'send.useThisRecipient',
      }),
    ).toBeDefined();
    expect(mockedWalletService.prepareTransaction).not.toHaveBeenCalled();
    expect(mockedWalletService.commitTransaction).not.toHaveBeenCalled();
    expect(acknowledgePaymentLink).toHaveBeenCalledWith(preset.flowId);
    expect(setParams).toHaveBeenCalledWith({
      paymentLinkSendPreset: undefined,
    });
  });

  it('clears a terminally invalid payment-link route instead of replaying it', async () => {
    const recipientAddress = `4${'3'.repeat(94)}`;
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
        spendAccountIndex: 0,
        spendPrimaryAddress: '4'.repeat(95),
        spendBalanceAtomic: '0',
        spendUnlockedBalanceAtomic: '0',
        synchronized: true,
      },
      status: 'open',
      syncProgress: 100,
      transactions: [],
      walletSnapshots: {},
    } as unknown as ReturnType<typeof useWalletState>);
    mockedWalletService.validateRecipientAddress.mockRejectedValueOnce(
      new Error('wrong network'),
    );
    const preset = createPaymentLinkSendPreset({
      flowId: 'payment-link-invalid-test',
      uri: `monero:${recipientAddress}?tx_amount=2`,
      resolvedAtMs: Date.now(),
    });
    const acknowledgePaymentLink = jest.fn();
    const setParams = jest.fn();

    await ReactTestRenderer.act(async () => {
      ReactTestRenderer.create(
        <IncomingPaymentLinkAcknowledgementProvider
          onAcknowledged={acknowledgePaymentLink}
        >
          <SendScreen
            navigation={{ navigate: jest.fn(), setParams }}
            route={{ params: { paymentLinkSendPreset: preset } }}
          />
        </IncomingPaymentLinkAcknowledgementProvider>,
      );
      await Promise.resolve();
    });

    expect(acknowledgePaymentLink).toHaveBeenCalledWith(preset.flowId);
    expect(setParams).toHaveBeenCalledWith({
      paymentLinkSendPreset: undefined,
    });
    expect(mockedWalletService.prepareTransaction).not.toHaveBeenCalled();
    expect(mockedWalletService.commitTransaction).not.toHaveBeenCalled();
  });

  it('consumes an already expired payment-link route without validating or sending', async () => {
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
      snapshot: { synchronized: true },
      status: 'open',
      syncProgress: 100,
      transactions: [],
      walletSnapshots: {},
    } as unknown as ReturnType<typeof useWalletState>);
    const now = Date.now();
    const preset = createPaymentLinkSendPreset({
      flowId: 'payment-link-expired-test',
      uri: `monero:4${'4'.repeat(94)}?tx_amount=2`,
      resolvedAtMs: now - 120_000,
      expiresAtMs: now - 60_000,
    });
    const acknowledgePaymentLink = jest.fn();
    const setParams = jest.fn();

    await ReactTestRenderer.act(async () => {
      ReactTestRenderer.create(
        <IncomingPaymentLinkAcknowledgementProvider
          onAcknowledged={acknowledgePaymentLink}
        >
          <SendScreen
            navigation={{ navigate: jest.fn(), setParams }}
            route={{ params: { paymentLinkSendPreset: preset } }}
          />
        </IncomingPaymentLinkAcknowledgementProvider>,
      );
      await Promise.resolve();
    });

    expect(acknowledgePaymentLink).toHaveBeenCalledWith(preset.flowId);
    expect(setParams).toHaveBeenCalledWith({
      paymentLinkSendPreset: undefined,
    });
    expect(mockedWalletService.validateRecipientAddress).not.toHaveBeenCalled();
    expect(mockedWalletService.prepareTransaction).not.toHaveBeenCalled();
    expect(mockedWalletService.commitTransaction).not.toHaveBeenCalled();
  });

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
        spendAccountIndex: 0,
        spendPrimaryAddress: '4'.repeat(95),
        spendBalanceAtomic: '0',
        spendUnlockedBalanceAtomic: '0',
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
    const connectLedgerForSigning = jest.fn();
    const reconcileLedgerBalance = jest.fn(async () => false);
    const refreshSnapshot = jest.fn(async () => undefined);
    const refreshTransactions = jest.fn(async () => []);
    const restoreLedgerViewAfterSigning = jest.fn(async () => false);
    const publishPendingOutgoing = jest.fn();
    mockedUseWalletState.mockReturnValue({
      connectLedgerForSigning,
      error: undefined,
      reconcileLedgerBalance,
      publishPendingOutgoing,
      refreshSnapshot,
      refreshTransactions,
      restoreLedgerViewAfterSigning,
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
        spendAccountIndex: 0,
        spendPrimaryAddress: '4'.repeat(95),
        spendBalanceAtomic: '1000000000',
        spendUnlockedBalanceAtomic: '1000000000',
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
      txIds: ['ab'.repeat(32)],
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
    await ReactTestRenderer.act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockedWalletService.commitTransaction).toHaveBeenCalledTimes(1);
    expect(mockedWalletService.commitTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ walletId: 'wallet-1' }),
      'pending-max',
    );
    expect(connectLedgerForSigning).not.toHaveBeenCalled();
    expect(reconcileLedgerBalance).not.toHaveBeenCalled();
    expect(restoreLedgerViewAfterSigning).not.toHaveBeenCalled();
    expect(publishPendingOutgoing).toHaveBeenCalledWith(
      expect.objectContaining({
        hash: 'ab'.repeat(32),
        pending: true,
        direction: 'out',
      }),
    );
    expect(refreshSnapshot).toHaveBeenCalledTimes(1);
    expect(refreshTransactions).toHaveBeenCalledTimes(1);
  });

  it('never starts a Ledger handoff for a read-only software wallet', async () => {
    const recipientAddress = `4${'5'.repeat(94)}`;
    const readOnlySoftwareSession = {
      walletId: 'wallet-software-read-only',
      network: 'mainnet' as const,
      readOnly: true,
    };
    const connectLedgerForSigning = jest.fn();
    const reconcileLedgerBalance = jest.fn(async () => false);
    mockedUseWalletState.mockReturnValue({
      connectLedgerForSigning,
      error: undefined,
      reconcileLedgerBalance,
      refreshSnapshot: jest.fn(async () => undefined),
      refreshTransactions: jest.fn(async () => []),
      restoreLedgerViewAfterSigning: jest.fn(async () => false),
      registeredWallet: {
        id: 'software-read-only',
        kind: 'software',
        walletName: 'software-read-only',
        network: 'mainnet',
      },
      registeredWallets: [],
      session: readOnlySoftwareSession,
      setActiveRegisteredWallet: jest.fn(),
      snapshot: {
        balanceAtomic: '1000000000',
        unlockedBalanceAtomic: '1000000000',
        spendAccountIndex: 0,
        spendPrimaryAddress: '4'.repeat(95),
        spendBalanceAtomic: '1000000000',
        spendUnlockedBalanceAtomic: '1000000000',
        synchronized: true,
      },
      status: 'open',
      syncProgress: 100,
      transactions: [],
      walletSnapshots: {},
    } as unknown as ReturnType<typeof useWalletState>);
    mockedWalletService.prepareTransaction.mockRejectedValueOnce(
      new Error('Read-only wallets cannot sign transactions.'),
    );

    let renderer: ReactTestRenderer.ReactTestRenderer | undefined;
    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(
        <SendScreen navigation={{ navigate: jest.fn() }} />,
      );
    });
    await prepareMaxTransaction(renderer!, recipientAddress);

    expect(reconcileLedgerBalance).not.toHaveBeenCalled();
    expect(connectLedgerForSigning).not.toHaveBeenCalled();
    expect(mockedWalletService.prepareTransaction).toHaveBeenCalledWith(
      readOnlySoftwareSession,
      expect.objectContaining({ sweepAll: true }),
    );
  });

  it('uses the signing wallet directly and refreshes the companion after commit', async () => {
    const recipientAddress = `4${'6'.repeat(94)}`;
    const stalePhysicalSession = {
      walletId: 'wallet-ledger-stale',
      network: 'mainnet' as const,
      readOnly: false,
      hardwareDevice: { name: 'Ledger', type: 'ledger' as const },
    };
    const signingSession = {
      walletId: 'wallet-ledger-signing',
      network: 'mainnet' as const,
      readOnly: false,
      hardwareDevice: { name: 'Ledger', type: 'ledger' as const },
    };
    const connectLedgerForSigning = jest.fn(async () => signingSession);
    const reconcileLedgerBalance = jest
      .fn<Promise<boolean>, []>()
      .mockRejectedValueOnce(new Error('post-broadcast refresh failed'));
    const refreshSnapshot = jest.fn(async () => undefined);
    const refreshTransactions = jest.fn(async () => []);
    const restoreLedgerViewAfterSigning = jest.fn(async () => true);
    const publishPendingOutgoing = jest.fn();
    mockedUseWalletState.mockReturnValue({
      connectLedgerForSigning,
      error: undefined,
      reconcileLedgerBalance,
      publishPendingOutgoing,
      refreshSnapshot,
      refreshTransactions,
      restoreLedgerViewAfterSigning,
      registeredWallet: {
        id: 'ledger-primary',
        kind: 'hardware',
        walletName: 'ledger-primary',
        network: 'mainnet',
        restoreHeight: 2_500_000,
      },
      registeredWallets: [],
      session: stalePhysicalSession,
      setActiveRegisteredWallet: jest.fn(),
      snapshot: {
        balanceAtomic: '1000000000',
        unlockedBalanceAtomic: '1000000000',
        spendAccountIndex: 0,
        spendPrimaryAddress: '4'.repeat(95),
        spendBalanceAtomic: '1000000000',
        spendUnlockedBalanceAtomic: '1000000000',
        synchronized: true,
      },
      status: 'open',
      syncProgress: 100,
      transactions: [],
      walletSnapshots: {},
    } as unknown as ReturnType<typeof useWalletState>);
    mockedWalletService.prepareTransaction.mockResolvedValue({
      id: 'pending-ledger',
      status: 'ok',
      error: '',
      amountAtomic: '970000000',
      dustAtomic: '0',
      feeAtomic: '30000000',
      txCount: 1,
      txIds: ['prepared-ledger'],
      subaddrAccounts: [0],
      subaddrIndices: [0],
    });
    mockedWalletService.commitTransaction.mockResolvedValue({
      id: 'pending-ledger',
      status: 'ok',
      error: '',
      amountAtomic: '970000000',
      dustAtomic: '0',
      feeAtomic: '30000000',
      txCount: 1,
      txIds: ['cd'.repeat(32)],
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
    const confirmButton = renderer!.root
      .findAllByType(TouchableOpacity)
      .find(node => node.props.accessibilityLabel === 'Send Now');
    await ReactTestRenderer.act(async () => confirmButton!.props.onPress());
    await ReactTestRenderer.act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(reconcileLedgerBalance).toHaveBeenCalledTimes(1);
    expect(connectLedgerForSigning).toHaveBeenCalledTimes(1);
    expect(mockedWalletService.prepareTransaction).toHaveBeenCalledWith(
      signingSession,
      expect.objectContaining({ sweepAll: true }),
    );
    expect(mockedWalletService.prepareTransaction).not.toHaveBeenCalledWith(
      stalePhysicalSession,
      expect.anything(),
    );
    expect(restoreLedgerViewAfterSigning).toHaveBeenCalledTimes(1);
    expect(publishPendingOutgoing).toHaveBeenCalledWith(
      expect.objectContaining({
        hash: 'cd'.repeat(32),
        pending: true,
        direction: 'out',
      }),
    );
    expect(
      mockedWalletService.commitTransaction.mock.invocationCallOrder[0],
    ).toBeLessThan(
      restoreLedgerViewAfterSigning.mock.invocationCallOrder[0],
    );
    expect(
      restoreLedgerViewAfterSigning.mock.invocationCallOrder[0],
    ).toBeLessThan(reconcileLedgerBalance.mock.invocationCallOrder[0]);
    expect(refreshSnapshot).toHaveBeenCalledTimes(1);
    expect(refreshTransactions).toHaveBeenCalledTimes(1);
    const renderedText = renderer!.root
      .findAllByType(Text)
      .flatMap(node => node.props.children)
      .filter((value): value is string => typeof value === 'string');
    expect(renderedText).toContain(
      'send.transactionBroadcastRefreshPending',
    );
    expect(renderedText).not.toContain('post-broadcast refresh failed');
  });
});
