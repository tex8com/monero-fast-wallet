import { parseFastWalletPushEvent } from '../FastWalletPushService';

describe('FastWalletPushService', () => {
  it('accepts only an opaque claim job route, never a name or transaction payload', () => {
    const data = {contractVersion:'monero-fast-wallet-push.v3',type:'monero.fast_wallet.mfw-claim',
      eventId:`evt_${'ab'.repeat(32)}`,jobId:'cd'.repeat(24),deepLink:`tex8monero://mfw-claim/${'cd'.repeat(24)}`};
    expect(parseFastWalletPushEvent({data})).toEqual(data);
    expect(parseFastWalletPushEvent({data:{...data,name:'private.mfw'}})).toBeUndefined();
    expect(parseFastWalletPushEvent({data:{...data,txId:'ab'.repeat(32)}})).toBeUndefined();
    expect(parseFastWalletPushEvent({data:{...data,deepLink:'https://evil.example'}})).toBeUndefined();
  });
  it('parses the privacy-preserving Fast Wallet event contract', () => {
    expect(
      parseFastWalletPushEvent({
        data: {
          contractVersion: 'monero-fast-wallet-push.v3',
          eventId: `evt_${'0a'.repeat(32)}`,
          type: 'monero.fast_wallet.incoming',
        },
      }),
    ).toEqual({
      contractVersion: 'monero-fast-wallet-push.v3',
      eventId: `evt_${'0a'.repeat(32)}`,
      type: 'monero.fast_wallet.incoming',
    });
  });

  it('parses a generic user-requested delivery test', () => {
    expect(
      parseFastWalletPushEvent({
        data: {
          contractVersion: 'monero-fast-wallet-push.v3',
          eventId: `evt_${'0b'.repeat(32)}`,
          type: 'monero.fast_wallet.test',
        },
      }),
    ).toEqual({
      contractVersion: 'monero-fast-wallet-push.v3',
      eventId: `evt_${'0b'.repeat(32)}`,
      type: 'monero.fast_wallet.test',
    });
  });

  it('ignores Vanity order notifications while the V1 feature is disabled', () => {
    const orderId = '12345678-1234-1234-1234-123456789abc';
    expect(
      parseFastWalletPushEvent({
        data: {
          contractVersion: 'monero-fast-wallet-push.v3',
          eventId: `evt_${'0c'.repeat(32)}`,
          type: 'monero.fast_wallet.vanity',
          orderId,
          deepLink: `mfw://vanity/order/${orderId}`,
        },
      }),
    ).toBeUndefined();
    expect(
      parseFastWalletPushEvent({
        data: {
          contractVersion: 'monero-fast-wallet-push.v3',
          eventId: `evt_${'0c'.repeat(32)}`,
          type: 'monero.fast_wallet.vanity',
          orderId,
          deepLink: 'mfw://vanity/order/other',
        },
      }),
    ).toBeUndefined();
  });

  it('rejects the retired scanner event contract', () => {
    expect(
      parseFastWalletPushEvent({
        data: {
          contractVersion: 'monero-fast-wallet-push.v2',
          eventId: `sig_${'a'.repeat(64)}`,
          type: 'monero.fast_wallet.incoming',
        },
      }),
    ).toBeUndefined();
  });

  it('rejects malformed or detail-bearing lookalike data', () => {
    expect(
      parseFastWalletPushEvent({
        data: {
          contractVersion: 'monero-fast-wallet-push.v3',
          eventId: 'bad',
          privateViewKey: 'secret',
          type: 'monero.fast_wallet.incoming',
        },
      }),
    ).toBeUndefined();

    expect(
      parseFastWalletPushEvent({
        data: {
          amountAtomic: '25000000000',
          contractVersion: 'monero-fast-wallet-push.v3',
          eventId: `evt_${'0a'.repeat(32)}`,
          network: 'mainnet',
          state: 'confirmed',
          txId: 'a'.repeat(64),
          type: 'monero.fast_wallet.incoming',
          walletId: 'fast-receive-v2-1',
        },
      }),
    ).toBeUndefined();
  });
});
