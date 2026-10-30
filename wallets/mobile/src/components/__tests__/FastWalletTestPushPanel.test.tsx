import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { Text, TouchableOpacity } from 'react-native';
import FastWalletTestPushPanel from '../FastWalletTestPushPanel';

const mockReady = jest.fn(async () => true);
const mockSend = jest.fn();
const mockLastEvent = jest.fn(async () => undefined as any);
const mockLastScheduled = jest.fn(async () => undefined as any);
const mockEnableAlerts = jest.fn(
  async (_input: { identityId: string }) => undefined,
);
const mockListeners = new Set<(event: any) => void>();
jest.mock('../../i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));
jest.mock('../../services/FastWalletPushService', () => ({
  FastWalletPushService: {
    testNotificationReady: () => mockReady(),
    sendTestNotification: (...args: any[]) => mockSend(...args),
    getLastEvent: () => mockLastEvent(),
    getLastScheduledTestPush: () => mockLastScheduled(),
    subscribe: (listener: (event: any) => void) => {
      mockListeners.add(listener);
      return () => mockListeners.delete(listener);
    },
  },
}));
jest.mock('../../services/WalletService', () => ({
  walletService: {
    enableEncryptedFastWalletAlerts: (input: { identityId: string }) =>
      mockEnableAlerts(input),
  },
}));
jest.mock('../../services/WalletLogger', () => ({ logWalletEvent: jest.fn() }));
const receipt = {
  accepted: true,
  eventId: 'evt_' + 'a'.repeat(64),
  scheduledAt: 100,
  deliverAfter: 110,
};
const wallets = [
  {
    id: 'fast',
    kind: 'fast',
    walletName: 'Fast Wallet',
    seedBackupStatus: 'verified',
  },
] as any;
let renderer: ReactTestRenderer.ReactTestRenderer;
async function render(value = wallets) {
  await ReactTestRenderer.act(async () => {
    renderer = ReactTestRenderer.create(
      <FastWalletTestPushPanel wallets={value} />,
    );
  });
}
function text() {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .join(' ');
}
function emit(eventId: string) {
  mockListeners.forEach(listener =>
    listener({ type: 'monero.fast_wallet.test', eventId }),
  );
}
function testButton() {
  return renderer.root.findByProps({ testID: 'fast-wallet-send-test' });
}
function enableButton() {
  return renderer.root.findByProps({
    testID: 'fast-wallet-enable-alerts-fast',
  });
}
beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(100000);
  mockReady.mockReset().mockResolvedValue(true);
  mockSend.mockReset();
  mockLastEvent.mockReset().mockResolvedValue(undefined);
  mockLastScheduled.mockReset().mockResolvedValue(undefined);
  mockEnableAlerts.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  if (renderer) ReactTestRenderer.act(() => renderer.unmount());
  jest.useRealTimers();
});
it('is absent for standard wallets and explains disabled alerts without enabling them', async () => {
  await render([{ id: 'normal', kind: 'software' }] as any);
  expect(renderer.toJSON()).toBeNull();
  mockReady.mockResolvedValue(false);
  await ReactTestRenderer.act(async () => {
    renderer.update(<FastWalletTestPushPanel wallets={wallets} />);
  });
  expect(testButton().props.disabled).toBe(true);
  expect(text()).toContain('settings.testNotificationRequirement');
  expect(mockSend).not.toHaveBeenCalled();
  expect(mockEnableAlerts).not.toHaveBeenCalled();
});
it('shows scheduled for the server receipt and requires the matching actual event', async () => {
  mockSend.mockResolvedValue(receipt);
  await render();
  await ReactTestRenderer.act(async () => {
    await testButton().props.onPress();
  });
  expect(text()).toContain('settings.testNotificationScheduled');
  ReactTestRenderer.act(() => jest.advanceTimersByTime(10000));
  expect(text()).toContain('settings.testNotificationScheduled');
  ReactTestRenderer.act(() => emit('evt_' + 'b'.repeat(64)));
  expect(text()).not.toContain('settings.testNotificationReceived');
  ReactTestRenderer.act(() => emit(receipt.eventId));
  expect(text()).toContain('settings.testNotificationReceived');
  expect(mockSend).toHaveBeenCalledTimes(1);
});

