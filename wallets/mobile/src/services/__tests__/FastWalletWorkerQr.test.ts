import {
  parsePrivateFastWalletWorkerQr,
  privateFastWalletWorkerQrPayload,
} from '../FastWalletWorkerQr';

describe('private Fast Wallet Worker QR', () => {
  it('round-trips one canonical versioned descriptor', () => {
    const descriptor = '54'.repeat(180);
    expect(
      parsePrivateFastWalletWorkerQr(
        privateFastWalletWorkerQrPayload(descriptor),
      ),
    ).toBe(descriptor);
  });

  it.each([
    '54'.repeat(20),
    'tex8-fast-wallet-worker:v2:' + '54'.repeat(20),
    'tex8-fast-wallet-worker:v1:AA',
    'tex8-fast-wallet-worker:v1:5',
    'tex8-fast-wallet-worker:v1:' + '54'.repeat(513),
    'https://relay.example/' + '54'.repeat(20),
  ])('rejects unversioned, malformed or ambiguous input', value => {
    expect(parsePrivateFastWalletWorkerQr(value)).toBeUndefined();
  });
});
