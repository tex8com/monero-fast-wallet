# Fast Wallet Community Directory

The Directory accepts only Worker-signed public registration and heartbeat
requests. New Workers remain `pending` until an authenticated local admin
approval issues a short-lived, descriptor-bound admission certificate.

The configured Monero network and Relay origin are enforced exactly. A public
Worker therefore cannot obtain admission for a different network or redirect
Wallet registrations to another Relay.

The public API contains Worker descriptors, operator-supplied labels and
coarse capacity only. It never receives a wallet address, view key, provider
token, assignment handle or notification event.

Private Workers do not call this service. They pair directly with one Wallet
through the signed `tex8-fast-wallet-worker:v1:` descriptor.
