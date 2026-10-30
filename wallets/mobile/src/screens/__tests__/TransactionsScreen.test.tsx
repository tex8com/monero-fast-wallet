import React from 'react';
import { FlatList } from 'react-native';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { useWalletState } from '../../services/WalletState';
import type { WalletTransaction } from '../../services/NativeMoneroWallet';
import TransactionsScreen from '../TransactionsScreen';

jest.mock('@react-navigation/native', () => ({
  useFocusEffect: (effect: () => void | (() => void)) => {
    const ReactModule = require('react');
    ReactModule.useEffect(effect, [effect]);
  },
}));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
jest.mock('../../i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
jest.mock('../../services/WalletState', () => ({ useWalletState: jest.fn() }));
jest.mock('../../components/TransactionRow', () => ({
  __esModule: true, default: () => null,
  transactionRowKey: (item: WalletTransaction) => item.hash,
}));

it('updates the visible full history from the existing wallet poll instead of retaining focus-time counts', async () => {
  const transaction = {
    hash: 'a'.repeat(64), direction: 'in', confirmations: 9, pending: false,
    subaddrAccount: 0, subaddrIndices: [0], transfers: [],
  } as unknown as WalletTransaction;
  const refresh = jest.fn(async () => [transaction]);
  let state = {
    registeredWallet: { id: 'wallet', walletName: 'primary' },
    session: { walletId: 'native-wallet', network: 'mainnet' },
    transactions: [transaction], refreshTransactions: refresh,
  } as unknown as ReturnType<typeof useWalletState>;
  (useWalletState as jest.Mock).mockImplementation(() => state);
  let tree: ReactTestRenderer | undefined;
  await act(async () => {
    tree = renderer.create(<TransactionsScreen navigation={{ goBack: jest.fn(), navigate: jest.fn() }} />);
  });
  expect(tree!.root.findByType(FlatList).props.data[0].confirmations).toBe(9);
  state = { ...state, transactions: [{ ...transaction, confirmations: 10 }] };
  await act(async () => {
    tree!.update(<TransactionsScreen navigation={{ goBack: jest.fn(), navigate: jest.fn() }} />);
  });
  expect(tree!.root.findByType(FlatList).props.data[0].confirmations).toBe(10);
  expect(refresh).toHaveBeenCalledTimes(1);
  act(() => tree!.unmount());
});
