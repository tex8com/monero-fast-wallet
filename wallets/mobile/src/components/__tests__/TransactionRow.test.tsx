import React from 'react';
import { Text, TouchableOpacity } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';

import type { WalletTransaction } from '../../backend/NativeMoneroWallet';
import TransactionRow, { transactionRowKey } from '../TransactionRow';

jest.mock('../../i18n', () => ({
  useI18n: () => ({
    dateLocale: 'en-US',
    t: (key: string, params?: Record<string, string | number>) => {
      const values: Record<string, string> = {
        'home.received': 'Received',
        'home.sent': 'Sent',
        'status.failed': 'Failed',
        'status.pending': 'Pending',
        'status.unconfirmed': 'Unconfirmed',
        'transactions.openDetails': 'Open transaction details',
      };
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
  });

  it('keeps wallet perspectives distinct in list keys', () => {
    expect(transactionRowKey(transaction)).not.toBe(
      transactionRowKey({ ...transaction, direction: 'out' }),
    );
  });
});
