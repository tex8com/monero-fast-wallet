import {
  formatWalletLogLine,
  WALLET_DIAGNOSTIC_LOG_PREFIX,
} from '../WalletLogger';

describe('Fast Wallet diagnostic logging', () => {
  it('keeps stage timing while removing every secret or stable identifier', () => {
    const line = formatWalletLogLine(
      'FastWalletEnrollment',
      'watchUpload.success',
      {
        elapsedMs: 42,
        generation: 3,
        success: true,
        providerToken: 'fcm-secret-token',
        appCheckToken: 'app-check-secret',
        identityId: 'wallet-stable-id',
        installationId: 'installation-stable-id',
        privateViewKey: 'private-view-key',
        address: 'monero-address',
      },
    );

    expect(line.startsWith(`${WALLET_DIAGNOSTIC_LOG_PREFIX} `)).toBe(true);
    expect(line).toContain('"elapsedMs":42');
    expect(line).toContain('"generation":3');
    expect(line).toContain('"success":true');
    expect(line).toContain('"scope":"FastWalletEnrollment"');
    expect(line).toContain('"event":"watchUpload.success"');
    expect(line).not.toContain('fcm-secret-token');
    expect(line).not.toContain('app-check-secret');
    expect(line).not.toContain('wallet-stable-id');
    expect(line).not.toContain('installation-stable-id');
    expect(line).not.toContain('private-view-key');
    expect(line).not.toContain('monero-address');
  });

  it('classifies errors without copying their message into the log', () => {
    const line = formatWalletLogLine('FastWalletPush', 'registration.error', {
      error: new Error('FCM token abc-secret timed out while connecting'),
      retryCount: 1,
    });

    expect(line).toContain('"failureCode":"timeout"');
    expect(line).toContain('"retryCount":1');
    expect(line).not.toContain('abc-secret');
  });
});
