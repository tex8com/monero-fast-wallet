import React from 'react';
import { Platform, StyleSheet, Text, TextInput, TouchableOpacity } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';
import { useFocusEffect } from '@react-navigation/native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { PreparedTransaction, WalletSnapshot } from '../../services/NativeMoneroWallet';

import { useWalletState } from '../../services/WalletState';
import { walletService } from '../../services/WalletService';
import { createPaymentLinkSendPreset } from '../../services/IncomingPaymentLink';
import { IncomingPaymentLinkAcknowledgementProvider } from '../../services/IncomingPaymentLinkController';
import SendScreen from '../SendScreen';
import WalletSelector from '../../components/WalletSelector';
import LedgerSigningModal from '../../components/LedgerSigningModal';
import type { LedgerSigningControl } from '../../services/LedgerSigningFlow';
import { colors } from '../../theme/colors';
import * as mfwNameResolution from '../../services/MfwNameResolutionService';
import { saveMfwResolverPreference } from '../../services/MfwResolverSettings';

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
    prepareSendPlan: jest.fn(),
    sendSourceIdentity: jest.fn(async session => `${session.network}:physical-${session.walletId}`),
    cancelLedgerOperation: jest.fn(async () => undefined),
    commitSendPlan: jest.fn(),
    discardSendPlan: jest.fn(async () => undefined),
    sendPlanStatus: jest.fn(),
    listSendPlans: jest.fn(async () => []),
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


