import { parseFastWalletPushEvent } from "../FastWalletPushService";

describe("FastWalletPushService", () => {
  it("parses the privacy-preserving Fast Wallet event contract", () => {
    expect(
      parseFastWalletPushEvent({
        data: {
          contractVersion: "monero-fast-wallet-push.v3",
          eventId: `evt_${"0a".repeat(32)}`,
          type: "monero.fast_wallet.incoming",
        },
      }),
    ).toEqual({
      contractVersion: "monero-fast-wallet-push.v3",
      eventId: `evt_${"0a".repeat(32)}`,
      type: "monero.fast_wallet.incoming",
    });
  });

  it("parses a generic user-requested delivery test", () => {
    expect(
      parseFastWalletPushEvent({
        data: {
          contractVersion: "monero-fast-wallet-push.v3",
          eventId: `evt_${"0b".repeat(32)}`,
          type: "monero.fast_wallet.test",
        },
      }),
    ).toEqual({
      contractVersion: "monero-fast-wallet-push.v3",
      eventId: `evt_${"0b".repeat(32)}`,
      type: "monero.fast_wallet.test",
    });
  });

  it("rejects the retired scanner event contract", () => {
    expect(
      parseFastWalletPushEvent({
        data: {
          contractVersion: "monero-fast-wallet-push.v2",
          eventId: `sig_${"a".repeat(64)}`,
          type: "monero.fast_wallet.incoming",
        },
      }),
    ).toBeUndefined();
  });

  it("rejects malformed or detail-bearing lookalike data", () => {
    expect(
      parseFastWalletPushEvent({
        data: {
          contractVersion: "monero-fast-wallet-push.v3",
          eventId: "bad",
          privateViewKey: "secret",
          type: "monero.fast_wallet.incoming",
        },
      }),
    ).toBeUndefined();

    expect(
      parseFastWalletPushEvent({
        data: {
          amountAtomic: "25000000000",
          contractVersion: "monero-fast-wallet-push.v3",
          eventId: `evt_${"0a".repeat(32)}`,
          network: "mainnet",
          state: "confirmed",
          txId: "a".repeat(64),
          type: "monero.fast_wallet.incoming",
          walletId: "fast-receive-v2-1",
        },
      }),
    ).toBeUndefined();
  });
});
