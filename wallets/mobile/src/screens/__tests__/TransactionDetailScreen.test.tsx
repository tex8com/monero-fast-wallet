import React from 'react';
import { Text, TouchableOpacity } from 'react-native';
import Clipboard from '@react-native-clipboard/clipboard';
import ReactTestRenderer from 'react-test-renderer';

import type { WalletTransaction } from '../../services/NativeMoneroWallet';
import { useWalletState } from '../../services/WalletState';
import TransactionDetailScreen from '../TransactionDetailScreen';

jest.mock('@react-native-clipboard/clipboard', () => ({
  __esModule: true,
  default: { setString: jest.fn() },
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }),
}));

jest.mock('../../i18n', () => ({
  useI18n: () => ({
    dateLocale: 'en-US',
    t: (key: string, params?: Record<string, string | number>) =>
      ({
        'action.back': 'Back',
        'action.copied': 'Copied',
        'common.wallet': 'Wallet',
        'home.received': 'Received',
        'home.sent': 'Sent',
        'status.failed': 'Failed',
        'status.pending': 'Pending',
        'status.unconfirmed': 'Unconfirmed',
        'transactions.account': 'Account',
        'transactions.amount': 'Amount',
        'transactions.blockHeight': 'Block height',
        'transactions.confirmations': 'Confirmations',
        'transactions.confirmed': 'Confirmed',
        'transactions.copyId': 'Copy transaction ID',
        'transactions.date': 'Date',
        'transactions.description': 'Description',
        'transactions.details': 'Transaction Details',
        'transactions.direction': 'Direction',
        'transactions.fee': 'Network fee',
        'transactions.hiddenAddress': 'Address hidden by Monero',
        'transactions.label': 'Label',
        'transactions.miningReward': 'Mining reward',
        'transactions.notFound': 'Transaction not found.',
        'transactions.paymentId': 'Payment ID',
        'transactions.selfTransfer': 'Self transfer',
        'transactions.status': 'Status',
        'transactions.subaddresses': 'Subaddresses',
        'transactions.transactionId': 'Transaction ID',
        'transactions.transfer': 'Transfer',
        'transactions.transferNumber': `Transfer ${params?.count}`,
        'transactions.transfers': 'Transfer details',
        'transactions.type': 'Type',
        'transactions.unlockTime': 'Unlock time',
        'transactions.wallet': 'Wallet',
      }[key] ?? key),
  }),
}));

jest.mock('../../services/WalletState', () => ({
  useWalletState: jest.fn(),
}));

const mockedUseWalletState = useWalletState as jest.MockedFunction<
  typeof useWalletState
>;
const hash = '1234567890abcdef'.repeat(4);
const transaction: WalletTransaction = {
  hash,
  paymentId: '',
  description: '',
  label: '',
  direction: 'out',
  pending: false,
  failed: false,
  coinbase: false,
  amountAtomic: '3000000000',
  feeAtomic: '25000000',
  blockHeight: 3_700_000,
  confirmations: 8,
  unlockTime: 0,
  timestamp: 1_720_000_000,
  subaddrAccount: 0,
  subaddrIndices: [0],
  transfers: [
    {
      amountAtomic: '3000000000',
      address: '4'.repeat(95),
    },
  ],
};

