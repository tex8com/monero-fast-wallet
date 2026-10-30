import React from 'react';
import {AppState, Text} from 'react-native';
import {Camera} from 'react-native-camera-kit';
import renderer, {act, type ReactTestRenderer} from 'react-test-renderer';

import RecipientQrScanner from '../RecipientQrScanner';

jest.mock('../../i18n', () => ({
  useI18n: () => ({t: (key: string) => key}),
}));

jest.mock('../Icon', () => ({Icon: () => null}));

const address = '4'.repeat(95);

describe('recipient QR scanner', () => {
  let tree: ReactTestRenderer;
  const onScanned = jest.fn();
  const onClose = jest.fn();
  const initialAppState = AppState.currentState;

  beforeEach(async () => {
    jest.clearAllMocks();
    AppState.currentState = 'active';
    await act(async () => {
      tree = renderer.create(
        <RecipientQrScanner visible onClose={onClose} onScanned={onScanned} />,
      );
    });
  });

  afterEach(() => {
    act(() => tree.unmount());
    AppState.currentState = initialAppState;
  });

  function readCode(value: string) {
    act(() => {
      tree.root.findByType(Camera).props.onReadCode({
        nativeEvent: {codeStringValue: value},
      });
    });
  }

  it('accepts QR codes across the preview instead of applying the native barcode frame', () => {
    const camera = tree.root.findByType(Camera);
    expect(camera.props.scanBarcode).toBe(true);
    expect(camera.props.allowedBarcodeTypes).toEqual(['qr']);
    // CameraKit's native frame rejects every QR not wholly inside its default
    // 300 x 150 rectangle, even when the code is visible in the live preview.
    expect(camera.props.showFrame).toBe(false);
    readCode(address);
    expect(onScanned).toHaveBeenCalledWith(address);
  });

  it('extracts the payment address and ignores duplicate camera events', () => {
    readCode(`monero:${address}?tx_amount=0.25`);
    readCode(address);
    expect(onScanned).toHaveBeenCalledTimes(1);
    expect(onScanned).toHaveBeenCalledWith(address);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('keeps scanning after an unrelated QR code', () => {
    readCode('https://example.com');
    expect(onScanned).not.toHaveBeenCalled();
    expect(tree.root.findAllByType(Text).some(
      node => node.props.children === 'send.scanInvalid',
    )).toBe(true);
    readCode(address);
    expect(onScanned).toHaveBeenCalledWith(address);
  });

  it('accepts another code after closing and reopening the scanner', async () => {
    readCode(address);
    await act(async () => {
      tree.update(
        <RecipientQrScanner visible={false} onClose={onClose} onScanned={onScanned} />,
      );
    });
    await act(async () => {
      tree.update(
        <RecipientQrScanner visible onClose={onClose} onScanned={onScanned} />,
      );
    });
    readCode(address);
    expect(onScanned).toHaveBeenCalledTimes(2);
  });
});
