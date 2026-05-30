# Monero Fast Wallet

Self-custodial Monero mobile wallet with optional fast receive notifications.

The product goal is a Monero wallet that opens and feels ready quickly, while
remaining compatible with normal Monero infrastructure. The default mode keeps
all wallet secrets local. The optional fast receive mode creates a separate
notification receive identity whose private view key can be hosted by our
server-side scanner. The private spend key never leaves the phone.

## Core Principles

- Self-custody by default.
- No private spend keys on servers.
- Main wallet stays private and local.
- Fast receive is opt-in and uses a separate receive identity.
- Server notifications are hints; the app verifies wallet state locally.
- Keep compatibility with upstream Monero and normal remote nodes.
- Use Cuprate as a fast node/scanner path without changing Monero consensus.

## Repository Shape

```text
apps/
  mobile/              React Native app
native/
  monero-bridge/       iOS/Android bridge to wallet core
services/
  notify-scanner/      view-key scanner and push notification service
  wallet-api/          device registration and opt-in API
node/
  cuprate-deploy/      node deployment, configs, benchmarks
third_party/
  monero/              pinned upstream/fork reference
  cuprate/             pinned Cuprate fork reference
docs/
  ROADMAP.md
  ARCHITECTURE.md
  PRIVACY_MODEL.md
```

## Existing Local Sources

- Prototype app: `$HOME/Documents/tex8/prototypes/monero-wallet`
- Cuprate checkout: `$HOME/Documents/cuprate`
- Monero GUI/Core checkout: `$HOME/Documents/monero-gui`

These are not moved yet. This repository starts as the product planning and
integration home.
