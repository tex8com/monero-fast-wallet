# Privacy

Monero Fast Wallet is designed for self-custody: seeds and spend keys remain
on the user's device or Ledger, and local wallet verification remains
authoritative.

The standard wallet mode keeps wallet scanning and payment interpretation on
the device. Optional Fast Receive is a convenience mode that may use an
isolated view key and generic notification wake-ups. It does not send seeds,
spend keys, transaction details or raw push tokens to a scanner.

No wallet key images or server-side key-image status are used. The client does
not upload key images.

Network privacy and synchronization speed involve trade-offs. Users may choose
their own node and routing configuration where the application exposes those
controls. No software configuration eliminates all network metadata.

Do not publish real addresses, wallet files, transaction data, seeds, keys,
credentials or production service details in issues, pull requests or logs.