it('retains the scheduled receipt and blocks further requests until delivery and the server rate window permit them', async () => {
  mockSend.mockResolvedValue(receipt);
  await render();
  const press = testButton().props.onPress;
  await ReactTestRenderer.act(async () => {
    await press();
    await press();
  });
  expect(testButton().props.disabled).toBe(true);
  expect(mockSend).toHaveBeenCalledTimes(1);
  ReactTestRenderer.act(() => emit(receipt.eventId));
  expect(text()).toContain('settings.testNotificationReceived');
  expect(testButton().props.disabled).toBe(true);
  await ReactTestRenderer.act(async () => {
    jest.advanceTimersByTime(59999);
    await press();
  });
  expect(mockSend).toHaveBeenCalledTimes(1);
  ReactTestRenderer.act(() => jest.advanceTimersByTime(1));
  expect(testButton().props.disabled).toBe(false);
});

it('ends unconfirmed waiting after the delivery grace period and allows a fresh correlated retry', async () => {
  const second = {
    ...receipt,
    eventId: 'evt_' + 'b'.repeat(64),
    scheduledAt: 230,
    deliverAfter: 240,
  };
  mockSend.mockResolvedValueOnce(receipt).mockResolvedValueOnce(second);
  await render();
  await ReactTestRenderer.act(async () => {
    await testButton().props.onPress();
    jest.advanceTimersByTime(129999);
  });
  expect(text()).toContain('settings.testNotificationScheduled');
  expect(testButton().props.disabled).toBe(true);
  await ReactTestRenderer.act(async () => jest.advanceTimersByTime(1));
  expect(text()).toContain('settings.testNotificationNotReceived');
  expect(testButton().props.disabled).toBe(false);
  await ReactTestRenderer.act(async () => testButton().props.onPress());
  expect(mockSend).toHaveBeenCalledTimes(2);
  expect(text()).toContain('settings.testNotificationScheduled');
  ReactTestRenderer.act(() => emit(receipt.eventId));
  expect(text()).not.toContain('settings.testNotificationReceived');
  ReactTestRenderer.act(() => emit(second.eventId));
  expect(text()).toContain('settings.testNotificationReceived');
});

it('does not wait forever for unavailable local receipt storage and still accepts a late actual receipt', async () => {
  mockSend.mockResolvedValue(receipt);
  await render();
  await ReactTestRenderer.act(async () => testButton().props.onPress());
  mockLastEvent.mockImplementationOnce(() => new Promise(() => undefined));
  await ReactTestRenderer.act(async () => jest.advanceTimersByTime(130000));
  expect(text()).toContain('settings.testNotificationNotReceived');
  expect(testButton().props.disabled).toBe(false);
  ReactTestRenderer.act(() => emit(receipt.eventId));
  expect(text()).toContain('settings.testNotificationReceived');
});

it('recovers a persisted actual receipt at the deadline and retains correlation after a failed retry', async () => {
  mockSend
    .mockResolvedValueOnce(receipt)
    .mockRejectedValueOnce(new Error('network'));
  await render();
  await ReactTestRenderer.act(async () => testButton().props.onPress());
  mockLastEvent.mockResolvedValueOnce({
    type: 'monero.fast_wallet.test',
    eventId: receipt.eventId,
  });
  await ReactTestRenderer.act(async () => jest.advanceTimersByTime(130000));
  expect(text()).toContain('settings.testNotificationReceived');
  await ReactTestRenderer.act(async () => testButton().props.onPress());
  expect(text()).toContain('settings.testNotificationFailed');
  ReactTestRenderer.act(() => emit(receipt.eventId));
  expect(text()).toContain('settings.testNotificationReceived');
});

it('restores an expired schedule as unconfirmed instead of leaving it scheduled forever', async () => {
  jest.setSystemTime(1000000);
  mockLastScheduled.mockResolvedValue(receipt);
  await render();
  await ReactTestRenderer.act(async () => jest.advanceTimersByTime(0));
  expect(text()).toContain('settings.testNotificationNotReceived');
  expect(testButton().props.disabled).toBe(false);
  expect(mockSend).not.toHaveBeenCalled();
});
it('keeps a genuine event that arrives before a delayed API receipt and ignores double clicks', async () => {
  let accept!: (value: typeof receipt) => void;
  mockSend.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        accept = resolve;
      }),
  );
  await render();
  let work: Promise<void>;
  ReactTestRenderer.act(() => {
    const press = testButton().props.onPress;
    work = press();
    press();
  });
  ReactTestRenderer.act(() => emit(receipt.eventId));
  await ReactTestRenderer.act(async () => {
    accept(receipt);
    await work;
  });
  expect(text()).toContain('settings.testNotificationReceived');
  expect(mockSend).toHaveBeenCalledTimes(1);
});
it('does not claim scheduling or delivery after an API error', async () => {
  mockSend.mockRejectedValue(new Error('timeout'));
  await render();
  await ReactTestRenderer.act(async () => {
    await testButton().props.onPress();
  });
  expect(text()).toContain('settings.testNotificationFailed');
  expect(text()).not.toContain('settings.testNotificationReceived');
});

