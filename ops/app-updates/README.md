# Monero Fast Wallet update publication

The mobile release manifest is consumed by the framework-neutral
`@tex8/app-update-core` policy and then handed to the platform installer.
Publishing a newer manifest does not bypass Android or Apple signing:

- direct Android updates must keep the exact application ID and APK signing
  identity or Android rejects the replacement;
- Play and App Store builds use only their store update adapters;
- mobile JavaScript never installs a new native binary itself.

Before publishing `mfw-mobile-stable.json`, verify the artifact byte size and
SHA-256 against the final hosted file. A release is offered only when its
semantic version is newer than the embedded app version.

The publication script installs the same signed manifest on the primary Tor
v3 hidden service. Wallet clients check that Onion URL through their embedded
Tor transport; only the platform's final artifact handoff may open the public
download or store URL selected from the signed manifest.

Desktop uses the official Tauri v2 updater format instead of this manifest.
Its updater stays disabled until the offline private updater key is backed up,
the public key is embedded, and a signed artifact exists for every advertised
platform.
