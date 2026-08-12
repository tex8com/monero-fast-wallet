# Fast Wallet Ciphertext Relay

The Relay stores only:

- fixed-size 484-byte HPKE envelopes;
- exact Worker root IDs;
- random assignment handles and epochs;
- message IDs, expiry, lease and retry metadata;
- short-lived replay identifiers for signed Worker requests;
- expiring Worker-signed acceptance receipts bound to the exact ciphertext ID.

It has no address, view-key, transaction, amount, provider-token or Monero
wallet type. Pull and ACK requests are signed by the exact descriptor-bound
Worker online key. Messages are leased for at-least-once delivery and removed
only after a valid ACK. A watch ACK must carry its exact signed receipt; until
then the bearer receipt lookup returns only `pending` and cannot claim Worker
acceptance.

Assignment sponsorship is intentionally an internal library boundary until the
open-source Gateway assignment protocol is connected.
