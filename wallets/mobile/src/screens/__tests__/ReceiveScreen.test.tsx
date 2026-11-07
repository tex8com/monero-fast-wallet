import React from 'react';
import { Text, TouchableOpacity } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';
import ReceiveScreen from '../ReceiveScreen';
import { useWalletState } from '../../services/WalletState';
import { walletService } from '../../services/WalletService';
import type { WalletAddressRecord } from '../../services/WalletAddressRegistry';

jest.mock('@react-navigation/native', () => ({ useFocusEffect: jest.fn() }));
jest.mock('react-native-qrcode-svg', () => () => null);
jest.mock('../../data/priceService', () => ({
  useXmrPrice: () => ({ price: 100 }),
}));
jest.mock('../../components/TransactionRow', () => () => null);
jest.mock('../../services/WalletState', () => ({ useWalletState: jest.fn() }));
jest.mock('../../services/WalletService', () => ({
  walletService: { listSubaddresses: jest.fn(), createSubaddress: jest.fn() },
}));
jest.mock('../../services/PaymentLinkClient', () => ({
  paymentLinkClient: {},
}));
jest.mock('../../i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string | number>) =>
      `${key}${params ? `:${Object.values(params).join('/')}` : ''}`,
  }),
}));

const stateMock = useWalletState as jest.MockedFunction<typeof useWalletState>;
const serviceMock = walletService as jest.Mocked<typeof walletService>;
const record = (
  walletId: string,
  accountIndex: number,
  addressIndex: number,
  label: string,
): WalletAddressRecord => ({
  id: `${walletId}:${accountIndex}:${addressIndex}`,
  walletId,
  accountIndex,
  addressIndex,
  address: `${accountIndex + 4}${String(addressIndex + 1).repeat(94)}`,
  label,
  balanceAtomic: '0',
  createdAt: '2026-01-01T00:00:00Z',
});
const addresses = [
  record('a', 0, 0, 'Daily'),
  record('a', 0, 1, 'Invoice'),
  record('a', 1, 0, 'Unused savings'),
];
function state(walletId: string) {
  const wallet = {
    id: walletId,
    kind: 'software',
    walletName: walletId,
    network: 'mainnet',
    seedBackupStatus: 'verified',
  };
  return {
    registeredWallet: wallet,
    registeredWallets: [wallet],
    session: {
      walletId: `native-${walletId}`,
      registrationId: walletId,
      network: 'mainnet',
    },
    snapshot: {
      primaryAddress: '4'.repeat(95),
      balanceAtomic: '0',
      unlockedBalanceAtomic: '0',
      synchronized: true,
    },
    transactions: [],
    walletSnapshots: {},
    refreshSnapshot: jest.fn(async () => undefined),
    refreshTransactions: jest.fn(async () => []),
  } as unknown as ReturnType<typeof useWalletState>;
}
function screen() {
  return (
    <ReceiveScreen
      navigation={{ navigate: jest.fn() }}
      route={{ params: { manageAddresses: true } }}
    />
  );
}
const hasTestId = (
  renderer: ReactTestRenderer.ReactTestRenderer,
  testID: string,
) => renderer.root.findAllByProps({ testID }).length > 0;
const texts = (renderer: ReactTestRenderer.ReactTestRenderer) =>
  renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .join(' ');

describe('ReceiveScreen complete native address inventory', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    stateMock.mockReturnValue(state('a'));
    serviceMock.listSubaddresses.mockResolvedValue(addresses);
  });

  it('groups two accounts including an unused account and keeps the selected primary address in the list', async () => {
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(screen());
    });
    expect(serviceMock.listSubaddresses).toHaveBeenCalledWith(
      expect.objectContaining({ walletId: 'native-a' }),
    );
    expect(hasTestId(renderer, 'receive-account-0')).toBe(true);
    expect(hasTestId(renderer, 'receive-account-1')).toBe(true);
    expect(texts(renderer)).toContain('receive.addressInventory:2/3');
    const radios = renderer.root
      .findAllByType(TouchableOpacity)
      .filter(
        node =>
          node.props.testID?.startsWith('receive-address-') &&
          node.props.accessibilityRole === 'radio',
      );
    expect(radios).toHaveLength(3);
    expect(radios[0].props.accessibilityState.selected).toBe(true);
    await ReactTestRenderer.act(async () => {
      renderer.unmount();
    });
  });

  it('creates an address in the selected account and selects the new native address', async () => {
    const created = record('a', 1, 1, 'New address');
    serviceMock.createSubaddress.mockResolvedValue(created);
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(screen());
    });
    const radios = renderer.root
      .findAllByType(TouchableOpacity)
      .filter(
        node =>
          node.props.testID?.startsWith('receive-address-') &&
          node.props.accessibilityRole === 'radio',
      );
    await ReactTestRenderer.act(async () => {
      radios[2].props.onPress();
    });
    serviceMock.listSubaddresses.mockResolvedValue([...addresses, created]);
    const button = renderer.root
      .findAllByType(TouchableOpacity)
      .find(node =>
        node
          .findAllByType(Text)
          .some(text => text.props.children === 'receive.newAddress'),
      );
    await ReactTestRenderer.act(async () => {
      await button!.props.onPress();
    });
    expect(serviceMock.createSubaddress).toHaveBeenCalledWith(
      expect.objectContaining({ walletId: 'native-a' }),
      expect.any(String),
      1,
    );
    expect(texts(renderer)).toContain('receive.addressInventory:2/4');
    const selected = renderer.root
      .findAllByType(TouchableOpacity)
      .filter(
        node =>
          node.props.testID?.startsWith('receive-address-') &&
          node.props.accessibilityRole === 'radio' &&
          node.props.accessibilityState.selected,
      );
    expect(selected).toHaveLength(1);
    expect(
      selected[0]
        .findAllByType(Text)
        .some(text => text.props.children === 'New address'),
    ).toBe(true);
    await ReactTestRenderer.act(async () => {
      renderer.unmount();
    });
  });

  it('shows an explicit incomplete-list error instead of a false zero/one-account count', async () => {
    serviceMock.listSubaddresses.mockRejectedValue(new Error('native busy'));
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(screen());
    });
    expect(hasTestId(renderer, 'receive-address-list-error')).toBe(true);
    expect(hasTestId(renderer, 'receive-address-inventory')).toBe(false);
    expect(
      renderer.root
        .findAllByType(TouchableOpacity)
        .filter(
          node =>
            node.props.testID?.startsWith('receive-address-') &&
            node.props.accessibilityRole === 'radio',
        ),
    ).toHaveLength(0);
    await ReactTestRenderer.act(async () => {
      renderer.unmount();
    });
  });

  it('drops an old wallet reply after switching to a different wallet', async () => {
    let resolveOld!: (items: WalletAddressRecord[]) => void;
    serviceMock.listSubaddresses.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveOld = resolve;
        }),
    );
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(async () => {
      renderer = ReactTestRenderer.create(screen());
    });
    stateMock.mockReturnValue(state('b'));
    serviceMock.listSubaddresses.mockResolvedValue([
      record('b', 2, 0, 'Wallet B'),
    ]);
    await ReactTestRenderer.act(async () => {
      renderer.update(screen());
    });
    await ReactTestRenderer.act(async () => {
      resolveOld(addresses);
    });
    expect(hasTestId(renderer, 'receive-account-2')).toBe(true);
    expect(hasTestId(renderer, 'receive-account-0')).toBe(false);
    expect(texts(renderer)).toContain('Wallet B');
    await ReactTestRenderer.act(async () => {
      renderer.unmount();
    });
  });
});
