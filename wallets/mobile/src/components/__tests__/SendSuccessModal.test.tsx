import React from 'react';
import { Text, TouchableOpacity } from 'react-native';
import Clipboard from '@react-native-clipboard/clipboard';
import ReactTestRenderer from 'react-test-renderer';

import SendSuccessModal from '../SendSuccessModal';

jest.mock('../../i18n', () => ({
  useI18n: () => ({
    t: (key: string) =>
      ({
        'send.successDone': 'Done',
        'send.successReady': 'Wallet updated',
        'send.successRefreshing': 'Updating wallet',
        'send.successSubtitle': 'The transaction was broadcast.',
        'send.successTitle': 'XMR sent',
        'transactions.amount': 'Amount',
        'transactions.copyId': 'Copy transaction ID',
        'transactions.fee': 'Fee',
        'transactions.transactionId': 'Transaction ID',
      }[key] ?? key),
  }),
}));

jest.mock('react-native-qrcode-svg', () => {
  const { View } = require('react-native');
  return (props: Record<string, unknown>) =>
    require('react').createElement(View, {
      ...props,
      testID: 'transaction-reference-qr',
    });
});

describe('SendSuccessModal', () => {
  it('offers a local TX-ID copy action and a reference QR after broadcast', () => {
    const transactionId = 'a'.repeat(64);
    let renderer: ReactTestRenderer.ReactTestRenderer | undefined;

    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(
        <SendSuccessModal
          onDone={jest.fn()}
          receipt={{
            amountAtomic: '1000000000000',
            feeAtomic: '1000000',
            refreshing: false,
            transactionId,
          }}
        />,
      );
    });

    const text = renderer!.root
      .findAllByType(Text)
      .map(node => node.props.children)
      .flat(Infinity)
      .join(' ');
    expect(text).toContain(transactionId);
    expect(text).toContain('Copy transaction ID');
    expect(renderer!.root.findByProps({ testID: 'transaction-reference-qr' }))
      .toBeDefined();

    const copyButton = renderer!.root
      .findAllByType(TouchableOpacity)
      .find(node => node.props.accessibilityLabel === 'Copy transaction ID');
    expect(copyButton).toBeDefined();
    ReactTestRenderer.act(() => copyButton!.props.onPress());
    expect(Clipboard.setString).toHaveBeenCalledWith(transactionId);
  });
});
