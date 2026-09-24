import React from 'react';
import { ActivityIndicator, Modal, Text, TouchableOpacity } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';

import LedgerSigningModal from '../LedgerSigningModal';

jest.mock('../../i18n', () => ({
  useI18n: () => ({
    t: (key: string) =>
      ({
        'action.cancel': 'Cancel',
        'ledgerSigning.connectedTitle': 'Ledger connected',
        'ledgerSigning.instructions':
          'Keep the Ledger unlocked with the Monero app open.',
        'ledgerSigning.synchronizingInstructions':
          'Keep the Ledger unlocked. Approve view-key export if asked.',
        'ledgerSigning.synchronizingWallet':
          'Ledger connected. Synchronizing the signing wallet…',
      }[key] ?? key),
  }),
}));

describe('LedgerSigningModal', () => {
  it('keeps wallet synchronization cancellable after Ledger connects', () => {
    const onCancel = jest.fn();
    let renderer: ReactTestRenderer.ReactTestRenderer | undefined;

    ReactTestRenderer.act(() => {
      renderer = ReactTestRenderer.create(
        <LedgerSigningModal
          canCancel
          onCancel={onCancel}
          progress={{
            phase: 'synchronizing-wallet',
            transport: {
              platform: 'android',
              transport: 'ble',
              supported: true,
              available: true,
              permissionGranted: true,
              requiresUserAction: false,
              deviceCount: 1,
              deviceName: '97A0',
              vendorId: 0,
              productId: 0,
              message: 'Ledger connected',
            },
          }}
        />,
      );
    });

    const text = renderer!.root
      .findAllByType(Text)
      .map(node => node.props.children)
      .flat(Infinity)
      .join(' ')
      .replace(/\s+/g, ' ');
    expect(text).toContain('Ledger connected');
    expect(text).toContain('Synchronizing the signing wallet');
    expect(text).toContain('Approve view-key export');
    expect(text).toContain('BLE · 97A0');
    expect(renderer!.root.findAllByType(ActivityIndicator)).toHaveLength(1);
    expect(renderer!.root.findAllByType(TouchableOpacity)).toHaveLength(1);
    ReactTestRenderer.act(() =>
      renderer!.root.findByType(TouchableOpacity).props.onPress(),
    );
    expect(onCancel).toHaveBeenCalledTimes(1);
    ReactTestRenderer.act(() =>
      renderer!.root.findByType(Modal).props.onRequestClose(),
    );
    expect(onCancel).toHaveBeenCalledTimes(2);
  });
});