function wholeWalletPrepared(tx: PreparedTransaction) {
  return { ...tx, sendPlan: {
    id: tx.id, status: 'ok' as const, phase: 'prepared' as const,
    amountAtomic: tx.amountAtomic, feeAtomic: tx.feeAtomic,
    totalAtomic: (BigInt(tx.amountAtomic) + BigInt(tx.feeAtomic)).toString(),
    txCount: tx.txCount, txIds: tx.txIds, address: '4'.repeat(95),
    broadcastAttempted: false, leaseHeld: true, broadcastedTotalsKnown: true,
    broadcastedTxIds: [], uncertainTxIds: [], remainingTxIds: tx.txIds,
    broadcastedAmountAtomic: '0', broadcastedFeeAtomic: '0',
  } };
}
function completedPlan(tx: PreparedTransaction) {
  return { ...wholeWalletPrepared(tx).sendPlan, phase: 'complete' as const,
    leaseHeld: false, broadcastAttempted: true, broadcastedTxIds: tx.txIds,
    remainingTxIds: [], broadcastedAmountAtomic: tx.amountAtomic, broadcastedFeeAtomic: tx.feeAtomic };
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
    expect(mockedWalletService.prepareSendPlan).not.toHaveBeenCalled();
    expect(mockedWalletService.commitSendPlan).not.toHaveBeenCalled();
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
    expect(mockedWalletService.prepareSendPlan).not.toHaveBeenCalled();
    expect(mockedWalletService.commitSendPlan).not.toHaveBeenCalled();
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
    expect(mockedWalletService.prepareSendPlan).not.toHaveBeenCalled();
    expect(mockedWalletService.commitSendPlan).not.toHaveBeenCalled();
  });

  it('refreshes the resolved recipient after changing the resolver on a mounted tab', async () => {
    jest.useFakeTimers();
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

    const firstAddress = `4${'1'.repeat(94)}`;
    const secondAddress = `4${'2'.repeat(94)}`;
    const resolveName = jest
      .spyOn(mfwNameResolution, 'resolveConfiguredMfwNameForPayment')
      .mockResolvedValueOnce(firstAddress)
      .mockResolvedValueOnce(secondAddress);
    const suggestions = jest
      .spyOn(mfwNameResolution, 'fetchConfiguredMfwNameSuggestions')
      .mockResolvedValue([]);
    const savePreference = jest
      .spyOn(AsyncStorage, 'setItem')
      .mockResolvedValue(undefined);
    const hasAddress = (value: string) =>
      renderer!.root
        .findAllByType(Text)
        .some(node => node.props.children === value);

    try {
      await ReactTestRenderer.act(async () => {
        jest.advanceTimersByTime(250);
      });
      expect(hasAddress(firstAddress)).toBe(true);

      await ReactTestRenderer.act(async () => {
        await saveMfwResolverPreference('tex8');
      });
      expect(hasAddress(firstAddress)).toBe(false);
      expect(continueButton!.props.disabled).toBe(true);

      await ReactTestRenderer.act(async () => {
        jest.advanceTimersByTime(250);
      });
      expect(resolveName).toHaveBeenCalledTimes(2);
      expect(hasAddress(secondAddress)).toBe(true);
    } finally {
      await ReactTestRenderer.act(async () => renderer!.unmount());
      resolveName.mockRestore();
      suggestions.mockRestore();
      savePreference.mockRestore();
      jest.useRealTimers();
    }
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
    mockedWalletService.prepareSendPlan.mockResolvedValue(wholeWalletPrepared({
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
    }));
    mockedWalletService.commitSendPlan.mockResolvedValue(completedPlan({
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
    }));

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

    expect(mockedWalletService.prepareSendPlan).toHaveBeenCalledWith(
      [expect.objectContaining({ walletId: 'wallet-1' })],
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

    expect(mockedWalletService.commitSendPlan).toHaveBeenCalledTimes(1);
    expect(mockedWalletService.commitSendPlan).toHaveBeenCalledWith(
      'pending-max',
    );
    expect(connectLedgerForSigning).not.toHaveBeenCalled();
    expect(reconcileLedgerBalance).not.toHaveBeenCalled();
    expect(restoreLedgerViewAfterSigning).not.toHaveBeenCalled();
    expect(publishPendingOutgoing).not.toHaveBeenCalled();
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
    mockedWalletService.prepareSendPlan.mockRejectedValueOnce(
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
    expect(mockedWalletService.prepareSendPlan).toHaveBeenCalledWith(
      [readOnlySoftwareSession],
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
    mockedWalletService.prepareSendPlan.mockResolvedValue(wholeWalletPrepared({
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
    }));
    mockedWalletService.commitSendPlan.mockResolvedValue(completedPlan({
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
    }));

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
    expect(mockedWalletService.prepareSendPlan).toHaveBeenCalledWith(
      [signingSession],
      expect.objectContaining({ sweepAll: true }),
    );
    expect(mockedWalletService.prepareSendPlan).not.toHaveBeenCalledWith(
      [stalePhysicalSession],
      expect.anything(),
    );
    expect(restoreLedgerViewAfterSigning).toHaveBeenCalledTimes(1);
    expect(publishPendingOutgoing).not.toHaveBeenCalled();
    expect(
      mockedWalletService.commitSendPlan.mock.invocationCallOrder[0],
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
      'send.planOutcome.complete',
    );
    expect(renderedText).not.toContain('post-broadcast refresh failed');
  });
});


describe('Whole-wallet balance and All feedback', () => {
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
    mockedWalletService.sendSourceIdentity.mockImplementation(async source => `${source.network}:physical-${source.walletId}`);
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

  it('shows all-account available funds and previews All without broadcasting', async () => {
    await openAmount();
    expect(texts('send-available-balance')).toContain('9 XMR');
    expect(texts('send-available-balance')).not.toContain('1.25 XMR');
    await ReactTestRenderer.act(async () => allButton().props.onPress());
    expect(allButton().props.accessibilityState.selected).toBe(true);
    expect(amountInput().props.value).toBe('9');
    expect(texts('send-sweep-all-notice')).toContain('send.sweepAll');
    expect(mockedWalletService.prepareSendPlan).not.toHaveBeenCalled();
    expect(mockedWalletService.commitSendPlan).not.toHaveBeenCalled();
    await ReactTestRenderer.act(async () => amountInput().props.onChangeText('0.5'));
    expect(allButton().props.accessibilityState.selected).toBe(false);
    expect(tree!.root.findAllByProps({ testID: 'send-sweep-all-notice' })).toHaveLength(0);
  });

  it('uses the authoritative whole-wallet balance without a legacy account scope', async () => {
    await openAmount({
      spendAccountIndex: undefined, spendPrimaryAddress: undefined,
      spendBalanceAtomic: undefined, spendUnlockedBalanceAtomic: undefined,
    });
    expect(texts('send-available-balance')).toContain('9 XMR');
    expect(allButton().props.disabled).toBe(false);
    await ReactTestRenderer.act(async () => amountInput().props.onChangeText('1'));
    expect(tree!.root.findByProps({ accessibilityLabel: 'Send XMR' }).props.disabled).toBe(false);
    expect(mockedWalletService.prepareSendPlan).not.toHaveBeenCalled();
  });

  it('distinguishes locked incoming funds from a missing balance', async () => {
    await openAmount({ unlockedBalanceAtomic: '0' });
    expect(texts('send-available-balance')).toContain('0 XMR');
    expect(texts('send-locked-balance')).toContain('Locked: 10 XMR');
    expect(allButton().props.disabled).toBe(true);
    expect(tree!.root.findByProps({ accessibilityLabel: 'Send XMR' }).props.disabled).toBe(true);
  });

  it('enables All after a synchronized whole-wallet snapshot is published', async () => {
    await openAmount({ synchronized: false });
    expect(allButton().props.disabled).toBe(true);
    state = { ...state, snapshot: liveSnapshot };
    await ReactTestRenderer.act(async () => {
      tree!.update(<SendScreen navigation={{ navigate: jest.fn() }} />);
    });
    expect(texts('send-available-balance')).toContain('9 XMR');
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

  it('updates the MAX preview when the complete wallet snapshot changes', async () => {
    await openAmount();
    await ReactTestRenderer.act(async () => allButton().props.onPress());
    state = { ...state, snapshot: { ...liveSnapshot, balanceAtomic: '12000000000000', unlockedBalanceAtomic: '11000000000000' } };
    await ReactTestRenderer.act(async () => { tree!.update(<SendScreen navigation={{ navigate: jest.fn() }} />); });
    expect(amountInput().props.value).toBe('11');
    expect(mockedWalletService.prepareSendPlan).not.toHaveBeenCalled();
  });

  it('includes an additional physical wallet only after explicit selection for a fixed payment', async () => {
    const extra = { ...state.registeredWallet!, id: 'extra', kind: 'software' as const, walletName: 'Extra', network: 'mainnet' as const };
    const extraSession = { walletId: 'session-extra', registrationId: 'extra', network: 'mainnet' as const };
    state = { ...state,
      registeredWallets: [...state.registeredWallets, extra],
      getRegisteredWalletSession: jest.fn(id => id === 'extra' ? extraSession : state.session),
      walletSnapshots: { extra: { ...liveSnapshot, id: 'session-extra', primaryAddress: '8'.repeat(95), balanceAtomic: '3000000000000', unlockedBalanceAtomic: '3000000000000' } },
    } as ReturnType<typeof useWalletState>;
    await openAmount();
    await ReactTestRenderer.act(async () => amountInput().props.onChangeText('10'));
    expect(tree!.root.findByProps({ accessibilityLabel: 'Send XMR' }).props.disabled).toBe(true);
    expect(mockedWalletService.prepareSendPlan).not.toHaveBeenCalled();
    await ReactTestRenderer.act(async () => tree!.root.findByProps({ testID: 'send-add-wallet' }).props.onPress());
    const checkbox = tree!.root.findByProps({ testID: 'send-source-extra' });
    expect(checkbox.props.accessibilityState.checked).toBe(false);
    await ReactTestRenderer.act(async () => checkbox.props.onPress());
    expect(texts('send-available-balance')).toContain('12 XMR');
    mockedWalletService.prepareSendPlan.mockResolvedValueOnce(wholeWalletPrepared({
      id: 'two-wallet-plan', status: 'ok', error: '', amountAtomic: '10000000000000',
      feeAtomic: '40000000', dustAtomic: '0', txCount: 2, txIds: ['tx-one', 'tx-two'],
      subaddrAccounts: [], subaddrIndices: [],
    }));
    await ReactTestRenderer.act(async () => tree!.root.findByProps({ accessibilityLabel: 'Send XMR' }).props.onPress());
    expect(mockedWalletService.prepareSendPlan).toHaveBeenCalledWith([
      expect.objectContaining({ walletId: 'wallet-1' }), extraSession,
    ], expect.objectContaining({ amountAtomic: '10000000000000', sweepAll: false }));
    expect(mockedWalletService.commitSendPlan).not.toHaveBeenCalled();
  });

  it('discovers held native receipts after a renderer restart without a cached plan identifier', async () => {
    const receipt = { id: 'recovered-plan', status: 'uncertain' as const, phase: 'interrupted' as const,
      address: '8'.repeat(95), txCount: 2, txIds: ['saved-one', 'saved-two'], leaseHeld: true,
      broadcastAttempted: true, broadcastedTotalsKnown: false,
      broadcastedAmountAtomic: null, broadcastedFeeAtomic: null, uncertainTxIds: ['saved-one'] };
    mockedWalletService.listSendPlans.mockResolvedValueOnce([receipt]);
    await ReactTestRenderer.act(async () => { tree = ReactTestRenderer.create(<SendScreen navigation={{ navigate: jest.fn() }} />); });
    const savedReceiptFocus = (useFocusEffect as jest.Mock).mock.calls[1][0];
    await ReactTestRenderer.act(async () => { savedReceiptFocus(); await Promise.resolve(); });
    await ReactTestRenderer.act(async () => tree!.root.findByProps({ testID: 'send-saved-plan-recovered-plan' }).props.onPress());
    expect(tree!.root.findByProps({ testID: 'send-plan-receipt' })).toBeDefined();
    expect(tree!.root.findAllByProps({ accessibilityLabel: 'Send Now' })).toHaveLength(0);
    expect(mockedWalletService.prepareSendPlan).not.toHaveBeenCalled();
    expect(mockedWalletService.commitSendPlan).not.toHaveBeenCalled();
  });

  it('excludes a restored-seed alias using native master identity and keeps a genuinely different master selectable', async () => {
    const alias = { ...state.registeredWallet!, id: 'alias', walletName: 'Restored alias' };
    const other = { ...state.registeredWallet!, id: 'other-master', walletName: 'Different master' };
    const otherNetwork = { ...state.registeredWallet!, id: 'other-network', network: 'testnet' as const };
    const sessions = {
      alias: { walletId: 'session-alias', registrationId: 'alias', network: 'mainnet' as const },
      'other-master': { walletId: 'session-other', registrationId: 'other-master', network: 'mainnet' as const },
      'other-network': { walletId: 'session-testnet', registrationId: 'other-network', network: 'testnet' as const },
    };
    mockedWalletService.sendSourceIdentity.mockImplementation(async source =>
      `${source.network}:${source.walletId === 'session-other' ? 'native-master-b' : 'native-master-a'}`);
    state = { ...state,
      registeredWallets: [...state.registeredWallets, alias, other, otherNetwork],
      getRegisteredWalletSession: jest.fn(id => sessions[id as keyof typeof sessions]),
      walletSnapshots: {
        // Cached account addresses deliberately disagree with physical identity.
        alias: { ...liveSnapshot, primaryAddress: '8'.repeat(95) },
        'other-master': { ...liveSnapshot, primaryAddress: liveSnapshot.primaryAddress,
          balanceAtomic: '3000000000000', unlockedBalanceAtomic: '3000000000000' },
        'other-network': liveSnapshot,
      },
    };
    await openAmount();
    await ReactTestRenderer.act(async () => tree!.root.findByProps({ testID: 'send-add-wallet' }).props.onPress());
    expect(tree!.root.findAllByProps({ testID: 'send-source-alias' })).toHaveLength(0);
    expect(tree!.root.findAllByProps({ testID: 'send-source-other-network' })).toHaveLength(0);
    expect(texts('send-available-balance')).toContain('9 XMR');
    await ReactTestRenderer.act(async () => tree!.root.findByProps({ testID: 'send-source-other-master' }).props.onPress());
    expect(texts('send-available-balance')).toContain('12 XMR');
    expect(mockedWalletService.prepareSendPlan).not.toHaveBeenCalled();
    expect(mockedWalletService.sendSourceIdentity.mock.calls.some(([source]) => source.walletId === 'session-testnet')).toBe(false);
  });

  it('ignores an old master-identity response after selecting another primary wallet', async () => {
    const extra = { ...state.registeredWallet!, id: 'extra-identity' };
    const extraSession = { walletId: 'identity-extra', network: 'mainnet' as const };
    let resolveOldPrimary!: (identity: string) => void;
    mockedWalletService.sendSourceIdentity.mockImplementation(async source => source.walletId === 'wallet-1'
      ? new Promise(resolve => { resolveOldPrimary = resolve; }) : 'mainnet:shared-master');
    state = { ...state, registeredWallets: [...state.registeredWallets, extra],
      getRegisteredWalletSession: jest.fn(() => extraSession),
      walletSnapshots: { 'extra-identity': liveSnapshot },
    };
    await openAmount();
    const nextWallet = { ...state.registeredWallet!, id: 'next-primary' };
    state = { ...state, registeredWallet: nextWallet, registeredWallets: [nextWallet, extra],
      session: { walletId: 'next-native-session', network: 'mainnet' },
      snapshot: { ...liveSnapshot, balanceAtomic: '2000000000000', unlockedBalanceAtomic: '2000000000000' },
    };
    await ReactTestRenderer.act(async () => { tree!.update(<SendScreen navigation={{ navigate: jest.fn() }} />); });
    expect(tree!.root.findAllByProps({ testID: 'send-add-wallet' })).toHaveLength(0);
    await ReactTestRenderer.act(async () => resolveOldPrimary('mainnet:old-different-master'));
    expect(tree!.root.findAllByProps({ testID: 'send-add-wallet' })).toHaveLength(0);
    expect(texts('send-available-balance')).toContain('2 XMR');
  });


  function prepared(id = 'software-prepared') {
    return wholeWalletPrepared({
      id, status: 'ok' as const, error: '', amountAtomic: '8999970000000',
      dustAtomic: '0', feeAtomic: '30000000', txCount: 1,
      txIds: ['ab'.repeat(32)], subaddrAccounts: [1], subaddrIndices: [0],
      approvalExpiresAtMs: Date.now() + 120_000,
    });
  }

  async function selectAllAndPrepare() {
    await openAmount();
    await ReactTestRenderer.act(async () => allButton().props.onPress());
    await ReactTestRenderer.act(async () => {
      await tree!.root.findByProps({ accessibilityLabel: 'Send XMR' }).props.onPress();
    });
  }

  async function openPendingLedgerDiscovery() {
    let resolveConnection!: (value: ReturnType<typeof useWalletState>['session']) => void;
    let control!: LedgerSigningControl;
    state = { ...state,
      registeredWallet: { ...state.registeredWallet!, kind: 'hardware' },
      session: { ...state.session!, readOnly: true, hardwareDevice: { name: 'Ledger', type: 'ledger' } },
      connectLedgerForSigning: jest.fn(next => {
        control = next!;
        return new Promise(resolve => { resolveConnection = resolve; });
      }),
      restoreLedgerViewAfterSigning: jest.fn(async () => true),
    };
    await openAmount();
    await ReactTestRenderer.act(async () => allButton().props.onPress());
    let work: Promise<void> | undefined;
    await ReactTestRenderer.act(async () => {
      work = tree!.root.findByProps({ accessibilityLabel: 'Send XMR' }).props.onPress();
    });
    return { control, resolveConnection, work };
  }

  it('cancels iOS discovery cooperatively without calling an unavailable native selector', async () => {
    const platform = jest.replaceProperty(Platform, 'OS', 'ios');
    try {
      const flow = await openPendingLedgerDiscovery();
      const modal = tree!.root.findByType(LedgerSigningModal);
      expect(modal.props.canCancel).toBe(true);
      await ReactTestRenderer.act(async () => modal.props.onCancel());
      expect(flow.control.isCancelled!()).toBe(true);
      expect(mockedWalletService.cancelLedgerOperation).not.toHaveBeenCalled();
      expect(mockedWalletService.prepareSendPlan).not.toHaveBeenCalled();
      await ReactTestRenderer.act(async () => { flow.resolveConnection(undefined); await flow.work; });
      expect(mockedWalletService.prepareSendPlan).not.toHaveBeenCalled();
    } finally { platform.restore(); }
  });

  it('ignores an old iOS discovery cancel callback after native Ledger work has started', async () => {
    const platform = jest.replaceProperty(Platform, 'OS', 'ios');
    try {
      const flow = await openPendingLedgerDiscovery();
      const oldCancel = tree!.root.findByType(LedgerSigningModal).props.onCancel;
      await ReactTestRenderer.act(async () => flow.control.onProgress!({ phase: 'synchronizing-wallet' }));
      expect(tree!.root.findByType(LedgerSigningModal).props.canCancel).toBe(false);
      await ReactTestRenderer.act(async () => oldCancel());
      expect(flow.control.isCancelled!()).toBe(false);
      expect(mockedWalletService.cancelLedgerOperation).not.toHaveBeenCalled();
      let finishPreparation!: (value: ReturnType<typeof prepared>) => void;
      mockedWalletService.prepareSendPlan.mockReturnValueOnce(new Promise(resolve => { finishPreparation = resolve; }));
      await ReactTestRenderer.act(async () => flow.resolveConnection({
        ...state.session!, walletId: 'ledger-signing', readOnly: false,
      }));
      expect(tree!.root.findByType(LedgerSigningModal).props.canCancel).toBe(false);
      await ReactTestRenderer.act(async () => oldCancel());
      expect(flow.control.isCancelled!()).toBe(false);
      await ReactTestRenderer.act(async () => { finishPreparation(prepared()); await flow.work; });
      expect(tree!.root.findByProps({ accessibilityLabel: 'Send Now' })).toBeDefined();
      expect(mockedWalletService.cancelLedgerOperation).not.toHaveBeenCalled();
    } finally { platform.restore(); }
  });

  it('keeps actual Android transport cancellation available during Ledger work', async () => {
    const platform = jest.replaceProperty(Platform, 'OS', 'android');
    try {
      const flow = await openPendingLedgerDiscovery();
      await ReactTestRenderer.act(async () => flow.control.onProgress!({ phase: 'synchronizing-wallet' }));
      const modal = tree!.root.findByType(LedgerSigningModal);
      expect(modal.props.canCancel).toBe(true);
      await ReactTestRenderer.act(async () => modal.props.onCancel());
      expect(flow.control.isCancelled!()).toBe(true);
      expect(mockedWalletService.cancelLedgerOperation).toHaveBeenCalledTimes(1);
      await ReactTestRenderer.act(async () => { flow.resolveConnection(undefined); await flow.work; });
      expect(mockedWalletService.prepareSendPlan).not.toHaveBeenCalled();
    } finally { platform.restore(); }
  });

  it.each(['success', 'failure'] as const)(
    'bounds hardware status polling and ignores a late dialog reply after preparation %s',
    async outcome => {
      const flow = await openPendingLedgerDiscovery();
      let finishPreparation!: (value: ReturnType<typeof prepared>) => void;
      let rejectPreparation!: (reason: Error) => void;
      mockedWalletService.prepareSendPlan.mockReturnValueOnce(new Promise((resolve, reject) => {
        finishPreparation = resolve;
        rejectPreparation = reject;
      }));
      let finishStatus!: (value: Awaited<ReturnType<typeof walletService.getHardwareWalletStatus>>) => void;
      mockedWalletService.getHardwareWalletStatus.mockReturnValueOnce(new Promise(resolve => {finishStatus = resolve;}));
      await ReactTestRenderer.act(async () => flow.resolveConnection({
        ...state.session!, walletId: 'ledger-signing', readOnly: false,
      }));
      expect(tree!.root.findByType(LedgerSigningModal).props.progress.phase).toBe('preparing-transaction');
      await ReactTestRenderer.act(async () => {jest.advanceTimersByTime(5_000);});
      expect(mockedWalletService.getHardwareWalletStatus).toHaveBeenCalledTimes(1);
      await ReactTestRenderer.act(async () => {
        if (outcome === 'success') finishPreparation(prepared());
        else rejectPreparation(new Error('unexpected error: Fee denied on device.'));
        await flow.work;
      });
      await ReactTestRenderer.act(async () => {
        finishStatus({requiresUserAction: true} as unknown as Awaited<ReturnType<typeof walletService.getHardwareWalletStatus>>);
        jest.advanceTimersByTime(5_000);
      });
      expect(tree!.root.findAllByProps({testID: 'ledger-signing-modal'})).toHaveLength(0);
      expect(mockedWalletService.getHardwareWalletStatus).toHaveBeenCalledTimes(1);
      expect(mockedWalletService.commitSendPlan).not.toHaveBeenCalled();
    },
  );

  it('shows preparation immediately, measures a long wait, and blocks duplicate taps until Review', async () => {
    let resolvePreparation!: (value: ReturnType<typeof prepared>) => void;
    const pending = new Promise<ReturnType<typeof prepared>>(resolve => { resolvePreparation = resolve; });
    mockedWalletService.prepareSendPlan.mockReturnValueOnce(pending);
    await openAmount();
    await ReactTestRenderer.act(async () => allButton().props.onPress());
    const press = tree!.root.findByProps({ accessibilityLabel: 'Send XMR' }).props.onPress;
    let work: Promise<void> | undefined;
    await ReactTestRenderer.act(async () => {
      work = press();
      press();
    });
    expect(mockedWalletService.prepareSendPlan).toHaveBeenCalledTimes(1);
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
    expect(amountInput().props.value).toBe('9');
    expect(allButton().props.accessibilityState.selected).toBe(true);
    expect(state.setActiveRegisteredWallet).not.toHaveBeenCalled();
    await ReactTestRenderer.act(async () => { jest.advanceTimersByTime(80_000); });
    expect(texts('send-preparation-progress')).toContain('Preparing transaction. Review before sending. 80s elapsed');
    expect(mockedWalletService.commitSendPlan).not.toHaveBeenCalled();
    await ReactTestRenderer.act(async () => {
      resolvePreparation(prepared());
      await work;
    });
    expect(tree!.root.findByProps({ accessibilityLabel: 'Send Now' })).toBeDefined();
    expect(tree!.root.findAllByProps({ testID: 'send-approval-countdown' })).toHaveLength(0);
    expect(tree!.root.findAllByProps({ testID: 'send-preparation-progress' })).toHaveLength(0);
    expect(mockedWalletService.prepareSendPlan).toHaveBeenCalledTimes(1);
    expect(mockedWalletService.commitSendPlan).not.toHaveBeenCalled();
  });

  it('discards a late prepared result when the selected native session changed', async () => {
    let resolvePreparation!: (value: ReturnType<typeof prepared>) => void;
    mockedWalletService.prepareSendPlan.mockReturnValueOnce(new Promise(resolve => { resolvePreparation = resolve; }));
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
    expect(mockedWalletService.prepareSendPlan).toHaveBeenCalledTimes(1);
    expect(mockedWalletService.commitSendPlan).not.toHaveBeenCalled();
  });

  it('does not submit a retained review from the previous wallet after an external selection', async () => {
    mockedWalletService.prepareSendPlan.mockResolvedValueOnce(prepared());
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
    expect(mockedWalletService.commitSendPlan).not.toHaveBeenCalled();
    expect(mockedWalletService.prepareSendPlan).toHaveBeenCalledTimes(1);
    expect(tree!.root.findAllByProps({ accessibilityLabel: 'Send Now' })).toHaveLength(0);
    expect(tree!.root.findByProps({ accessibilityLabel: 'Prepare again' })).toBeDefined();
    expect(tree!.root.findAllByType(Text).map(node => node.props.children)).toContain('send.preparationChanged');
  });

  it('does not submit an old review after a new payment route clears its pending transaction', async () => {
    mockedWalletService.prepareSendPlan.mockResolvedValueOnce(prepared());
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
    expect(mockedWalletService.commitSendPlan).not.toHaveBeenCalled();
    expect(mockedWalletService.prepareSendPlan).toHaveBeenCalledTimes(1);
    expect(tree!.root.findAllByProps({ accessibilityLabel: 'Send Now' })).toHaveLength(0);
    expect(tree!.root.findAllByType(Text).map(node => node.props.children)).toContain('send.preparationChanged');
  });

  it('keeps the native group approval authoritative instead of inventing a JavaScript expiry', async () => {
    mockedWalletService.prepareSendPlan.mockResolvedValueOnce(prepared());
    await selectAllAndPrepare();
    await ReactTestRenderer.act(async () => { jest.advanceTimersByTime(125_000); });
    expect(tree!.root.findAllByProps({ testID: 'send-approval-countdown' })).toHaveLength(0);
    expect(tree!.root.findByProps({ accessibilityLabel: 'Send Now' })).toBeDefined();
    expect(mockedWalletService.prepareSendPlan).toHaveBeenCalledTimes(1);
    expect(mockedWalletService.commitSendPlan).not.toHaveBeenCalled();
  });

  it('retains an unknown native result and offers status checks without a blind resend', async () => {
    mockedWalletService.prepareSendPlan.mockResolvedValueOnce(prepared());
    let rejectCommit!: (error: Error) => void;
    mockedWalletService.commitSendPlan.mockReturnValueOnce(new Promise((_resolve, reject) => { rejectCommit = reject; }));
    await selectAllAndPrepare();
    const confirm = tree!.root.findByProps({ accessibilityLabel: 'Send Now' }).props.onPress;
    let submission: Promise<void> | undefined;
    await ReactTestRenderer.act(async () => { submission = confirm(); confirm(); });
    expect(mockedWalletService.commitSendPlan).toHaveBeenCalledTimes(1);
    await ReactTestRenderer.act(async () => { jest.advanceTimersByTime(125_000); });
    expect(tree!.root.findByProps({ accessibilityLabel: 'Send Now' }).props.disabled).toBe(true);
    await ReactTestRenderer.act(async () => { rejectCommit(new Error('Status unavailable')); await submission; });
    expect(tree!.root.findAllByProps({ accessibilityLabel: 'Send Now' })).toHaveLength(0);
    expect(tree!.root.findByProps({ testID: 'send-plan-refresh' })).toBeDefined();
    expect(tree!.root.findAllByProps({ testID: 'send-plan-discard' })).toHaveLength(0);
    expect(mockedWalletService.prepareSendPlan).toHaveBeenCalledTimes(1);
    expect(mockedWalletService.commitSendPlan).toHaveBeenCalledTimes(1);
  });

  it('clears preparation progress and busy state after a native preparation error', async () => {
    mockedWalletService.prepareSendPlan.mockRejectedValueOnce(new Error('Native preparation failed'));
    await selectAllAndPrepare();
    expect(tree!.root.findAllByProps({ testID: 'send-preparation-progress' })).toHaveLength(0);
    expect(tree!.root.findByProps({ accessibilityLabel: 'Send XMR' }).props.disabled).toBe(false);
    expect(mockedWalletService.commitSendPlan).not.toHaveBeenCalled();
  });

  it.each(['Fee denied on device.', 'Transaction denied on device.'])(
    'treats the intentional Ledger preparation rejection %s as a status notice',
    async denial => {
      mockedWalletService.prepareSendPlan.mockRejectedValueOnce(new Error(`unexpected error: ${denial}`));
      await selectAllAndPrepare();
      const notice = tree!.root.findByProps({testID: 'send-status-message'});
      expect(notice.props.children).toBe('send.preparationCancelledLedger');
      expect(StyleSheet.flatten(notice.props.style).color).not.toBe(colors.error);
      expect(tree!.root.findAllByType(Text).some(node => node.props.children === denial)).toBe(false);
      expect(tree!.root.findByProps({accessibilityLabel: 'Send XMR'}).props.disabled).toBe(false);
      expect(mockedWalletService.commitSendPlan).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['RPC error: get_output_distribution', 'send.preparationNodeFailed'],
    ['Ledger output binding failed at index 25', 'send.preparationLedgerVerificationFailed'],
    ['Native error at /private/wallet/path', 'send.preparationUnknownFailed'],
  ])('shows a safe preparation explanation for %s', async (nativeError, key) => {
    mockedWalletService.prepareSendPlan.mockRejectedValueOnce(new Error(nativeError));
    await selectAllAndPrepare();
    const content = tree!.root.findAllByType(Text).map(node => node.props.children);
    expect(content).toContain(key);
    expect(content).not.toContain(nativeError);
    expect(content).not.toContain('send.preparationCancelledLedger');
    expect(mockedWalletService.commitSendPlan).not.toHaveBeenCalled();
  });
});
