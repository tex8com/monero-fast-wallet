# Community Contact Core

Durable wallet-independent contact-consent boundary for Monero Enthusiast V1.

- Matrix IDs are encrypted at rest and never enter public catalogs.
- A requester sees the peer's Matrix ID only after the recipient explicitly
  accepts.
- Requests carry only requester/recipient identity IDs. There is no listing
  ID, price, quantity, terms, “respond to offer” state or prepared message.
- Blocking immediately revokes contact resolution in both directions and
  closes pending requests.
- All state transitions append a minimal audit event without Matrix plaintext.

The service adapter must rate-limit requests, authenticate both identities and
keep the 32-byte storage key in its secret manager.
