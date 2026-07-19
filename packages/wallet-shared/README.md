# Monero Wallet Shared

This package contains platform-neutral wallet rules that must have identical
behaviour in the React Native and Tauri apps. It intentionally contains no UI,
React, React Native, browser, Tauri, or native-bridge imports.

Currently shared:

- native-core-confirmed wallet synchronization and spend-readiness rules
- safe scan-start date validation and restore-height estimation

Keep platform views separate, but add shared wallet contracts and pure rules
here before duplicating logic in either application.
