# Community notification core

Dedicated provider-token and generic-push boundary for Monero Enthusiast.
It is intentionally separate from the Fast Wallet notification gateway so a
Community identity is not joined with a wallet assignment.

- FCM/APNs tokens are encrypted with XChaCha20-Poly1305 and owner-bound AAD.
- Registrations are bounded to four installations per Community identity.
- Provider payloads contain only a fixed category, generic text, a random
  delivery ID and a non-sensitive deep link.
- Invalid provider tokens are disabled; transient responses are retryable.
- No title, report text, reporter, listing content, Matrix ID, wallet address,
  amount or transaction ID is accepted by the notification type.