describe('TransactionDetailScreen', () => {
  it('shows and copies the full transaction ID', () => {
    jest.useFakeTimers();
    mockedUseWalletState.mockReturnValue({
      registeredWallet: { walletName: 'primary' },
      transactions: [transaction],
    } as unknown as ReturnType<typeof useWalletState>);

    let renderer: ReactTestRenderer.ReactTestRenderer | undefined;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(
        <TransactionDetailScreen
          navigation={{ goBack: jest.fn() }}
          route={{
            params: {
              transaction,
              transactionHash: hash,
              walletName: 'primary',
            },
          }}
        />,
      );
    });

    const text = renderer!.root
      .findAllByType(Text)
      .map(node => node.props.children)
      .flat(Infinity)
      .join(' ');
    expect(text).toContain(hash);

    const copyButton = renderer!.root
      .findAllByType(TouchableOpacity)
      .find(node => node.props.accessibilityLabel === 'Copy transaction ID');
    expect(copyButton).toBeDefined();
    ReactTestRenderer.act(() => copyButton!.props.onPress());
    expect(Clipboard.setString).toHaveBeenCalledWith(hash);

    ReactTestRenderer.act(() => jest.runOnlyPendingTimers());
    jest.useRealTimers();
  });

  it('shows amount and network fee with aligned full precision and muted trailing zeroes', () => {
    mockedUseWalletState.mockReturnValue({
      registeredWallet: { walletName: 'primary' },
      transactions: [transaction],
    } as unknown as ReturnType<typeof useWalletState>);

    let renderer: ReactTestRenderer.ReactTestRenderer | undefined;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(
        <TransactionDetailScreen
          navigation={{ goBack: jest.fn() }}
          route={{ params: { transaction, transactionHash: hash } }}
        />,
      );
    });

    const renderedText = renderer!.root.findAllByType(Text);
    const amount = renderedText.find(
      node => node.props.testID === 'transaction-amount',
    );
    const fee = renderedText.find(
      node => node.props.testID === 'transaction-network-fee',
    );
    expect(amount).toBeDefined();
    expect(fee).toBeDefined();
    expect(amount!.props.accessibilityLabel).toBe('0.003000000000 XMR');
    expect(fee!.props.accessibilityLabel).toBe('0.000025000000 XMR');
    expect(
      renderer!.root.findByProps({
        testID: 'transaction-amount-significant',
      }).props.children,
    ).toBe('0.003');
    expect(
      renderer!.root.findByProps({
        testID: 'transaction-amount-trailing-zeros',
      }).props.children,
    ).toBe('000000000');
    expect(
      renderer!.root.findByProps({
        testID: 'transaction-network-fee-significant',
      }).props.children,
    ).toBe('0.000025');
    expect(
      renderer!.root.findByProps({
        testID: 'transaction-network-fee-trailing-zeros',
      }).props.children,
    ).toBe('000000');
  });

  it('shows a fee-only self transfer as its real wallet decrease', () => {
    const selfTransfer = {
      ...transaction,
      amountAtomic: '0',
      feeAtomic: '44440000',
      transfers: [],
    };
    mockedUseWalletState.mockReturnValue({
      registeredWallet: { walletName: 'primary' },
      transactions: [selfTransfer],
    } as unknown as ReturnType<typeof useWalletState>);

    let renderer: ReactTestRenderer.ReactTestRenderer | undefined;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(
        <TransactionDetailScreen
          navigation={{ goBack: jest.fn() }}
          route={{ params: { transaction: selfTransfer, transactionHash: hash } }}
        />,
      );
    });

    const text = renderer!.root
      .findAllByType(Text)
      .map(node => node.props.children)
      .flat(Infinity)
      .join('');
    expect(text).toContain('Self transfer');
    expect(text).toContain('-0.00004444 XMR');
  });

  it('shows the recipient amount instead of a wrapped Ledger history value', () => {
    const wrappedLedgerTransaction = {
      ...transaction,
      amountAtomic: '18446743927874251388',
      feeAtomic: '45220000',
      transfers: [{ amountAtomic: '1', address: '4'.repeat(95) }],
    };
    mockedUseWalletState.mockReturnValue({
      registeredWallet: { walletName: 'ledger' },
      transactions: [wrappedLedgerTransaction],
    } as unknown as ReturnType<typeof useWalletState>);

    let renderer: ReactTestRenderer.ReactTestRenderer | undefined;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(
        <TransactionDetailScreen
          navigation={{ goBack: jest.fn() }}
          route={{
            params: {
              transaction: wrappedLedgerTransaction,
              transactionHash: hash,
            },
          }}
        />,
      );
    });

    const amount = renderer!.root
      .findAllByType(Text)
      .find(node => node.props.testID === 'transaction-amount');
    expect(amount?.props.accessibilityLabel).toBe('0.000000000001 XMR');
  });
});
