# brace-expansion compatibility adapter

Legacy development tools bundled below React Native still expect the
`brace-expansion` 1.x CommonJS export to be directly callable. The security
fix for CVE-2026-14257 is only available in 5.0.8, which exports `{ expand }`.

This adapter exposes the patched 5.0.8 implementation through both API shapes.
It contains no expansion implementation of its own and can be removed once all
callers accept the 5.x API.
