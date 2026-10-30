import React from 'react';
import { Text, TouchableOpacity } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';

import type { WalletTransaction } from '../../services/NativeMoneroWallet';
import TransactionRow, { transactionRowKey } from '../TransactionRow';

jest.mock('../../i18n', () => ({
  useI18n: () => ({
    dateLocale: 'en-US',
    t: (key: string, params?: Record<string, string | number>) => {
      const values: Record<string, string> = {
        'home.received': 'Received',
        'home.receiving': 'Receiving',
        'transactions.confirming': 'Confirming',
        'home.sent': 'Sent',
        'status.failed': 'Failed',
        'status.pending': 'Pending',
        'status.unconfirmed': 'Unconfirmed',
        'transactions.confirmed': 'Confirmed',
        'transactions.openDetails': 'Open transaction details',
      };
      if (key === 'transactions.confirmationProgressShort') {
        return `${params?.current}/${params?.required} conf.`;
      }
      if (key === 'transactions.confirmationsShort') {
        return `${params?.count} conf.`;
      }
      return values[key] ?? key;
    },
  }),
}));

const transaction: WalletTransaction = {
  hash: 'a'.repeat(64),
  paymentId: '',
  description: '',
  label: '',
  direction: 'in',
  pending: false,
  failed: false,
  coinbase: false,
  amountAtomic: '3000000000',
  feeAtomic: '0',
  blockHeight: 3_700_000,
  confirmations: 12,
  unlockTime: 0,
  timestamp: 1_720_000_000,
  subaddrAccount: 0,
  subaddrIndices: [0],
  transfers: [],
};

describe('TransactionRow', () => {
  it('opens the selected transaction and shows a recognizable hash', () => {
    const onPress = jest.fn();
    let renderer: ReactTestRenderer.ReactTestRenderer | undefined;

    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(
        <TransactionRow transaction={transaction} onPress={onPress} />,
      );
    });

    const button = renderer!.root.findByType(TouchableOpacity);
    ReactTestRenderer.act(() => button.props.onPress());

    expect(onPress).toHaveBeenCalledTimes(1);
    const text = renderer!.root
      .findAllByType(Text)
      .map(node => node.props.children)
      .flat(Infinity)
      .join(' ');
    expect(text).toContain('aaaaaa...aaaa');
    expect(text).toContain('Received');
    expect(text).toContain('Confirmed');
  });

  it('keeps the confirmation count while it still helps the user', () => {
    let renderer: ReactTestRenderer.ReactTestRenderer | undefined;

    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(
        <TransactionRow
          transaction={{ ...transaction, confirmations: 10 }}
          onPress={jest.fn()}
        />,
      );
    });

    const text = renderer!.root
      .findAllByType(Text)
      .map(node => node.props.children)
      .flat(Infinity)
      .join(' ');
    expect(text).toContain('10/10 conf.');
    expect(text).toContain('Confirmed');
  });

  it('keeps wallet perspectives distinct in list keys', () => {
    expect(transactionRowKey(transaction)).not.toBe(
      transactionRowKey({ ...transaction, direction: 'out' }),
    );
  });


  it.each([0, 1, 9, 10, 11])('shows native progress %s/10 and confirms exactly at ten', confirmations => {
    let tree: ReactTestRenderer.ReactTestRenderer | undefined;
    ReactTestRenderer.act(() => {
      tree = ReactTestRenderer.create(<TransactionRow transaction={{
        ...transaction, confirmations, pending: confirmations === 0,
      }} onPress={jest.fn()} />);
    });
    const text = tree!.root.findAllByType(Text).map(node => node.props.children).flat(Infinity).join(' ');
    expect(text).toContain(`${confirmations}/10 conf.`);
    expect(text).toContain(confirmations < 10 ? 'Receiving' : 'Received');
    if (confirmations < 10) expect(text).not.toContain('Confirmed');
    else expect(text).toContain('Confirmed');
    ReactTestRenderer.act(() => tree!.unmount());
  });

  it('keeps the counter first in compact metadata and uses the coinbase target', () => {
    let tree: ReactTestRenderer.ReactTestRenderer | undefined;
    ReactTestRenderer.act(() => {
      tree = ReactTestRenderer.create(<TransactionRow transaction={{
        ...transaction, coinbase: true, confirmations: 59,
      }} onPress={jest.fn()} />);
    });
    const progress = tree!.root.findByProps({ testID: 'transaction-confirmation-progress' });
    expect(progress.props.children[0]).toBe('59/60 conf.');
    expect(tree!.root.findAllByType(Text).map(node => node.props.children).flat(Infinity).join(' ')).not.toContain('Confirmed');
    ReactTestRenderer.act(() => {
      tree!.update(<TransactionRow transaction={{ ...transaction, coinbase: true, confirmations: 60 }} onPress={jest.fn()} />);
    });
    expect(tree!.root.findByProps({ testID: 'transaction-confirmation-progress' }).props.children[0]).toBe('60/60 conf.');
    ReactTestRenderer.act(() => tree!.unmount());
  });

  it('passes an explicit block lock to the shared progress rule', () => {
    let tree: ReactTestRenderer.ReactTestRenderer | undefined;
    ReactTestRenderer.act(() => {
      tree = ReactTestRenderer.create(<TransactionRow transaction={{
        ...transaction, confirmations: 10, unlockTime: transaction.blockHeight + 20,
      }} onPress={jest.fn()} />);
    });
    expect(tree!.root.findByProps({ testID: 'transaction-confirmation-progress' }).props.children[0]).toBe('10/20 conf.');
    ReactTestRenderer.act(() => tree!.unmount());
  });
});
