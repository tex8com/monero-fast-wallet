import { parseFastWalletPushEvent } from "../FastWalletPushService";

describe("FastWalletPushService", () => {
  it("parses the privacy-preserving Fast Wallet event contract", () => {
    expect(
      parseFastWalletPushEvent({
        data: {
          contractVersion: "monero-fast-wallet-push.v2",
          eventId: "fwpush_0123456789abcdef0123456789abcdef",
          type: "monero.fast_wallet.incoming",
        },
      }),
    ).toEqual({
      contractVersion: "monero-fast-wallet-push.v2",
      eventId: "fwpush_0123456789abcdef0123456789abcdef",
      type: "monero.fast_wallet.incoming",
    });
  });

  it("accepts the opaque scanner event identifier used by deployed scanners", () => {
    expect(
      parseFastWalletPushEvent({
        data: {
          contractVersion: "monero-fast-wallet-push.v2",
          eventId: `sig_${"a".repeat(64)}`,
          type: "monero.fast_wallet.incoming",
        },
      }),
    ).toEqual({
      contractVersion: "monero-fast-wallet-push.v2",
      eventId: `sig_${"a".repeat(64)}`,
      type: "monero.fast_wallet.incoming",
    });
  });

  it("rejects malformed or detail-bearing lookalike data", () => {
    expect(
      parseFastWalletPushEvent({
        data: {
          contractVersion: "monero-fast-wallet-push.v2",
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
          contractVersion: "monero-fast-wallet-push.v2",
          eventId: "fwpush_0123456789abcdef0123456789abcdef",
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
