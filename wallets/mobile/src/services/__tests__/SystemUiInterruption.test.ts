const mockNativeBeginSystemUiInterruption = jest.fn(
  async (reason: string) => `native-${reason}`,
);
const mockNativeEndSystemUiInterruption = jest.fn(async () => undefined);

jest.mock('../NativeMoneroWallet', () => ({
  requireNativeMoneroWallet: () => ({
    beginSystemUiInterruption: mockNativeBeginSystemUiInterruption,
    endSystemUiInterruption: mockNativeEndSystemUiInterruption,
  }),
}));

import { Platform } from 'react-native';
import {
  activeSystemUiInterruptionDeadlineMs,
  beginSystemUiInterruption,
  recentlyCompletedSystemUiInterruption,
  resetSystemUiInterruptionsForTests,
  withSystemUiInterruption,
} from '../SystemUiInterruption';

describe('SystemUiInterruption', () => {
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(
    Platform,
    'OS',
  );

  beforeEach(() => {
    resetSystemUiInterruptionsForTests();
    mockNativeBeginSystemUiInterruption.mockClear();
    mockNativeEndSystemUiInterruption.mockClear();
    jest.restoreAllMocks();
  });

  afterEach(() => {
    resetSystemUiInterruptionsForTests();
    jest.restoreAllMocks();
    Object.defineProperty(Platform, 'OS', originalPlatformDescriptor!);
  });

  it('tracks nested operating-system UI with a bounded latest deadline', () => {
    jest.spyOn(Date, 'now').mockReturnValue(1_000);
    const endFirst = beginSystemUiInterruption('camera', 100);
    const endSecond = beginSystemUiInterruption('location', 250);

    expect(activeSystemUiInterruptionDeadlineMs()).toBe(1_250);
    endSecond();
    expect(activeSystemUiInterruptionDeadlineMs()).toBe(1_100);
    endFirst();
    expect(activeSystemUiInterruptionDeadlineMs()).toBeUndefined();
  });

  it('expires a stale interruption even if its platform promise hangs', () => {
    jest.spyOn(Date, 'now').mockReturnValue(5_000);
    beginSystemUiInterruption('ledger', 45_000);

    expect(activeSystemUiInterruptionDeadlineMs(49_999)).toBe(50_000);
    expect(activeSystemUiInterruptionDeadlineMs(50_000)).toBeUndefined();
  });

  it('only records a recent completion before the security deadline', () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(10_000);
    const endSuccessful = beginSystemUiInterruption('camera', 1_000);
    now.mockReturnValue(10_500);
    endSuccessful();

    expect(recentlyCompletedSystemUiInterruption(11_999)).toBe(true);
    expect(recentlyCompletedSystemUiInterruption(12_001)).toBe(false);

    resetSystemUiInterruptionsForTests();
    now.mockReturnValue(20_000);
    const endExpired = beginSystemUiInterruption('camera', 1_000);
    now.mockReturnValue(21_001);
    endExpired();
    expect(recentlyCompletedSystemUiInterruption(21_001)).toBe(false);
  });

  it('does not wait for iOS native interruption bookkeeping', async () => {
    await expect(
      withSystemUiInterruption('permission', async () => 'ok'),
    ).resolves.toBe('ok');
    expect(mockNativeBeginSystemUiInterruption).not.toHaveBeenCalled();
    expect(mockNativeEndSystemUiInterruption).not.toHaveBeenCalled();
    expect(activeSystemUiInterruptionDeadlineMs()).toBeUndefined();

    await expect(
      withSystemUiInterruption('permission', async () => {
        throw new Error('denied');
      }),
    ).rejects.toThrow('denied');
    expect(mockNativeBeginSystemUiInterruption).not.toHaveBeenCalled();
    expect(mockNativeEndSystemUiInterruption).not.toHaveBeenCalled();
    expect(activeSystemUiInterruptionDeadlineMs()).toBeUndefined();
  });

  it('keeps Android native interruption protection unchanged', async () => {
    Object.defineProperty(Platform, 'OS', {
      configurable: true,
      value: 'android',
    });

    await withSystemUiInterruption(
      'camera',
      async () => undefined,
      Number.MAX_SAFE_INTEGER,
    );

    expect(mockNativeBeginSystemUiInterruption).toHaveBeenCalledWith(
      'camera',
      45_000,
    );
    expect(mockNativeEndSystemUiInterruption).toHaveBeenCalledWith(
      'native-camera',
    );
  });
});