it('keeps a server acknowledgement when optional local event storage is unavailable', async () => {
  mockSend.mockResolvedValue(receipt);
  await render();
  mockLastEvent.mockRejectedValueOnce(new Error('app locked'));
  await ReactTestRenderer.act(async () => {
    await testButton().props.onPress();
  });
  expect(text()).toContain('settings.testNotificationScheduled');
  expect(text()).not.toContain('settings.testNotificationFailed');
});

it('offers explicit enrollment only for a backed-up Fast Wallet and rechecks test readiness', async () => {
  mockReady.mockResolvedValueOnce(false).mockResolvedValue(true);
  await render([
    ...wallets,
    { id: 'pending', kind: 'fast', seedBackupStatus: 'pending' },
    { id: 'normal', kind: 'software', seedBackupStatus: 'verified' },
  ] as any);
  expect(renderer.root.findAllByType(TouchableOpacity)).toHaveLength(2);
  expect(mockEnableAlerts).not.toHaveBeenCalled();
  expect(testButton().props.disabled).toBe(true);
  await ReactTestRenderer.act(async () => {
    await enableButton().props.onPress();
  });
  expect(mockEnableAlerts).toHaveBeenCalledTimes(1);
  expect(mockEnableAlerts).toHaveBeenCalledWith({ identityId: 'fast' });
  expect(mockReady).toHaveBeenCalledTimes(2);
  expect(testButton().props.disabled).toBe(false);
  expect(text()).toContain('setup.fastWalletTransferAccepted');
  expect(mockSend).not.toHaveBeenCalled();
});

it('keeps the test disabled unless the normal prerequisites pass after enrollment', async () => {
  mockReady.mockResolvedValue(false);
  await render();
  await ReactTestRenderer.act(async () => {
    await enableButton().props.onPress();
  });
  expect(testButton().props.disabled).toBe(true);
  expect(mockReady).toHaveBeenCalledTimes(2);
  expect(mockSend).not.toHaveBeenCalled();
});

it('blocks duplicate activation and testing while normal enrollment is pending', async () => {
  mockReady.mockResolvedValue(false);
  let finish!: () => void;
  mockEnableAlerts.mockImplementationOnce(
    () =>
      new Promise<undefined>(resolve => {
        finish = () => resolve(undefined);
      }),
  );
  await render();
  let work!: Promise<void>;
  ReactTestRenderer.act(() => {
    const press = enableButton().props.onPress;
    work = press();
    press();
    testButton().props.onPress();
  });
  expect(mockEnableAlerts).toHaveBeenCalledTimes(1);
  expect(enableButton().props.disabled).toBe(true);
  expect(testButton().props.disabled).toBe(true);
  expect(text()).toContain('setup.fastWalletTransferSending');
  expect(mockSend).not.toHaveBeenCalled();
  await ReactTestRenderer.act(async () => {
    finish();
    await work;
  });
});

it('shows a recoverable enrollment failure and allows another explicit attempt', async () => {
  mockReady.mockResolvedValueOnce(false).mockResolvedValue(true);
  mockEnableAlerts.mockRejectedValueOnce(new Error('Worker unavailable'));
  await render();
  await ReactTestRenderer.act(async () => {
    await enableButton().props.onPress();
  });
  expect(text()).toContain('setup.fastWalletTransferFailed');
  expect(testButton().props.disabled).toBe(true);
  expect(enableButton().props.disabled).toBe(false);
  await ReactTestRenderer.act(async () => {
    await enableButton().props.onPress();
  });
  expect(mockEnableAlerts).toHaveBeenCalledTimes(2);
  expect(testButton().props.disabled).toBe(false);
});
