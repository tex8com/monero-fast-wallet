import React from 'react';
import { TouchableOpacity } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';

import IncomingPaymentNotice from '../IncomingPaymentNotice';
import { useWalletState } from '../../services/WalletState';

jest.mock('../../i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string | number>) => {
      if (key === 'notification.incomingAmount') {
        return `${params?.amount} XMR incoming`;
      }
      if (key === 'notification.incomingWallet') {
        return `To ${params?.wallet}`;
      }
      if (key === 'notification.closesIn') {
        return `Closes in ${params?.seconds}s`;
      }
      if (key === 'notification.incomingTitle') {
        return 'Incoming XMR';
      }
      return 'OK';
    },
  }),
}));

jest.mock('../../services/WalletState', () => ({
  useWalletState: jest.fn(),
}));

const mockedUseWalletState = useWalletState as jest.MockedFunction<
  typeof useWalletState
>;

const notice = {
  id: 'primary:incoming-1',
  walletId: 'primary',
  walletName: 'primary',
  direction: 'in' as const,
  amountAtomic: '100000000',
  pending: true,
  confirmations: 0,
};

describe('IncomingPaymentNotice', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('dismisses immediately when OK is pressed', () => {
    const dismissIncomingTransactionNotice = jest.fn();
    mockedUseWalletState.mockReturnValue({
      incomingTransactionNotice: notice,
      dismissIncomingTransactionNotice,
    } as unknown as ReturnType<typeof useWalletState>);

    let renderer: ReactTestRenderer.ReactTestRenderer | undefined;
    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(<IncomingPaymentNotice />);
    });

    const confirm = renderer!.root
      .findAllByType(TouchableOpacity)
      .find(element => element.props.accessibilityLabel === 'OK');
    expect(confirm).toBeDefined();

    ReactTestRenderer.act(() => {
      confirm!.props.onPress();
    });
    expect(dismissIncomingTransactionNotice).toHaveBeenCalledTimes(1);
  });

  it('dismisses automatically after five seconds', () => {
    const dismissIncomingTransactionNotice = jest.fn();
    mockedUseWalletState.mockReturnValue({
      incomingTransactionNotice: notice,
      dismissIncomingTransactionNotice,
    } as unknown as ReturnType<typeof useWalletState>);

    ReactTestRenderer.act(() => {
      ReactTestRenderer.create(<IncomingPaymentNotice />);
    });

    ReactTestRenderer.act(() => {
      jest.advanceTimersByTime(4_999);
    });
    expect(dismissIncomingTransactionNotice).not.toHaveBeenCalled();

    ReactTestRenderer.act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(dismissIncomingTransactionNotice).toHaveBeenCalledTimes(1);
  });
});
