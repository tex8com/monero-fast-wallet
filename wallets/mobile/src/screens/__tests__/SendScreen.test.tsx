import React from 'react';
import { Text, TextInput, TouchableOpacity } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';
import { useFocusEffect } from '@react-navigation/native';
import type { WalletSnapshot } from '../../services/NativeMoneroWallet';

import { useWalletState } from '../../services/WalletState';
import { walletService } from '../../services/WalletService';
import { createPaymentLinkSendPreset } from '../../services/IncomingPaymentLink';
import { IncomingPaymentLinkAcknowledgementProvider } from '../../services/IncomingPaymentLinkController';
import SendScreen from '../SendScreen';
import WalletSelector from '../../components/WalletSelector';

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
    t: (key: string, params?: Record<string, string | number>) =>
      key === 'home.lockedBalance' ? `Locked: ${params?.amount} XMR`
      : key === 'send.preparingTransaction' ? `Preparing transaction… ${params?.seconds}s`
      : key === 'send.preparationProgress' ? `Preparing transaction. Review before sending. ${params?.seconds}s elapsed`
      : key === 'mfwNames.approvalExpiresIn' ? `Approval expires in ${params?.seconds}s`
      : ({
        'action.sendNow': 'Send Now',
        'action.working': 'Working...',
        'send.sendXmr': 'Send XMR',
        'send.prepareAgain': 'Prepare again',
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
      approvalExpiresAtMs: Date.now() + 120_000,
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
      approvalExpiresAtMs: Date.now() + 120_000,
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


describe('Send account balance and All feedback', () => {
  const recipientAddress = `4${'5'.repeat(94)}`;
  const liveSnapshot = {
    id: 'wallet-1', path: '/synthetic/wallet', primaryAddress: recipientAddress,
    balanceAtomic: '10000000000000', unlockedBalanceAtomic: '9000000000000',
    walletHeight: 100, daemonHeight: 100, daemonTargetHeight: 100,
    synchronized: true, snapshotRevision: 10,
    spendAccountIndex: 1, spendPrimaryAddress: recipientAddress,
    spendBalanceAtomic: '2000000000000', spendUnlockedBalanceAtomic: '1250000000000',
  } as WalletSnapshot;
  let tree: ReactTestRenderer.ReactTestRenderer | undefined;
  let state: ReturnType<typeof useWalletState>;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    mockedWalletService.validateRecipientAddress.mockImplementation(async address => address);
    const wallet = {
      id: 'primary', kind: 'fast', walletName: 'Fast Wallet', network: 'mainnet',
    };
    state = {
      registeredWallet: wallet, registeredWallets: [wallet],
      session: { walletId: 'wallet-1', network: 'mainnet' },
      snapshot: liveSnapshot, walletSnapshots: {}, transactions: [],
      refreshSnapshot: jest.fn(async () => liveSnapshot),
      refreshTransactions: jest.fn(async () => []),
      isRegisteredWalletOpen: jest.fn(() => true),
      setActiveRegisteredWallet: jest.fn(),
    } as unknown as ReturnType<typeof useWalletState>;
    mockedUseWalletState.mockImplementation(() => state);
  });

  afterEach(() => {
    ReactTestRenderer.act(() => tree?.unmount());
    tree = undefined;
    jest.useRealTimers();
  });

  async function openAmount(overrides: Partial<WalletSnapshot> = {}) {
    state = { ...state, snapshot: { ...liveSnapshot, ...overrides } };
    await ReactTestRenderer.act(async () => {
      tree = ReactTestRenderer.create(<SendScreen navigation={{ navigate: jest.fn() }} />);
    });
    await ReactTestRenderer.act(async () => {
      tree!.root.findByProps({ accessibilityLabel: 'send.manualRecipient' }).props.onPress();
    });
    await ReactTestRenderer.act(async () => {
      tree!.root.findAllByType(TextInput)[0].props.onChangeText(recipientAddress);
    });
    await ReactTestRenderer.act(async () => {
      tree!.root.findByProps({ accessibilityLabel: 'action.continue' }).props.onPress();
    });
    await ReactTestRenderer.act(async () => {
      tree!.root.findByProps({ accessibilityLabel: 'send.useThisRecipient' }).props.onPress();
    });
  }

  function allButton() {
    return tree!.root.findByProps({ accessibilityLabel: 'send.all' });
  }

  function amountInput() {
    return tree!.root.findByProps({ accessibilityLabel: 'send.amount' });
  }

  function texts(testID: string) {
    return tree!.root.findByProps({ testID }).findAllByType(Text)
      .map(node => node.props.children);
  }

  it('shows account-scoped available funds and previews All without broadcasting', async () => {
    await openAmount();
    expect(texts('send-available-balance')).toContain('1.25 XMR');
    expect(texts('send-available-balance')).not.toContain('9 XMR');
    await ReactTestRenderer.act(async () => allButton().props.onPress());
    expect(allButton().props.accessibilityState.selected).toBe(true);
    expect(amountInput().props.value).toBe('1.25');
    expect(texts('send-sweep-all-notice')).toContain('send.sweepAll');
    expect(mockedWalletService.prepareTransaction).not.toHaveBeenCalled();
    expect(mockedWalletService.commitTransaction).not.toHaveBeenCalled();
    await ReactTestRenderer.act(async () => amountInput().props.onChangeText('0.5'));
    expect(allButton().props.accessibilityState.selected).toBe(false);
    expect(tree!.root.findAllByProps({ testID: 'send-sweep-all-notice' })).toHaveLength(0);
  });

  it('does not use aggregate funds when a synchronized account scope is missing', async () => {
    await openAmount({
      spendAccountIndex: undefined, spendPrimaryAddress: undefined,
      spendBalanceAtomic: undefined, spendUnlockedBalanceAtomic: undefined,
    });
    expect(texts('send-available-balance')).toContain('home.loadingBalance');
    expect(allButton().props.disabled).toBe(true);
    await ReactTestRenderer.act(async () => amountInput().props.onChangeText('1'));
    expect(tree!.root.findByProps({ accessibilityLabel: 'Send XMR' }).props.disabled).toBe(true);
    expect(mockedWalletService.prepareTransaction).not.toHaveBeenCalled();
  });

  it('distinguishes locked incoming funds from a missing balance', async () => {
    await openAmount({ spendUnlockedBalanceAtomic: '0' });
    expect(texts('send-available-balance')).toContain('0 XMR');
    expect(texts('send-locked-balance')).toContain('Locked: 2 XMR');
    expect(allButton().props.disabled).toBe(true);
    expect(tree!.root.findByProps({ accessibilityLabel: 'Send XMR' }).props.disabled).toBe(true);
  });

  it('enables All after a complete fresh account scope is published', async () => {
    await openAmount({ spendUnlockedBalanceAtomic: undefined });
    expect(allButton().props.disabled).toBe(true);
    state = { ...state, snapshot: liveSnapshot };
    await ReactTestRenderer.act(async () => {
      tree!.update(<SendScreen navigation={{ navigate: jest.fn() }} />);
    });
    expect(texts('send-available-balance')).toContain('1.25 XMR');
    expect(allButton().props.disabled).toBe(false);
  });

  it('requests one coherent snapshot and history refresh on focus', async () => {
    await ReactTestRenderer.act(async () => {
      tree = ReactTestRenderer.create(<SendScreen navigation={{ navigate: jest.fn() }} />);
    });
    const focus = (useFocusEffect as jest.Mock).mock.calls[0][0];
    let cleanup: (() => void) | undefined;
    await ReactTestRenderer.act(async () => { cleanup = focus(); });
    expect(state.refreshSnapshot).toHaveBeenCalledTimes(1);
    expect(state.refreshTransactions).not.toHaveBeenCalled();
    cleanup?.();
  });


  function prepared(id = 'software-prepared') {
    return {
      id, status: 'ok' as const, error: '', amountAtomic: '1249970000000',
      dustAtomic: '0', feeAtomic: '30000000', txCount: 1,
      txIds: ['ab'.repeat(32)], subaddrAccounts: [1], subaddrIndices: [0],
      approvalExpiresAtMs: Date.now() + 120_000,
    };
  }

  async function selectAllAndPrepare() {
    await openAmount();
    await ReactTestRenderer.act(async () => allButton().props.onPress());
    await ReactTestRenderer.act(async () => {
      await tree!.root.findByProps({ accessibilityLabel: 'Send XMR' }).props.onPress();
    });
  }

  it('shows preparation immediately, measures a long wait, and blocks duplicate taps until Review', async () => {
    let resolvePreparation!: (value: ReturnType<typeof prepared>) => void;
    const pending = new Promise<ReturnType<typeof prepared>>(resolve => { resolvePreparation = resolve; });
    mockedWalletService.prepareTransaction.mockReturnValueOnce(pending);
    await openAmount();
    await ReactTestRenderer.act(async () => allButton().props.onPress());
    const press = tree!.root.findByProps({ accessibilityLabel: 'Send XMR' }).props.onPress;
    let work: Promise<void> | undefined;
    await ReactTestRenderer.act(async () => {
      work = press();
      press();
    });
    expect(mockedWalletService.prepareTransaction).toHaveBeenCalledTimes(1);
    expect(texts('send-preparation-progress')).toContain('Preparing transaction. Review before sending. 0s elapsed');
    expect(tree!.root.findByProps({ accessibilityLabel: 'Send XMR' }).props.disabled).toBe(true);
    expect(amountInput().props.editable).toBe(false);
    const currency = tree!.root.findAllByType(TouchableOpacity)
      .filter(button => button.props.accessibilityRole === 'radio');
    expect(currency.every(button => button.props.disabled)).toBe(true);
    const changeRecipient = tree!.root.findByProps({ testID: 'send-change-recipient' });
    const keypad = tree!.root.findByProps({ accessibilityLabel: '1' });
    expect(changeRecipient.props.disabled).toBe(true);
    expect(keypad.props.disabled).toBe(true);
    await ReactTestRenderer.act(async () => {
      // Guards also reject already-queued events from the previous render.
      amountInput().props.onChangeText('2');
      currency[1].props.onPress();
      keypad.props.onPress();
      changeRecipient.props.onPress();
      await tree!.root.findByType(WalletSelector).props.onSelect({
        id: 'other-wallet', label: 'Other', kind: 'fast', meta: 'mainnet',
      });
    });
    expect(amountInput().props.value).toBe('1.25');
    expect(allButton().props.accessibilityState.selected).toBe(true);
    expect(state.setActiveRegisteredWallet).not.toHaveBeenCalled();
    await ReactTestRenderer.act(async () => { jest.advanceTimersByTime(80_000); });
    expect(texts('send-preparation-progress')).toContain('Preparing transaction. Review before sending. 80s elapsed');
    expect(mockedWalletService.commitTransaction).not.toHaveBeenCalled();
    await ReactTestRenderer.act(async () => {
      resolvePreparation(prepared());
      await work;
    });
    expect(tree!.root.findByProps({ accessibilityLabel: 'Send Now' })).toBeDefined();
    expect(texts('send-approval-countdown')).toContain('Approval expires in 120s');
    expect(tree!.root.findAllByProps({ testID: 'send-preparation-progress' })).toHaveLength(0);
    expect(mockedWalletService.prepareTransaction).toHaveBeenCalledTimes(1);
    expect(mockedWalletService.commitTransaction).not.toHaveBeenCalled();
  });

  it('discards a late prepared result when the selected native session changed', async () => {
    let resolvePreparation!: (value: ReturnType<typeof prepared>) => void;
    mockedWalletService.prepareTransaction.mockReturnValueOnce(new Promise(resolve => { resolvePreparation = resolve; }));
    await openAmount();
    await ReactTestRenderer.act(async () => allButton().props.onPress());
    let work: Promise<void> | undefined;
    await ReactTestRenderer.act(async () => {
      work = tree!.root.findByProps({ accessibilityLabel: 'Send XMR' }).props.onPress();
    });
    state = { ...state, session: { walletId: 'externally-reopened-session', network: 'mainnet' } };
    await ReactTestRenderer.act(async () => { tree!.update(<SendScreen navigation={{ navigate: jest.fn() }} />); });
    await ReactTestRenderer.act(async () => {
      resolvePreparation(prepared());
      await work;
    });
    expect(tree!.root.findAllByProps({ accessibilityLabel: 'Send Now' })).toHaveLength(0);
    expect(tree!.root.findAllByProps({ testID: 'send-approval-countdown' })).toHaveLength(0);
    expect(tree!.root.findAllByProps({ testID: 'send-preparation-progress' })).toHaveLength(0);
    expect(amountInput().props.editable).toBe(true);
    expect(tree!.root.findAllByType(Text).map(node => node.props.children)).toContain('send.preparationChanged');
    expect(mockedWalletService.prepareTransaction).toHaveBeenCalledTimes(1);
    expect(mockedWalletService.commitTransaction).not.toHaveBeenCalled();
  });

  it('does not submit a retained review from the previous wallet after an external selection', async () => {
    mockedWalletService.prepareTransaction.mockResolvedValueOnce(prepared());
    await selectAllAndPrepare();
    const priorWalletSend = tree!.root.findByProps({ accessibilityLabel: 'Send Now' }).props.onPress;
    state = {
      ...state,
      registeredWallet: { ...state.registeredWallet!, id: 'other-registration' },
      session: { walletId: 'other-wallet-session', network: 'mainnet' },
    };
    await ReactTestRenderer.act(async () => { tree!.update(<SendScreen navigation={{ navigate: jest.fn() }} />); });
    // A callback queued by the previous render must also check current refs.
    await ReactTestRenderer.act(async () => { await priorWalletSend(); });
    expect(mockedWalletService.commitTransaction).not.toHaveBeenCalled();
    expect(mockedWalletService.prepareTransaction).toHaveBeenCalledTimes(1);
    expect(tree!.root.findAllByProps({ accessibilityLabel: 'Send Now' })).toHaveLength(0);
    expect(tree!.root.findByProps({ accessibilityLabel: 'Prepare again' })).toBeDefined();
    expect(tree!.root.findAllByType(Text).map(node => node.props.children)).toContain('send.preparationChanged');
  });

  it('does not submit an old review after a new payment route clears its pending transaction', async () => {
    mockedWalletService.prepareTransaction.mockResolvedValueOnce(prepared());
    await selectAllAndPrepare();
    const priorReviewSend = tree!.root.findByProps({ accessibilityLabel: 'Send Now' }).props.onPress;
    const preset = createPaymentLinkSendPreset({
      flowId: 'replacement-payment-same-recipient',
      uri: `monero:${recipientAddress}?tx_amount=0.5`,
      resolvedAtMs: Date.now(),
    });
    await ReactTestRenderer.act(async () => {
      tree!.update(<SendScreen navigation={{ navigate: jest.fn(), setParams: jest.fn() }}
        route={{ params: { paymentLinkSendPreset: preset } }} />);
    });
    await ReactTestRenderer.act(async () => { await priorReviewSend(); });
    expect(mockedWalletService.commitTransaction).not.toHaveBeenCalled();
    expect(mockedWalletService.prepareTransaction).toHaveBeenCalledTimes(1);
    expect(tree!.root.findAllByProps({ accessibilityLabel: 'Send Now' })).toHaveLength(0);
    expect(tree!.root.findAllByType(Text).map(node => node.props.children)).toContain('send.preparationChanged');
  });

  it('rejects an approval that expires between the last timer tick and Send Now', async () => {
    mockedWalletService.prepareTransaction.mockResolvedValueOnce(prepared());
    await selectAllAndPrepare();
    const staleSend = tree!.root.findByProps({ accessibilityLabel: 'Send Now' }).props.onPress;
    jest.setSystemTime(Date.now() + 120_001);
    await ReactTestRenderer.act(async () => { await staleSend(); });
    expect(mockedWalletService.commitTransaction).not.toHaveBeenCalled();
    expect(tree!.root.findByProps({ accessibilityLabel: 'Prepare again' })).toBeDefined();
    expect(tree!.root.findAllByProps({ accessibilityLabel: 'Send Now' })).toHaveLength(0);
    expect(mockedWalletService.prepareTransaction).toHaveBeenCalledTimes(1);

    // A stale prepared signing session must not survive the retry. The next
    // user action starts preparation against the current selected session.
    state = { ...state, session: { walletId: 'reopened-software', network: 'mainnet' } };
    await ReactTestRenderer.act(async () => { tree!.update(<SendScreen navigation={{ navigate: jest.fn() }} />); });
    mockedWalletService.prepareTransaction.mockResolvedValueOnce(prepared('fresh-approval'));
    await ReactTestRenderer.act(async () => {
      await tree!.root.findByProps({ accessibilityLabel: 'Prepare again' }).props.onPress();
    });
    expect(mockedWalletService.prepareTransaction).toHaveBeenCalledTimes(2);
    expect(mockedWalletService.prepareTransaction).toHaveBeenLastCalledWith(
      expect.objectContaining({ walletId: 'reopened-software' }),
      expect.objectContaining({ sweepAll: true }),
    );
    expect(mockedWalletService.commitTransaction).not.toHaveBeenCalled();
  });

  it('counts down normal approvals and discards them at the native deadline without automatic preparation', async () => {
    mockedWalletService.prepareTransaction.mockResolvedValueOnce(prepared());
    await selectAllAndPrepare();
    await ReactTestRenderer.act(async () => { jest.advanceTimersByTime(1_000); });
    expect(texts('send-approval-countdown')).toContain('Approval expires in 119s');
    await ReactTestRenderer.act(async () => { jest.advanceTimersByTime(119_000); });
    expect(tree!.root.findByProps({ accessibilityLabel: 'Prepare again' })).toBeDefined();
    expect(tree!.root.findAllByProps({ testID: 'send-approval-countdown' })).toHaveLength(0);
    expect(mockedWalletService.prepareTransaction).toHaveBeenCalledTimes(1);
    expect(mockedWalletService.commitTransaction).not.toHaveBeenCalled();
  });

  it('returns to explicit preparation when a queued native commit rejects an expired approval', async () => {
    mockedWalletService.prepareTransaction.mockResolvedValueOnce(prepared());
    let rejectCommit!: (error: Error) => void;
    mockedWalletService.commitTransaction.mockReturnValueOnce(new Promise((_resolve, reject) => { rejectCommit = reject; }));
    await selectAllAndPrepare();
    const confirm = tree!.root.findByProps({ accessibilityLabel: 'Send Now' }).props.onPress;
    let submission: Promise<void> | undefined;
    await ReactTestRenderer.act(async () => { submission = confirm(); confirm(); });
    expect(mockedWalletService.commitTransaction).toHaveBeenCalledTimes(1);
    await ReactTestRenderer.act(async () => { jest.advanceTimersByTime(125_000); });
    // A timer must not claim that an in-flight native commit was cancelled.
    expect(tree!.root.findByProps({ accessibilityLabel: 'Send Now' }).props.disabled).toBe(true);
    await ReactTestRenderer.act(async () => {
      rejectCommit(Object.assign(new Error('Transaction approval is missing, expired, or already used. Prepare it again.'), {
        code: 'monero_wallet_android_transaction_approval_missing',
      }));
      await submission;
    });
    expect(tree!.root.findByProps({ accessibilityLabel: 'Prepare again' }).props.disabled).toBe(false);
    expect(tree!.root.findAllByProps({ accessibilityLabel: 'Send Now' })).toHaveLength(0);
    expect(mockedWalletService.prepareTransaction).toHaveBeenCalledTimes(1);
    expect(mockedWalletService.commitTransaction).toHaveBeenCalledTimes(1);
  });

  it('clears preparation progress and busy state after a native preparation error', async () => {
    mockedWalletService.prepareTransaction.mockRejectedValueOnce(new Error('Native preparation failed'));
    await selectAllAndPrepare();
    expect(tree!.root.findAllByProps({ testID: 'send-preparation-progress' })).toHaveLength(0);
    expect(tree!.root.findByProps({ accessibilityLabel: 'Send XMR' }).props.disabled).toBe(false);
    expect(mockedWalletService.commitTransaction).not.toHaveBeenCalled();
  });
});
