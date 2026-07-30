# Fast Wallet Ciphertext Relay

The Relay stores only:

- fixed-size 484-byte HPKE envelopes;
- exact Worker root IDs;
- random assignment handles and epochs;
- message IDs, expiry, lease and retry metadata;
- short-lived replay identifiers for signed Worker requests.

It has no address, view-key, transaction, amount, provider-token or Monero
wallet type. Pull and ACK requests are signed by the exact descriptor-bound
Worker online key. Messages are leased for at-least-once delivery and removed
only after a valid ACK.

Assignment sponsorship is intentionally an internal library boundary until the
open-source Gateway assignment protocol is connected.
