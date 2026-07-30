# TEX8 App Update Core

`@tex8/app-update-core` is the framework-neutral update policy shared by the
React Native and Tauri applications. It contains no React, React Native,
Tauri, browser, operating-system, wallet, or private-key code.

The module owns:

- strict semantic-version comparison;
- app/channel/platform/architecture/delivery matching;
- deterministic staged rollout from a local installation identifier;
- minimum-version and mandatory-update decisions;
- HTTPS and allow-listed artifact-host validation;
- a single-flight check/install lifecycle for consistent UI state.

Platform adapters remain deliberately separate:

- iOS App Store and Google Play builds use their store update mechanisms;
- direct Android builds may open a signed replacement APK and let Android
  verify the package signing identity before installation;
- direct macOS, Windows, and Linux builds use signed Tauri updater artifacts;
- store-distributed desktop builds remain on the corresponding store channel.

The shared module never downloads or executes code and never handles release
private keys. Native/store adapters are the final trust boundary.
